// Байгууллагын цахим тамга (e-Seal): eID-ийн серверт хадгалагдах байгууллагын түлхүүрээр digest тамгална. Интерактив биш
// (иргэн, PIN, апп оролцохгүй) — хариу шууд, session-гүй. RP-д тухайн байгууллагын `SEAL:<orgEtsi>` эрх хэрэгтэй (үгүй бол
// ForbiddenError 403) — эрхийг байгууллагын улсын бүртгэлээр баталгаажсан ADMIN eID аппаараа PIN2-оор зөвшөөрсний дараа л
// авна (CA 2026-11-12; хүсэлтийг eID-ийн оператор үүсгэнэ). Хэт олон хүсэлтэд 429 → ApiError (`retryable`,
// `retryAfterMs`). Оператор тамгалалт / гэрчилгээ олголтыг унтраасан үед 503 `SEAL_SERVICE_DISABLED` →
// SealServiceDisabledError (`service`, давтахгүй). 409 бүр тогтвортой code-той (SEAL_ERROR_CODES) — код бүр өөрийн ApiError
// дэд ангитай: OrgNotActiveError, SealNotIssuedError, SealCertRevokedError, SealKeyUnavailableError, SealCertExpiredError,
// SealCertNotYetValidError, SealApproverUnavailableError.
//
// PDF-ийг тамгалах: `@gerege-systems/eid-mongolia-sdk/pades`-ийн `sealPdf(eid.seal, orgEtsi, pdf)` (PAdES-BASELINE-LT,
// RFC 3161 timestamp заавал).
//
// Тамганы гэрчилгээ олгох (CA !483, 2026-11-09): `requestCertificate` → 202 PENDING хүсэлт; байгууллагын ADMIN eID аппаараа
// PIN2-оор батална; `getCertificateRequest` / `waitForCertificate`-ээр ISSUED (гэрчилгээтэй) / REJECTED / EXPIRED / FAILED
// хүртэл асууна.
//
// Тамганы эрх (`SEAL:<orgEtsi>`)-ийг RP өөрөө хүсэх (CA V156, 2026-11-20): `requestGrant(orgEtsi, sessionId)` — sessionId нь
// танай RP-ийн эхлүүлсэн, сүүлийн 5 минутад OK-оор дууссан AUTHENTICATION session; түүний хүн байгууллагын улсын
// бүртгэлээр баталгаажсан Гүйцэтгэх захирал байх ёстой, push зөвхөн түүн рүү (PIN2). `grantStatus` / `waitForGrant`-ээр
// APPROVED хүртэл асууна. Эрх цуцлагдтал (захирал eID аппаас, эсвэл оператор) хүчинтэй. Биллинг тооцохгүй.

import { X509Certificate } from "node:crypto";
import { RP_ROUTES, SEAL_GRANT_REQUEST_FIELDS, SEAL_REGISTER_FIELDS, SEAL_REQUEST_FIELDS, SEAL_RESERVATION_FIELDS, routePath } from "./contract.js";
import { hashLen } from "./crypto.js";
import { ApiError, SealCertificateRequestError, SealGrantRequestError, ValidationError } from "./errors.js";
import type { Http } from "./http.js";
import { priorSplits, type PriorSignature, type RegisterSignatureResult } from "./sign.js";
import type { CertificateLevel, HashAlgorithm } from "./types.js";
import { verifyPrehashedSignature } from "./validator.js";
import { certExtension, tlv } from "./subject.js";

/** `GET /seal/certificate/{orgEtsi}` (CA `dto.SealCertificateResponse`). */
export interface SealCertificate {
  orgEtsi: string;
  /** DER. */
  certificate: Uint8Array;
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  /** RFC 3339. */
  notBefore: string;
  notAfter: string;
  /** Гэрчилгээнээс өөрөөс нь (QcSSCD байвал `QSCD`, үгүй бол `QUALIFIED`) — CA-ийн одоогийн түлхүүрийн тохиргооноос биш. */
  certificateLevel: CertificateLevel | string;
  /** Серверийн түүхий JSON. */
  raw: unknown;
}

/** Тамганы гэрчилгээний хүсэлтийн төлөв (CA `dto.SealCertificateRequestResponse.status`). */
export type SealCertificateRequestStatus = "PENDING" | "APPROVED" | "ISSUED" | "REJECTED" | "EXPIRED" | "FAILED";

/**
 * `POST /seal/certificate/{orgEtsi}` (202) ба `GET /seal/certificate/{orgEtsi}/requests/{requestId}` (CA
 * `dto.SealCertificateRequestResponse`).
 */
