// Signature flow — иргэн PIN2 (signing key, non-repudiation)-оор баримтын digest-д хууль ёсны
// гарын үсэг зурна. RP нь баримтынхаа SHA-256 digest-ийг илгээж, хариунд ирэх signature-ийг
// тэр digest + иргэний cert-ийн эсрэг ResponseValidator-аар шалгана.

import type { Http } from "./http.js";
import { interactionsToBase64, sha256Base64 } from "./crypto.js";
import type {
  CertificateLevel,
  HashAlgorithm,
  Interaction,
  NotificationSession,
  RpCredentials,
  SignatureAlgorithm,
} from "./types.js";

export interface SignDefaults {
  certificateLevel: CertificateLevel;
}

export interface SignOptions {
  certificateLevel?: CertificateLevel;
  /**
   * Same-device App2App буцах URL. Query-д буцах browser-ийн hint нэмэхийг ЗӨВЛӨНӨ
   * (`?retScheme=` iOS / `?retPkg=` Android) — docs/RP_GEREGE_INTEGRATION.md §1.1b.
   */
  callbackUrl?: string;
  /** digest-ийн hash (default SHA-256). digest-ийг өөрөө бэлдсэн бол тааруулна (урт = hLen). */
  hashAlgorithm?: HashAlgorithm;
  /** Гарын үсгийн алгоритм (default rsassa-pss; PKCS#1 v1.5 нь deprecated). */
  signatureAlgorithm?: SignatureAlgorithm;
  /**
   * Байгууллагын нэрийн өмнөөс гарын үсэг (docs/ORG_LOGIN.md) — байгууллагын ETSI
   * (`NTRMN-<register>`). Сервер төлөөллийн эрхийг шалгаж (эрхгүй бол 403), утсанд
   * байгууллагын нэрийг харуулж, session хариунд `onBehalfOf` блок буцаана. Гарын үсэг
   * өөрөө иргэний PIN2 гэрчилгээгээр — байгууллага нь digest-д ОРОХГҮЙ.
   */
  onBehalfOf?: string;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export class SignApi {
  constructor(
    private readonly http: Http,
    private readonly creds: RpCredentials,
    private readonly defaults: SignDefaults,
  ) {}

  private body(digestB64: string, interactions: Interaction[], opts?: SignOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: this.creds.rpName,
      certificateLevel: opts?.certificateLevel ?? this.defaults.certificateLevel,
      signatureProtocol: "RAW_DIGEST_SIGNATURE",
      signatureProtocolParameters: {
        digest: digestB64,
        signatureAlgorithm: opts?.signatureAlgorithm ?? "rsassa-pss",
        signatureAlgorithmParameters: { hashAlgorithm: opts?.hashAlgorithm ?? "SHA-256" },
      },
      interactions: interactionsToBase64(interactions),
    };
    if (opts?.callbackUrl?.trim()) body.initialCallbackUrl = opts.callbackUrl.trim();
    if (opts?.onBehalfOf?.trim()) body.onBehalfOf = opts.onBehalfOf.trim();
    return body;
  }

  private parse(raw: unknown): NotificationSession {
    const r = rec(raw);
    const vc = rec(r.vc).value;
    // sign flow-д rpChallenge байхгүй — signature нь digest-ийн эсрэг баталгаажна.
    return { sessionId: String(r.sessionID), vc: vc != null ? String(vc) : null, rpChallenge: "" };
  }

  /**
   * Бэлэн digest-ээр push sign (РД/civil_id/ETSI). Баримт (PDF/файл)-ын байтын SHA-256
   * digest-ийг гаднаас бэлдэж өгнө — текст бус бинар баримтад тохиромжтой.
   */
  async digestByEtsi(id: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    const raw = await this.http.post(`/signature/notification/etsi/${encodeURIComponent(id)}`, this.body(digestB64, interactions, opts));
    return this.parse(raw);
  }

  /** Бэлэн digest-ээр push sign — баримтын дугаараар (auth-аас гарсан documentNumber дээр). */
  async digestByDocument(documentNumber: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    const raw = await this.http.post(`/signature/notification/document/${encodeURIComponent(documentNumber)}`, this.body(digestB64, interactions, opts));
    return this.parse(raw);
  }

  /** Текстийн SHA-256 digest-ийг дотроо тооцоод push sign (богино текст баримтад тохиромжтой). */
  async textByEtsi(id: string, text: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    return this.digestByEtsi(id, sha256Base64(text), interactions, opts);
  }
}
