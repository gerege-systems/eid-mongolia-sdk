// Authentication flow — иргэнийг нэвтрүүлэх (PIN1, identity proof). Push (notification) ба
// QR/App2App (device-link) хоёр горим. Бүгд rpChallenge үүсгэж, хариуны ACSP_V2 signature-ийг
// үүний эсрэг ResponseValidator-аар шалгана (replay/forgery хамгаалалт).

import { RP_ROUTES, routePath } from "./contract.js";
import type { Http } from "./http.js";
import { interactionsToBase64, randomChallenge } from "./crypto.js";
import { parseExpiresAt } from "./types.js";
import type {
  AcspContext,
  CertificateLevel,
  DeviceLinkSession,
  FlowType,
  HashAlgorithm,
  Interaction,
  NotificationSession,
  RpCredentials,
  SignatureAlgorithm,
} from "./types.js";

export interface AuthDefaults {
  certificateLevel: CertificateLevel;
}

export interface AuthOptions {
  /** Энэ session-д certLevel-ийг дарж бичих (default — client-ийн тохиргоо). */
  certificateLevel?: CertificateLevel;
  /**
   * Same-device App2App буцах URL (notification). Өгвөл initialCallbackUrl-аар илгээнэ.
   *
   * Query-д буцах browser-ийн hint нэмэхийг ЗӨВЛӨНӨ (`?retScheme=` iOS / `?retPkg=` Android) —
   * эс бөгөөс апп системийн default browser-оор буцаж, иргэн эхэлсэн цонхоо алддаг.
   * Жагсаалт: docs/RP_GEREGE_INTEGRATION.md §1.1b.
   */
  callbackUrl?: string;
  /**
   * Байгууллагаар нэвтрэх (docs/ORG_LOGIN.md) — байгууллагын ETSI (`NTRMN-<register>`).
   * Иргэн тухайн байгууллагыг ТӨЛӨӨЛӨН нэвтэрнэ: сервер төлөөллийн эрхийг шалгаж
   * (эрхгүй бол 403), утсанд байгууллагын нэрийг харуулж, дууссан session-ий хариунд
   * `onBehalfOf` блок (orgEtsi/orgName/role/rightType) буцаана.
   *
   * (!) Байгууллага нь ГАРЫН ҮСЭГ ЗУРАГДАХ өгөгдөлд (ACSP_V2) ОРОХГҮЙ — холбоос нь
   * серверийн баталгаа. RP энэ талбарыг өөрөө шалгаж болохгүй, session хариунаас уншина.
   */
  onBehalfOf?: string;
  /** Гарын үсгийн алгоритм (default rsassa-pss). */
  signatureAlgorithm?: SignatureAlgorithm;
  /** ACSP_V2 payload-ийн hash (default SHA-512 — Smart-ID v3 жишээтэй ижил). */
  hashAlgorithm?: HashAlgorithm;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Discovery-ийн `sessionTtl` (мс). 0 = хуучин CA. */
export interface SessionTtl {
  authMs: number;
  signMs: number;
}

export class AuthApi {
  constructor(
    private readonly http: Http,
    private readonly creds: RpCredentials,
    private readonly defaults: AuthDefaults,
  ) {}

  /** v3 nested body + validator-т хэрэгтэй контекст (ижил утгуудаас — байт зөрөхгүй). */
  private baseBody(
    rpChallenge: string,
    interactions: Interaction[],
    flows: FlowType[],
    opts?: AuthOptions,
  ): { body: Record<string, unknown>; acsp: AcspContext } {
    const callback = opts?.callbackUrl?.trim() ?? "";
    const acsp: AcspContext = {
      rpChallenge,
      relyingPartyName: this.creds.rpName,
      brokeredRpName: "",
      interactions: interactionsToBase64(interactions),
      initialCallbackUrl: callback,
      flowTypes: callback ? [...flows, "App2App", "Web2App"] : flows,
      signatureAlgorithm: opts?.signatureAlgorithm ?? "rsassa-pss",
      hashAlgorithm: opts?.hashAlgorithm ?? "SHA-512",
    };
    const body: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: acsp.relyingPartyName,
      certificateLevel: opts?.certificateLevel ?? this.defaults.certificateLevel,
      signatureProtocol: "ACSP_V2",
      signatureProtocolParameters: {
        rpChallenge,
        signatureAlgorithm: acsp.signatureAlgorithm,
        signatureAlgorithmParameters: { hashAlgorithm: acsp.hashAlgorithm },
      },
      interactions: acsp.interactions,
    };
    if (callback) body.initialCallbackUrl = callback;
    if (opts?.onBehalfOf?.trim()) body.onBehalfOf = opts.onBehalfOf.trim();
    return { body, acsp };
  }

