// Гарын үсэгтэй файлыг имэйлээр дамжуулах — `POST /share` (CA docs/SHARE_EMAIL.md). RP гарын үсэг зурсан файлаа
// дараагийн гарын үсэг зурагч / хүлээн авагч руу хавсралтаар илгээнэ. CA файлыг хадгалахгүй: eID-ийн хүчинтэй гарын
// үсэгтэй эсэхийг шалгаад email-service руу дамжуулж хаяна. SIGN эрх. CA-ийн туг `EID_SHARE_ENABLED` унтраалттай үед
// 503 SHARE_DISABLED — асаалттай эсэхийг {@link ShareInfo.enabled}-ээр (discovery) шалга.
//
// multipart/form-data-г стандарт `FormData` + `Blob`-оор угсарна — Node ≥ 18 ба хөтөчид ижил ажиллана (API secret
// шаарддаг тул хөтөчөөс шууд биш, RP backend-ээс дуудна).

import { RP_ROUTES } from "./contract.js";
import { ApiError, type HttpErrorInit } from "./errors.js";
import type { Http } from "./http.js";

/** Хүсэлтийн хугацаа: CA бүх хүлээн авагчид 120 с-д илгээнэ, nginx 150 с. */
export const DEFAULT_SHARE_TIMEOUT_MS = 150_000;

