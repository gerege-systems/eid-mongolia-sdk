// Signature flow — иргэн PIN2 (signing key, non-repudiation)-оор баримтын digest-д хууль ёсны
// гарын үсэг зурна. RP нь баримтынхаа SHA-256 digest-ийг илгээж, хариунд ирэх signature-ийг
// тэр digest + иргэний cert-ийн эсрэг ResponseValidator-аар шалгана.
//
// Гэрчилгээг урьдчилж мэдэх шаардлагатай урсгал (client-side PAdES: CMS signedAttrs-ийн signingCertificateV2):
//   certificateChoiceByEtsi / certificateChoiceDeviceLink → session.waitForResult → validator.validateCertificateChoice
//   → Signer{certificate, documentNumber} → DTBS угсарна → digestForSigner / deviceLinkForSigner (ЯГ тэр төхөөрөмж)
//   → validator.validateSign(…, { expectedAlgorithm, expectedCertificate }).

import { PDF_SIGNATURE_REGISTER_FIELDS, RP_ROUTES, routePath } from "./contract.js";
import { ApiError, ValidationError } from "./errors.js";
import type { Http } from "./http.js";
import { hashLen, interactionsToBase64, sha256Base64 } from "./crypto.js";
import { startExpiry } from "./types.js";
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
 * Клиент талын PAdES-ийн бүртгэл — `POST /pdf/signatures`-ийн бие (CA `dto.PDFSignatureRegisterRequest`,
 * docs/PADES_CLIENT_SIDE.md §4.3/§4.3.1; CA `DisallowUnknownFields` — талбарын нэр ЯГ энэ). Ихэвчлэн
 * {@link registrationFromCompleted}-оор `pades.complete()`-ийн үр дүнгээс бөглөнө.
 */
export interface RegisterSignatureInput {
  /** `complete().docId` (UUID). */
  docID: string;
  /** `complete().revIndex` — энэ гарын үсгийн дугаар (1–16). */
  revIndex: number;
  /** `phone` (утас, `sessionID`-тэй) | `token` (USB токен). Анхдагч: `sessionID` байвал phone, эс бөгөөс token. */
  medium?: "phone" | "token";
  /** Утсаар зурсан бол `signPdfDigest`-ийн sessionId (CA session-ий digest ↔ CMS signedAttrs-ийг тулгана); токенд алга. */
  sessionID?: string;
  /** `complete().cms` — DER (≤ 28 672 байт) эсвэл түүний стандарт base64. */
  cms: Uint8Array | string;
  /** Баримтын нэр (≤ 120 тэмдэгт; CA `cleanFileName`). */
  fileName: string;
  /** `complete().inSha256` — оролтын PDF-ийн SHA-256 (hex). */
  inSha256: string;
  /** `complete().pageSha256` — `revIndex` 1 бол заавал (хуудас нэмсний дараах баримт), бусад үед алга. */
  pageSha256?: string;
  /** `complete().sigRevSha256` — гарын үсгийн revision-ий SHA-256 (hex). */
  sigRevSha256: string;
  /** `complete().outSha256` — гарын үсэгтэй PDF-ийн SHA-256 (hex). */
  outSha256: string;
  /** `complete().priorCmsSha256` — өмнөх (клиент талын) гарын үсгүүдийн CMS SHA-256 (hex). */
  priorCmsSha256?: string[];
  /** Горим A-ийн (CA угсарсан) өмнөх гарын үсгүүдийн revision SHA-256. `priorCmsSha256`-тай нийлээд = `revIndex − 1`. */
  priorRevisionSha256?: string[];
  /**
   * SDK-д л (CA руу илгээхгүй): өмнөх гарын үсэг бүрийн хоёр түлхүүр, баримтын дарааллаар — {@link registrationFromCompleted}
   * бөглөнө. CA өмнөх мөр бүрийг өөрийнх нь түлхүүрээр таньдаг (клиент талын мөр — CMS, горим A — revision), файлаас аль
   * нь болохыг ялгах боломжгүй. Тиймээс `registerSignature` эхлээд бүгдийг CMS-ээр илгээж, 409 `PRIOR_MISMATCH` бол
   * эхний k-г revision-оор (горим A нь клиент талынхаас өмнө), өмнөх нь ≤ 4 бол бүх хослолыг оролдоно.
   * `priorRevisionSha256`-г гараар өгсөн бол оролдохгүй.
   */
  priorSignatures?: PriorSignature[];
  /** Байгууллагын нэрийн өмнөөс (`NTRMN-…`) — session-ийнхтэй ижил. */
  onBehalfOf?: string;
  /** Заавал биш (`PNOMN-…`): ирвэл CMS-ийн зурагчийн SERIALNUMBER-тэй тэнцүү (эс бөгөөс 409 `SIGNER_MISMATCH`). */
  signerEtsi?: string;
}

