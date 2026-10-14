// PAdES гарын үсэг (CA угсарна) — RP эх PDF-ээ илгээж, иргэн PIN2-оор зурсны дараа CA PAdES-BASELINE-LT
// гарын үсэгтэй PDF-ийг буцаана. Урсгал: prepare → session poll (`pdf.documentStatus=READY`) → document.
// `onBehalfOf` (`NTRMN-…`) өгвөл байгууллагын нэрийн өмнөөс: хувь хүний квалификацтай гарын үсэг + eID-ийн
// бүртгэлээр шалгасан төлөөлөл (CMS signer-attributes-v2 мэдүүлсэн үүрэг, /Reason «<нэр>-ийг төлөөлж»).

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { RP_ROUTES, RP_ROUTES_UNDISCOVERED, routePath } from "./contract.js";
import type { Http } from "./http.js";
import type { CertificateLevel, PdfSessionBlock, RpCredentials } from "./types.js";

export interface PdfDefaults {
  certificateLevel: CertificateLevel;
  /** prepare / document дуудлагын хугацаа (мс); анхдагч {@link DEFAULT_PDF_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** document / tokenDocument-ийн санах ойд унших дээд хэмжээ (байт); анхдагч {@link DEFAULT_PDF_MAX_BYTES}. */
  maxBytes?: number;
}

/** Гарын үсэгтэй PDF татахад санах ойд уншиж болох анхдагч дээд хэмжээ (64 MiB) — `ClientConfig.pdfMaxBytes`. */
export const DEFAULT_PDF_MAX_BYTES = 64 << 20;

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

/** USB токены PAdES — POST /pdf/token/prepare-ийн оролт. */
export interface PdfTokenPrepareInput {
  /** Эх PDF (≤ 10 223 616 байт). */
  pdf: Uint8Array;
  /** Баримтын нэр (≤ 120 тэмдэгт, заавал). */
  fileName: string;
  /** Иргэний ETSI (`PNOMN-…`) — токены гэрчилгээний SERIALNUMBER-тэй таарна. */
  signerEtsi: string;
  /** Токены SIGN гэрчилгээ (DER): eID Mongolia Issuing CA-аас, ACTIVE токенд холбогдсон. */
  certificate: Uint8Array;
  /** Олон гарын үсэгтэй баримтын docID (заавал биш, UUID). */
  docID?: string;
  /** Байгууллагын токенд ЗААВАЛ тухайн байгууллага (`NTRMN-…`); хувийн токенд хоосон. Зөрвөл 403 TOKEN_ORG_MISMATCH. */
  onBehalfOf?: string;
}

/** POST /pdf/token/prepare-ийн хариу. */
export interface PdfTokenPrepareSession {
  signingId: string;
  docId: string;
  /** Токеноор зурах 32 байт (SHA-256 DTBS): CKM_ECDSA (prehashed) → түүхий r||s (64 байт). */
  hashToSign: Uint8Array;
  hashAlgorithm: string;
  signatureAlgorithm: string;
  /** "RAW_RS". */
  signatureFormat: string;
  /** tokenFinalize-ийн эцсийн хугацаа (prepare-ээс 10 мин), ISO-8601. */
  expiresAt: string;
  raw: unknown;
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

