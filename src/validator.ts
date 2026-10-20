// ResponseValidator — RP-API-аас ирсэн session хариуг КРИПТОГРАФААР баталгаажуулна.
// ⚠️ Энэ бол SDK-ийн гол аюулгүйн давхарга. endResult==OK гэдэгт ДАНГААР нь итгэхгүй:
// RP-API эвдэрсэн/proxy хийгдсэн бол хуурамч OK ирж болзошгүй. Иймд:
//   1) state==COMPLETE && endResult==OK
//   2) Иргэний cert-ийг trust anchor (Mongolian National Root CA) хүртэл chain-аар баталгаажуулах
//   3) cert хүчинтэй хугацаанд байх + шаардсан certLevel хангах
//   4) Гарын үсгийг иргэний cert-ийн public key-ээр шалгах (signatureAlgorithm-ийн дагуу:
//      rsassa-pss / shaNNNWithRSAEncryption / хуучин ecdsa-with-SHA256):
//        auth → ACSP_V2 payload (Smart-ID v3: serverRandom|rpChallenge|userChallenge|rpName|…) дээр
//        sign → RP-ийн өгсөн digest дээр (prehashed)
// Аль нэг алхам бүтэлгүйтвэл ValidationError шиднэ — хариунд ИТГЭХГҮЙ.

import { X509Certificate, constants, createHash, publicDecrypt, verify, type KeyObject } from "node:crypto";
import { buildAcspV2Payload, hashLen, nodeHash } from "./crypto.js";
import { SessionFailedError, ValidationError } from "./errors.js";
import { INTERMEDIATES, NATIONAL_ROOT } from "./pades/assets/chain.js";
import { certExtension, certExtensions, oidOf, parseSubject, tlv, type CertSubject } from "./subject.js";
import type { AcspContext, CertificateLevel, FlowType, SessionResult, SignatureAlgorithm } from "./types.js";

/**
 * validateAuth-ийн нэмэлт шалгалт — RP ЯМАР урсгал эхлүүлснээ мэддэг тул түүнийг тулгана
 * (device-link relay хаалт).
 */
export interface ValidateAuthOptions {
  /**
   * RP-ийн ХАРУУЛСАН device link-ийн төрөл (эсвэл push). Өгвөл гарын үсэг зурагдсан ACSP_V2 `flowType`
   * ЯГ ИЖИЛ байх ёстой: QR хуудас → "QR"; гар утасны браузер дахь товч → "Web2App"; RP-ийн апп дахь
   * товч → "App2App"; push → "Notification". "Web2App"/"App2App" үед `userChallengeVerifier` ЗААВАЛ.
   *
   * v3 холбоосонд (`buildDeviceLink`) төрөл нь authCode-оор хамгаалагдсан — сервер түүнийг session-д
   * бэхэлж, `flowType` = тэр төрөл. Нэг хуудсанд QR ба товч хоёуланг харуулсан бол: callback-аар
   * (verifier-тэй) ирсэн үр дүнг "Web2App"/"App2App"-аар, poll-оор ирснийг "QR"-аар шалга — товчоор
   * нээгдсэн session poll замаар OK болохгүй, callback-аар л дуусна.
   *
   * Legacy `/dl?sessionId&vc` холбоос 2026-10-07-нд серверээс хасагдсан — төрөл үргэлж authCode-оор хамгаалагдана.
   */
  expectedFlowType?: FlowType;
  /**
   * Callback URL-ийн `userChallengeVerifier` параметр (same-device урсгалд апп RP руу буцаахдаа
   * нэмдэг). Өгвөл `BASE64URL(SHA-256(UTF-8(verifier)))` нь гарын үсэг зурагдсан `userChallenge`-тэй
   * таарах ёстой.
   */
  userChallengeVerifier?: string;
}

/**
 * validateSign-ийн нэмэлт шалгалт. Гуравдах параметрт мөр (`hashAlgorithm`) эсвэл энэ объектыг өгнө.
 */
export interface ValidateSignOptions {
  /** digest-ийг үүсгэсэн hash (хүсэлтэд илгээсэнтэй ижил; default SHA-256). */
  hashAlgorithm?: string;
  /**
   * RP-ийн эхлүүлсэн урсгал (device-link: "QR" / "Web2App" / "App2App"; push → "Notification"). Өгвөл хариуны
   * `flowType` ЯГ ИЖИЛ байх ёстой, эс бөгөөс `ValidationError` — validateAuth-ийн `expectedFlowType`-тэй ижил.
   * ⚠️ RAW_DIGEST_SIGNATURE-д `flowType` гарын үсэгт ОРДОГГҮЙ (зөвхөн digest зурагдана) — энэ нь RP-API хариуны
   * тулгалт, криптограф баталгаа биш.
   */
  expectedFlowType?: FlowType;
  /**
   * Хүсэлтэд илгээсэн signatureAlgorithm (`s.sign.signatureAlgorithm`). Өгвөл хариуны RSA алгоритм ЯГ ИЖИЛ байх ёстой:
   * `sha256WithRSAEncryption` хүссэн session-д `rsassa-pss` (эсвэл эсрэгээр) хариу → `ValidationError`. CA-ийн хуучин
   * threshold-ECDSA credential хүссэнээс үл хамааран `ecdsa-with-SHA256` буцаадаг (түлхүүрийн төрөл гэрчилгээнд
   * бэхлэгдсэн) — зөвхөн EC P-256 гэрчилгээ + SHA-256 үед зөвшөөрнө. Өгөөгүй бол хуучин зан (RSA алгоритмыг тулгахгүй).
   */
  expectedAlgorithm?: SignatureAlgorithm;
  /**
   * Урьдчилж мэдсэн гэрчилгээ (certificate-choice: `signer.certificate`). Өгвөл хариуны гэрчилгээ байт-ижил байх ёстой —
   * өөр төхөөрөмж/гэрчилгээгээр зурсан бол (олон утастай иргэн) `ValidationError`.
   */
  expectedCertificate?: X509Certificate;
}

/**
 * Certificate-choice-оор баталгаажсан гарын үсэг зурагч ({@link ResponseValidator.validateCertificateChoice}) —
 * `sign.digestForSigner` / `sign.deviceLinkForSigner`-д өгнө.
 */
export interface Signer {
  /** Гэрчилгээг сонгосон ЯГ ТЭР төхөөрөмж — sign session-ийг ҮҮГЭЭР эхлүүлнэ. */
  documentNumber: string;
  /** Иргэний SIGN гэрчилгээ (KeyUsage contentCommitment). */
  certificate: X509Certificate;
  /** DER, стандарт base64. */
  certificateDerB64: string;
  certificateLevel: string;
  parsedSubject: CertSubject;
  /** Certificate-choice session (linked sign-ийн `linkedSessionID`). */
  certChoiceSessionId: string | null;
}

/**
 * RevocationChecker — иргэний cert revoke хийгдсэн эсэхийг шалгах hook (OCSP/CRL).
 * Сүлжээний I/O шаардсан тул async. RP нь cert доторх AIA (OCSP) / CDP (CRL) URL-аар
 * хэрэгжүүлнэ. "good" = хүчинтэй, "revoked" = цуцлагдсан, "unknown" = тогтоогдсонгүй.
 */