export interface SealCertificateRequest {
  requestId: string;
  orgEtsi: string;
  /** PENDING / APPROVED — хүлээнэ; ISSUED — `certificate` бөглөгдсөн; REJECTED / EXPIRED / FAILED — шинэ хүсэлт. */
  status: SealCertificateRequestStatus | string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339 — батлах хугацааны төгсгөл (дараа нь EXPIRED). */
  expiresAt: string;
  decidedAt?: string;
  /** PIN2 push илгээсэн ADMIN-ийн тоо (шинэ/PENDING хариунд). */
  approvers?: number;
  /**
   * FAILED/EXPIRED үеийн машин код: `EXPIRED` | `SEAL_ISSUANCE_FAILED` | `PUSH_FAILED` | `SEAL_SERVICE_DISABLED` (ADMIN
   * баталсан ч гэрчилгээ олголт унтраалттай байсан — гэрчилгээ гараагүй; олголт асмагц шинэ хүсэлт).
   */
  failure?: string;
  /** ISSUED үед — {@link SealApi.getCertificate}-тэй ижил хэлбэр. */
  certificate?: SealCertificate;
  raw: unknown;
}

/** {@link SealApi.waitForCertificate}-ийн сонголт. */
export interface SealWaitOptions {
  /** Нийт хүлээх дээд хугацаа (мс). Анхдагч {@link DEFAULT_SEAL_WAIT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Poll хоорондын зай (мс). Анхдагч {@link DEFAULT_SEAL_POLL_INTERVAL_MS}; 429/503-ын Retry-After илүү бол түүнийг дагана. */
  intervalMs?: number;
  /** Цуцлах — тасармагц `signal.reason`-ыг шиднэ. */
  signal?: AbortSignal;
}

/** `waitForCertificate`-ийн анхдагч хүлээх хугацаа — CA-ийн батлах цонх (sign session TTL + 2 мин)-оос урт. */
export const DEFAULT_SEAL_WAIT_TIMEOUT_MS = 15 * 60_000;
/** `waitForCertificate`-ийн анхдагч poll зай (CA зөвлөмж 2–5 с). */
export const DEFAULT_SEAL_POLL_INTERVAL_MS = 3_000;

/** Тамганы эрхийн хүсэлтийн төлөв (CA `dto.RPSealGrantStatus.status`). */
export type SealGrantRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "FAILED" | "REVOKED";

/**
 * `POST /seal/grants` (202) ба `GET /seal/grants/{grantId}` (CA `dto.RPSealGrantStatus`). `APPROVED` үед `/seal/{orgEtsi}`
 * ажиллана.
 */
export interface SealGrantRequest {
  grantId: string;
  orgEtsi: string;
  /** PENDING — хүлээнэ; APPROVED — эрхтэй; REJECTED / EXPIRED / FAILED — шинэ хүсэлт; REVOKED — эрх цуцлагдсан. */
  status: SealGrantRequestStatus | string;
  /** RFC 3339 — PENDING хүсэлтийг зөвшөөрөх хугацааны төгсгөл (эрх өөрөө хугацаагүй). */
  expiresAt: string;
  /** RFC 3339 — захирал PIN2-оор зөвшөөрсөн цаг (APPROVED, эсвэл зөвшөөрсний дараа REVOKED). */
  approvedAt?: string;
  revokedAt?: string;
  /** FAILED / EXPIRED / REVOKED-ийн машин код (ж: `EXPIRED`, `PUSH_FAILED`, `RP_NOT_ACTIVE`, `ORG_NOT_ACTIVE`, `CANCELLED`). */
  failure?: string;
  raw: unknown;
}