    const r = rec(await this.http.postMultipart(routePath(RP_ROUTES.pdfPrepare), form, this.timeout));
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
    return this.http.getBytes(routePath(RP_ROUTES.pdfDocument, sessionId), this.timeout, this.maxBytes);
  }

  private get timeout(): number {
    return this.defaults.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS;
  }

  private get maxBytes(): number {
    return this.defaults.maxBytes ?? DEFAULT_PDF_MAX_BYTES;
  }

  /**
   * USB токены PAdES (CA docs/PADES_SIGNING.md §16.5, TOKEN_CERT.md) — session / утас оролцохгүй. POST /pdf/token/prepare
   * (multipart: `request` JSON + `pdf`), SIGN эрх. Дараа нь токеноор `hashToSign`-ийг CKM_ECDSA (prehashed, P-256)-аар
   * зурж {@link tokenFinalize}. Түр алдаа: `ApiError` 429 PDF_PREPARE_BUSY / RATE_LIMITED, 503 TSA_UNAVAILABLE /
   * LTV_UNAVAILABLE / STATE_UNAVAILABLE (`retryable`). Гэрчилгээ токенд холбогдоогүй / цуцлагдсан → 409
   * TOKEN_CERT_INVALID. Зам нь CA-д бий ч `/.well-known/eid`-д хараахан алга (гэрээний тест WARN).
   */
  async tokenPrepare(input: PdfTokenPrepareInput): Promise<PdfTokenPrepareSession> {
    if (!input.pdf?.length || !input.certificate?.length || !input.signerEtsi?.trim() || !input.fileName?.trim()) {
      throw new Error("eid: pdf token: pdf, certificate, signerEtsi, fileName шаардлагатай");
    }
    const request: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: this.creds.rpName,
      signer: { etsi: input.signerEtsi.trim() },
      certificate: Buffer.from(input.certificate).toString("base64"),
      fileName: input.fileName,
    };
    if (input.docID?.trim()) request.docID = input.docID.trim();
    if (input.onBehalfOf?.trim()) request.onBehalfOf = input.onBehalfOf.trim();
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("pdf", new Blob([input.pdf], { type: "application/pdf" }), input.fileName);
    const raw = await this.http.postMultipart(routePath(RP_ROUTES_UNDISCOVERED.pdfTokenPrepare), form, this.timeout);
    const r = rec(raw);
    const hashToSign = new Uint8Array(Buffer.from(String(r.hashToSign ?? ""), "base64"));
    if (!r.signingID || hashToSign.length !== 32) {
      throw new ValidationError("pdf token prepare: signingID / hashToSign (32 байт) буруу");
    }
    return {
      signingId: String(r.signingID),
      docId: String(r.docID ?? ""),
      hashToSign,
      hashAlgorithm: String(r.hashAlgorithm ?? ""),
      signatureAlgorithm: String(r.signatureAlgorithm ?? ""),
      signatureFormat: String(r.signatureFormat ?? ""),
      expiresAt: String(r.expiresAt ?? ""),
      raw,
    };
  }

  /**
   * POST /pdf/token/{signingID}/finalize `{signature: base64 түүхий r||s}` — `signature` 64 байт (P-256 r||s, DER БИШ).
   * Амжвал READY баримтын блок (`outSha256` — {@link tokenDocument}-оор татсан файлтай тулга). READY-ээс хойш идэмпотент.
   * Алдаа: 400 SIGNATURE_INVALID (3 удаа → FAILED), 409 DOCUMENT_FAILED, 410 DOCUMENT_EXPIRED, 503 DOCUMENT_PENDING /
   * TSA_UNAVAILABLE / LTV_UNAVAILABLE — ижил гарын үсгийг `retryAfterMs`-ийн дараа дахин илгээнэ.
   */
  async tokenFinalize(signingId: string, signature: Uint8Array): Promise<PdfSessionBlock> {
    if (signature?.length !== 64) throw new Error("eid: pdf token: signature нь түүхий r||s 64 байт байх ёстой (P-256, DER биш)");
    const r = await this.http.post(
      routePath(RP_ROUTES_UNDISCOVERED.pdfTokenFinalize, signingId),
      { signature: Buffer.from(signature).toString("base64") },
      this.timeout,
    );
    return r as PdfSessionBlock;
  }

  /**
   * GET /pdf/token/{signingID}/document — гарын үсэгтэй PDF (зөвхөн үүсгэсэн RP, expiresAt хүртэл), `pdfMaxBytes`
   * хүртэл. SHA-256-ийг {@link tokenFinalize}-ийн `outSha256`-тай заавал тулга.
   */
  tokenDocument(signingId: string): Promise<Uint8Array> {
    return this.http.getBytes(routePath(RP_ROUTES_UNDISCOVERED.pdfTokenDocument, signingId), this.timeout, this.maxBytes);
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
