// EidClient — SDK-ийн гол үүд. Бүх flow-г нэг газар цуглуулна:
//   client.auth      — нэвтрэлт эхлүүлэх (push/QR)
//   client.sign      — гарын үсэг эхлүүлэх (digest)
//   client.session   — үр дүн poll хийх (long-poll)
//   client.validator — хариуг крипто-баталгаажуулах (cert chain + signature)
//
// Жишээ (push нэвтрэлт):
//   const eid = new EidClient({ baseUrl: "https://ca.eidmongolia.mn",
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
import { ResponseValidator, type TrustConfig } from "./validator.js";
import type { CertificateLevel, RpCredentials } from "./types.js";

export interface ClientConfig {
  /** RP-API суурь URL (/v3-гүйгээр — SDK нэмнэ). Ж: https://ca.eidmongolia.mn */
  baseUrl: string;
  /** RP таних мэдээлэл + API secret. */
  credentials: RpCredentials;
  /** Default certLevel (auth/sign бүрд). Default QUALIFIED. */
  defaultCertificateLevel?: CertificateLevel;
  /** HTTP timeout (мс). */
  timeoutMs?: number;
  /** undici Dispatcher (mTLS client cert). */
  dispatcher?: unknown;
  /** fetch орлуулагч (тест). */
  fetchImpl?: typeof fetch;
  /** Trust anchor (Root CA) — validator-д. Production-д ЗААВАЛ. */
  trust?: TrustConfig;
}

export class EidClient {
  readonly auth: AuthApi;
  readonly sign: SignApi;
  readonly session: SessionApi;
  readonly validator: ResponseValidator;

  constructor(cfg: ClientConfig) {
    if (!cfg.baseUrl) throw new Error("EidClient: baseUrl шаардлагатай");
    if (!cfg.credentials?.apiSecret) throw new Error("EidClient: credentials.apiSecret шаардлагатай");

    const base = cfg.baseUrl.replace(/\/+$/, "") + "/v3";
    const http = new Http({
      baseUrl: base,
      apiSecret: cfg.credentials.apiSecret,
      timeoutMs: cfg.timeoutMs,
      dispatcher: cfg.dispatcher,
      fetchImpl: cfg.fetchImpl,
    });
    const level: CertificateLevel = cfg.defaultCertificateLevel ?? "QUALIFIED";

    this.auth = new AuthApi(http, cfg.credentials, { certificateLevel: level });
    this.sign = new SignApi(http, cfg.credentials, { certificateLevel: level });
    this.session = new SessionApi(http);
    this.validator = new ResponseValidator(cfg.trust ?? {});
  }
}
