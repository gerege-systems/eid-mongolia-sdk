// ResponseValidator — RP-API-аас ирсэн session хариуг КРИПТОГРАФААР баталгаажуулна.
// ⚠️ Энэ бол SDK-ийн гол аюулгүйн давхарга. endResult==OK гэдэгт ДАНГААР нь итгэхгүй:
// RP-API эвдэрсэн/proxy хийгдсэн бол хуурамч OK ирж болзошгүй. Иймд:
//   1) state==COMPLETE && endResult==OK
//   2) Иргэний cert-ийг trust anchor (Gerege Root CA) хүртэл chain-аар баталгаажуулах
//   3) cert хүчинтэй хугацаанд байх + шаардсан certLevel хангах
//   4) Гарын үсгийг иргэний cert-ийн public key-ээр шалгах (signatureAlgorithm-ийн дагуу:
//      rsassa-pss / shaNNNWithRSAEncryption / хуучин ecdsa-with-SHA256):
//        auth → ACSP_V2 payload (Smart-ID v3: serverRandom|rpChallenge|userChallenge|rpName|…) дээр
//        sign → RP-ийн өгсөн digest дээр (prehashed)
// Аль нэг алхам бүтэлгүйтвэл ValidationError шиднэ — хариунд ИТГЭХГҮЙ.

import { X509Certificate, constants, createHash, publicDecrypt, verify, type KeyObject } from "node:crypto";
import { buildAcspV2Payload, hashLen, nodeHash } from "./crypto.js";
import { SessionFailedError, ValidationError } from "./errors.js";
import type { AcspContext, CertificateLevel, FlowType, SessionResult } from "./types.js";

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
   * ⚠️ Legacy `/dl?sessionId&vc` холбоосонд төрөл хамгаалагдаагүй — build 59 + `min_version=59` хүртэл
   * энэ шалгалт relay-ээс бүрэн хамгаалахгүй.
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
 * RevocationChecker — иргэний cert revoke хийгдсэн эсэхийг шалгах hook (OCSP/CRL).
 * Сүлжээний I/O шаардсан тул async. RP нь cert доторх AIA (OCSP) / CDP (CRL) URL-аар
 * хэрэгжүүлнэ. "good" = хүчинтэй, "revoked" = цуцлагдсан, "unknown" = тогтоогдсонгүй.
 */
export type RevocationStatus = "good" | "revoked" | "unknown";
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
  /** Intermediate CA PEM-үүд (leaf ↔ root хооронд). */
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
}

/** Баталгаажсан иргэний таних мэдээлэл (auth). */
export interface VerifiedIdentity {
  documentNumber: string;
  /** Иргэний X.509 гэрчилгээ — subject-д РД/нэр. RP цааш parse хийж болно. */
  certificate: X509Certificate;
  /** Cert subject DN (түүхий). Ж: "C=MN, CN=..., SERIALNUMBER=PNOMN-...". */
  subject: string;
  certificateLevel: string;
}

/** Баталгаажсан гарын үсэг (sign). */
export interface VerifiedSignature {
  documentNumber: string;
  signatureValueB64: string;
  signatureAlgorithm: string | null;
  certificate: X509Certificate;
  subject: string;
}

export class ResponseValidator {
  private readonly anchors: X509Certificate[];
  private readonly intermediates: X509Certificate[];
  private readonly requiredLevel: CertificateLevel;
  private readonly skew: number;
  private readonly allowUntrusted: boolean;
  private readonly revocation?: RevocationChecker;
  private readonly revocationMode: "hard-fail" | "soft-fail";

  constructor(trust: TrustConfig = {}) {
    this.anchors = (trust.trustAnchorsPem ?? []).map((p) => new X509Certificate(p));
    this.intermediates = (trust.intermediatesPem ?? []).map((p) => new X509Certificate(p));
    this.requiredLevel = trust.requiredLevel ?? "QUALIFIED";
    this.skew = trust.clockSkewMs ?? 0;
    this.allowUntrusted = trust.allowUntrusted ?? false;
    this.revocation = trust.revocation;
    this.revocationMode = trust.revocationMode ?? "hard-fail";
  }

  // ── нийтийн API ──

  /**
   * Auth session-ийн хариуг бүрэн шалгаж, баталгаажсан иргэнийг буцаана.
   * @param acsp — session эхлүүлэхэд SDK-ийн буцаасан `acsp` контекст (RP хадгалсан).
   */
  validateAuth(result: SessionResult, acsp: AcspContext, opts: ValidateAuthOptions = {}): VerifiedIdentity {
    const leaf = this.precheck(result, "ACSP_V2");
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
    const { alg, hash } = this.algorithmOf(result, acsp.signatureAlgorithm, acsp.hashAlgorithm);
    const payload = buildAcspV2Payload({
      serverRandom,
      rpChallenge: acsp.rpChallenge,
      userChallenge,
      relyingPartyName: acsp.relyingPartyName,
      brokeredRpName: acsp.brokeredRpName,
      interactions: acsp.interactions,
      interactionTypeUsed,
      initialCallbackUrl: acsp.initialCallbackUrl,
      flowType,
    });
    if (!verifyPayloadSignature(payload, result.signatureValueB64!, leaf.publicKey, alg, hash)) {
      throw new ValidationError("Auth гарын үсэг ACSP_V2 payload-той таарсангүй (хуурамч хариу байж болзошгүй)");
    }
    return {
      documentNumber: result.documentNumber!,
      certificate: leaf,
      subject: leaf.subject,
      certificateLevel: String(result.certificateLevel ?? ""),
    };
  }

