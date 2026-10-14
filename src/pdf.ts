// PAdES гарын үсэг (CA угсарна) — RP эх PDF-ээ илгээж, иргэн PIN2-оор зурсны дараа CA PAdES-BASELINE-LT
// гарын үсэгтэй PDF-ийг буцаана. Урсгал: prepare → session poll (`pdf.documentStatus=READY`) → document.
// `onBehalfOf` (`NTRMN-…`) өгвөл байгууллагын нэрийн өмнөөс: хувь хүний квалификацтай гарын үсэг + eID-ийн
// бүртгэлээр шалгасан төлөөлөл (CMS signer-attributes-v2 мэдүүлсэн үүрэг, /Reason «<нэр>-ийг төлөөлж»).

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { RP_ROUTES, routePath } from "./contract.js";
import type { Http } from "./http.js";
import type { CertificateLevel, PdfSessionBlock, RpCredentials } from "./types.js";

export interface PdfDefaults {
  certificateLevel: CertificateLevel;
  /** prepare / document дуудлагын хугацаа (мс); анхдагч {@link DEFAULT_PDF_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * PAdES prepare / баримт татах нэг дуудлагын анхдагч хугацаа (мс). CA prepare нь ≤ 10 MiB уншиж, өмнөх гарын үсэг +
 * LTV өгөгдөл шалгаад push эхлүүлдэг; баримт татахад угсралтыг ≤ 30с хүлээдэг (PADES_SIGNING §3.4). 80с нь хоёуланд
 * хүрэлцэнэ, CA-ийн nginx proxy_read_timeout-оос бага.
 */
export const DEFAULT_PDF_TIMEOUT_MS = 80_000;

/** Гарын үсэг зурагч — яг нэг нь. */
export type PdfSignerRef =
  | { etsi: string }
  | { documentNumber: string }
  | { certificateChoiceSessionId: string };

export interface PdfPrepareInput {
  /** Эх PDF (≤ 10 223 616 байт — `/.well-known/eid` `pdfSigning.maxInputBytes`). */
  pdf: Uint8Array;
  /** Баримтын нэр (≤ 120 тэмдэгт) — /verify хуудас, иргэний түүхэнд харагдана. */
  fileName: string;
  signer: PdfSignerRef;
  /** `notification` (push) эсвэл `device-link` (QR/Web2App/App2App). Анхдагч notification. */
  flow?: "notification" | "device-link";
  certificateLevel?: CertificateLevel;
  /** device-link Web2App/App2App буцах URL. */
  initialCallbackUrl?: string;
  /** Олон гарын үсэгтэй баримтад хүлээж буй docID (заавал биш — CA өөрөө олно). */
  docID?: string;
  /**
   * Байгууллагын нэрийн өмнөөс: байгууллагын ETSI (`NTRMN-<бүртгэл>`). Сервер төлөөллийг prepare-д ба баримт
   * угсрахын өмнө дахин шалгана; татгалзвал `ForbiddenError`/`ApiError` `.code` ({@link OnBehalfErrorCode}).
   */
  onBehalfOf?: string;
}

/** prepare-ийн хариу. device-link-д `deviceLink` (digest/interactions-ийг authCode-д ЯГ ХЭВЭЭР). */
export interface PdfPrepareSession {
  sessionId: string;
  docId: string;
  /** Иргэнд ХАРУУЛАХ баталгаажуулах код (ПИН биш). */
  vc: string | null;
  /**
   * Иргэний зурах DTBS (base64, SHA-256 = 32 байт) — урсгалаас үл хамааран. Хариуны гарын үсгийг өөрөө шалгахад:
   * `validator.validateSign(result, digest)`. Хуучин CA push хариунд талбаргүй → undefined (device-link-д
   * `deviceLink.digest`-ээс).
   */
  digest?: string;
  deviceLink: {
    sessionToken: string;
    sessionSecret: string;
    deviceLinkBase: string;
    digest: string;
    interactions: string;
  } | null;
  /** SDK хариу хүлээн авсан мөч (ms epoch) — QR-ийн `receivedAt` ({@link buildDeviceLink}). */
  receivedAt: number;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export class PdfApi {
  constructor(
    private readonly http: Http,
    private readonly creds: RpCredentials,
    private readonly defaults: PdfDefaults,
  ) {}

  /**
   * POST /pdf/sign/prepare — multipart (`request` JSON + `pdf`). SIGN эрх шаардана. Түр алдаа: `ApiError` 429
   * PDF_PREPARE_BUSY, 503 LTV_UNAVAILABLE / TSA_UNAVAILABLE — `retryAfterMs`-ийн дараа дахин (`retryable`).
   */
  async prepare(input: PdfPrepareInput): Promise<PdfPrepareSession> {
    const request: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: this.creds.rpName,
      certificateLevel: input.certificateLevel ?? this.defaults.certificateLevel,
      signer: input.signer,
      flow: input.flow ?? "notification",
      fileName: input.fileName,
    };
    if (input.initialCallbackUrl?.trim()) request.initialCallbackUrl = input.initialCallbackUrl.trim();
    if (input.docID?.trim()) request.docID = input.docID.trim();
    if (input.onBehalfOf?.trim()) request.onBehalfOf = input.onBehalfOf.trim();

    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("pdf", new Blob([input.pdf], { type: "application/pdf" }), input.fileName);

    const r = rec(await this.http.postMultipart(routePath(RP_ROUTES.pdfPrepare), form, this.defaults.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS));
    const receivedAt = Date.now();
    const vc = rec(r.vc).value;
    const dl = rec(r.deviceLink);
    const digest = typeof r.digest === "string" && r.digest ? r.digest : typeof dl.digest === "string" && dl.digest ? dl.digest : undefined;
    return {
      sessionId: String(r.sessionID),
      docId: String(r.docID),
      vc: vc != null ? String(vc) : null,
      ...(digest !== undefined ? { digest } : {}),
      deviceLink: dl.sessionToken
        ? {
            sessionToken: String(dl.sessionToken),
            sessionSecret: String(dl.sessionSecret),
            deviceLinkBase: String(dl.deviceLinkBase),
            digest: String(dl.digest),
            interactions: String(dl.interactions),
          }
        : null,
      receivedAt,
    };
  }

