// Signature flow — иргэн PIN2 (signing key, non-repudiation)-оор баримтын digest-д хууль ёсны
// гарын үсэг зурна. RP нь баримтынхаа SHA-256 digest-ийг илгээж, хариунд ирэх signature-ийг
// тэр digest + иргэний cert-ийн эсрэг ResponseValidator-аар шалгана.
//
// Гэрчилгээг урьдчилж мэдэх шаардлагатай урсгал (client-side PAdES: CMS signedAttrs-ийн signingCertificateV2):
//   certificateChoiceByEtsi / certificateChoiceDeviceLink → session.waitForResult → validator.validateCertificateChoice
//   → Signer{certificate, documentNumber} → DTBS угсарна → digestForSigner / deviceLinkForSigner (ЯГ тэр төхөөрөмж)
//   → validator.validateSign(…, { expectedAlgorithm, expectedCertificate }).

import { RP_ROUTES, routePath } from "./contract.js";
import type { Http } from "./http.js";
import { hashLen, interactionsToBase64, sha256Base64 } from "./crypto.js";
import { sessionExpiry } from "./types.js";
import type {
  CertificateLevel,
  DeviceLinkSession,
  HashAlgorithm,
  Interaction,
  NotificationSession,
  RpCredentials,
  SignContext,
  SignatureAlgorithm,
} from "./types.js";

export interface SignDefaults {
  certificateLevel: CertificateLevel;
  /** Sign / certificate-choice session-ий `expiresAt`-ийг тооцоолох хугацаа (мс); undefined = 600000. */
  sessionTtlMs?: number;
}

export interface SignOptions {
  certificateLevel?: CertificateLevel;
  /**
   * Same-device App2App/Web2App буцах URL (initialCallbackUrl). Device link-д Web2App/App2App холбоос зөвхөн үүнтэй
   * session-д хүчинтэй; host нь RP-ийн callbackHosts-д байх ёстой. Query-д буцах browser-ийн hint нэмэхийг ЗӨВЛӨНӨ
   * (`?retScheme=` iOS / `?retPkg=` Android) — docs/RP_GEREGE_INTEGRATION.md §1.1b.
   */
  callbackUrl?: string;
  /** digest-ийн hash (default SHA-256). digest-ийг өөрөө бэлдсэн бол тааруулна (урт = hLen). */
  hashAlgorithm?: HashAlgorithm;
  /**
   * Гарын үсгийн алгоритм (default rsassa-pss; PKCS#1 v1.5 нь deprecated). `digestForSigner` / `deviceLinkForSigner`-д
   * default `sha256WithRSAEncryption` (PAdES/CMS).
   */
  signatureAlgorithm?: SignatureAlgorithm;
  /**
   * Байгууллагын нэрийн өмнөөс гарын үсэг (docs/ORG_LOGIN.md) — байгууллагын ETSI
   * (`NTRMN-<register>`). Сервер төлөөллийн эрхийг шалгаж (эрхгүй бол 403), утсанд
   * байгууллагын нэрийг харуулж, session хариунд `onBehalfOf` блок буцаана. Гарын үсэг
   * өөрөө иргэний PIN2 гэрчилгээгээр — байгууллага нь digest-д ОРОХГҮЙ.
   */
  onBehalfOf?: string;
  /**
   * Гарын үсэг зурагдах баримтын нэр — CA-ийн /verify хуудас ба иргэний түүхэнд харагдана. Заавал биш: өгөөгүй бол CA
   * interaction текстээс таамаглана.
   */
  fileName?: string;
}

/** Certificate-choice session-ий тохиргоо. */
export interface CertChoiceOptions {
  certificateLevel?: CertificateLevel;
}

/**
 * Гарын үсэг зурах төхөөрөмж — `validator.validateCertificateChoice`-ийн үр дүн (эсвэл түүнээс хадгалсан утга).
 * `documentNumber` — гэрчилгээг сонгосон ЯГ ТЭР төхөөрөмж; `certChoiceSessionId` байвал linked sign.
 */
export interface SignerRef {
  documentNumber: string;
  certChoiceSessionId?: string | null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

const vcOf = (r: Record<string, unknown>): string | null => {
  // notification: {type,value}; device-link: мөр.
  const vc = typeof r.vc === "object" && r.vc !== null ? rec(r.vc).value : r.vc;
  return vc != null ? String(vc) : null;
};

export class SignApi {
  constructor(
    private readonly http: Http,
    private readonly creds: RpCredentials,
    private readonly defaults: SignDefaults,
  ) {}