  /**
   * Sign session-ийн хариуг бүрэн шалгаж, баталгаажсан гарын үсгийг буцаана.
   * @param hashAlgorithm — digest-ийг үүсгэсэн hash (хүсэлтэд илгээсэнтэй ижил; default SHA-256).
   */
  validateSign(result: SessionResult, digestB64: string, hashAlgorithm = "SHA-256"): VerifiedSignature {
    const leaf = this.precheck(result, "RAW_DIGEST_SIGNATURE");
    const digest = Buffer.from(digestB64, "base64");
    const { alg, hash } = this.algorithmOf(result, null, hashAlgorithm);
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
    };
  }

  /**
   * Хариуны signatureAlgorithm + hashAlgorithm-ийг RP-ийн хүссэнтэй тулгана (downgrade хаалт).
   * ecdsa-with-SHA256 (хуучин cert) хүссэн rsassa-pss-ийн оронд ирэхийг зөвшөөрнө — SHA-256-аар л.
   */
  private algorithmOf(result: SessionResult, wantAlg: string | null, wantHash: string): { alg: string; hash: string } {
    const alg = result.signatureAlgorithm ?? "";
    let hash: string;
    if (alg === "rsassa-pss") {
      hash = String(result.signatureAlgorithmParameters?.hashAlgorithm ?? "");
      const mgf = result.signatureAlgorithmParameters?.maskGenAlgorithm?.parameters?.hashAlgorithm;
      if (mgf && mgf !== hash) throw new ValidationError("MGF1 hash нь hashAlgorithm-аас өөр");
      if (result.signatureAlgorithmParameters?.saltLength != null && result.signatureAlgorithmParameters.saltLength !== hashLen(hash)) {
        throw new ValidationError("saltLength ≠ hLen");
      }
    } else if (/^sha(256|384|512)WithRSAEncryption$/.test(alg)) {
      hash = "SHA-" + alg.slice(3, 6);
    } else if (alg === "ecdsa-with-SHA256") {
      hash = "SHA-256";
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
  private precheck(result: SessionResult, protocol: string): X509Certificate {
    if (result.state !== "COMPLETE") throw new ValidationError(`Session дуусаагүй (state=${result.state})`);
    if (result.endResult !== "OK") throw new SessionFailedError(result.endResult ?? "UNKNOWN");
    if (result.signatureProtocol && result.signatureProtocol !== protocol) {
      throw new ValidationError(`signatureProtocol ${result.signatureProtocol} ≠ ${protocol}`);
    }
    if (!result.certificateDerB64) throw new ValidationError("Хариунд гэрчилгээ алга");
    if (!result.signatureValueB64) throw new ValidationError("Хариунд гарын үсэг алга");
    if (!result.documentNumber) throw new ValidationError("Хариунд documentNumber алга");

    const leaf = new X509Certificate(Buffer.from(result.certificateDerB64, "base64"));
    this.checkValidity(leaf);
    this.checkLevel(String(result.certificateLevel ?? ""));
    // Trust anchor ЗААВАЛ — хоосон бол fail-closed (allowUntrusted-аар л үл тоомсорлоно).
    // Өмнө нь anchor хоосон үед chain ЧИМЭЭГҮЙ алгасч, self-asserted leaf-д итгэдэг байсан.
    if (this.anchors.length === 0) {
      if (!this.allowUntrusted) {
        throw new ValidationError(
          "Trust anchor тохируулаагүй — итгэлцэл шалгах боломжгүй (production-д trustAnchorsPem өг, эсвэл allowUntrusted=true)",
        );
      }
    } else {
      this.verifyChain(leaf);
    }
    return leaf;
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
    const rank: Record<string, number> = { ADVANCED: 1, QUALIFIED: 2, QSCD: 3 };
    const got = rank[level] ?? 0;
    const need = rank[this.requiredLevel] ?? 2;
    if (got < need) throw new ValidationError(`Гэрчилгээний түвшин хүрэлцэхгүй: ${level} < ${this.requiredLevel}`);
  }

  /** leaf-ээс эхлэн issuer-ийг intermediates/anchors дотроос олж, anchor хүртэл chain зангидна. */
  private verifyChain(leaf: X509Certificate): void {
    let current = leaf;
    const pool = [...this.intermediates, ...this.anchors];
    for (let depth = 0; depth < 8; depth++) {
      // current-ийг trust anchor аль нэг шууд гаргасан уу? (M5: issuer нь CA байх ёстой)
      for (const anchor of this.anchors) {
        if (isCa(anchor) && current.checkIssued(anchor) && current.verify(anchor.publicKey)) return;
      }
      // эс бөгөөс intermediate/anchor дундаас issuer-ийг олж нэг шат дээшил (зөвхөн CA cert)
      const issuer = pool.find(
        (c) => isCa(c) && current.checkIssued(c) && current.verify(c.publicKey),
      );
      if (!issuer) break;
      current = issuer;
    }
    throw new ValidationError("Гэрчилгээний итгэлцлийн гинж trust anchor (Root CA) хүрсэнгүй");
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
    if (!this.revocation) return; // hook алга — RP-ийн үүрэг (warn доор аль хэдийн баримтжсан)
    const status = await this.revocation(cert, this.findIssuer(cert));
    if (status === "revoked") {
      throw new ValidationError("Гэрчилгээ цуцлагдсан (revoked)");
    }
    if (status === "unknown" && this.revocationMode === "hard-fail") {
      throw new ValidationError("Гэрчилгээний revocation төлөв тогтоогдсонгүй (hard-fail)");
    }
  }

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

/** isCa — cert нь CA мөн эсэх (basicConstraints CA:TRUE). Node X509Certificate.ca getter. */
function isCa(cert: X509Certificate): boolean {
  return cert.ca === true;
}