/** Өмнөх нэг гарын үсгийн хоёр түлхүүр ({@link RegisterSignatureInput.priorSignatures}). */
export interface PriorSignature {
  /** CMS DER-ийн SHA-256 (hex) — клиент талын мөр. */
  cmsSha256: string;
  /** `sha256(doc[0 : ByteRange[2]+ByteRange[3]])` (hex) — горим A-ийн мөр (CA `sig_rev_sha256`). */
  revisionSha256: string;
}

/** {@link registrationFromCompleted}-д хэрэгтэй `pades.complete()`-ийн хэсэг (JSON-оор дамжсан бол `cms` нь base64). */
export interface CompletedForRegistration {
  docId: string;
  revIndex: number;
  cms: Uint8Array | string;
  inSha256: string;
  hasPage: boolean;
  pageSha256: string;
  sigRevSha256: string;
  outSha256: string;
  priorCmsSha256: string[];
  /** `complete().priorRevisionSha256` (0.15.2+) — байвал `priorSignatures` бөглөгдөж горим A-ийн өмнөх мөрийг SDK өөрөө тааруулна. */
  priorRevisionSha256?: string[];
}

/**
 * `pades.complete()`-ийн үр дүнгээс `registerSignature`-ийн биеийг бөглөнө (`hasPage`-ийг илгээхгүй — CA `revIndex`-ээс
 * тооцно; `pageSha256` зөвхөн хуудастай үед).
 */
export function registrationFromCompleted(
  done: CompletedForRegistration,
  extra: Pick<RegisterSignatureInput, "fileName" | "sessionID" | "medium" | "onBehalfOf" | "signerEtsi" | "priorRevisionSha256">,
): RegisterSignatureInput {
  const out: RegisterSignatureInput = {
    docID: done.docId,
    revIndex: done.revIndex,
    cms: done.cms,
    fileName: extra.fileName,
    inSha256: done.inSha256,
    sigRevSha256: done.sigRevSha256,
    outSha256: done.outSha256,
  };
  if (extra.medium) out.medium = extra.medium;
  if (extra.sessionID) out.sessionID = extra.sessionID;
  if (done.hasPage && done.pageSha256) out.pageSha256 = done.pageSha256;
  if (extra.priorRevisionSha256?.length) {
    // Дуудагч өөрөө ангилсан (хуучин зан) — CMS-ийн жагсаалтаас хасах нь түүний үүрэг.
    if (done.priorCmsSha256.length) out.priorCmsSha256 = done.priorCmsSha256;
    out.priorRevisionSha256 = extra.priorRevisionSha256;
  } else if (done.priorCmsSha256.length) {
    out.priorCmsSha256 = done.priorCmsSha256;
    const rev = done.priorRevisionSha256 ?? [];
    if (rev.length === done.priorCmsSha256.length) {
      out.priorSignatures = done.priorCmsSha256.map((c, i) => ({ cmsSha256: c, revisionSha256: rev[i]! }));
    }
  }
  if (extra.onBehalfOf) out.onBehalfOf = extra.onBehalfOf;
  if (extra.signerEtsi) out.signerEtsi = extra.signerEtsi;
  return out;
}

/** `POST /pdf/signatures`-ийн хариу (201 шинэ, 200 идэмпотент давталт). */
export interface RegisterSignatureResult {
  docID: string;
  revIndex: number;
  /** RFC 3339 (+08). */
  registeredAt: string;
  /** Нийтийн шалгах хуудас (`https://ca.eidmongolia.mn/verify/<docID>`). */
  verifyUrl: string;
  /** true — 201 (шинээр бүртгэв); false — 200 (ижил биеийн идэмпотент давталт, анхны хариу). */
  created: boolean;
  raw: unknown;
}

/**
 * `PRIOR_MISMATCH`-ийн дараах оролдлогууд (true = тухайн өмнөх гарын үсгийг revision-оор): эхлээд эхний k (k = 1…n; горим A
 * нь клиент талынхаас өмнө — §15 устгагдаж буй), дараа нь n ≤ 4 бол үлдсэн бүх хослол. Бүгдийг CMS-ээр (k = 0) аль хэдийн
 * оролдсон. Go `priorSplits`-тэй ижил дараалал.
 */