export type RevocationStatus = "good" | "revoked" | "unknown";
/**
 * {@link ResponseValidator.checkRevocationStatus}-ийн амжилттай дүн: "good" — issuer хүчинтэй гэж хариулсан;
 * "unchecked" — "unknown", soft-fail горимд зөвшөөрөв; "skipped" — revocation hook тохируулаагүй.
 */
export type RevocationOutcome = "good" | "unchecked" | "skipped";

/**
 * eID Mongolia Issuing CA (04)-ийн Subject Key Identifier — иргэний утасны болон USB токены AUTH/SIGN гэрчилгээг
 * гаргадаг цорын ганц CA. `TrustConfig.allowedIssuerSkis`-д.
 */
export const CITIZEN_ISSUING_CA_SKI = "b8a37f2c64ad677912db7d9e34f246358a2fb909";
const derB64ToPem = (b64: string): string =>
  `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

/**
 * Mongolian National Root CA (01) — итгэлийн тулгуур (`TrustConfig.trustAnchorsPem`). Нийтийн эх:
 * https://ca.eidmongolia.mn/pki/mongolian-national-root-ca.cer. Go SDK `eid.NationalRootCAPEM`-тэй ижил.
 */
export const NATIONAL_ROOT_CA_PEM: string = derB64ToPem(NATIONAL_ROOT[0]!);

/**
 * Иргэний гэрчилгээний завсрын CA-ууд: 02 National Issuing CA (MDDC) → 03 Gerege Issuing CA → 04 eID Mongolia Issuing
 * CA. RP-API хариунд гинж ирдэггүй — `TrustConfig.intermediatesPem` өгөөгүй бол (0.19.0-аас) эдгээрийг анхдагчаар
 * хэрэглэнэ. Go SDK `eid.CitizenIntermediatesPEM`-тэй ижил.
 */
export const CITIZEN_INTERMEDIATES_PEM: readonly string[] = Object.freeze(INTERMEDIATES.slice(0, 3).map(derB64ToPem));

export type RevocationChecker = (
  cert: X509Certificate,
  issuer: X509Certificate | undefined,
) => Promise<RevocationStatus>;

export interface TrustConfig {
  /**
   * Trust anchor (Root CA) PEM-үүд. Cert chain эдгээрийн аль нэг хүрэх ёстой.
   * ⚠️ Production-д ЗААВАЛ өг — хоосон бол ValidationError шиднэ (allowUntrusted-аар л
   * үл тоомсорлоно — зөвхөн dev/тест).
   */
  trustAnchorsPem?: string[];
  /** Intermediate CA PEM-үүд (leaf ↔ root хооронд). Алга бол {@link CITIZEN_INTERMEDIATES_PEM} (02, 03, 04; 0.19.0-аас). */
  intermediatesPem?: string[];
  /** Шаардах certLevel (default QUALIFIED). ADVANCED тохируулбал доод түвшин зөвшөөрнө. */
  requiredLevel?: CertificateLevel;
  /** Cert validity шалгахад зөвшөөрөх цагийн зөрүү (мс, default 0). */
  clockSkewMs?: number;
  /**
   * Trust anchor өгөөгүй ч баталгаажуулалт үргэлжлүүлэхийг ИЛ зөвшөөрнө (default false).
   * ⚠️ true бол cert-ийг trust anchor хүртэл chain хийхгүй — зөвхөн dev/тест.
   */
  allowUntrusted?: boolean;
  /**
   * Revocation (OCSP/CRL) шалгагч hook. Тохируулаагүй бол revocation ШАЛГАХГҮЙ
   * (QUALIFIED non-repudiation-д RP-ийн үүрэг — checkRevocation-г үзнэ үү).
   */
  revocation?: RevocationChecker;
  /**
   * Revocation шийдвэрийн горим: "hard-fail" — "unknown"-г татгалзана (default
   * revocation тохируулсан үед); "soft-fail" — "unknown"-г зөвшөөрнө.
   */
  revocationMode?: "hard-fail" | "soft-fail";
  /**
   * Иргэний гэрчилгээг шууд гаргасан CA-ийн Subject Key Identifier (hex, ":" зөвшөөрнө) жагсаалт. **0.19.0-аас анхдагч
   * `[CITIZEN_ISSUING_CA_SKI]`** (trust anchor тохируулсан үед) — ижил root-ийн доорх өөр CA (ж: байгууллагын Issuing CA)
   * иргэний гэрчилгээ гаргахаас хамгаална. Өгвөл энэ жагсаалтаар солино (үргэлж шалгана, `allowUntrusted` үед ч).
   * Дурын issuer-ийг зөвшөөрөх бол {@link allowAnyIssuer}.
   */
  allowedIssuerSkis?: string[];
  /**
   * true бол анхдагч issuer allowlist-ийг (`[CITIZEN_ISSUING_CA_SKI]`) унтраана — trust anchor хүртэл гинжлэгдсэн дурын CA
   * (0.18.x-ийн зан). `allowedIssuerSkis` өгсөн бол түүнийг шалгасаар байна. Тест/dev, эсвэл өөр Issuing CA-тай орчинд л.
   */
  allowAnyIssuer?: boolean;
  /**
   * Гэрчилгээний зориулалтыг CA-ийн профайлаар шалгана: auth → KeyUsage digitalSignature + ExtKeyUsage clientAuth
   * (P-CITIZEN-AUTH); sign → KeyUsage contentCommitment / nonRepudiation (P-CITIZEN-SIGN). **0.19.0-аас анхдагч true**
   * — нэвтрэлтийн (PIN1) түлхүүрийн гарын үсэг `validateSign`-д тэнцэхгүй. `false` — шалгахгүй (хуучин зан, зөвлөхгүй).
   */
  checkKeyUsage?: boolean;
  /** ACSP_V2 payload-ийн scheme нэр (CA-ийн `capabilities.acsp_scheme_name`); анхдагч "smart-id". */
  schemeName?: string;
}

/** Баталгаажсан иргэний таних мэдээлэл (auth). */
export interface VerifiedIdentity {
  documentNumber: string;
  /** Иргэний X.509 гэрчилгээ — subject-д РД/нэр. RP цааш parse хийж болно. */
  certificate: X509Certificate;
  /** Cert subject DN (түүхий). Ж: "C=MN, CN=..., SERIALNUMBER=PNOMN-...". */
  subject: string;
  /** Subject-ийн задалсан талбарууд (нэр, ETSI `serialNumber`, улс) — {@link parseSubject}. */
  parsedSubject: CertSubject;
  /**
   * Үнэлэгдсэн түвшин: хариуны `certificateLevel` ба гэрчилгээнээс тогтоосон түвшний ({@link certificateLevelOf}) бага
   * нь. Хариу гэрчилгээнээс өндөр түвшин зарлавал ValidationError.
   */
  certificateLevel: string;
}

/** Баталгаажсан гарын үсэг (sign). */
export interface VerifiedSignature {
  documentNumber: string;
  signatureValueB64: string;
  signatureAlgorithm: string | null;
  certificate: X509Certificate;
  subject: string;
  /** Subject-ийн задалсан талбарууд — {@link parseSubject}. */
  parsedSubject: CertSubject;
  /** Үнэлэгдсэн түвшин ({@link VerifiedIdentity.certificateLevel}-тэй ижил дүрэм; гарын үсгийн гэрчилгээнд qcStatements). */
  certificateLevel: string;
}

export class ResponseValidator {
  private readonly anchors: X509Certificate[];
  private readonly intermediates: X509Certificate[];
  private readonly requiredLevel: CertificateLevel;
  private readonly skew: number;
  private readonly allowUntrusted: boolean;
  private readonly revocation?: RevocationChecker;
  private readonly revocationMode: "hard-fail" | "soft-fail";
  private readonly allowedIssuers?: Set<string>;
  private readonly checkKeyUsage: boolean;
  private readonly schemeName?: string;

  constructor(trust: TrustConfig = {}) {
    this.anchors = (trust.trustAnchorsPem ?? []).map((p) => new X509Certificate(p));
    this.intermediates = (trust.intermediatesPem ?? CITIZEN_INTERMEDIATES_PEM).map((p) => new X509Certificate(p));
    this.requiredLevel = trust.requiredLevel ?? "QUALIFIED";
    this.skew = trust.clockSkewMs ?? 0;
    this.allowUntrusted = trust.allowUntrusted ?? false;
    this.revocation = trust.revocation;
    this.revocationMode = trust.revocationMode ?? "hard-fail";
    const explicitIssuers = trust.allowedIssuerSkis?.length ? trust.allowedIssuerSkis : undefined;
    // Анхдагч allowlist зөвхөн гинж шалгах үед (anchor-тай) — allowUntrusted dev горимд issuer тогтоох гинж алга.
    const issuerList = explicitIssuers ?? (!trust.allowAnyIssuer && this.anchors.length > 0 ? [CITIZEN_ISSUING_CA_SKI] : undefined);
    if (issuerList) {
      this.allowedIssuers = new Set(
        issuerList.map((s) => {
          const ski = s.trim().replace(/:/g, "").toLowerCase();
          if (!/^(?:[0-9a-f]{2})+$/.test(ski)) throw new Error(`ResponseValidator: allowedIssuerSkis: "${s}" hex key identifier биш`);
          return ski;
        }),
      );
    }
    this.checkKeyUsage = trust.checkKeyUsage ?? true;
    this.schemeName = trust.schemeName;
  }

  // ── нийтийн API ──

  /**
   * Auth session-ийн хариуг бүрэн шалгаж, баталгаажсан иргэнийг буцаана.
   * @param acsp — session эхлүүлэхэд SDK-ийн буцаасан `acsp` контекст (RP хадгалсан).
   */
  validateAuth(result: SessionResult, acsp: AcspContext, opts: ValidateAuthOptions = {}): VerifiedIdentity {
    const { leaf, level } = this.precheck(result, "ACSP_V2");
    const { serverRandom, userChallenge, flowType, interactionTypeUsed } = result;
    if (!serverRandom || Buffer.from(serverRandom, "base64").length < 18) throw new ValidationError("serverRandom алга/богино");
    if (!userChallenge || !/^[A-Za-z0-9_-]{43}$/.test(userChallenge)) throw new ValidationError("userChallenge буруу хэлбэртэй");
    if (!flowType || !acsp.flowTypes.includes(flowType as AcspContext["flowTypes"][number])) {
      throw new ValidationError(`flowType ${flowType} нь санал болгосон урсгалд байхгүй`);
    }
    if (opts.expectedFlowType && flowType !== opts.expectedFlowType) {
      throw new ValidationError(`flowType ${flowType} ≠ эхлүүлсэн урсгал ${opts.expectedFlowType} (relay байж болзошгүй)`);
    }
    const sameDevice = opts.expectedFlowType === "Web2App" || opts.expectedFlowType === "App2App";
    if (sameDevice && !opts.userChallengeVerifier) {
      throw new ValidationError(`${opts.expectedFlowType} урсгалд callback-ийн userChallengeVerifier заавал`);
    }
    if (opts.userChallengeVerifier !== undefined && userChallengeOf(opts.userChallengeVerifier) !== userChallenge) {
      throw new ValidationError("userChallengeVerifier нь гарын үсэг зурагдсан userChallenge-тэй таарсангүй");
    }
    if (!interactionTypeUsed) throw new ValidationError("interactionTypeUsed алга");
    const { alg, hash } = this.algorithmOf(result, leaf, acsp.signatureAlgorithm, acsp.hashAlgorithm);
    const payload = buildAcspV2Payload({
      ...(this.schemeName ? { schemeName: this.schemeName } : {}),
      serverRandom,
      rpChallenge: acsp.rpChallenge,
      userChallenge,
      relyingPartyName: acsp.relyingPartyName,
      brokeredRpName: acsp.brokeredRpName,
      interactions: acsp.interactions,
      interactionTypeUsed,
      initialCallbackUrl: signedCallbackUrl(result.initialCallbackUrl, acsp.initialCallbackUrl, flowType),
      flowType,
    });
    if (!verifyPayloadSignature(payload, result.signatureValueB64!, leaf.publicKey, alg, hash)) {
      throw new ValidationError("Auth гарын үсэг ACSP_V2 payload-той таарсангүй (хуурамч хариу байж болзошгүй)");
    }
    return {
      documentNumber: result.documentNumber!,
      certificate: leaf,
      subject: leaf.subject,
      parsedSubject: parseSubject(leaf),
      certificateLevel: level,
    };
  }

  /**
   * Sign session-ийн хариуг бүрэн шалгаж, баталгаажсан гарын үсгийг буцаана.
   * @param opts — `hashAlgorithm` мөр (хуучин хэлбэр; default SHA-256) эсвэл {@link ValidateSignOptions}.
   */
  validateSign(result: SessionResult, digestB64: string, opts: string | ValidateSignOptions = {}): VerifiedSignature {
    const o: ValidateSignOptions = typeof opts === "string" ? { hashAlgorithm: opts } : opts;
    const { hashAlgorithm = "SHA-256", expectedFlowType } = o;
    const { leaf, level } = this.precheck(result, "RAW_DIGEST_SIGNATURE");
    if (expectedFlowType && result.flowType !== expectedFlowType) {
      throw new ValidationError(`flowType ${result.flowType} ≠ эхлүүлсэн урсгал ${expectedFlowType} (relay байж болзошгүй)`);
    }
    if (o.expectedCertificate && !leaf.raw.equals(o.expectedCertificate.raw)) {
      throw new ValidationError(
        `Гэрчилгээ certificate-choice-оор сонгосонтой таарахгүй (serial ${leaf.serialNumber} ≠ ${o.expectedCertificate.serialNumber})`,
      );
    }
    const digest = Buffer.from(digestB64, "base64");
    const { alg, hash } = this.algorithmOf(result, leaf, o.expectedAlgorithm ?? null, hashAlgorithm);
    if (digest.length !== hashLen(hash)) throw new ValidationError("digest урт hashAlgorithm-тай таарахгүй");
    if (!verifyPrehashedSignature(digest, result.signatureValueB64!, leaf.publicKey, alg, hash)) {
      throw new ValidationError("Гарын үсэг өгсөн digest-тэй таарсангүй");
    }
    return {
      documentNumber: result.documentNumber!,
      signatureValueB64: result.signatureValueB64!,
      signatureAlgorithm: result.signatureAlgorithm,
      certificate: leaf,
      subject: leaf.subject,
      parsedSubject: parseSubject(leaf),
      certificateLevel: level,
    };
  }

  /**
   * Certificate-choice session-ий хариуг шалгана: COMPLETE/OK (эс бөгөөс `SessionFailedError`), гэрчилгээ ба
   * documentNumber байгаа, хугацаа, certLevel, зориулалт (гарын үсгийн — contentCommitment, `checkKeyUsage` үед), гинж,
   * issuer. Энэ хариунд гарын үсэг БАЙХГҮЙ — иргэнийг таниагүй (нэвтрэлт биш); зөвхөн дараагийн sign session-ий
   * гэрчилгээг урьдчилж мэдэхэд. `sessionId` — certificate-choice session.
   */
  validateCertificateChoice(result: SessionResult, sessionId: string | null = null): Signer {
    this.sessionDone(result);
    const { leaf, level } = this.leafOf(result, "RAW_DIGEST_SIGNATURE");
    return {
      documentNumber: result.documentNumber!,
      certificate: leaf,
      certificateDerB64: leaf.raw.toString("base64"),
      certificateLevel: level,
      parsedSubject: parseSubject(leaf),
      certChoiceSessionId: sessionId,
    };
  }

  /**
   * Хариуны signatureAlgorithm + hashAlgorithm-ийг RP-ийн хүссэнтэй ба иргэний түлхүүрийн төрөлтэй тулгана
   * (downgrade / alg confusion хаалт).
   *
   * CA-ийн бодит зан (ca-eidmongolia-mn `service/memory/crypto_wired.go` `messageHash`, `domain/enums.go`):
   * RP-API session-ий гарын үсэг хоёр замаас л гарна — SplitKey RSA (`rsassa-pss` / `shaNNNWithRSAEncryption`,
   * hash = хүсэлтийн `hashAlgorithm`) ба legacy threshold ECDSA P-256 (ҮРГЭЛЖ `ecdsa-with-SHA256`). ECDSA credential
   * зөвхөн 32 байт digest зурдаг: session-ий hash SHA-256 биш бол сервер гарын үсэг гаргахгүй (session OK болохгүй).
   * Иймд:
   *   - hash нь ҮРГЭЛЖ хүссэнтэй яг тэнцүү — `ecdsa-with-SHA256` хариу SHA-384/512 хүссэн session-д ирвэл хуурамч;
   *   - `ecdsa-with-SHA256` нь хүссэн `rsassa-pss`-ийн оронд ирж болно (credential-ийн төрөл), ГЭХДЭЭ зөвхөн
   *     EC P-256 түлхүүртэй гэрчилгээнд; RSA алгоритмууд зөвхөн RSA түлхүүрт (alg confusion үгүй).
   */
  private algorithmOf(
    result: SessionResult,
    leaf: X509Certificate,
    wantAlg: string | null,
    wantHash: string,
  ): { alg: string; hash: string } {
    const alg = result.signatureAlgorithm ?? "";
    const keyType = leaf.publicKey.asymmetricKeyType;
    let hash: string;
    if (alg === "rsassa-pss") {
      hash = String(result.signatureAlgorithmParameters?.hashAlgorithm ?? "");
      if (!HASHES.has(hash)) throw new ValidationError(`Дэмжигдээгүй hashAlgorithm: ${hash}`);
      const mgf = result.signatureAlgorithmParameters?.maskGenAlgorithm?.parameters?.hashAlgorithm;
      if (mgf && mgf !== hash) throw new ValidationError("MGF1 hash нь hashAlgorithm-аас өөр");
      if (result.signatureAlgorithmParameters?.saltLength != null && result.signatureAlgorithmParameters.saltLength !== hashLen(hash)) {
        throw new ValidationError("saltLength ≠ hLen");
      }
      if (keyType !== "rsa" && keyType !== "rsa-pss") throw new ValidationError(`${alg} нь ${keyType} түлхүүртэй таарахгүй`);
    } else if (/^sha(256|384|512)WithRSAEncryption$/.test(alg)) {
      hash = "SHA-" + alg.slice(3, 6);
      if (keyType !== "rsa") throw new ValidationError(`${alg} нь ${keyType} түлхүүртэй таарахгүй`);
    } else if (alg === "ecdsa-with-SHA256") {
      hash = "SHA-256";
      if (keyType !== "ec" || leaf.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new ValidationError(`${alg} нь EC P-256 бус түлхүүртэй таарахгүй`);
      }
      if (wantHash !== hash) {
        // CA ECDSA credential-аар SHA-256-аас өөр hash зурдаггүй — ийм хариу серверээс гарахгүй.
        throw new ValidationError(`ecdsa-with-SHA256 хариу ${wantHash} хүссэн session-д боломжгүй (ECDSA credential зөвхөн SHA-256)`);
      }
    } else {
      throw new ValidationError(`Дэмжигдээгүй signatureAlgorithm: ${alg}`);
    }
    if (wantAlg && alg !== wantAlg && alg !== "ecdsa-with-SHA256") {
      throw new ValidationError(`signatureAlgorithm ${alg} ≠ хүссэн ${wantAlg}`);
    }
    if (hash !== wantHash) throw new ValidationError(`hashAlgorithm ${hash} ≠ хүссэн ${wantHash}`);
    return { alg, hash };
  }

  // ── дотоод ──

  /** state/endResult, cert байгаа эсэх, chain, validity, certLevel — нийтлэг шалгалт. */
  private precheck(result: SessionResult, protocol: string): { leaf: X509Certificate; level: CertificateLevel } {
    this.sessionDone(result);
    if (result.signatureProtocol && result.signatureProtocol !== protocol) {
      throw new ValidationError(`signatureProtocol ${result.signatureProtocol} ≠ ${protocol}`);
    }
    if (!result.certificateDerB64) throw new ValidationError("Хариунд гэрчилгээ алга");
    if (!result.signatureValueB64) throw new ValidationError("Хариунд гарын үсэг алга");
    return this.leafOf(result, protocol);
  }

  /** COMPLETE + OK; амжилтгүй endResult → SessionFailedError. */
  private sessionDone(result: SessionResult): void {
    if (result.state !== "COMPLETE") throw new ValidationError(`Session дуусаагүй (state=${result.state})`);
    if (result.endResult !== "OK") throw new SessionFailedError(result.endResult ?? "UNKNOWN");
  }

  /** Хариуны гэрчилгээ: documentNumber, задлалт, хугацаа, certLevel, зориулалт (protocol), гинж, issuer. */
  private leafOf(result: SessionResult, protocol: string): { leaf: X509Certificate; level: CertificateLevel } {
    if (!result.certificateDerB64) throw new ValidationError("Хариунд гэрчилгээ алга");
    if (!result.documentNumber) throw new ValidationError("Хариунд documentNumber алга");

    const leaf = new X509Certificate(Buffer.from(result.certificateDerB64, "base64"));
    this.checkValidity(leaf);
    this.verifyCertificate(leaf, protocol);
    const level = effectiveLevel(String(result.certificateLevel ?? ""), certificateLevelOf(leaf, protocol));
    this.checkLevel(level);
    return { leaf, level };
  }

  /**
   * Токены нэвтрэлтийн гэрчилгээ ({@link TokenApi.authVerify}) — хугацаа, зориулалт (auth), гинж, issuer. Түвшинг
   * шалгахгүй (USB токен ADVANCED).
   * @internal
   */
  verifyTokenAuthCertificate(leaf: X509Certificate): void {
    this.checkValidity(leaf);
    this.verifyCertificate(leaf, "ACSP_V2");
  }

  /** Зориулалт (protocol), гинж, issuer — хугацаа/түвшнийг дуудагч шалгасан. */
  private verifyCertificate(leaf: X509Certificate, protocol: string): void {
    this.checkPurpose(leaf, protocol);
    // Trust anchor ЗААВАЛ — хоосон бол fail-closed (allowUntrusted-аар л үл тоомсорлоно).
    // Өмнө нь anchor хоосон үед chain ЧИМЭЭГҮЙ алгасч, self-asserted leaf-д итгэдэг байсан.
    if (this.anchors.length === 0) {
      if (!this.allowUntrusted) {
        throw new ValidationError(
          "Trust anchor тохируулаагүй — итгэлцэл шалгах боломжгүй (production-д trustAnchorsPem өг, эсвэл allowUntrusted=true)",
        );
      }
    } else {
      this.verifyChain(leaf, protocol === "ACSP_V2" ? EKU_CLIENT_AUTH : EKU_EMAIL_PROTECTION);
    }
    this.checkIssuer(leaf);
  }

  /**
   * checkKeyUsage үед гэрчилгээний зориулалт протоколд тохирох эсэх (CA crypto/ca_profile.go): ACSP_V2 (auth) → KU
   * digitalSignature + EKU clientAuth (эсвэл anyExtendedKeyUsage); RAW_DIGEST_SIGNATURE (sign) → KU contentCommitment.
   */
  private checkPurpose(leaf: X509Certificate, protocol: string): void {
    if (!this.checkKeyUsage) return;
    const ku = keyUsageBits(leaf);
    if (protocol === "ACSP_V2") {
      if (!(ku & 0x80)) throw new ValidationError("Нэвтрэлтийн гэрчилгээнд KeyUsage digitalSignature алга");
      const eku = extKeyUsage(leaf);
      if (!eku.includes("1.3.6.1.5.5.7.3.2") && !eku.includes("2.5.29.37.0")) {
        throw new ValidationError("Нэвтрэлтийн гэрчилгээнд ExtKeyUsage clientAuth алга (гарын үсгийн гэрчилгээ байж болзошгүй)");
      }
      return;
    }
    if (!(ku & 0x40)) throw new ValidationError("Гарын үсгийн гэрчилгээнд KeyUsage nonRepudiation (contentCommitment) алга");
  }

  /** allowedIssuerSkis үед leaf-ийн шууд issuer-ийн SKI (issuer-т алга бол leaf-ийн AKI) жагсаалтад байх ёстой. */
  private checkIssuer(leaf: X509Certificate): void {
    if (!this.allowedIssuers) return;
    const issuer = this.findIssuer(leaf);
    const ski = (issuer && subjectKeyId(issuer)) ?? authorityKeyId(leaf);
    if (!ski || !this.allowedIssuers.has(ski)) {
      throw new ValidationError("Гэрчилгээг гаргасан CA зөвшөөрөгдсөн иргэний issuer биш (allowedIssuerSkis)");
    }
  }

  private checkValidity(cert: X509Certificate): void {
    const now = Date.now();
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (!Number.isNaN(from) && now + this.skew < from) throw new ValidationError("Гэрчилгээ хүчинтэй болоогүй байна");
    if (!Number.isNaN(to) && now - this.skew > to) throw new ValidationError("Гэрчилгээний хугацаа дууссан");
  }

  private checkLevel(level: string): void {
    // Дараалал ADVANCED < QUALIFIED < QSCD: шаардсанаас дээш түвшнийг хүлээн авна (QSCD нь QUALIFIED-ийг хангана).
    const got = LEVEL_RANK[level] ?? 0;
    const need = LEVEL_RANK[this.requiredLevel] ?? 2;
    if (got < need) throw new ValidationError(`Гэрчилгээний түвшин хүрэлцэхгүй: ${level} < ${this.requiredLevel}`);
  }

  /**
   * RFC 5280 замын шалгалт (Go SDK-ийн `x509.Certificate.Verify`-тэй ижил дүрэм): leaf-ээс trust anchor хүртэлх
   * замыг intermediates/anchors-оос (backtracking-тай) угсарна. Issuer бүр: subject = child.issuer, AKI/SKI таарах,
   * гарын үсэг, CA (basicConstraints CA:TRUE), KeyUsage тавьсан бол keyCertSign, **pathLenConstraint** (доорх
   * завсрын CA-ийн тоо), хүчинтэй хугацаа, EKU тавьсан бол `usage` / anyExtendedKeyUsage агуулах. Leaf болон CA
   * бүрийн үл таних **critical extension** → татгалзана. **Name constraints**-ийг SDK үнэлдэггүй — гинжинд байвал
   * fail-closed (CA-ийн бодит гинж 01–04-т алга). Цаг = now, leaf-ийн хүчинтэй хугацаанд хавчсан (`clockSkewMs`-ийн
   * хүрээнд; leaf-ийн хугацааг checkValidity шалгасан). certificatePolicies шалгахгүй (Go-той ижил).
   */
  private verifyChain(leaf: X509Certificate, usage: string): void {
    const now = Math.min(Math.max(Date.now(), Date.parse(leaf.validFrom)), Date.parse(leaf.validTo));
    const leafReason = criticalReason(leaf) ?? ekuReason(leaf, usage);
    if (leafReason) throw new ValidationError(`Гэрчилгээний гинж хүчингүй: ${leafReason}`);
    let reason: string | undefined;
    const extend = (cur: X509Certificate, cas: X509Certificate[]): boolean => {
      if (cas.length >= 8) return false;
      for (const [cand, isAnchor] of [
        ...this.anchors.map((c) => [c, true] as const),
        ...this.intermediates.map((c) => [c, false] as const),
      ]) {
        if (cas.includes(cand) || !signedBy(cur, cand)) continue;
        const bad = caReason(cand, cas.length, now, usage);
        if (bad) {
          reason ??= bad;
          continue;
        }
        if (isAnchor || extend(cand, [...cas, cand])) return true;
      }
      return false;
    };
    if (extend(leaf, [])) return;
    throw new ValidationError(
      reason ? `Гэрчилгээний гинж хүчингүй: ${reason}` : "Гэрчилгээний итгэлцлийн гинж trust anchor (Root CA) хүрсэнгүй",
    );
  }

  /** leaf-ийн шууд issuer-ийг trust pool-оос буцаана (revocation шалгагчид issuer хэрэгтэй). */
  private findIssuer(leaf: X509Certificate): X509Certificate | undefined {
    return [...this.intermediates, ...this.anchors].find(
      (c) => isCa(c) && leaf.checkIssued(c) && leaf.verify(c.publicKey),
    );
  }

  /**
   * checkRevocation — тохируулсан RevocationChecker hook-оор cert-ийн revoke төлвийг
   * шалгана. revocation тохируулаагүй бол no-op (true буцаана). "revoked" үед, мөн
   * hard-fail горимд "unknown" үед ValidationError шиднэ. validateAuth/Sign-ийн дараа
   * дуудна (тэдгээр нь sync; revocation нь сүлжээ I/O тул async).
   */
  async checkRevocation(cert: X509Certificate): Promise<void> {
    await this.checkRevocationStatus(cert);
  }

  /**
   * {@link checkRevocation} + юу шийдсэнийг буцаана (лог/аудитад): "good" | "unchecked" (unknown, soft-fail) |
   * "skipped" (hook алга). "revoked", мөн hard-fail горимд "unknown" → ValidationError; hook-ийн алдаа дамжина.
   */
  async checkRevocationStatus(cert: X509Certificate): Promise<RevocationOutcome> {
    return this.checkRevocationWith(cert, this.revocation, this.revocationMode);
  }

  /**
   * {@link checkRevocationStatus}-тэй ижил, гэхдээ TrustConfig-ийн биш өгсөн checker ба горимоор (issuer-ийг trust
   * pool-оос олно). checker алга бол "skipped"; горим анхдагч "hard-fail".
   */
  async checkRevocationWith(
    cert: X509Certificate,
    checker: RevocationChecker | undefined,
    mode: "hard-fail" | "soft-fail" = "hard-fail",
  ): Promise<RevocationOutcome> {
    if (!checker) return "skipped"; // hook алга — RP-ийн үүрэг
    const status = await checker(cert, this.findIssuer(cert));
    if (status === "good") return "good";
    if (status === "revoked") {
      throw new ValidationError("Гэрчилгээ цуцлагдсан (revoked)");
    }
    if (mode === "hard-fail") {
      throw new ValidationError("Гэрчилгээний revocation төлөв тогтоогдсонгүй (hard-fail)");
    }
    return "unchecked";
  }

}

/**
 * ACSP_V2 payload-ийн `initialCallbackUrl` — CA урсгалаар шийднэ (Smart-ID: QR/Notification → `""`,
 * Web2App/App2App → RP-ийн callback).
 * Хариуны утгыг (`signature.initialCallbackUrl`) ашиглана, ГЭХДЭЭ зөвхөн `""` эсвэл RP-ийн session start-д
 * илгээсэн callback-тай байт-ижил бол — дурын утгад итгэхгүй. Web2App/App2App-д заавал RP-ийн callback.
 * Талбар алга (хуучин CA) → RP-ийн callback (өмнөх зан).
 */
export function signedCallbackUrl(fromResponse: string | null | undefined, rpCallback: string | undefined, flowType: string): string {
  const rp = rpCallback ?? "";
  if (fromResponse == null) return rp;
  if (fromResponse !== "" && fromResponse !== rp) {
    throw new ValidationError("signature.initialCallbackUrl нь хоосон ч биш, илгээсэн callback ч биш (хуурамч хариу байж болзошгүй)");
  }
  if ((flowType === "Web2App" || flowType === "App2App") && fromResponse !== rp) {
    throw new ValidationError(`${flowType} урсгалд signature.initialCallbackUrl нь илгээсэн callback байх ёстой`);
  }
  return fromResponse;
}

/** Payload (auth) дээрх гарын үсэг — алгоритмаар салаалж node:crypto verify. */
/** Smart-ID: userChallenge = BASE64URL(SHA-256(UTF-8(userChallengeVerifier))), padding-гүй. */
export function userChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function verifyPayloadSignature(payload: Buffer, sigB64: string, key: KeyObject, alg: string, hash: string): boolean {
  const sig = Buffer.from(sigB64, "base64");
  const h = nodeHash(hash);
  if (alg === "rsassa-pss") {
    return verify(h, payload, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: hashLen(hash) }, sig);
  }
  if (alg === "ecdsa-with-SHA256") return verify(h, payload, { key, dsaEncoding: "der" }, sig);
  return verify(h, payload, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
}

/** Prehashed digest (sign) дээрх гарын үсэг. RSA: raw public op + EMSA-PSS-VERIFY / PKCS#1 DigestInfo. */
export function verifyPrehashedSignature(digest: Buffer, sigB64: string, key: KeyObject, alg: string, hash: string): boolean {
  const sig = Buffer.from(sigB64, "base64");
  // node:crypto нь EC-д prehashed verify (algorithm=null) хийдэггүй → P-256 ECDSA-г өөрөө шалгана.
  if (alg === "ecdsa-with-SHA256") return ecdsaP256VerifyPrehashed(digest, sig, key);
  const modBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (!modBits || sig.length !== Math.ceil(modBits / 8)) return false;
  let em: Buffer;
  try {
    em = publicDecrypt({ key, padding: constants.RSA_NO_PADDING }, sig);
  } catch {
    return false;
  }
  if (alg === "rsassa-pss") return emsaPssVerify(digest, em, modBits - 1, hash);
  const prefix = DIGEST_INFO[hash];
  if (!prefix) return false;
  const t = Buffer.concat([prefix, digest]);
  const expected = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(em.length - t.length - 3, 0xff), Buffer.from([0x00]), t]);
  return em.length === expected.length && em.equals(expected);
}

// ── P-256 ECDSA prehashed verify (хуучин threshold-ECDSA cert-д; node:crypto-д raw EC verify байхгүй) ──
const P256 = {
  p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};
type Pt = [bigint, bigint] | null; // null = хязгааргүй цэг
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function inv(a: bigint, m: bigint): bigint {
  let [g, x, y, u] = [mod(a, m), 1n, 0n, m];
  while (g !== 0n) {
    const q = u / g;
    [u, g, y, x] = [g, u - q * g, x, y - q * x];
  }
  return mod(y, m);
}
function ptAdd(P: Pt, Q: Pt): Pt {
  if (!P) return Q;
  if (!Q) return P;
  const { p } = P256;
  let l: bigint;
  if (P[0] === Q[0]) {
    if (mod(P[1] + Q[1], p) === 0n) return null;
    l = mod((3n * P[0] * P[0] - 3n) * inv(2n * P[1], p), p);
  } else {
    l = mod((Q[1] - P[1]) * inv(Q[0] - P[0], p), p);
  }
  const x = mod(l * l - P[0] - Q[0], p);
  return [x, mod(l * (P[0] - x) - P[1], p)];
}
function ptMul(k: bigint, P: Pt): Pt {
  let R: Pt = null;
  for (let b = P; k > 0n; k >>= 1n, b = ptAdd(b, b)) if (k & 1n) R = ptAdd(R, b);
  return R;
}
function derInts(sig: Buffer): [bigint, bigint] | null {
  // SEQUENCE { INTEGER r, INTEGER s } — богино хэлбэрийн урттай (P-256-д ≤ 72 байт).
  if (sig[0] !== 0x30 || sig[1] !== sig.length - 2) return null;
  let i = 2;
  const out: bigint[] = [];
  for (let k = 0; k < 2; k++) {
    if (sig[i] !== 0x02) return null;
    const len = sig[i + 1] ?? 0;
    out.push(BigInt("0x" + (sig.subarray(i + 2, i + 2 + len).toString("hex") || "0")));
    i += 2 + len;
  }
  return i === sig.length ? [out[0]!, out[1]!] : null;
}
function ecdsaP256VerifyPrehashed(digest: Buffer, sig: Buffer, key: KeyObject): boolean {
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
  const jwk = key.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) return false;
  const Q: Pt = [BigInt("0x" + Buffer.from(jwk.x, "base64url").toString("hex")), BigInt("0x" + Buffer.from(jwk.y, "base64url").toString("hex"))];
  const rs = derInts(sig);
  if (!rs) return false;
  const [r, sv] = rs;
  const { n } = P256;
  if (r <= 0n || r >= n || sv <= 0n || sv >= n) return false;
  const z = BigInt("0x" + digest.subarray(0, 32).toString("hex")); // зүүн 256 бит
  const w = inv(sv, n);
  const R = ptAdd(ptMul(mod(z * w, n), [P256.gx, P256.gy]), ptMul(mod(r * w, n), Q));
  return R !== null && mod(R[0], n) === r;
}

const HASHES = new Set(["SHA-256", "SHA-384", "SHA-512"]);

/** PKCS#1 v1.5 DigestInfo DER угтвар (RFC 8017 §9.2). */
const DIGEST_INFO: Record<string, Buffer> = {
  "SHA-256": Buffer.from("3031300d060960864801650304020105000420", "hex"),
  "SHA-384": Buffer.from("3041300d060960864801650304020205000430", "hex"),
  "SHA-512": Buffer.from("3051300d060960864801650304020305000440", "hex"),
};

/** MGF1 (RFC 8017 §B.2.1). */
function mgf1(hash: string, seed: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  for (let i = 0, n = 0; n < length; i++, n += hashLen(hash)) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(i, 0);
    out.push(createHash(nodeHash(hash)).update(seed).update(c).digest());
  }
  return Buffer.concat(out).subarray(0, length);
}

/** EMSA-PSS-VERIFY (RFC 8017 §9.1.2), sLen = hLen. em нь k байт (зүүн 0 нөхөлттэй байж болно). */
function emsaPssVerify(mHash: Buffer, em: Buffer, emBits: number, hash: string): boolean {
  const hLen = hashLen(hash);
  const sLen = hLen;
  const emLen = Math.ceil(emBits / 8);
  if (em.length > emLen) {
    if (!em.subarray(0, em.length - emLen).every((b) => b === 0)) return false;
    em = em.subarray(em.length - emLen);
  }
  if (emLen < hLen + sLen + 2 || em[emLen - 1] !== 0xbc) return false;
  const maskedDB = em.subarray(0, emLen - hLen - 1);
  const h = em.subarray(emLen - hLen - 1, emLen - 1);
  const topBits = 8 * emLen - emBits;
  if (topBits > 0 && (maskedDB[0] ?? 0) >> (8 - topBits) !== 0) return false;
  const db = Buffer.from(maskedDB);
  const mask = mgf1(hash, h, db.length);
  for (let i = 0; i < db.length; i++) db[i] = (db[i] ?? 0) ^ (mask[i] ?? 0);
  if (topBits > 0) db[0] = (db[0] ?? 0) & (0xff >> topBits);
  const psLen = emLen - hLen - sLen - 2;
  if (!db.subarray(0, psLen).every((b) => b === 0) || db[psLen] !== 0x01) return false;
  const salt = db.subarray(psLen + 1);
  const h2 = createHash(nodeHash(hash)).update(Buffer.alloc(8)).update(mHash).update(salt).digest();
  return h.equals(h2);
}

/** KeyUsage (2.5.29.15) BIT STRING-ийн эхний байт (digitalSignature 0x80, nonRepudiation 0x40); алга бол 0. */
function keyUsageBits(cert: X509Certificate): number {
  const v = certExtension(cert.raw, "2.5.29.15");
  if (!v) return 0;
  const bs = tlv(v, 0, v.length);
  if (bs.tag !== 0x03 || bs.end - bs.start < 2) return 0;
  return v[bs.start + 1]!;
}

const LEVEL_RANK: Record<string, number> = { ADVANCED: 1, QUALIFIED: 2, QSCD: 3 };
const OID_QC_STATEMENTS = "1.3.6.1.5.5.7.1.3";
const OID_QC_COMPLIANCE = "0.4.0.1862.1.1";
const OID_QC_SSCD = "0.4.0.1862.1.4";

/**
 * Гэрчилгээнээс тогтоох түвшин (CA `crypto/ca_profile.go`): qcStatements-д QcCompliance → QUALIFIED (+ QcSSCD →
 * QSCD); qcStatements алга бол — гарын үсгийн гэрчилгээ ADVANCED (USB токен), нэвтрэлтийн гэрчилгээ (CA AUTH-д
 * qcStatements бичдэггүй) KeyUsage-аар: keyEncipherment-тэй (утасны P-CITIZEN-AUTH) → QUALIFIED, үгүй (токены
 * P-CITIZEN-AUTH-TOKEN) → ADVANCED. `protocol` — "ACSP_V2" (auth) эсвэл "RAW_DIGEST_SIGNATURE" (sign).
 */
export function certificateLevelOf(cert: X509Certificate, protocol: string): CertificateLevel {
  const qc = qcStatementIds(cert);
  if (qc) {
    if (!qc.includes(OID_QC_COMPLIANCE)) return "ADVANCED";
    return qc.includes(OID_QC_SSCD) ? "QSCD" : "QUALIFIED";
  }
  if (protocol === "ACSP_V2" && keyUsageBits(cert) & 0x20) return "QUALIFIED";
  return "ADVANCED";
}

/**
 * Хариуны түвшин гэрчилгээнийхээс өндөр бол ValidationError (хуурамч/proxy хариу); бага бол хариуныхыг (RP-ийн хүссэн
 * доод түвшин). Хариунд түвшин алга/үл таних бол гэрчилгээнийх.
 */
function effectiveLevel(claimed: string, fromCert: CertificateLevel): CertificateLevel {
  const c = LEVEL_RANK[claimed];
  if (c === undefined) return fromCert;
  if (c > LEVEL_RANK[fromCert]!) {
    throw new ValidationError(`Хариуны certificateLevel ${claimed} гэрчилгээнээс (${fromCert}) өндөр`);
  }
  return claimed as CertificateLevel;
}

/** qcStatements (1.3.6.1.5.5.7.1.3)-ийн statementId-ууд; extension алга бол undefined. */
function qcStatementIds(cert: X509Certificate): string[] | undefined {
  const v = certExtension(cert.raw, OID_QC_STATEMENTS);
  if (!v) return undefined;
  const seq = tlv(v, 0, v.length);
  if (seq.tag !== 0x30) throw new ValidationError("qcStatements буруу");
  const out: string[] = [];
  for (let p = seq.start; p < seq.end; ) {
    const st = tlv(v, p, seq.end);
    if (st.tag !== 0x30) throw new ValidationError("qcStatements буруу");
    out.push(oidOf(v, tlv(v, st.start, st.end)));
    p = st.end;
  }
  return out;
}

/** ExtKeyUsage (2.5.29.37) OID-ууд; алга бол []. */
function extKeyUsage(cert: X509Certificate): string[] {
  const v = certExtension(cert.raw, "2.5.29.37");
  if (!v) return [];
  const seq = tlv(v, 0, v.length);
  const out: string[] = [];
  for (let p = seq.start; p < seq.end; ) {
    const t = tlv(v, p, seq.end);
    out.push(oidOf(v, t));
    p = t.end;
  }
  return out;
}

/** SubjectKeyIdentifier (2.5.29.14), жижиг үсгийн hex. */
function subjectKeyId(cert: X509Certificate): string | undefined {
  const v = certExtension(cert.raw, "2.5.29.14");
  if (!v) return undefined;
  const o = tlv(v, 0, v.length);
  return o.tag === 0x04 && o.end > o.start ? Buffer.from(v.subarray(o.start, o.end)).toString("hex") : undefined;
}

/** AuthorityKeyIdentifier (2.5.29.35)-ийн keyIdentifier [0], жижиг үсгийн hex. */
function authorityKeyId(cert: X509Certificate): string | undefined {
  const v = certExtension(cert.raw, "2.5.29.35");
  if (!v) return undefined;
  const seq = tlv(v, 0, v.length);
  if (seq.start >= seq.end) return undefined;
  const k = tlv(v, seq.start, seq.end);
  return k.tag === 0x80 && k.end > k.start ? Buffer.from(v.subarray(k.start, k.end)).toString("hex") : undefined;
}

/** isCa — cert нь CA мөн эсэх (basicConstraints CA:TRUE). Node X509Certificate.ca getter. */
function isCa(cert: X509Certificate): boolean {
  return cert.ca === true;
}

// ── гинжийн шалгалт (RFC 5280, Go crypto/x509-тэй ижил) ──

const EKU_ANY = "2.5.29.37.0";
const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const EKU_EMAIL_PROTECTION = "1.3.6.1.5.5.7.3.4";
const OID_NAME_CONSTRAINTS = "2.5.29.30";
/** SDK-ийн ойлгодог critical extension-ууд (Go crypto/x509-ийн задалдагтай ижил); бусад critical → татгалзана. */
const HANDLED_CRITICAL = new Set([
  "2.5.29.14", // subjectKeyIdentifier
  "2.5.29.15", // keyUsage
  "2.5.29.17", // subjectAltName
  "2.5.29.19", // basicConstraints
  "2.5.29.30", // nameConstraints (CA-д — caReason fail-closed)
  "2.5.29.31", // cRLDistributionPoints
  "2.5.29.32", // certificatePolicies
  "2.5.29.35", // authorityKeyIdentifier
  "2.5.29.37", // extKeyUsage
  "1.3.6.1.5.5.7.1.1", // authorityInfoAccess
]);

/** child-ийг cand гаргасан эсэх: issuer нэр = subject, AKI/SKI (хоёулаа байвал) таарах, гарын үсэг. */
function signedBy(child: X509Certificate, cand: X509Certificate): boolean {
  if (child.issuer !== cand.subject) return false;
  const aki = authorityKeyId(child);
  const ski = subjectKeyId(cand);
  if (aki && ski && aki !== ski) return false;
  try {
    return child.verify(cand.publicKey);
  } catch {
    return false;
  }
}

/** Үл таних critical extension байвал шалтгаан. */
function criticalReason(cert: X509Certificate): string | undefined {
  return certExtensions(cert.raw).some((e) => e.critical && !HANDLED_CRITICAL.has(e.oid)) ? "үл таних critical extension" : undefined;
}

/** EKU тавьсан бол `usage` эсвэл anyExtendedKeyUsage агуулах ёстой (EKU-гүй = дурын). */
function ekuReason(cert: X509Certificate, usage: string): string | undefined {
  const eku = extKeyUsage(cert);
  return eku.length && !eku.includes(usage) && !eku.includes(EKU_ANY)
    ? "гэрчилгээний ExtKeyUsage энэ үйлдэлд тохирохгүй (гинжийн EKU)"
    : undefined;
}

/** issuer CA-ийн шалгалт; below = энэ CA-аас доорх завсрын CA-ийн тоо (leaf-ийг тооцохгүй). */
function caReason(ca: X509Certificate, below: number, now: number, usage: string): string | undefined {
  if (!isCa(ca)) return "завсрын гэрчилгээ CA биш эсвэл keyCertSign эрхгүй";
  if (certExtension(ca.raw, "2.5.29.15") && !(keyUsageBits(ca) & 0x04)) return "CA-ийн KeyUsage-д keyCertSign алга";
  const from = Date.parse(ca.validFrom);
  const to = Date.parse(ca.validTo);
  if (Number.isNaN(from) || Number.isNaN(to) || now < from || now > to) {
    return "гинжийн гэрчилгээний хугацаа дууссан эсвэл хүчинтэй болоогүй";
  }
  const pathLen = basicConstraintsPathLen(ca);
  if (pathLen !== undefined && below > pathLen) return "pathLenConstraint зөрчсөн (завсрын CA хэт олон)";
  if (certExtension(ca.raw, OID_NAME_CONSTRAINTS)) return "CA-д name constraints байна (SDK үнэлдэггүй — fail-closed)";
  return criticalReason(ca) ?? ekuReason(ca, usage);
}

/** basicConstraints-ийн pathLenConstraint; алга бол undefined. */
function basicConstraintsPathLen(cert: X509Certificate): number | undefined {
  const v = certExtension(cert.raw, "2.5.29.19");
  if (!v) return undefined;
  const seq = tlv(v, 0, v.length);
  for (let p = seq.start; p < seq.end; ) {
    const t = tlv(v, p, seq.end);
    if (t.tag === 0x02) {
      if (t.end - t.start > 4 || (v[t.start]! & 0x80) !== 0) throw new ValidationError("basicConstraints: pathLen буруу");
      let n = 0;
      for (let i = t.start; i < t.end; i++) n = n * 256 + v[i]!;
      return n;
    }
    p = t.end;
  }
  return undefined;
}