/** `POST /seal/{orgEtsi}` (CA `dto.SealResponse`). */
export interface SealResult {
  orgEtsi: string;
  /** digest дээрх ECDSA гарын үсэг (ASN.1 DER). */
  signature: Uint8Array;
  /** ж: `ecdsa-with-SHA256` (digest-ийн hash-аас). */
  signatureAlgorithm: string;
  /** Тамгалсан гэрчилгээ (DER). */
  certificate: Uint8Array;
  /** Тамгалсан гэрчилгээнээс өөрөөс нь (QcSSCD байвал `QSCD`, үгүй бол `QUALIFIED`). */
  certificateLevel: CertificateLevel | string;
  /** RFC 3339. */
  sealedAt: string;
  raw: unknown;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const b64 = (s: unknown, what: string): Uint8Array => {
  if (typeof s !== "string" || s === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new ValidationError(`seal: ${what} base64 биш эсвэл хоосон`);
  return new Uint8Array(Buffer.from(s, "base64"));
};

/**
 * e-Seal профайл: KeyUsage-д nonRepudiation (contentCommitment) байгаа, digitalSignature байхгүй, EKU зорилго үгүй (EKU
 * extension байхгүй эсвэл хоосон SEQUENCE), CA биш (CA/SDK шалгагчийн `usage: "seal"` ангилалтай ижил; Go
 * `eid.IsSealCertificate`, APPEARANCE_SPEC.md §6.1).
 */
export function isSealCertificate(cert: X509Certificate | Uint8Array): boolean {
  let c: X509Certificate;
  try {
    c = cert instanceof X509Certificate ? cert : new X509Certificate(Buffer.from(cert));
  } catch {
    return false;
  }
  if (c.ca || !noEkuPurpose(certExtension(c.raw, "2.5.29.37"))) return false;
  const v = certExtension(c.raw, "2.5.29.15");
  if (!v) return false;
  const bs = tlv(v, 0, v.length);
  if (bs.tag !== 0x03 || bs.end - bs.start < 2) return false;
  const bits = v[bs.start + 1]!;
  return (bits & 0x40) !== 0 && (bits & 0x80) === 0;
}

/** EKU extension value: absent or an empty SEQUENCE → no purpose; one or more purposes or malformed → false (Go). */
function noEkuPurpose(v: Uint8Array | undefined): boolean {
  if (!v) return true;
  try {
    const s = tlv(v, 0, v.length);
    return s.tag === 0x30 && s.start === s.end && s.end === v.length;
  } catch {
    return false;
  }
}

function parseSealCertificate(raw: unknown, orgEtsi: string): SealCertificate {
  const r = rec(raw);
  return {
    orgEtsi: String(r.orgEtsi ?? orgEtsi),
    certificate: b64(r.certificate, "certificate"),
    serialNumber: String(r.serialNumber ?? ""),
    subjectDn: String(r.subjectDn ?? ""),
    issuerDn: String(r.issuerDn ?? ""),
    notBefore: String(r.notBefore ?? ""),
    notAfter: String(r.notAfter ?? ""),
    certificateLevel: String(r.certificateLevel ?? ""),
    raw,
  };
}

function parseSealRequest(raw: unknown, orgEtsi: string): SealCertificateRequest {
  const r = rec(raw);
  if (typeof r.requestId !== "string" || r.requestId === "" || typeof r.status !== "string" || r.status === "") {
    throw new ValidationError("seal: хүсэлтийн хариунд requestId/status алга");
  }
  const status = r.status;
  if (status === "ISSUED" && !r.certificate) throw new ValidationError("seal: ISSUED хүсэлтэд certificate алга");
  return {
    requestId: r.requestId,
    orgEtsi: String(r.orgEtsi ?? orgEtsi),
    status,
    createdAt: String(r.createdAt ?? ""),
    expiresAt: String(r.expiresAt ?? ""),
    ...(typeof r.decidedAt === "string" ? { decidedAt: r.decidedAt } : {}),
    ...(typeof r.approvers === "number" ? { approvers: r.approvers } : {}),
    ...(typeof r.failure === "string" && r.failure ? { failure: r.failure } : {}),
    ...(r.certificate ? { certificate: parseSealCertificate(r.certificate, orgEtsi) } : {}),
    raw,
  };
}

function parseSealGrant(raw: unknown, orgEtsi?: string): SealGrantRequest {
  const r = rec(raw);
  if (typeof r.grantId !== "string" || r.grantId === "" || typeof r.status !== "string" || r.status === "") {
    throw new ValidationError("seal: эрхийн хүсэлтийн хариунд grantId/status алга");
  }
  return {
    grantId: r.grantId,
    orgEtsi: String(r.orgEtsi ?? orgEtsi ?? ""),
    status: r.status,
    expiresAt: String(r.expiresAt ?? ""),
    ...(typeof r.approvedAt === "string" ? { approvedAt: r.approvedAt } : {}),
    ...(typeof r.revokedAt === "string" ? { revokedAt: r.revokedAt } : {}),
    ...(typeof r.failure === "string" && r.failure ? { failure: r.failure } : {}),
    raw,
  };
}

/** `ms` хүлээнэ; `signal` тасрахад `signal.reason`-аар reject. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Байгууллагын тамгатай PDF-ийн бүртгэл — `POST /seal/{orgEtsi}/registrations`-ийн бие (CA V158, `dto.SealRegisterRequest`,
 * docs/PADES_CLIENT_SIDE.md §4.5; CA `DisallowUnknownFields` — medium, sessionID, onBehalfOf, signerEtsi, pageSha256 үгүй).
 * `pades.sealPdf()`-ийн `sealRegistration` (эсвэл `pades.sealRegistration(done)`) яг энэ хэлбэртэй. Hash-ууд иргэний
 * {@link RegisterSignatureInput}-тэй ижил тодорхойлолт.
 */
export interface SealRegisterInput {
  /** Жижиг үсгийн UUID (`done.docId`). */
  docID: string;
  /** Тамганы файл дахь байрлал (1–16). */
  revIndex: number;
  /** CMS DER (≤ 28 672 байт) эсвэл түүний стандарт base64. */
  cms: Uint8Array | string;
  /** Заавал биш — `/verify`-д харагдах нэр (≤ 120 тэмдэгт). */
  fileName?: string;
  inSha256: string;
  sigRevSha256: string;
  outSha256: string;
  priorCmsSha256?: string[];
  priorRevisionSha256?: string[];
  /** SDK-д л: 409 `PRIOR_MISMATCH` бол горим A-ийн өмнөх мөрийг revision-оор тааруулна (`registerSignature`-тэй ижил). */
  priorSignatures?: PriorSignature[];
}

/** `POST /seal/{orgEtsi}/registrations`-ийн хариу (CA `PDFSignatureRegisterResponse` — иргэний бүртгэлтэй ижил). */
export type SealRegisterResult = RegisterSignatureResult;

const SEAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEAL_ORG_RE = /^NTRMN-[0-9A-Z]{1,58}$/;
const SEAL_HEX64 = /^[0-9a-f]{64}$/;
const SEAL_MAX_CMS = 28_672;
const SEAL_MAX_FILE_NAME = 120;

/**
 * `POST /seal/{orgEtsi}/registrations`-ийн JSON бие — {@link SEAL_REGISTER_FIELDS}-ийн дарааллаар. CA-ийн
 * `normalizeSealRegister`-ийн хэлбэрийн дүрмийг сүлжээгүй шалгана: docID жижиг UUID, revIndex 1–16, fileName ≤ 120
 * (өгсөн бол), inSha256 / sigRevSha256 / outSha256 / prior* нь 64 жижиг hex, prior-ийн тоо = revIndex − 1, cms 1…28 672 байт.
 * @throws {ValidationError}
 */
export function buildSealRegisterBody(input: SealRegisterInput): Record<string, unknown> {
  const fail = (m: string): never => {
    throw new ValidationError(`registerSealedPdf: ${m}`);
  };
  if (!SEAL_UUID_RE.test(input.docID ?? "")) fail("docID жижиг үсгийн UUID биш");
  if (!Number.isInteger(input.revIndex) || input.revIndex < 1 || input.revIndex > 16) fail("revIndex 1–16");
  const hex = (name: string, v: string | undefined): string => {
    if (typeof v !== "string" || !SEAL_HEX64.test(v)) fail(`${name}: 64 жижиг hex биш`);
    return v as string;
  };
  let cmsB64: string;
  if (typeof input.cms === "string") {
    const raw = Buffer.from(input.cms, "base64");
    if (raw.length === 0 || raw.toString("base64") !== input.cms) fail("cms стандарт base64 биш");
    if (raw.length > SEAL_MAX_CMS) fail(`cms > ${SEAL_MAX_CMS} байт`);
    cmsB64 = input.cms;
  } else {
    if (!(input.cms instanceof Uint8Array) || input.cms.length === 0) fail("cms хоосон");
    if (input.cms.length > SEAL_MAX_CMS) fail(`cms > ${SEAL_MAX_CMS} байт`);
    cmsB64 = Buffer.from(input.cms).toString("base64");
  }
  const fileName = input.fileName?.trim() ?? "";
  if (Array.from(fileName).length > SEAL_MAX_FILE_NAME) fail(`fileName ≤ ${SEAL_MAX_FILE_NAME} тэмдэгт`);
  const priorCms = (input.priorCmsSha256 ?? []).map((h, i) => hex(`priorCmsSha256[${i}]`, h));
  const priorRev = (input.priorRevisionSha256 ?? []).map((h, i) => hex(`priorRevisionSha256[${i}]`, h));
  if (priorCms.length + priorRev.length !== input.revIndex - 1) fail("priorCmsSha256 + priorRevisionSha256-ийн тоо = revIndex − 1");
  const body: Record<string, unknown> = { docID: input.docID, revIndex: input.revIndex, cms: cmsB64 };
  if (fileName) body.fileName = fileName;
  body.inSha256 = hex("inSha256", input.inSha256);
  body.sigRevSha256 = hex("sigRevSha256", input.sigRevSha256);
  body.outSha256 = hex("outSha256", input.outSha256);
  if (priorCms.length) body.priorCmsSha256 = priorCms;
  if (priorRev.length) body.priorRevisionSha256 = priorRev;
  for (const k of Object.keys(body)) if (!(SEAL_REGISTER_FIELDS as readonly string[]).includes(k)) fail(`дотоод: үл мэдэгдэх талбар ${k}`);
  return body;
}

export class SealApi {
  /** @param registerTimeoutMs `registerSealedPdf`-ийн HTTP хугацаа (`ClientConfig.pdfTimeoutMs`; алга бол 80 000). */
  constructor(
    private readonly http: Http,
    private readonly registerTimeoutMs?: number,
  ) {}

  /**
   * `POST /seal/{orgEtsi}/registrations` (`SEAL:<orgEtsi>`, CA V158) — байгууллагын тамгатай PDF-ийг CA-ийн бүртгэлд
   * (`/verify/{docID}`, байгууллагын мөр) оруулна; иргэний `sign.registerSignature`-ийн тамганы хувилбар. `pades.sealPdf`-ийн
   * дараа `done.sealRegistration`-оор. CA-ийн нөхцөл: тамгыг ЭНЭ RP `POST /seal/{orgEtsi}`-ээр хүссэн (CMS-ийн
   * SHA-256(signedAttrs) = тамгалсан digest), тамгалснаас 7 хоногийн дотор, нөөцөлсөн docId/revIndex-тэй таарах. Ижил бие
   * давтвал 200 (`created: false`). 409 `PRIOR_MISMATCH` бол `priorSignatures`-ээр `registerSignature`-тэй ижил хослолоор
   * дахин оролдоно. Хэлбэрийн алдаа ({@link buildSealRegisterBody}) сүлжээнд гарахгүй.
   * @throws {ValidationError} хэлбэр; `ApiError` (`code` ∈ {@link SealRegisterErrorCode}; 429/503 `retryable`);
   *   `ForbiddenError` (403, `SEAL:<orgEtsi>` эрхгүй).
   */
  async registerSealedPdf(orgEtsi: string, input: SealRegisterInput): Promise<SealRegisterResult> {
    const org = String(orgEtsi ?? "").trim();
    if (!SEAL_ORG_RE.test(org.toUpperCase())) throw new ValidationError("registerSealedPdf: orgEtsi нь NTRMN-…");
    const body = buildSealRegisterBody(input);
    const prior = input.priorSignatures ?? [];
    if (input.priorRevisionSha256?.length || prior.length === 0 || prior.length !== input.revIndex - 1) return this.registerBody(org, body);
    try {
      return await this.registerBody(org, body);
    } catch (first) {
      if (!(first instanceof ApiError && first.code === "PRIOR_MISMATCH")) throw first;
      // Аль өмнөх мөр горим A (revision-оор) болохыг файлаас мэдэх аргагүй — registerSignature-тэй ижил хослолууд.
      for (const asRevision of priorSplits(prior.length)) {
        const next: SealRegisterInput = {
          ...input,
          priorSignatures: undefined,
          priorCmsSha256: prior.filter((_, i) => !asRevision[i]).map((p) => p.cmsSha256),
          priorRevisionSha256: prior.filter((_, i) => asRevision[i]).map((p) => p.revisionSha256),
        };
        try {
          return await this.registerBody(org, buildSealRegisterBody(next));
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "PRIOR_MISMATCH")) throw e;
        }
      }
      throw first;
    }
  }

