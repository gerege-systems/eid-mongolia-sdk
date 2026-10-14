// Signature flow — иргэн PIN2 (signing key, non-repudiation)-оор баримтын digest-д хууль ёсны
// гарын үсэг зурна. RP нь баримтынхаа SHA-256 digest-ийг илгээж, хариунд ирэх signature-ийг
// тэр digest + иргэний cert-ийн эсрэг ResponseValidator-аар шалгана.

import { RP_ROUTES, RP_ROUTES_UNDISCOVERED, routePath } from "./contract.js";
import { ValidationError } from "./errors.js";
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
  /**
   * Гарын үсэг зурагдах баримтын нэр — CA-ийн /verify хуудас ба иргэний түүхэнд харагдана. Заавал биш: өгөөгүй бол CA
   * interaction текстээс таамаглана.
   */
  fileName?: string;
}

/** {@link SignApi.pdfDigest}-ийн зурагч — яг нэг нь. `documentNumber` нь `PadesPrepareOptions.signerCert`-ийн төхөөрөмж. */
export type PdfDigestSigner = { etsi: string } | { documentNumber: string };

/** Клиент талын PAdES-ийн DTBS-д гарын үсгийн session (`@gerege-systems/eid-mongolia-sdk/pades` `prepare`-ийн дараа). */
export interface PdfDigestInput {
  /** `prepare()`-ийн `dtbs` — SHA-256(signedAttrs), 32 байт (Uint8Array эсвэл стандарт base64). */
  dtbs: Uint8Array | string;
  /** Баримтын нэр (≤ 120 тэмдэгт) — утсанд «Баримтад гарын үсэг зурах: <нэр>», /verify ба иргэний түүхэнд. */
  fileName: string;
  /**
   * Зурагч. `prepare()`-д өгсөн SIGN гэрчилгээ нь энэ төхөөрөмжийнх байх ёстой (өөр төхөөрөмж зурвал `complete()`
   * SIGNATURE_INVALID) — олон төхөөрөмжтэй иргэнд `documentNumber`-ийг сонго.
   */
  signer: PdfDigestSigner;
  /** `notification` (push, анхдагч) эсвэл `device-link` (QR/Web2App/App2App — холбоосыг {@link buildDeviceLink}). */
  flow?: "notification" | "device-link";
  certificateLevel?: CertificateLevel;
  /** device-link Web2App/App2App буцах https URL (`callbackHosts`-д бүртгэлтэй). */
  initialCallbackUrl?: string;
  /**
   * Байгууллагын нэрийн өмнөөс (`NTRMN-…`). Сервер төлөөллийг шалгаж утсанд харуулна. `prepare()`-ийн `claimedRole`
   * нь `organization.getRepresentations()`-ийн тухайн мөрийн `claimedRole` (CMS-д орно).
   */
  onBehalfOf?: string;
}

/** {@link SignApi.pdfDigest}-ийн хариу. `deviceLink`-ийн нууцыг ЗӨВХӨН backend-д хадгална. */
export interface PdfDigestSession {
  sessionId: string;
  /** Иргэнд ХАРУУЛАХ баталгаажуулах код (ПИН биш). */
  vc: string | null;
  /** Илгээсэн DTBS (base64) — `validator.validateSign(result, digest)` ба device link-ийн `digest`. */
  digest: string;
  /** Илгээсэн interactions-ийн base64 МӨР — device link-ийн authCode-д ЯГ ХЭВЭЭР. */
  interactions: string;
  /** device-link урсгалд; push-д null. */
  deviceLink: { sessionToken: string; sessionSecret: string; deviceLinkBase: string } | null;
  /** SDK хариу хүлээн авсан мөч (ms epoch) — QR-ийн `receivedAt`. */
  receivedAt: number;
}

/**
 * Клиент талын PAdES-ийн бүртгэл (`POST /pdf/signatures`, CA docs/PADES_CLIENT_SIDE.md §4.3) — PDF биш, зөвхөн CMS ба
 * hash-ууд. Утгуудыг `pades.complete()`-ийн үр дүнгээс ЯГ ХЭВЭЭР өгнө.
 */
