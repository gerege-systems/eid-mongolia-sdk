// eID Gerege RP-API-ийн wire-contract төрлүүд. JSON талбарын нэр серверийн /v3 API-тай
// ЯГ ИЖИЛ (camelCase). Эдгээр нь SDK-ийн нийтийн гэрээ тул өөрчлөхдөө wire-compat бодолцоно.

/** Сертификатын баталгаажуулалтын түвшин (eIDAS LoA). QUALIFIED — хууль ёсны гарын үсэгт. */
export type CertificateLevel = "ADVANCED" | "QUALIFIED" | "QSCD";

/** Гарын үсгийн протокол: auth → ACSP_V2, sign → RAW_DIGEST_SIGNATURE (Smart-ID v3). */
export type SignatureProtocol = "ACSP_V2" | "RAW_DIGEST_SIGNATURE";

/** Гарын үсгийн алгоритм. rsassa-pss анхдагч; ecdsa-with-SHA256 — хуучин threshold-ECDSA cert. */
export type SignatureAlgorithm =
  | "rsassa-pss"
  | "sha256WithRSAEncryption"
  | "sha384WithRSAEncryption"
  | "sha512WithRSAEncryption"
  | "ecdsa-with-SHA256";

/** Hash алгоритм (Smart-ID v3 нэршил). Хуучин "SHA256" нэршил SDK-д БАЙХГҮЙ. */
export type HashAlgorithm = "SHA-256" | "SHA-384" | "SHA-512";

/** Урсгалын төрөл — хариуны signature.flowType; RP өөрийн санал болгосонтой тулгана. */
export type FlowType = "QR" | "App2App" | "Web2App" | "Notification";

/** rsassa-pss хариуны параметр (signature.signatureAlgorithmParameters). */
export interface SignatureAlgorithmParameters {
  hashAlgorithm: HashAlgorithm | string;
  maskGenAlgorithm?: { algorithm: string; parameters?: { hashAlgorithm: string } };
  saltLength?: number;
  trailerField?: string;
}

/**
 * Auth session-ийн ACSP_V2 контекст — RP ХҮСЭЛТЭД илгээсэн утгууд. validator энэ + хариугаар
 * payload-ийг дахин угсарна. Session эхлүүлэхэд SDK өөрөө бөглөнө; RP үүнийг хадгална.
 */
export interface AcspContext {
  rpChallenge: string;
  relyingPartyName: string;
  brokeredRpName: string;
  /** Илгээсэн base64 МӨР (дахин serialize хийхгүй). */
  interactions: string;
  initialCallbackUrl: string;
  /** RP-ийн санал болгосон урсгалууд — хариуны flowType эдгээрийн нэг байх ёстой. */
  flowTypes: FlowType[];
  signatureAlgorithm: SignatureAlgorithm;
  hashAlgorithm: HashAlgorithm;
}

/**
 * Interaction — иргэний утсан дээр харагдах харилцан үйлдэл. displayTextAndPIN нь PIN асууж
 * текст харуулна (хамгийн түгээмэл). text60 — 60 тэмдэгт хүртэл; text200 — 200 хүртэл.
 */
export interface Interaction {
  type: "displayTextAndPIN" | "confirmationMessage" | "confirmationMessageAndVerificationCodeChoice";
  displayText60?: string;
  displayText200?: string;
}

/** Session-ийн төлөв. RUNNING — иргэн хариу өгөөгүй; COMPLETE — дууссан (endResult-ыг үз). */
export type SessionState = "RUNNING" | "COMPLETE";

/**
 * endResult — COMPLETE session-ийн эцсийн үр дүн.
 *   OK                        — амжилттай (signature/cert бэлэн)
 *   USER_REFUSED*             — иргэн татгалзсан
 *   TIMEOUT                   — иргэн хугацаанд хариу өгөөгүй
 *   DOCUMENT_UNUSABLE         — гэрчилгээ/төхөөрөмж ашиглах боломжгүй
 *   WRONG_VC                  — баталгаажуулах код таарсангүй
 */