  private async registerBody(org: string, body: Record<string, unknown>): Promise<SealRegisterResult> {
    const { status, body: raw } = await this.http.postWithStatus(routePath(RP_ROUTES.sealRegistrations, org), body, this.registerTimeoutMs ?? 80_000);
    const r = rec(raw);
    return {
      docID: String(r.docID ?? body.docID),
      revIndex: Number(r.revIndex ?? 0),
      registeredAt: typeof r.registeredAt === "string" ? r.registeredAt : "",
      verifyUrl: String(r.verifyUrl ?? ""),
      created: status === 201,
      raw,
    };
  }

  /**
   * `POST /seal/{orgEtsi}` `{digest, hashType: "SHA256", docId, revIndex}` (CA V158) — {@link seal}-тэй ижил, нэмээд QR-тэй
   * тамганы баримтын нөөц: дардасны QR (`/verify/<docId>/<revIndex>`)-ийн байрлалыг өөр гарын үсгийн бүртгэлээс хамгаална
   * (CA: бүртгэгдээгүй нөөц 7 хоног `DOC_ID_CONFLICT` / `DOC_ID_RESERVED`). Зөвхөн SHA-256 (32 байт) digest; docId жижиг
   * UUID, revIndex 1–16 — эс бөгөөс ValidationError (сүлжээгүй; CA 400 REQUEST_INVALID). Бүртгэлийн docID/revIndex нөөцөөс
   * өөр бол `registerSealedPdf` 409 `SEAL_DOC_MISMATCH`. `pades.sealPdf({qr: true})` дуудна.
   */
  async sealForDocument(orgEtsi: string, digest: Uint8Array, docId: string, revIndex: number): Promise<SealResult> {
    if (!SEAL_UUID_RE.test(docId ?? "") || !Number.isInteger(revIndex) || revIndex < 1 || revIndex > 16) {
      throw new ValidationError("sealForDocument: docId жижиг үсгийн UUID, revIndex 1–16");
    }
    const reservation: Record<(typeof SEAL_RESERVATION_FIELDS)[number], string | number> = { docId, revIndex };
    return this.sealDigest(orgEtsi, digest, "SHA-256", reservation);
  }