function priorSplits(n: number): boolean[][] {
  const out: boolean[][] = [];
  const seen = new Set<number>();
  for (let k = 1; k <= n; k++) {
    seen.add((1 << k) - 1);
    out.push(Array.from({ length: n }, (_, i) => i < k));
  }
  if (n <= 4) {
    for (let m = 1; m < 1 << n; m++) if (!seen.has(m)) out.push(Array.from({ length: n }, (_, i) => (m & (1 << i)) !== 0));
  }
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_CMS_BYTES = 28_672;

/**
 * `POST /pdf/signatures`-ийн JSON бие — CA `dto.PDFSignatureRegisterRequest`-ийн талбарын дарааллаар, зөвхөн
 * {@link PDF_SIGNATURE_REGISTER_FIELDS}. Оролтыг шалгана (ValidationError).
 */
export function buildRegisterBody(input: RegisterSignatureInput): Record<string, unknown> {
  const fail = (m: string): never => {
    throw new ValidationError(`registerSignature: ${m}`);
  };
  if (!UUID_RE.test(input.docID ?? "")) fail("docID UUID биш");
  if (!Number.isInteger(input.revIndex) || input.revIndex < 1 || input.revIndex > 16) fail("revIndex 1–16");
  const hex = (name: string, v: string | undefined): string => {
    const x = v?.trim().toLowerCase() ?? "";
    if (!HEX64.test(x)) fail(`${name} SHA-256 hex (64) биш`);
    return x;
  };
  let cmsB64: string;
  if (typeof input.cms === "string") {
    const raw = Buffer.from(input.cms, "base64");
    if (raw.length === 0 || raw.toString("base64") !== input.cms) fail("cms стандарт base64 биш");
    cmsB64 = input.cms;
    if (raw.length > MAX_CMS_BYTES) fail(`cms > ${MAX_CMS_BYTES} байт`);
  } else {
    if (!input.cms?.length) fail("cms хоосон");
    if (input.cms.length > MAX_CMS_BYTES) fail(`cms > ${MAX_CMS_BYTES} байт`);
    cmsB64 = Buffer.from(input.cms).toString("base64");
  }
  const fileName = input.fileName?.trim() ?? "";
  if (!fileName || Array.from(fileName).length > PDF_MAX_FILE_NAME) fail(`fileName заавал, ≤ ${PDF_MAX_FILE_NAME} тэмдэгт`);
  const sessionID = input.sessionID?.trim() ?? "";
  const medium = input.medium ?? (sessionID ? "phone" : "token");
  if (medium !== "phone" && medium !== "token") fail("medium: phone | token");
  if (medium === "phone" && !sessionID) fail("phone-д sessionID заавал");
  const priorCms = (input.priorCmsSha256 ?? []).map((h, i) => hex(`priorCmsSha256[${i}]`, h));
  const priorRev = (input.priorRevisionSha256 ?? []).map((h, i) => hex(`priorRevisionSha256[${i}]`, h));
  if (priorCms.length + priorRev.length !== input.revIndex - 1) fail("priorCmsSha256 + priorRevisionSha256-ийн тоо = revIndex − 1");
  if (input.revIndex === 1 && !input.pageSha256) fail("revIndex 1-д pageSha256 заавал");
  const body: Record<string, unknown> = { docID: input.docID, revIndex: input.revIndex, medium };
  if (sessionID) body.sessionID = sessionID;
  body.cms = cmsB64;
  body.fileName = fileName;
  body.inSha256 = hex("inSha256", input.inSha256);
  if (input.pageSha256) body.pageSha256 = hex("pageSha256", input.pageSha256);
  body.sigRevSha256 = hex("sigRevSha256", input.sigRevSha256);
  body.outSha256 = hex("outSha256", input.outSha256);
  if (priorCms.length) body.priorCmsSha256 = priorCms;
  if (priorRev.length) body.priorRevisionSha256 = priorRev;
  if (input.onBehalfOf?.trim()) body.onBehalfOf = input.onBehalfOf.trim();
  if (input.signerEtsi?.trim()) body.signerEtsi = input.signerEtsi.trim();
  for (const k of Object.keys(body)) if (!(PDF_SIGNATURE_REGISTER_FIELDS as readonly string[]).includes(k)) fail(`дотоод: үл мэдэгдэх талбар ${k}`);
  return body;
}
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
      expiresAt: startExpiry(r, sent, this.defaults.sessionTtlMs),
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
      expiresAt: startExpiry(r, sent, this.defaults.sessionTtlMs),
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
    const body = buildRegisterBody(input);
    const prior = input.priorSignatures ?? [];
    if (input.priorRevisionSha256?.length || prior.length === 0 || prior.length !== input.revIndex - 1) return this.registerBody(body);
    try {
      return await this.registerBody(body);
    } catch (first) {
      if (!(first instanceof ApiError && first.code === "PRIOR_MISMATCH")) throw first;
      // Аль өмнөх мөр горим A (revision-оор) болохыг файлаас мэдэх аргагүй — хослолыг оролдоно (priorSplits).
      for (const asRevision of priorSplits(prior.length)) {
        const next = { ...input, priorSignatures: undefined, priorCmsSha256: prior.filter((_, i) => !asRevision[i]).map((p) => p.cmsSha256),
          priorRevisionSha256: prior.filter((_, i) => asRevision[i]).map((p) => p.revisionSha256) };
        try {
          return await this.registerBody(buildRegisterBody(next));
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "PRIOR_MISMATCH")) throw e;
        }
      }
      throw first;
    }
  }

  private async registerBody(body: Record<string, unknown>): Promise<RegisterSignatureResult> {
    const { status, body: raw } = await this.http.postWithStatus(routePath(RP_ROUTES.pdfSignatures), body);
    const r = rec(raw);
    return {
      docID: String(r.docID ?? body.docID),
      revIndex: Number(r.revIndex ?? 0),
      registeredAt: typeof r.registeredAt === "string" ? r.registeredAt : "",
      verifyUrl: String(r.verifyUrl ?? ""),
      created: status === 201,
      raw,
    };
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