export type EndResult =
  | "OK"
  | "USER_REFUSED"
  | "USER_REFUSED_DISPLAYTEXTANDPIN"
  | "USER_REFUSED_VC_CHOICE"
  | "USER_REFUSED_CONFIRMATIONMESSAGE"
  | "USER_REFUSED_CERT_CHOICE"
  | "TIMEOUT"
  | "DOCUMENT_UNUSABLE"
  | "WRONG_VC"
  | "PROTOCOL_FAILURE"
  | string;

/**
 * Push (notification) session эхлүүлсний хариу. vc — иргэний дэлгэцэд ХАРУУЛАХ 5 оронтой
 * баталгаажуулах код: утсан дээрх кодтой ижил эсэхийг НҮДЭЭР тулгах зориулалттай.
 *
 * VC нь ПИН БИШ — RP нь үүнийг хэрэглэгчээр оруулуулж болохгүй, зөвхөн харуулна. (PIN1 нь
 * 4 оронтой; VC-г 5 оронтой болгосон нь хэрэглэгч андуурч PIN-ий талбарт оруулаад PIN
 * блок болохоос сэргийлсэн зориудын ялгаа.)
 */
export interface NotificationSession {
  sessionId: string;
  /** Verification Code — иргэний утсан дээр харагдах код. RP UI-даа ижлийг харуулна (man-in-the-middle хамгаалалт). */
  vc: string | null;
  /** RP-ийн илгээсэн санамсаргүй challenge (base64). Хариуны signature-ийг үүний эсрэг шалгана. */
  rpChallenge: string;
  /** Auth session-д validator-т өгөх контекст (sign session-д undefined). */
  acsp?: AcspContext;
  /** Sign session-ий хүсэлтэд илгээсэн утгууд ({@link SignContext}); auth / certificate-choice-д undefined. */
  sign?: SignContext;
  /** Sign / certificate-choice session-ий ТООЦООЛСОН дуусах мөч (ms epoch) — {@link sessionExpiry}; auth-д undefined. */
  expiresAt?: number;
}

/**
 * Sign session-ий хүсэлтэд илгээсэн утгууд ЯГ ХЭВЭЭР: `validateSign` (digest, hashAlgorithm, signatureAlgorithm) ба
 * device link (`buildDeviceLink`: digest, relyingPartyName, interactions, initialCallbackUrl)-д. RP session-тэй хамт
 * серверт хадгална.
 */
export interface SignContext {
  /** Илгээсэн digest (стандарт base64, ЯГ ХЭВЭЭР — device link-ийн authCode-д ордог). */
  digest: string;
  hashAlgorithm: HashAlgorithm;
  signatureAlgorithm: SignatureAlgorithm;
  relyingPartyName: string;
  /** Илгээсэн interactions-ийн base64 МӨР. */
  interactions: string;
  initialCallbackUrl: string;
}

/**
 * CA-ийн SIGNATURE ба CERTIFICATE_CHOICE session-ий анхдагч хүчинтэй хугацаа (мс; `EID_SIGN_SESSION_TTL_SECONDS` = 600).
 * CA-ийн админ «Системийн тохиргоо»-нд 60–1800 секундэд өөрчилж болно. CA 2026-10-14-өөс session start хариунд
 * `expiresAt` (RFC 3339) буцаадаг — SDK түүнийг ашиглана; хуучин CA (талбаргүй) үед л `ClientConfig.signSessionTtlMs`-ээр
 * тооцоолно ({@link startExpiry}).
 */
export const DEFAULT_SIGN_SESSION_TTL_MS = 600_000;

/**
 * Session start-ын хариунаас тооцоолох дуусах мөч (ms epoch): хүсэлт илгээхээс ӨМНӨХ цаг + ttl. CA ExpiresAt-ийг өөрийн
 * хүлээн авсан мөчөөс тооцдог тул энэ утга CA-ийнхаас ХЭЗЭЭ Ч хойно биш (консерватив). RP UI-ийн тоолуур / «дахин
 * эхлүүлэх» шийдвэрт л — эцсийн үнэн нь `GET /session` (`TIMEOUT`).
 */
export function sessionExpiry(sentAtMs: number, ttlMs?: number): number {
  return sentAtMs + (ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_SIGN_SESSION_TTL_MS);
}