  /**
   * GET /pdf/sign/{sessionID}/document — гарын үсэгтэй PDF (READY-ээс хойш 30 мин). Татсан байтын SHA-256-ийг
   * session-ий `pdf.outSha256`-тай тулга. Эрх хасагдсан бол `ForbiddenError` `.code = "REPRESENTATION_REVOKED"`. Баримт
   * бэлэн болоогүй бол `ApiError` 503 `.code` DOCUMENT_PENDING / TSA_UNAVAILABLE / LTV_UNAVAILABLE — `retryAfterMs`-ийн
   * дараа дахин татна (`retryable`).
   */
  document(sessionId: string): Promise<Uint8Array> {
    return this.http.getBytes(routePath(RP_ROUTES.pdfDocument, sessionId), this.defaults.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS);
  }

  /**
   * {@link document} + тулгалт: татсан байтын SHA-256 нь session poll-ийн `pdf.outSha256`-тай тэнцүү байх ёстой.
   * `expected` — poll-ийн `result.pdf` блок (`documentStatus` READY + `outSha256` заавал) эсвэл SHA-256 hex.
   *
   * @throws {ValidationError} блок READY биш / `outSha256` алга / hash таарахгүй (файлд бүү итгэ).
   */
  async documentVerified(sessionId: string, expected: PdfSessionBlock | string): Promise<Uint8Array> {
    let want: string | undefined;
    if (typeof expected === "string") {
      want = expected;
    } else {
      if (expected.documentStatus !== "READY") throw new ValidationError(`pdf.documentStatus ${expected.documentStatus} ≠ READY`);
      want = expected.outSha256;
    }
    if (!want || !/^[0-9a-fA-F]{64}$/.test(want)) throw new ValidationError("pdf.outSha256 алга эсвэл SHA-256 hex биш");
    const bytes = await this.document(sessionId);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want.toLowerCase()) throw new ValidationError("Татсан PDF-ийн SHA-256 нь pdf.outSha256-тай таарсангүй");
    return bytes;
  }
}