  private body(
    digestB64: string,
    interactions: Interaction[],
    opts: SignOptions | undefined,
    defAlg: SignatureAlgorithm,
  ): { body: Record<string, unknown>; sign: SignContext } {
    const sign: SignContext = {
      digest: digestB64,
      hashAlgorithm: opts?.hashAlgorithm ?? "SHA-256",
      signatureAlgorithm: opts?.signatureAlgorithm ?? defAlg,
      relyingPartyName: this.creds.rpName,
      interactions: interactionsToBase64(interactions),
      initialCallbackUrl: opts?.callbackUrl?.trim() ?? "",
    };
    const body: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: sign.relyingPartyName,
      certificateLevel: opts?.certificateLevel ?? this.defaults.certificateLevel,
      signatureProtocol: "RAW_DIGEST_SIGNATURE",
      signatureProtocolParameters: {
        digest: digestB64,
        signatureAlgorithm: sign.signatureAlgorithm,
        signatureAlgorithmParameters: { hashAlgorithm: sign.hashAlgorithm },
      },
      interactions: sign.interactions,
    };
    if (sign.initialCallbackUrl) body.initialCallbackUrl = sign.initialCallbackUrl;
    if (opts?.onBehalfOf?.trim()) body.onBehalfOf = opts.onBehalfOf.trim();
    if (opts?.fileName?.trim()) body.fileName = opts.fileName.trim();
    return { body, sign };
  }

  private async notification(path: string, body: Record<string, unknown>, sign?: SignContext): Promise<NotificationSession> {
    const sent = Date.now();
    const r = rec(await this.http.post(path, body));
    // sign flow-д rpChallenge байхгүй — signature нь digest-ийн эсрэг баталгаажна.
    return {
      sessionId: String(r.sessionID),
      vc: vcOf(r),
      rpChallenge: "",
      ...(sign ? { sign } : {}),
      expiresAt: sessionExpiry(sent, this.defaults.sessionTtlMs),
    };
  }

  private async deviceLink(
    path: string,
    body: Record<string, unknown>,
    extra: Pick<DeviceLinkSession, "sessionType" | "sign" | "relyingPartyName">,
  ): Promise<DeviceLinkSession> {
    const sent = Date.now();
    const r = rec(await this.http.post(path, body));
    return {
      sessionId: String(r.sessionID),
      sessionToken: r.sessionToken != null ? String(r.sessionToken) : null,
      sessionSecret: r.sessionSecret != null ? String(r.sessionSecret) : null,
      deviceLinkBase: r.deviceLinkBase != null ? String(r.deviceLinkBase) : null,
      vc: vcOf(r),
      rpChallenge: "",
      receivedAt: Date.now(),
      ...extra,
      expiresAt: sessionExpiry(sent, this.defaults.sessionTtlMs),
    };
  }

  /**
   * Бэлэн digest-ээр push sign (РД/civil_id/ETSI). Баримт (PDF/файл)-ын байтын SHA-256
   * digest-ийг гаднаас бэлдэж өгнө — текст бус бинар баримтад тохиромжтой.
   *
   * ⚠️ Олон утастай иргэнд CA etsi-г ЭХНИЙ идэвхтэй төхөөрөмж рүү шийднэ. Гэрчилгээг урьдчилж мэдэх шаардлагатай бол
   * (PAdES/CMS) {@link certificateChoiceByEtsi} → {@link digestForSigner}.
   */
  async digestByEtsi(id: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    const { body, sign } = this.body(digestB64, interactions, opts, "rsassa-pss");
    return this.notification(routePath(RP_ROUTES.signNotificationEtsi, id), body, sign);
  }

  /** Бэлэн digest-ээр push sign — баримтын дугаараар (auth / certificate-choice-оос гарсан documentNumber дээр). */
  async digestByDocument(documentNumber: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    const { body, sign } = this.body(digestB64, interactions, opts, "rsassa-pss");
    return this.notification(routePath(RP_ROUTES.signNotificationDocument, documentNumber), body, sign);
  }

  /** Текстийн SHA-256 digest-ийг дотроо тооцоод push sign (богино текст баримтад тохиромжтой). */
  async textByEtsi(id: string, text: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    return this.digestByEtsi(id, sha256Base64(text), interactions, opts);
  }