  /**
   * `GET /seal/certificate/{orgEtsi}` — байгууллагын одоогийн (хамгийн сүүлд олгогдсон, идэвхтэй) тамганы гэрчилгээ
   * (PAdES-ийн signerCert). Шинээр олгохгүй — олголт {@link requestCertificate}. Идэвхтэй гэрчилгээ алга бол 409 (200 биш,
   * CA 2026-11-12): {@link SealNotIssuedError} (олгогдоогүй), {@link SealCertRevokedError} (цуцлагдсан), {@link
   * SealCertExpiredError} / {@link SealCertNotYetValidError} (хугацааны гадна).
   */
  async getCertificate(orgEtsi: string): Promise<SealCertificate> {
    return parseSealCertificate(await this.http.get(routePath(RP_ROUTES.sealCertificate, orgEtsi)), orgEtsi);
  }

  /**
   * `POST /seal/certificate/{orgEtsi}` — тамганы гэрчилгээний ХҮСЭЛТ (202, `status: "PENDING"`). Байгууллагын ADMIN
   * төлөөлөгч(ид) eID аппаараа PIN2-оор батална; {@link waitForCertificate} / {@link getCertificateRequest}-ээр асууна.
   * Байгууллагад PENDING хүсэлт байвал CA түүнийг буцаана (шинэ push үгүй). Алдаа: 409 {@link
   * SealApproverUnavailableError} (идэвхтэй төхөөрөмжтэй ADMIN алга), 409 {@link OrgNotActiveError} (байгууллага ACTIVE биш), 403
   * `ForbiddenError` (`SEAL:<orgEtsi>` эрхгүй), 404 (байгууллага олдсонгүй), 429 `RATE_LIMITED` (байгууллагад 5/цаг;
   * `retryAfterMs`), 503 {@link SealServiceDisabledError} (`service: "issuance"` — оператор гэрчилгээ олголтыг унтраасан;
   * Retry-After-гүй, давтахгүй).
   */
  async requestCertificate(orgEtsi: string): Promise<SealCertificateRequest> {
    return parseSealRequest(await this.http.post(routePath(RP_ROUTES.sealCertificateRequest, orgEtsi), {}), orgEtsi);
  }