export interface RegisterSignatureInput {
  docID: string;
  /** Утсаар зурсан бол `signPdfDigest`-ийн sessionId (CA session-ий digest ↔ CMS signedAttrs-ийг тулгана); токенд алга. */
  sessionId?: string;
  /** `complete().cms` — DER (≤ 28 672 байт). */
  cms: Uint8Array;
  /** Гарын үсэгтэй PDF-ийн SHA-256 (hex). */
  outSha256: string;
  /** Оролтын PDF-ийн SHA-256 (hex). */
  inSha256?: string;
  fileName: string;
  /** Баталгаажуулах хуудас энэ гарын үсэгт нэмэгдсэн эсэх (эхний гарын үсэг). */
  hasPage: boolean;
  pageSha256?: string;
  /** Байгууллагын нэрийн өмнөөс (`NTRMN-…`) — session-ийнхтэй ижил. */
  onBehalfOf?: string;
}

/** `POST /pdf/signatures`-ийн хариу (201 шинэ, 200 идэмпотент давталт). */
export interface RegisterSignatureResult {
  docID: string;
  revIndex: number;
  /** Нийтийн шалгах хуудас (`https://ca.eidmongolia.mn/verify/<docID>`). */
  verifyUrl: string;
  raw: unknown;
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CA-ийн өөрийн PAdES session-тэй ижил утасны текст (server/internal/service/memory/pades.go). */
const PDF_DISPLAY_TEXT = "Баримтад гарын үсэг зурах: ";
const PDF_MAX_FILE_NAME = 120;

function dtbsBase64(v: Uint8Array | string): string {
  const raw = typeof v === "string" ? Buffer.from(v, "base64") : Buffer.from(v);
  if (raw.length !== 32 || (typeof v === "string" && raw.toString("base64") !== v)) {
    throw new ValidationError("pdfDigest: dtbs нь 32 байт (SHA-256) байх ёстой");
  }
  return raw.toString("base64");
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
    if (opts?.fileName?.trim()) body.fileName = opts.fileName.trim();
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
    const raw = await this.http.post(routePath(RP_ROUTES.signNotificationEtsi, id), this.body(digestB64, interactions, opts));
    return this.parse(raw);
  }

  /** Бэлэн digest-ээр push sign — баримтын дугаараар (auth-аас гарсан documentNumber дээр). */
  async digestByDocument(documentNumber: string, digestB64: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    const raw = await this.http.post(routePath(RP_ROUTES.signNotificationDocument, documentNumber), this.body(digestB64, interactions, opts));
    return this.parse(raw);
  }

  /**
   * Клиент талын PAdES (`@gerege-systems/eid-mongolia-sdk/pades`): `prepare()`-ийн DTBS-д иргэнээр гарын үсэг зуруулна.
   * PDF CA руу ОЧИХГҮЙ — зөвхөн 32 байт. CA-ийн өөрийн PAdES session-тэй ижил: `RAW_DIGEST_SIGNATURE`,
   * `sha256WithRSAEncryption` (CMS-д PKCS#1 v1.5; legacy ECDSA иргэнд сервер `ecdsa-with-SHA256`), `displayTextAndPIN`
   * «Баримтад гарын үсэг зурах: <fileName>» (60 тэмдэгтэд тайрна).
   *
   * Дараа нь `session.waitForResult(sessionId)` → `validator.validateSign(result, s.digest)` → `signature.value`-г
   * (base64 → байт) `complete(state, signature)`-д.
   */
  async pdfDigest(input: PdfDigestInput): Promise<PdfDigestSession> {
    const digest = dtbsBase64(input.dtbs);
    const fileName = input.fileName?.trim() ?? "";
    if (!fileName || Array.from(fileName).length > PDF_MAX_FILE_NAME) {
      throw new ValidationError(`pdfDigest: fileName заавал, ≤ ${PDF_MAX_FILE_NAME} тэмдэгт`);
    }
    const signer = input.signer as Partial<{ etsi: string; documentNumber: string }>;
    const etsi = signer?.etsi?.trim();
    const doc = signer?.documentNumber?.trim();
    if (!etsi === !doc) throw new ValidationError("pdfDigest: signer — etsi эсвэл documentNumber-ийн яг нэг нь");
    const deviceLink = input.flow === "device-link";

    const display = Array.from(PDF_DISPLAY_TEXT + fileName).slice(0, 60).join("");
    const interactions = interactionsToBase64([{ type: "displayTextAndPIN", displayText60: display }]);
    const body: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: this.creds.rpName,
      certificateLevel: input.certificateLevel ?? this.defaults.certificateLevel,
      signatureProtocol: "RAW_DIGEST_SIGNATURE",
      signatureProtocolParameters: {
        digest,
        signatureAlgorithm: "sha256WithRSAEncryption",
        signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" },
      },
      interactions,
      fileName,
    };
    if (input.initialCallbackUrl?.trim()) body.initialCallbackUrl = input.initialCallbackUrl.trim();
    if (input.onBehalfOf?.trim()) body.onBehalfOf = input.onBehalfOf.trim();

