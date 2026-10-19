// EidClient — SDK-ийн гол үүд. Бүх flow-г нэг газар цуглуулна:
//   client.auth      — нэвтрэлт эхлүүлэх (push/QR)
//   client.sign      — гарын үсэг эхлүүлэх (digest; push / device link), гэрчилгээ сонгуулах (certificate-choice) ба
//                      клиент талын PAdES-ийн DTBS (sign.pdfDigest / signPdfDigest, registerSignature)
//   client.organization — иргэний төлөөлөх байгууллагууд
//   client.person    — иргэний PKI самбар (PKI_READ): гэрчилгээ, төхөөрөмж, үйл ажиллагаа, тоо, хүүхдүүд
//   client.token     — USB токены гэрчилгээ олголт (TOKEN_ISSUE) ба токеноор нэвтрэлт (AUTH)
//   client.share()   — гарын үсэгтэй файлыг имэйлээр дамжуулах (SIGN; `shareInfo()` — discovery-ийн туг, хязгаар)
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
import {
  SignApi,
  type PdfDigestInput,
  type PdfDigestSession,
  type RegisterSignatureInput,
  type RegisterSignatureResult,
} from "./sign.js";
import { SessionApi } from "./session.js";
import { OrganizationApi } from "./organization.js";
import { PersonApi } from "./person.js";
import { TokenApi } from "./token.js";
import { shareFile, shareInfo, type ShareInfo, type ShareInput, type ShareResult } from "./share.js";
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
  /**
   * `registerSignature` (`POST /pdf/signatures`)-ийн хугацаа (мс). Анхдагч {@link DEFAULT_PDF_TIMEOUT_MS} (80 с — CA CMS +
   * TSA + LTV-г шалгадаг; nginx proxy_read_timeout-оос бага; Go SDK `Config.PDFTimeout`-тэй ижил). 0.18.x-д ердийн 15 с.
   */
  pdfTimeoutMs?: number;
  /** undici Dispatcher (mTLS client cert). */
  dispatcher?: unknown;
  /** fetch орлуулагч (тест). */
  fetchImpl?: typeof fetch;
  /**
   * Хүнд харуулах текстийн хэл (`roleLabel` г.м.) — дуудлага бүрд `Accept-Language` болж илгээгдэнэ (`"mn"` | `"en"`).
   * Анхдагч: илгээхгүй (сервер mn).
   */
  language?: string;
  /**
   * Sign / certificate-choice session-ий `expiresAt`-ийг тооцоолох хугацаа (мс). Анхдагч 600000
   * ({@link DEFAULT_SIGN_SESSION_TTL_MS}, CA-ийн анхдагч); CA-ийн админ тохиргоог өөрчилсөн бол тааруул. CA session start
   * хариунд хугацаа буцаадаггүй.
   */
  signSessionTtlMs?: number;
  /** Trust anchor (Root CA) — validator-д. Production-д ЗААВАЛ. */
  trust?: TrustConfig;
}

/** RP-API-ийн албан ёсны хост (2026-09-28-наас бүх RP, /v3-гүй). */
export const DEFAULT_BASE_URL = "https://rp.eidmongolia.mn";

/** `registerSignature`-ийн анхдагч хугацаа (мс) — Go SDK `DefaultPDFTimeout` (80s)-тэй ижил. */
export const DEFAULT_PDF_TIMEOUT_MS = 80_000;

// Хуучин (0.2.x) хэлбэр: ca. хост руу /v3 залгадаг байсан. ca. дээр RP-API /v3-гүй байхгүй тул чимээгүй 404-ийн
// оронд тодорхой алдаа.
const LEGACY_HOSTS = new Set(["ca.eidmongolia.mn", "e-id.mn", "www.e-id.mn"]);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** baseUrl-ийг шалгаж (https; http зөвхөн localhost / 127.0.0.1 / [::1]), төгсгөлийн "/"-ийг хасна. */
export function resolveBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`EidClient: baseUrl буруу URL: ${raw}`);
  }
  // RP secret (Bearer) ба иргэний мэдээлэл явна — зөвхөн https; http нь зөвхөн loopback (локал тест / mock).
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error(`EidClient: baseUrl https байх ёстой (http зөвхөн localhost): ${u.protocol}//${u.host}`);
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
  readonly organization: OrganizationApi;
  readonly person: PersonApi;
  readonly token: TokenApi;
  readonly session: SessionApi;
  readonly validator: ResponseValidator;
  /** `credentials.rpName` — иргэний утсанд харагдах RP нэр. */
  readonly rpName: string;
  private readonly http: Http;

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
    this.sign = new SignApi(http, cfg.credentials, { certificateLevel: level, sessionTtlMs: cfg.signSessionTtlMs, pdfTimeoutMs: cfg.pdfTimeoutMs });
    this.organization = new OrganizationApi(http);
    this.person = new PersonApi(http);
    this.validator = new ResponseValidator(cfg.trust ?? {});
    this.token = new TokenApi(http, cfg.credentials, this.validator);
    this.session = new SessionApi(http);
    this.rpName = cfg.credentials.rpName;
    this.http = http;
  }

  /** {@link SignApi.pdfDigest} — клиент талын PAdES-ийн DTBS-д гарын үсгийн session (PDF CA руу очихгүй). */
  signPdfDigest(input: PdfDigestInput): Promise<PdfDigestSession> {
    return this.sign.pdfDigest(input);
  }

  /** {@link SignApi.registerSignature} — `pades.complete()`-ийн CMS-ийг CA-д бүртгэнэ (`POST /pdf/signatures`). */
  registerSignature(input: RegisterSignatureInput): Promise<RegisterSignatureResult> {
    return this.sign.registerSignature(input);
  }

  /**
   * `POST /share` (SIGN эрх) — гарын үсэгтэй файлыг (PDF, eID-ийн хүчинтэй гарын үсэгтэй) 1–5 хүлээн авагч руу
   * имэйлээр, хавсралтаар илгээнэ; CA файлыг хадгалахгүй. Алдаа: `ShareError` (`code`, 422-д `reason`, 502-д
   * `sent`/`failed`/`recipients`), 401 AuthenticationError, 403 ForbiddenError. CA-ийн туг унтраалттай бол 503
   * SHARE_DISABLED — {@link shareInfo}-оор урьдчилан шалга.
   */
  share(input: ShareInput): Promise<ShareResult> {
    return shareFile(this.http, input);
  }

  /** Discovery (`/.well-known/eid`)-ийн `share` блок: `enabled`, формат, хязгаар, квот. */
  shareInfo(): Promise<ShareInfo> {
    return shareInfo(this.http);
  }
}