  private parseNotification(raw: unknown, acsp: AcspContext): NotificationSession {
    const r = rec(raw);
    const vc = rec(r.vc).value;
    const expiresAt = parseExpiresAt(r.expiresAt);
    return {
      sessionId: String(r.sessionID),
      vc: vc != null ? String(vc) : null,
      rpChallenge: acsp.rpChallenge,
      acsp,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  private parseDeviceLink(raw: unknown, acsp: AcspContext): DeviceLinkSession {
    const r = rec(raw);
    // CA device-link хариунд vc нь мөр; notification-ийн хэлбэр ({type,value})-ийг ч хүлээн авна.
    const vc = typeof r.vc === "object" && r.vc !== null ? rec(r.vc).value : r.vc;
    const expiresAt = parseExpiresAt(r.expiresAt);
    return {
      sessionId: String(r.sessionID),
      sessionToken: r.sessionToken != null ? String(r.sessionToken) : null,
      sessionSecret: r.sessionSecret != null ? String(r.sessionSecret) : null,
      deviceLinkBase: r.deviceLinkBase != null ? String(r.deviceLinkBase) : null,
      vc: vc != null ? String(vc) : null,
      rpChallenge: acsp.rpChallenge,
      acsp,
      receivedAt: Date.now(),
      sessionType: "auth",
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  /**
   * Discovery (`/.well-known/eid`)-ийн `sessionTtl` — CA-ийн нэвтрэлт / гарын үсгийн session-ий хугацаа (мс; CA-ийн
   * «Системийн тохиргоо»-оос амьд). Хуучин CA-д (талбар алга) 0.
   */
  async sessionTtl(): Promise<SessionTtl> {
    const t = rec(rec(await this.http.get("/.well-known/eid")).sessionTtl);
    const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) * 1000 : 0);
    return { authMs: ms(t.auth), signMs: ms(t.sign) };
  }

  /** Push — РД/иргэний дугаар/ETSI-ээр (сервер төрлийг таьна). Иргэний утас руу мэдэгдэл очно. */
  async notificationByEtsi(id: string, interactions: Interaction[], opts?: AuthOptions): Promise<NotificationSession> {
    const { body, acsp } = this.baseBody(randomChallenge(), interactions, ["Notification"], opts);
    const raw = await this.http.post(routePath(RP_ROUTES.authNotificationEtsi, id), body);
    return this.parseNotification(raw, acsp);
  }

  /** Push — баримтын дугаараар (тодорхой төхөөрөмж рүү). */
  async notificationByDocument(documentNumber: string, interactions: Interaction[], opts?: AuthOptions): Promise<NotificationSession> {
    const { body, acsp } = this.baseBody(randomChallenge(), interactions, ["Notification"], opts);
    const raw = await this.http.post(routePath(RP_ROUTES.authNotificationDocument, documentNumber), body);
    return this.parseNotification(raw, acsp);
  }

  /** QR/App2App — нэр томьёололгүй (иргэн хэн болохыг урьдчилж мэдэхгүй). QR код үүсгэхэд. */
  async deviceLinkAnonymous(interactions: Interaction[], opts?: AuthOptions): Promise<DeviceLinkSession> {
    const { body, acsp } = this.baseBody(randomChallenge(), interactions, ["QR"], opts);
    const raw = await this.http.post(routePath(RP_ROUTES.authDeviceLinkAnonymous), body);
    return this.parseDeviceLink(raw, acsp);
  }

  /** QR/App2App — тодорхой иргэн (РД/civil_id/ETSI). */
  async deviceLinkByEtsi(id: string, interactions: Interaction[], opts?: AuthOptions): Promise<DeviceLinkSession> {
    const { body, acsp } = this.baseBody(randomChallenge(), interactions, ["QR"], opts);
    const raw = await this.http.post(routePath(RP_ROUTES.authDeviceLinkEtsi, id), body);
    return this.parseDeviceLink(raw, acsp);
  }
}