    const route = deviceLink
      ? etsi ? RP_ROUTES.signDeviceLinkEtsi : RP_ROUTES.signDeviceLinkDocument
      : etsi ? RP_ROUTES.signNotificationEtsi : RP_ROUTES.signNotificationDocument;
    const r = rec(await this.http.post(routePath(route, (etsi ?? doc)!), body));
    const receivedAt = Date.now();
    // notification: vc = {type,value}; device-link: vc нь мөр.
    const vc = typeof r.vc === "object" && r.vc !== null ? rec(r.vc).value : r.vc;
    let dl: PdfDigestSession["deviceLink"] = null;
    if (deviceLink) {
      if (!r.sessionToken || !r.sessionSecret || !r.deviceLinkBase) {
        throw new ValidationError("pdfDigest: device-link хариунд sessionToken/sessionSecret/deviceLinkBase алга");
      }
      dl = { sessionToken: String(r.sessionToken), sessionSecret: String(r.sessionSecret), deviceLinkBase: String(r.deviceLinkBase) };
    }
    return { sessionId: String(r.sessionID), vc: vc != null ? String(vc) : null, digest, interactions, deviceLink: dl, receivedAt };
  }

  /**
   * `POST /pdf/signatures` — `pades.complete()`-ийн дараа CMS-ийг CA-д бүртгэнэ (`/verify/{docID}`, иргэний түүх). PDF
   * илгээгдэхгүй. SIGN эрх. CA CMS-ийг шалгана: 04-ийн SIGN cert, session digest = SHA-256(signedAttrs), claimedRole ↔
   * төлөөлөл. Алдаа: 403 `REPRESENTATION_REVOKED`, 409 `CLAIMED_ROLE_MISMATCH` / `REGISTRY_CONFLICT` /
   * `DOC_ID_CONFLICT` / `PDF_FOREIGN_SIGNATURE` (`ApiError.code`). Бүртгэлгүй файл ч Adobe/EU DSS-д хүчинтэй — зөвхөн
   * `/verify` «бүртгэлгүй» гэнэ.
   */
  async registerSignature(input: RegisterSignatureInput): Promise<RegisterSignatureResult> {
    if (!UUID_RE.test(input.docID ?? "")) throw new ValidationError("registerSignature: docID UUID биш");
    if (!input.cms?.length) throw new ValidationError("registerSignature: cms хоосон");
    const hex = (name: string, v: string | undefined, required: boolean): string | undefined => {
      const x = v?.trim().toLowerCase();
      if (!x) {
        if (required) throw new ValidationError(`registerSignature: ${name} заавал`);
        return undefined;
      }
      if (!HEX64.test(x)) throw new ValidationError(`registerSignature: ${name} SHA-256 hex биш`);
      return x;
    };
    const fileName = input.fileName?.trim() ?? "";
    if (!fileName || Array.from(fileName).length > PDF_MAX_FILE_NAME) {
      throw new ValidationError(`registerSignature: fileName заавал, ≤ ${PDF_MAX_FILE_NAME} тэмдэгт`);
    }
    const body: Record<string, unknown> = {
      docID: input.docID,
      cms: Buffer.from(input.cms).toString("base64"),
      outSha256: hex("outSha256", input.outSha256, true),
      fileName,
      hasPage: input.hasPage === true,
    };
    if (input.sessionId?.trim()) body.sessionID = input.sessionId.trim();
    const inSha = hex("inSha256", input.inSha256, false);
    if (inSha) body.inSha256 = inSha;
    const pageSha = hex("pageSha256", input.pageSha256, input.hasPage === true);
    if (pageSha) body.pageSha256 = pageSha;
    if (input.onBehalfOf?.trim()) body.onBehalfOf = input.onBehalfOf.trim();
    const raw = await this.http.post(routePath(RP_ROUTES_UNDISCOVERED.pdfSignatures), body);
    const r = rec(raw);
    return { docID: String(r.docID ?? input.docID), revIndex: Number(r.revIndex ?? 0), verifyUrl: String(r.verifyUrl ?? ""), raw };
  }

  /** Текстийн SHA-256 digest-ийг дотроо тооцоод push sign (богино текст баримтад тохиромжтой). */
  async textByEtsi(id: string, text: string, interactions: Interaction[], opts?: SignOptions): Promise<NotificationSession> {
    return this.digestByEtsi(id, sha256Base64(text), interactions, opts);
  }
}
