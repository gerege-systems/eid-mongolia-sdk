// PAdES гарын үсэг (CA угсарна) — RP эх PDF-ээ илгээж, иргэн PIN2-оор зурсны дараа CA PAdES-BASELINE-LT
// гарын үсэгтэй PDF-ийг буцаана. Урсгал: prepare → session poll (`pdf.documentStatus=READY`) → document.
// `onBehalfOf` (`NTRMN-…`) өгвөл байгууллагын нэрийн өмнөөс: хувь хүний квалификацтай гарын үсэг + eID-ийн
// бүртгэлээр шалгасан төлөөлөл (CMS signer-attributes-v2 мэдүүлсэн үүрэг, /Reason «<нэр>-ийг төлөөлж»).

import type { Http } from "./http.js";
import type { CertificateLevel, RpCredentials } from "./types.js";

export interface PdfDefaults {
  certificateLevel: CertificateLevel;
}

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

  /** POST /pdf/sign/prepare — multipart (`request` JSON + `pdf`). SIGN эрх шаардана. */
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

    const r = rec(await this.http.postMultipart("/pdf/sign/prepare", form, 60_000));
    const receivedAt = Date.now();
    const vc = rec(r.vc).value;
    const dl = rec(r.deviceLink);
    return {
      sessionId: String(r.sessionID),
      docId: String(r.docID),
      vc: vc != null ? String(vc) : null,
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
   * session-ий `pdf.outSha256`-тай тулга. Эрх хасагдсан бол `ForbiddenError` `.code = "REPRESENTATION_REVOKED"`.
   */
  document(sessionId: string): Promise<Uint8Array> {
    return this.http.getBytes(`/pdf/sign/${encodeURIComponent(sessionId)}/document`, 60_000);
  }
}