  /**
   * `GET /seal/certificate/{orgEtsi}/requests/{requestId}` — хүсэлтийн төлөв; ISSUED үед `certificate` бөглөгдөнө. Олдоогүй
   * (эсвэл өөр байгууллагынх) → {@link SealRequestNotFoundError} 404.
   */
  async getCertificateRequest(orgEtsi: string, requestId: string): Promise<SealCertificateRequest> {
    const raw = await this.http.get(routePath(RP_ROUTES.sealCertificateRequestStatus, orgEtsi, requestId));
    return parseSealRequest(raw, orgEtsi);
  }

  /**
   * Хүсэлт ISSUED болтол `intervalMs` тутамд асууж олгогдсон гэрчилгээг буцаана. REJECTED / EXPIRED / FAILED →
   * {@link SealCertificateRequestError} (`outcome`, `failure`; шинэ хүсэлт хэрэгтэй); `timeoutMs` дуусвал `outcome:
   * "TIMEOUT"` (хүсэлт серверт PENDING хэвээр — ижил `requestId`-аар дахин хүлээж болно). Түр алдаа (`ApiError.retryable`:
   * 429/503 + Retry-After) — Retry-After-ийг хүлээгээд үргэлжилнэ; бусад алдаа шууд шидэгдэнэ ({@link
   * SealServiceDisabledError} ч мөн — давтахгүй). Хүсэлтийг батлах үед олголт унтраалттай байсан бол `FAILED` +
   * `failure: "SEAL_SERVICE_DISABLED"`.
   */
  async waitForCertificate(orgEtsi: string, requestId: string, opts: SealWaitOptions = {}): Promise<SealCertificate> {
    const interval = opts.intervalMs !== undefined && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_SEAL_POLL_INTERVAL_MS;
    const deadline = Date.now() + (opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SEAL_WAIT_TIMEOUT_MS);
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      let wait = interval;
      try {
        const r = await this.getCertificateRequest(orgEtsi, requestId);
        if (r.status === "ISSUED" && r.certificate) return r.certificate;
        if (r.status === "REJECTED" || r.status === "EXPIRED" || r.status === "FAILED") {
          throw new SealCertificateRequestError(r.status, r.requestId, r.failure);
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.retryable)) throw e;
        wait = Math.max(interval, e.retryAfterMs ?? 0);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SealCertificateRequestError("TIMEOUT", requestId);
      await sleep(Math.min(wait, left), opts.signal);
    }
  }

  /**
   * `POST /seal/grants` `{orgEtsi, sessionId}` — тамганы эрх (`SEAL:<orgEtsi>`)-ийг RP өөрөө хүсэх (202, `status:
   * "PENDING"`). `sessionId` — танай RP-ийн эхлүүлсэн, сүүлийн 5 минутад OK-оор дууссан AUTHENTICATION session; түүний хүн
   * байгууллагын улсын бүртгэлээр баталгаажсан Гүйцэтгэх захирал байх ёстой — push зөвхөн түүн рүү очиж PIN2-оор
   * зөвшөөрнө. Нэг session — нэг хүсэлт; ижил session-ээр дахин дуудвал ижил PENDING хүсэлтийг буцаана. SEAL эрх шаардахгүй,
   * биллинг тооцохгүй. Төлөвийг {@link waitForGrant} / {@link grantStatus}-ээр асууна. Алдаа: 400 {@link
   * RequestInvalidError}; 403 `ForbiddenError` (`RP_NOT_REGISTERED` | `NOT_ORG_CEO`); 404 {@link AuthSessionNotFoundError} |
   * `ORG_NOT_FOUND`; 409 {@link AuthSessionWrongFlowError} | {@link AuthSessionNotCompletedError} | {@link
   * AuthSessionTooOldError} | {@link AuthSessionAlreadyUsedError} | {@link OrgNotActiveError} | {@link RpNotActiveError} |
   * {@link SealGrantAlreadyApprovedError} | {@link RpPermissionsFullError} | {@link SealApproverUnavailableError}; 429
   * `RATE_LIMITED` (`retryAfterMs`).
   */
  async requestGrant(orgEtsi: string, sessionId: string): Promise<SealGrantRequest> {
    if (typeof orgEtsi !== "string" || orgEtsi.trim() === "" || orgEtsi.length > 64) throw new ValidationError("seal: orgEtsi хоосон эсвэл 64 тэмдэгтээс урт");
    if (typeof sessionId !== "string" || sessionId.trim() === "" || sessionId.length > 64) throw new ValidationError("seal: sessionId хоосон эсвэл 64 тэмдэгтээс урт");
    const body: Record<(typeof SEAL_GRANT_REQUEST_FIELDS)[number], string> = { orgEtsi: orgEtsi.trim(), sessionId: sessionId.trim() };
    return parseSealGrant(await this.http.post(RP_ROUTES.sealGrantRequest.path, body), body.orgEtsi);
  }

  /**
   * `GET /seal/grants/{grantId}` — хүсэлтийн төлөв. Зөвхөн хүсэлтийн эзэн RP; бусад RP-д / олдоогүй → {@link
   * SealGrantNotFoundError} 404. `APPROVED` нь эрх цуцлагдтал хэвээр (`REVOKED` болтол).
   */
  async grantStatus(grantId: string): Promise<SealGrantRequest> {
    if (typeof grantId !== "string" || grantId === "") throw new ValidationError("seal: grantId хоосон");
    return parseSealGrant(await this.http.get(routePath(RP_ROUTES.sealGrantStatus, grantId)));
  }

  /**
   * Хүсэлт APPROVED болтол `intervalMs` тутамд асууж зөвшөөрсөн хүсэлтийг буцаана. REJECTED / EXPIRED / FAILED / REVOKED →
   * {@link SealGrantRequestError} (`outcome`, `failure`; шинэ хүсэлт хэрэгтэй); `timeoutMs` дуусвал `outcome: "TIMEOUT"`
   * (хүсэлт серверт PENDING хэвээр — ижил `grantId`-аар дахин хүлээж болно). Түр алдаа (`ApiError.retryable`) — Retry-After-ийг
   * хүлээгээд үргэлжилнэ; бусад алдаа шууд шидэгдэнэ. Хүлээх хугацаа, зайн анхдагч нь {@link waitForCertificate}-тэй ижил.
   */
  async waitForGrant(grantId: string, opts: SealWaitOptions = {}): Promise<SealGrantRequest> {
    const interval = opts.intervalMs !== undefined && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_SEAL_POLL_INTERVAL_MS;
    const deadline = Date.now() + (opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SEAL_WAIT_TIMEOUT_MS);
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      let wait = interval;
      try {
        const g = await this.grantStatus(grantId);
        if (g.status === "APPROVED") return g;
        if (g.status === "REJECTED" || g.status === "EXPIRED" || g.status === "FAILED" || g.status === "REVOKED") {
          throw new SealGrantRequestError(g.status, g.grantId, g.failure);
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.retryable)) throw e;
        wait = Math.max(interval, e.retryAfterMs ?? 0);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SealGrantRequestError("TIMEOUT", grantId);
      await sleep(Math.min(wait, left), opts.signal);
    }
  }

  /**
   * `POST /seal/{orgEtsi}` — digest-ийг байгууллагын тамгаар тамгална. `hashAlgorithm`: SHA-256 (анхдагч) | SHA-384 |
   * SHA-512; digest-ийн урт таарахгүй бол сүлжээнд гарахгүй. Хариуны гарын үсгийг хариуны гэрчилгээгээр digest дээр
   * шалгаж, гэрчилгээ e-Seal ({@link isSealCertificate}) эсэхийг тулгана — эс бөгөөс ValidationError. Гинж/цуцлалтыг
   * `sealPdf` (OCSP/CRL) шалгана. Оператор тамгалалтыг унтраасан үед 503 {@link SealServiceDisabledError} (`service:
   * "sealing"`; Retry-After-гүй, давтахгүй). 409: {@link OrgNotActiveError}, {@link SealNotIssuedError}, {@link
   * SealCertRevokedError}, {@link SealKeyUnavailableError}, {@link SealCertExpiredError}, {@link
   * SealCertNotYetValidError}; 403 `ForbiddenError` — RP-д `SEAL:<orgEtsi>` эрхгүй (байгууллага зөвшөөрөөгүй / эрх хасагдсан);
   * 429 `RATE_LIMITED` (RP-д минутад 300; `retryAfterMs`).
   */
  async seal(orgEtsi: string, digest: Uint8Array, hashAlgorithm: HashAlgorithm = "SHA-256"): Promise<SealResult> {
    return this.sealDigest(orgEtsi, digest, hashAlgorithm);
  }

  private async sealDigest(orgEtsi: string, digest: Uint8Array, hashAlgorithm: HashAlgorithm, reservation?: Record<string, string | number>): Promise<SealResult> {
    if (!["SHA-256", "SHA-384", "SHA-512"].includes(hashAlgorithm)) throw new ValidationError(`seal: дэмжигдээгүй hashAlgorithm ${hashAlgorithm}`);
    if (!(digest instanceof Uint8Array) || digest.length !== hashLen(hashAlgorithm)) {
      throw new ValidationError(`seal: digest нь ${hashAlgorithm}-ийн урт (${hashLen(hashAlgorithm)} байт) байх ёстой`);
    }
    const body: Record<(typeof SEAL_REQUEST_FIELDS)[number], string> = {
      digest: Buffer.from(digest).toString("base64"),
      hashType: hashAlgorithm.replace("-", ""),
    };
    const raw = await this.http.post(routePath(RP_ROUTES.seal, orgEtsi), reservation ? { ...body, ...reservation } : body);
    const r = rec(raw);
    const sig = rec(r.signature);
    const cert = rec(r.cert);
    const signature = b64(sig.value, "signature.value");
    const certificate = b64(cert.value, "cert.value");
    let x: X509Certificate;
    try {
      x = new X509Certificate(Buffer.from(certificate));
    } catch (e) {
      const err = new ValidationError("seal: cert задарсангүй");
      (err as { cause?: unknown }).cause = e;
      throw err;
    }
    if (!isSealCertificate(x)) throw new ValidationError("seal: хариуны гэрчилгээ e-Seal биш (KeyUsage)");
    if (x.publicKey.asymmetricKeyType !== "ec" || !verifyPrehashedSignature(Buffer.from(digest), String(sig.value), x.publicKey, "ecdsa-with-SHA256", hashAlgorithm)) {
      throw new ValidationError("seal: гарын үсэг digest-тэй таарсангүй");
    }
    return {
      orgEtsi: String(r.orgEtsi ?? orgEtsi),
      signature,
      signatureAlgorithm: String(sig.signatureAlgorithm ?? ""),
      certificate,
      certificateLevel: String(cert.certificateLevel ?? ""),
      sealedAt: String(r.sealedAt ?? ""),
      raw,
    };
  }
}
