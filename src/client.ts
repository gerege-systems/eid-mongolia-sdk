// EidClient — SDK-ийн гол үүд. Бүх flow-г нэг газар цуглуулна:
//   client.auth      — нэвтрэлт эхлүүлэх (push/QR)
//   client.sign      — гарын үсэг эхлүүлэх (digest)
//   client.pdf       — PDF гарын үсэг (PAdES, CA угсарна; onBehalfOf)
//   client.organization — иргэний төлөөлөх байгууллагууд
//   client.person    — иргэний PKI самбар (PKI_READ): гэрчилгээ, төхөөрөмж, үйл ажиллагаа, тоо, хүүхдүүд
//   client.token     — USB токены гэрчилгээ олголт (TOKEN_ISSUE) ба токеноор нэвтрэлт (AUTH)
//   client.session   — үр дүн poll хийх (long-poll)
//   client.validator — хариуг крипто-баталгаажуулах (cert chain + signature)
//
// Жишээ (push нэвтрэлт):
//   const eid = new EidClient({   // baseUrl анхдагч https://rp.eidmongolia.mn
//     credentials: { rpUUID, rpName: "Хаан Банк", apiSecret: process.env.EID_SECRET! },
//     trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] } });
//   const s = await eid.auth.notificationByEtsi("PNOMN-12345678",
//     [{ type: "displayTextAndPIN", displayText60: "Хаан Банк-д нэвтрэх" }]);
//   showVc(s.vc);                                   // иргэнд VC код ХАРУУЛ (оруулуулахгүй — ПИН биш)
//   const r = await eid.session.waitForResult(s.sessionId);
//   const who = eid.validator.validateAuth(r, s.acsp);          // ← гинж + ACSP_V2 баталгаажсан иргэн
//   console.log(who.documentNumber, who.subject);

import { Http } from "./http.js";
import { AuthApi } from "./auth.js";
import { SignApi } from "./sign.js";
import { SessionApi } from "./session.js";
import { PdfApi, DEFAULT_PDF_MAX_BYTES, DEFAULT_PDF_TIMEOUT_MS } from "./pdf.js";
import { OrganizationApi } from "./organization.js";
import { PersonApi } from "./person.js";
import { TokenApi } from "./token.js";
import { ResponseValidator, type TrustConfig } from "./validator.js";
import type { CertificateLevel, RpCredentials } from "./types.js";

export interface ClientConfig {
  /**
   * RP-API-ийн БҮТЭН суурь URL — SDK зам залгахаас өөр юу ч нэмэхгүй (0.3.0-аас /v3 залгахгүй).
   * Анхдагч: {@link DEFAULT_BASE_URL} (`https://rp.eidmongolia.mn`). mTLS-тэй RP ч мөн энэ хост.
   */
  baseUrl?: string;
  /** RP таних мэдээлэл + API secret. */
  credentials: RpCredentials;
  /** Default certLevel (auth/sign бүрд). Default QUALIFIED. */
  defaultCertificateLevel?: CertificateLevel;
  /** HTTP timeout (мс). */
  timeoutMs?: number;
  /** PAdES prepare / баримт татах дуудлагын хугацаа (мс). Анхдагч 80000 ({@link DEFAULT_PDF_TIMEOUT_MS}). */
  pdfTimeoutMs?: number;
  /**
   * `pdf.document` / `pdf.tokenDocument`-ийн санах ойд унших дээд хэмжээ (байт). Анхдагч 64 MiB
   * ({@link DEFAULT_PDF_MAX_BYTES}); хэтэрвэл `ResponseTooLargeError`.
   */
  pdfMaxBytes?: number;
  /** undici Dispatcher (mTLS client cert). */
  dispatcher?: unknown;
  /** fetch орлуулагч (тест). */
  fetchImpl?: typeof fetch;
  /**
   * Хүнд харуулах текстийн хэл (`roleLabel` г.м.) — дуудлага бүрд `Accept-Language` болж илгээгдэнэ (`"mn"` | `"en"`).
   * Анхдагч: илгээхгүй (сервер mn).
   */
  language?: string;
  /** Trust anchor (Root CA) — validator-д. Production-д ЗААВАЛ. */
  trust?: TrustConfig;
}

/** RP-API-ийн албан ёсны хост (2026-09-28-наас бүх RP, /v3-гүй). */
export const DEFAULT_BASE_URL = "https://rp.eidmongolia.mn";

// Хуучин (0.2.x) хэлбэр: ca. хост руу /v3 залгадаг байсан. ca. дээр RP-API /v3-гүй байхгүй тул чимээгүй 404-ийн
// оронд тодорхой алдаа.
const LEGACY_HOSTS = new Set(["ca.eidmongolia.mn", "e-id.mn", "www.e-id.mn"]);

/** baseUrl-ийг шалгаж, төгсгөлийн "/"-ийг хасна. */
export function resolveBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`EidClient: baseUrl буруу URL: ${raw}`);
  }
  if (LEGACY_HOSTS.has(u.hostname) && (u.pathname === "" || u.pathname === "/")) {
    throw new Error(
      `EidClient: RP-API ${u.hostname}-аас ${DEFAULT_BASE_URL} руу шилжсэн (/v3-гүй) — baseUrl-ийг ${DEFAULT_BASE_URL} болгоно уу (эсвэл хоосон орхи).`,
    );
  }
  return raw;
}

export class EidClient {
  readonly auth: AuthApi;
  readonly sign: SignApi;
  readonly pdf: PdfApi;
  readonly organization: OrganizationApi;
  readonly person: PersonApi;
  readonly token: TokenApi;
  readonly session: SessionApi;
  readonly validator: ResponseValidator;

  constructor(cfg: ClientConfig) {
    if (!cfg.credentials?.apiSecret) throw new Error("EidClient: credentials.apiSecret шаардлагатай");

    const base = resolveBaseUrl(cfg.baseUrl);
    const http = new Http({
      baseUrl: base,
      apiSecret: cfg.credentials.apiSecret,
      timeoutMs: cfg.timeoutMs,
      dispatcher: cfg.dispatcher,
      fetchImpl: cfg.fetchImpl,
      language: cfg.language?.trim() || undefined,
    });
    const level: CertificateLevel = cfg.defaultCertificateLevel ?? "QUALIFIED";

    this.auth = new AuthApi(http, cfg.credentials, { certificateLevel: level });
    this.sign = new SignApi(http, cfg.credentials, { certificateLevel: level });
    this.pdf = new PdfApi(http, cfg.credentials, {
      certificateLevel: level,
      timeoutMs: cfg.pdfTimeoutMs ?? DEFAULT_PDF_TIMEOUT_MS,
      maxBytes: cfg.pdfMaxBytes && cfg.pdfMaxBytes > 0 ? cfg.pdfMaxBytes : DEFAULT_PDF_MAX_BYTES,
    });
    this.organization = new OrganizationApi(http);
    this.person = new PersonApi(http);
    this.token = new TokenApi(http, cfg.credentials);
    this.session = new SessionApi(http);
    this.validator = new ResponseValidator(cfg.trust ?? {});
  }
}