/** CA-ийн `expiresAt` (RFC 3339) → ms epoch; байхгүй / задрахгүй бол undefined. */
export function parseExpiresAt(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Session start-ын дуусах мөч: CA-ийн `expiresAt` байвал түүнийг, үгүй бол {@link sessionExpiry} (тооцоолол). */
export function startExpiry(raw: unknown, sentAtMs: number, ttlMs?: number): number {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return parseExpiresAt(r.expiresAt) ?? sessionExpiry(sentAtMs, ttlMs);
}

/**
 * Device-link (QR/Web2App/App2App) session. Иргэн QR уншиж эсвэл товч дарж нэгдэнэ.
 * `sessionToken`, `sessionSecret`-ийг ЗӨВХӨН backend-д хадгална — браузер руу бүү гарга.
 */
export interface DeviceLinkSession {
  sessionId: string;
  sessionToken: string | null;
  sessionSecret: string | null;
  /**
   * QR/App2App/Web2App холбоосын суурь URL (ж: `https://ca.eidmongolia.mn/dl`). Холбоосыг
   * өөрөө угсрахгүй — backend-д {@link buildDeviceLink}-ээр (v3).
   */
  deviceLinkBase: string | null;
  /**
   * Verification Code (5 оронтой) — иргэний утсан дээр харагдах кодтой НҮДЭЭР тулгахад RP UI-д
   * харуулна. ПИН БИШ. Холбоосын `vc` параметрт мөн орно.
   */
  vc: string | null;
  rpChallenge: string;
  acsp?: AcspContext;
  /**
   * RP backend энэ хариуг хүлээн авсан мөч (ms epoch, SDK `Date.now()`-оор тэмдэглэнэ) — v3 QR-ийн
   * `elapsedSeconds`-ийн эх ({@link buildDeviceLink} `receivedAt`). sessionToken/sessionSecret-тэй хамт
   * ЗӨВХӨН backend-д хадгална.
   */
  receivedAt: number;
  /** auth | sign | cert ({@link deviceLinkInput}-д). Хуучин хадгалсан session-д undefined = auth. */
  sessionType?: "auth" | "sign" | "cert";
  /** Sign session-д ({@link deviceLinkInput}, `validateSign`); бусад үед undefined. */
  sign?: SignContext;
  /** Certificate-choice session-ий хүсэлтэд илгээсэн нэр (cert холбоосын authCode-д). */
  relyingPartyName?: string;
  /**
   * Session дуусах мөч (ms epoch): CA-ийн start хариуны `expiresAt`; хуучин CA-д sign / certificate-choice-д тооцоолсон
   * ({@link startExpiry}), auth-д undefined.
   */
  expiresAt?: number;
}

/** Session poll-ийн нэгтгэсэн үр дүн (validator-т орох түүхий материал). */
export interface SessionResult {
  state: SessionState | string;
  endResult: EndResult | null;
  documentNumber: string | null;
  /** Иргэний X.509 гэрчилгээ (DER, base64). cert chain validation-д орно. */
  certificateDerB64: string | null;
  certificateLevel: CertificateLevel | string | null;
  /** Гарын үсгийн утга (base64). rpChallenge/digest-ийн эсрэг баталгаажна. */
  signatureValueB64: string | null;
  signatureAlgorithm: string | null;
  signatureProtocol: string | null;
  /** ACSP_V2 (auth): серверийн санамсаргүй (base64), утасны challenge (base64url), урсгал. */
  serverRandom: string | null;
  userChallenge: string | null;
  flowType: string | null;
  /**
   * ACSP_V2 payload-д гарын үсэг зурагдсан `initialCallbackUrl` (хариуны `signature.initialCallbackUrl`,
   * eID нэмэлт). Smart-ID: QR/Notification → `""`, Web2App/App2App → RP-ийн илгээсэн URL. null = хариунд
   * талбар алга (хуучин CA). Validator үүнийг зөвхөн `""` эсвэл RP-ийн өөрийн callback байхад л хүлээн авна.
   */
  initialCallbackUrl?: string | null;
  signatureAlgorithmParameters: SignatureAlgorithmParameters | null;
  interactionTypeUsed: string | null;
  /**
   * Байгууллагын нэрийн өмнөөс (нэвтрэлт эсвэл гарын үсэг) байсан бол — СЕРВЕР төлөөллийн
   * эрхийг session үүсэх үед шалгасны баталгаа. null бол ердийн хувь хүний session.
   * RP энэ талбарыг л итгэж уншина (клиентийн сонголтод биш). docs/ORG_LOGIN.md.
   */
  onBehalfOf: OrgResult | null;
  /**
   * PAdES (`POST /pdf/sign/prepare`) session-ий `pdf` блок — PDF урсгал биш бол null (талбар алга = хуучин SDK-аар
   * угсарсан объект). {@link PdfSessionBlock}.
   */
  pdf?: PdfSessionBlock | null;
  /**
   * COMPLETE+OK auth session-ий `person` блок (CA бүртгэлээс: кирилл нэр, төрсөн огноо, хүйс — гэрчилгээнд байдаггүй).
   * Зөвхөн session эзэмшигч RP-д; CA иргэнийг олоогүй бол null. ГАРЫН ҮСЭГТ ОРДОГГҮЙ — validateAuth-ийн дараа
   * {@link personMatchesCertificate}-ээр гэрчилгээний SERIALNUMBER (`PNOMN-<civilId>`)-тэй тулгаж л хэрэглэнэ.
   */
  person?: PersonBlock | null;
  /** USB токены гэрчилгээ олголтын session-ий `tokenCertificate` блок (`token.issueCertificate`); бусад урсгалд null. */
  tokenCertificate?: TokenCertSessionBlock | null;
  /** Серверийн хариуны түүхий JSON (`parseSessionResult`-ийн оролт) — SDK задлаагүй талбарт. */
  raw?: unknown;
}

/**
 * Session-ий `person` блок (CA `dto.PersonBlock`). Нэршил core.gerege.mn-тэй нэг мөр — гурван нэр ӨӨР ойлголт:
 * `firstName` = нэр, `lastName` = ЭЦГИЙН нэр (гэрчилгээнд ордог), `familyName` = УРГИЙН овог (гэрчилгээнд ОРОХГҮЙ).
 * Мэдэгдэхгүй талбар undefined — RP заавал байх талбар гэж үзэхгүй.
 */
export interface PersonBlock {
  firstName?: string;
  lastName?: string;
  familyName?: string;
  firstNameEn?: string;
  lastNameEn?: string;
  civilId?: string;
  regNo?: string;
  /** YYYY-MM-DD (цаг/бүсгүй). */
  birthDate?: string;
  /** M | F | X. */
  gender?: string;
  /** core.gerege.mn-ий дотоод дугаар; байхгүй = тулгагдаагүй. */
  geID?: number;
}

/** Токены гэрчилгээ олголтын төлөв. */
export type TokenCertStatus = "PENDING" | "ISSUED" | "FAILED" | "EXPIRED";

/** GET /session/{id}-ийн `tokenCertificate` (TOKEN_CERT §Төлөв). */
export interface TokenCertSessionBlock {
  status: TokenCertStatus | string;
  /** FAILED үед: endResult (USER_REFUSED, TIMEOUT …) эсвэл CSR_DIGEST_MISMATCH, TOKEN_LIMIT_REACHED г.м. */
  errorCode?: string;
  authSerialHex?: string;
  signSerialHex?: string;
}

/** PDF баримтын төлөв: PENDING → READY (эсвэл FAILED / EXPIRED). */
export type PdfDocumentStatus = "PENDING" | "READY" | "FAILED" | "EXPIRED";

/** PAdES гаралтын гарын үсэг зурагч. */
export interface PdfSigner {
  etsi: string;
  certSerial: string;
  /** Байгууллагын нэрийн өмнөөс бол байгууллагын ETSI (`NTRMN-…`) — баримтад бичигдсэн утга. */
  onBehalfOf?: string;
  /** CMS signer-attributes-v2-д бичигдсэн мэдүүлсэн үүрэг: «<албан тушаал>, <нэр> (NTRMN-…)». */
  claimedRole?: string;
}

/** GET /session/{id}-ийн `pdf` объект (PAdES, CA угсарна). */
export interface PdfSessionBlock {
  docID: string;
  documentStatus: PdfDocumentStatus | string;
  /** FAILED үед — ж: `REPRESENTATION_REVOKED` (prepare-ээс хойш эрх хасагдсан, баримт үүсээгүй). */
  errorCode?: string;
  /** Гарын үсэгтэй PDF-ийн SHA-256 (hex) — татсан файлтай тулгана. */
  outSha256?: string;
  size?: number;
  expiresAt?: string;
  signatureLevel?: string;
  signer?: PdfSigner;
  validation?: { indication: string; ltv: boolean; signatures: number };
}

/** Иргэний төлөөлж чадах нэг байгууллага (GET /organization/representations/etsi/{personEtsi}). */
export interface Representation {
  /** `NTRMN-<бүртгэл>` — `onBehalfOf`-д өгөх утга. */
  orgEtsi: string;
  orgRegister: string;
  orgName: string;
  orgNameEn?: string;
  /**
   * Албан тушаалын машин утга (ХУР-аас холбогдсонд `ceo` / `founder` / `stakeholder`, MANAGER-т ADMIN-ий бичсэн
   * текст) — өөрөө орчуулахгүй, хүнд {@link Representation.roleLabel}-ийг харуулна.
   */
  role?: string;
  /**
   * Албан тушаалын хүнд харуулах нэр (CA нэг газраас; хэл: `ClientConfig.language` → `Accept-Language`, анхдагч mn).
   * Хуучин CA-д байхгүй.
   */
  roleLabel?: string;
  rightType: "ADMIN" | "MANAGER" | string;
  /** Эрхийн төрлийн хүнд харуулах нэр (ADMIN → «Админ», MANAGER → «Гарын үсэг зурагч»; хэл нь `roleLabel`-тэй ижил). Хуучин CA-д байхгүй. */
  rightTypeLabel?: string;
  source: "REGISTRY" | "MANUAL" | string;
  /** Эх үүсвэрийн хүнд харуулах нэр (REGISTRY → «Улсын бүртгэл», MANUAL → «Захирал нэмсэн»; хэл нь `roleLabel`-тэй ижил). Хуучин CA-д байхгүй. */
  sourceLabel?: string;
  /** ISO 8601. */
  validFrom: string;
  /** ISO 8601; байхгүй = хугацаагүй. */
  validTo?: string;
}

/** GET /organization/representations/etsi/{personEtsi} хариу. */
export interface RepresentationsResponse {
  personEtsi: string;
  representations: Representation[];
  /** Серверийн түүхий JSON (SDK задлаагүй шинэ талбарт). */
  raw?: unknown;
}

/** Session-ий байгууллагын блок — байгууллага + тухайн иргэний эрх (бүртгэлээс real-time). */
export interface OrgResult {
  /** `NTRMN-<улсын бүртгэлийн дугаар>`. */
  orgEtsi: string;
  orgName: string | null;
  /** Албан тушаалын машин утга (`ceo`, MANUAL текст) — өөрөө орчуулахгүй. Эрх хураагдсан бол null. */
  role: string | null;
  /** Албан тушаалын хүнд харуулах нэр ({@link Representation.roleLabel}). Эрх хураагдсан / хуучин CA бол байхгүй. */
  roleLabel?: string;
  /** ADMIN | MANAGER. Эрх хураагдсан бол null. */
  rightType: string | null;
  /** Эрхийн төрлийн хүнд харуулах нэр ({@link Representation.rightTypeLabel}). Эрх хураагдсан / хуучин CA бол байхгүй. */
  rightTypeLabel?: string;
}

/** RP-ийн нэвтрэх мэдээлэл — бүх дуудлагад хэрэгтэй таних тэмдэг + secret. */
export interface RpCredentials {
  /** relying_parties-д бүртгэлтэй RP UUID. */
  rpUUID: string;
  /**
   * Дэд системийн нэр (ж: «Интернэт банк») — CA-д session бүрд хадгалагдана, ≤120 тэмдэгт
   * (сервер илүүг таслана). Иргэний утсан дээр харагдах нэр нь RP-ийн бүртгэлийн нэр.
   */
  rpName: string;
  /** API secret (rp_sk_…). Зөвхөн backend-д хадгална — браузерт ХЭЗЭЭ Ч задлахгүй. */
  apiSecret: string;
}