  /**
   * QR / Web2App / App2App sign — тодорхой иргэн (РД/civil_id/ETSI). Холбоосыг backend-д
   * `buildDeviceLink(deviceLinkInput(s, type, lang))`-ээр; Web2App/App2App-д `callbackUrl` заавал.
   * `validateSign`-д `expectedFlowType` = харуулсан холбоосын төрөл.
   */
  async deviceLinkByEtsi(id: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<DeviceLinkSession> {
    const { body, sign } = this.body(digestB64, interactions, opts, "rsassa-pss");
    return this.deviceLink(routePath(RP_ROUTES.signDeviceLinkEtsi, id), body, { sessionType: "sign", sign });
  }

  /** QR / Web2App / App2App sign — баримтын дугаараар (тодорхой төхөөрөмж). */
  async deviceLinkByDocument(documentNumber: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<DeviceLinkSession> {
    const { body, sign } = this.body(digestB64, interactions, opts, "rsassa-pss");
    return this.deviceLink(routePath(RP_ROUTES.signDeviceLinkDocument, documentNumber), body, { sessionType: "sign", sign });
  }

  // ── Certificate-choice ──

  private certChoiceBody(opts?: CertChoiceOptions): Record<string, unknown> {
    // CA dto.CertificateChoiceRequest — interactions/initialCallbackUrl БАЙХГҮЙ (үл мэдэгдэх талбар → 400).
    return {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: this.creds.rpName,
      certificateLevel: opts?.certificateLevel ?? this.defaults.certificateLevel,
    };
  }

  /**
   * Push: иргэний (РД/civil_id/ETSI) утас руу гарын үсгийн гэрчилгээ сонгуулах хүсэлт (PIN-гүй). Үр дүнг
   * `session.waitForResult` → `validator.validateCertificateChoice`. CERT эрх шаардана.
   */
  async certificateChoiceByEtsi(id: string, opts?: CertChoiceOptions): Promise<NotificationSession> {
    return this.notification(routePath(RP_ROUTES.certChoiceEtsi, id), this.certChoiceBody(opts));
  }

  /**
   * QR: иргэн хэн болохыг урьдчилж мэдэхгүй үед гэрчилгээ сонгуулах. CA-ийн certificate-choice хүсэлт
   * initialCallbackUrl авдаггүй тул ЗӨВХӨН QR холбоос (`deviceLinkInput(s, "QR", lang)`). CERT эрх.
   */
  async certificateChoiceDeviceLink(opts?: CertChoiceOptions): Promise<DeviceLinkSession> {
    return this.deviceLink(routePath(RP_ROUTES.certChoiceDeviceLink), this.certChoiceBody(opts), {
      sessionType: "cert",
      relyingPartyName: this.creds.rpName,
    });
  }

  // ── Гэрчилгээ урьдчилж мэдэгдэх гарын үсэг (client-side PAdES / CMS) ──

  private signerBody(signer: SignerRef, digestB64: string, interactions: Interaction[], opts?: SignOptions) {
    if (!signer?.documentNumber?.trim()) {
      throw new Error("eid: signer.documentNumber хоосон — validateCertificateChoice-ийн үр дүнг өг");
    }
    const out = this.body(digestB64, interactions, opts, "sha256WithRSAEncryption");
    const want = hashLen(out.sign.hashAlgorithm);
    const d = /^[A-Za-z0-9+/]*={0,2}$/.test(digestB64) ? Buffer.from(digestB64, "base64") : null;
    if (!d || d.length !== want || d.toString("base64") !== digestB64) {
      throw new Error(`eid: digest нь стандарт base64, ${out.sign.hashAlgorithm}-ийн урт (${want} байт) байх ёстой`);
    }
    return out;
  }

  /**
   * Certificate-choice-оор сонгосон ЯГ ТЭР төхөөрөмж (`signer.documentNumber`) рүү push sign. Олон утастай иргэнд
   * etsi-ээр эхлүүлбэл өөр утас (өөр гэрчилгээ) зурж, гэрчилгээг урьдчилж оруулсан CMS (PAdES signingCertificateV2)
   * хүчингүй болдог — тиймээс digest-ийг ҮРГЭЛЖ documentNumber-аар зуруулна.
   *
   * `signer.certChoiceSessionId` байвал `/signature/notification/linked/{documentNumber}` (`linkedSessionID`), эс
   * бөгөөс `/signature/notification/document/{documentNumber}`. Default `sha256WithRSAEncryption` + SHA-256 (digest =
   * 32 байт DTBS); digest-ийн урт буруу бол хүсэлт явахгүй. Хариуг:
   * `validator.validateSign(r, s.sign.digest, { hashAlgorithm: s.sign.hashAlgorithm, expectedAlgorithm:
   * s.sign.signatureAlgorithm, expectedCertificate: signer.certificate, expectedFlowType: "Notification" })`.
   */
  async digestForSigner(signer: SignerRef, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    const { body, sign } = this.signerBody(signer, digestB64, interactions, opts);
    const linked = signer.certChoiceSessionId?.trim();
    if (linked) {
      body.linkedSessionID = linked;
      return this.notification(routePath(RP_ROUTES.signNotificationLinked, signer.documentNumber), body, sign);
    }
    return this.notification(routePath(RP_ROUTES.signNotificationDocument, signer.documentNumber), body, sign);
  }

  /** {@link digestForSigner}-ийн QR / Web2App / App2App хувилбар: `/signature/device-link/document/{documentNumber}`. */
  async deviceLinkForSigner(signer: SignerRef, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<DeviceLinkSession> {
    const { body, sign } = this.signerBody(signer, digestB64, interactions, opts);
    return this.deviceLink(routePath(RP_ROUTES.signDeviceLinkDocument, signer.documentNumber), body, { sessionType: "sign", sign });
  }
}