/** `client.share()`-ийн оролт. Хязгаар (CA main 0329ef95): discovery-ийн `share` блок ({@link ShareInfo}). */
export interface ShareInput {
  /** Гарын үсэгтэй файл (одоогоор зөвхөн PDF), ≤ 3 080 192 байт. `File` бол нэр нь `filename`-ийн анхдагч. */
  file: Blob | Uint8Array | ArrayBuffer;
  /**
   * Хавсралтын нэр (≤ 120 тэмдэгт). Өргөтгөл нь форматтай таарах ёстой (`.pdf`) — эс бөгөөс 415. Анхдагч: `File`-ийн
   * нэр, байхгүй бол `document.pdf`.
   */
  filename?: string;
  /** Хүлээн авагч, 1–5 (хүн бүрт тусдаа имэйл). Давхардвал 400 RECIPIENT_DUPLICATE. */
  to: string | readonly string[];
  /** Имэйлийн гарчиг (≤ 150); CA үргэлж `‹RP нэр›: …` угтвар тавина. */
  subject?: string;
  /** Илгээгчийн тэмдэглэл (≤ 1000). */
  message?: string;
  /** Имэйлийн хэл: `mn` (анхдагч) | `en`. */
  lang?: "mn" | "en";
  /** Хүсэлтийн хугацаа (мс). Анхдагч {@link DEFAULT_SHARE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** 200 хариу. */
export interface ShareResult {
  /** Илгээсэн имэйлийн тоо (= хүлээн авагчийн тоо). */
  sent: number;
  /** Файлын SHA-256 (hex). */
  sha256: string;
  /** Хүчинтэй eID гарын үсгийн тоо. */
  signatures: number;
  /** CA-д (`/pdf/signatures`) бүртгэлтэй бол баримтын ID — имэйлд verify холбоос орно. */
  docID?: string;
  raw: unknown;
}

/** `share()`-ийн CA алдааны кодууд ({@link ShareError.code}). */
export type ShareErrorCode =
  | "REQUEST_INVALID"
  | "FILE_EMPTY"
  | "RECIPIENT_REQUIRED"
  | "TOO_MANY_RECIPIENTS"
  | "RECIPIENT_INVALID"
  | "RECIPIENT_DUPLICATE"
  | "FILE_TOO_LARGE"
  | "FILE_TYPE_NOT_SUPPORTED"
  | "FILE_NOT_SIGNED"
  | "RATE_LIMITED"
  | "MAIL_FAILED"
  | "SHARE_DISABLED"
  | "MAIL_UNAVAILABLE"
  | "VALIDATOR_UNAVAILABLE"
  | "VALIDATOR_BUSY";

/** {@link ShareErrorCode}-ийн бүх утга. */
export const SHARE_ERROR_CODES: readonly ShareErrorCode[] = [
  "REQUEST_INVALID",
  "FILE_EMPTY",
  "RECIPIENT_REQUIRED",
  "TOO_MANY_RECIPIENTS",
  "RECIPIENT_INVALID",
  "RECIPIENT_DUPLICATE",
  "FILE_TOO_LARGE",
  "FILE_TYPE_NOT_SUPPORTED",
  "FILE_NOT_SIGNED",
  "RATE_LIMITED",
  "MAIL_FAILED",
  "SHARE_DISABLED",
  "MAIL_UNAVAILABLE",
  "VALIDATOR_UNAVAILABLE",
  "VALIDATOR_BUSY",
];

/** 422 FILE_NOT_SIGNED-ийн шалтгаан. */
export type ShareNotSignedReason = "no_signature" | "invalid" | "untrusted";

/**
 * `share()`-ийн CA алдаа (401/403-аас бусад 4xx/5xx; 401 → AuthenticationError, 403 → ForbiddenError). `code`
 * ({@link ShareErrorCode}): 400 талбарын алдаа, 413 FILE_TOO_LARGE, 415 FILE_TYPE_NOT_SUPPORTED, 422 FILE_NOT_SIGNED
 * (+`reason`), 429 RATE_LIMITED (+`retryAfterMs`), 502 MAIL_FAILED (+`sent`, `failed`, `recipients`), 503
 * SHARE_DISABLED / MAIL_UNAVAILABLE / VALIDATOR_UNAVAILABLE / VALIDATOR_BUSY. JSON биш хариу (proxy) бол `code`
 * undefined.
 */
export class ShareError extends ApiError {
  /** 422 FILE_NOT_SIGNED: no_signature | invalid | untrusted. */
  readonly reason?: ShareNotSignedReason | string;
  /** 502 MAIL_FAILED: амжилттай илгээсэн тоо. */
  readonly sent?: number;
  /** 502 MAIL_FAILED: амжилтгүй тоо. */
  readonly failed?: number;
  /**
   * 502 MAIL_FAILED: `to`-гийн дарааллаар `"sent"` | `"failed"`. Зөвхөн `failed`-ийг дахин илгээ (амжилттайг дахин
   * бүү илгээ).
   */
  readonly recipients?: readonly string[];
  constructor(status: number, body: string, code?: string, init?: HttpErrorInit) {
    super(status, body, code, init);
    const o = parseObject(body);
    if (typeof o.reason === "string") this.reason = o.reason;
    if (typeof o.sent === "number") this.sent = o.sent;
    if (typeof o.failed === "number") this.failed = o.failed;
    if (Array.isArray(o.recipients)) this.recipients = o.recipients.map(String);
  }
}

/** Discovery (`/.well-known/eid`)-ийн `share` блок. */
export interface ShareInfo {
  /** CA-ийн туг. false бол `share()` → 503 SHARE_DISABLED. */
  enabled: boolean;
  endpoint: string;
  formats: { name: string; extension: string; mime: string }[];
  languages: string[];
  maxFileBytes: number;
  maxFilenameChars: number;
  maxMessageChars: number;
  maxRecipients: number;
  maxSubjectChars: number;
  /** Шаардлагатай RP эрх (SIGN). */
  permission: string;
  /** RP тутам цаг/өдөр (хүсэлт), хүлээн авагч тутам өдөр (имэйл, RP тус бүрд). */
  quota: { perRPHour: number; perRPDay: number; perRecipientDay: number };
  requiresValidSignature: boolean;
  raw: unknown;
}

const DISCOVERY_PATH = "/.well-known/eid";

function parseObject(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `POST /share`. */
export async function shareFile(http: Http, input: ShareInput): Promise<ShareResult> {
  const to = typeof input.to === "string" ? [input.to] : [...input.to];
  // Uint8Array/ArrayBuffer-ийг хуулна (SharedArrayBuffer-тэй view-г Blob хүлээж авдаггүй).
  const blob = input.file instanceof Blob ? input.file : new Blob([new Uint8Array(input.file)], { type: "application/pdf" });
  const filename = input.filename ?? ((input.file as { name?: unknown }).name as string | undefined) ?? "document.pdf";

  const form = new FormData();
  for (const a of to) form.append("to", a);
  if (input.subject !== undefined) form.append("subject", input.subject);
  if (input.message !== undefined) form.append("message", input.message);
  if (input.lang !== undefined) form.append("lang", input.lang);
  if (input.filename !== undefined) form.append("filename", input.filename);
  // Content-Type-гүй Blob → multipart-д application/octet-stream (CA зөвшөөрнө); PDF-ийг тодорхой тэмдэглэнэ.
  form.append("file", blob.type ? blob : new Blob([blob], { type: "application/pdf" }), filename || "document.pdf");

  let raw: unknown;
  try {
    raw = await http.postForm(RP_ROUTES.share.path, form, input.timeoutMs ?? DEFAULT_SHARE_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof ApiError && !(e instanceof ShareError)) {
      throw new ShareError(e.status, e.body, e.code, { headers: e.headers, retryAfterMs: e.retryAfterMs });
    }
    throw e;
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    sent: Number(o.sent ?? 0),
    sha256: String(o.sha256 ?? ""),
    signatures: Number(o.signatures ?? 0),
    ...(typeof o.docID === "string" && o.docID ? { docID: o.docID } : {}),
    raw,
  };
}

/** Discovery-ийн `share` блок. Блок байхгүй (хуучин CA) бол `enabled: false`. */
export async function shareInfo(http: Http): Promise<ShareInfo> {
  const d = (await http.get(DISCOVERY_PATH)) as Record<string, unknown>;
  const s = (d.share && typeof d.share === "object" ? d.share : {}) as Record<string, unknown>;
  const q = (s.quota && typeof s.quota === "object" ? s.quota : {}) as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    endpoint: String(s.endpoint ?? ""),
    formats: Array.isArray(s.formats) ? (s.formats as ShareInfo["formats"]) : [],
    languages: Array.isArray(s.languages) ? s.languages.map(String) : [],
    maxFileBytes: Number(s.maxFileBytes ?? 0),
    maxFilenameChars: Number(s.maxFilenameChars ?? 0),
    maxMessageChars: Number(s.maxMessageChars ?? 0),
    maxRecipients: Number(s.maxRecipients ?? 0),
    maxSubjectChars: Number(s.maxSubjectChars ?? 0),
    permission: String(s.permission ?? ""),
    quota: {
      perRPHour: Number(q.perRPHour ?? 0),
      perRPDay: Number(q.perRPDay ?? 0),
      perRecipientDay: Number(q.perRecipientDay ?? 0),
    },
    requiresValidSignature: s.requiresValidSignature === true,
    raw: d.share,
  };
}
