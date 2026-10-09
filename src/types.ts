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
  /** Бүртгэлийн албан тушаал (ХУР-аас холбогдсонд `ceo` / `founder`, MANAGER-т ADMIN-ий бичсэн текст). */
  role?: string;
  rightType: "ADMIN" | "MANAGER" | string;
  source: "REGISTRY" | "MANUAL" | string;
  /** ISO 8601. */
  validFrom: string;
  /** ISO 8601; байхгүй = хугацаагүй. */
  validTo?: string;
}

/** GET /organization/representations/etsi/{personEtsi} хариу. */
export interface RepresentationsResponse {
  personEtsi: string;
  representations: Representation[];
}

/** Session-ий байгууллагын блок — байгууллага + тухайн иргэний эрх (бүртгэлээс real-time). */
export interface OrgResult {
  /** `NTRMN-<улсын бүртгэлийн дугаар>`. */
  orgEtsi: string;
  orgName: string | null;
  /** Албан тушаал (ж: "Захирал"). Эрх хураагдсан бол null. */
  role: string | null;
  /** ADMIN | MANAGER. Эрх хураагдсан бол null. */
  rightType: string | null;
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
