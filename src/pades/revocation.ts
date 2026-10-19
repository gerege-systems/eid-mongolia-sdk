// Цуцлалтын нотолгооны (OCSP/CRL) шинэлэг байдал ба тохирлын нэг дүрэм — Go SDK pades/internal/validate/revocation.go-ийн
// порт. DSS (offline), онлайн OCSP/CRL, LTV хамралт, complete-ийн DSS цуглуулалт бүгд үүгээр шийднэ (golden validate/v4).

import { TAG, children, expect, intValue, oidString, parseOne, parsePreciseTime, readNode, type Node } from "./asn1.js";
import { equal } from "./bytes.js";
import { digest } from "./crypto.js";
import { verifySignature, type Certificate } from "./x509.js";
import { addMs, after, before, fromPrecise, isZero, type GoTime } from "./validate/gofmt.js";

/** nextUpdate-гүй (эсвэл шалгах цагийг хамраагүй) хариуны thisUpdate нь шалгах цагаас хамгийн ихдээ ийм хугацаагаар өмнө. */
export const REVOCATION_MAX_AGE_MS = 24 * 3600_000;
/** Responder ба шалгагчийн цагийн зөрүүний хүлцэл. */
export const REVOCATION_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Go validate.FreshAt — thisUpdate/nextUpdate-тэй хариу (OCSP SingleResponse эсвэл CRL) at агшны «good» нотолгоо болох эсэх:
 * thisUpdate тэг биш, now+skew-ээс хожуу биш; nextUpdate (байвал) at−skew-ээс өмнө биш; thisUpdate ≥ at − 24ц, эсвэл
 * [thisUpdate, nextUpdate] нь at-ийг хамарна. at — шалгах цаг (итгэмжлэгдсэн цагийн тэмдгийн цаг, эс бөгөөс now).
 * «Revoked» нотолгоонд хамаарахгүй — цуцлалт буцахгүй.
 */
export function freshAt(thisUpdate: GoTime, nextUpdate: GoTime, at: GoTime, now: GoTime): boolean {
  if (isZero(thisUpdate) || after(thisUpdate, addMs(now, REVOCATION_CLOCK_SKEW_MS))) return false;
  if (!isZero(nextUpdate) && before(nextUpdate, addMs(at, -REVOCATION_CLOCK_SKEW_MS))) return false;
  if (!before(thisUpdate, addMs(at, -REVOCATION_MAX_AGE_MS))) return true;
  return !isZero(nextUpdate) && !after(thisUpdate, at);
}

const OCSP_HASHES: Record<string, "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};

/**
 * Go validate.OCSPCertIDMatches — OCSP хариуны (DER) cert-ийн serial-тэй SingleResponse БҮР нь issuer-ийн CertID-тэй
 * (issuerNameHash = H(issuer subject), issuerKeyHash = H(issuer subjectPublicKey)) бөгөөд дор хаяж нэг нь байна. Зөвхөн
 * serial-аар сонговол өөр олгогчийн ижил serial-ийн хариу энэ гэрчилгээнд тооцогдоно.
 */
export async function ocspCertIDMatches(der: Uint8Array, cert: Certificate, issuer: Certificate): Promise<boolean> {
  try {
    const top = children(expect(readNode(der), TAG.SEQUENCE, "OCSPResponse"));
    const st = expect(top[0], TAG.ENUMERATED, "status");
    if (st.value.length !== 1 || st.value[0] !== 0) return false;
    const rb = children(expect(children(expect(top[1], 0xa0, "responseBytes"))[0], TAG.SEQUENCE, "ResponseBytes"));
    expect(rb[0], TAG.OID, "responseType");
    const basic = children(expect(readNode(expect(rb[1], TAG.OCTET_STRING, "response").value), TAG.SEQUENCE, "BasicOCSPResponse"));
    const tf = children(expect(basic[0], TAG.SEQUENCE, "tbsResponseData"));
    let i = 0;
    if (tf[i]?.tag === 0xa0) i++;
    if (!tf[i++]) return false; // responderID
    expect(tf[i++], TAG.GeneralizedTime, "producedAt");
    const singles = children(expect(tf[i], TAG.SEQUENCE, "responses"));
    const serial = intValue(cert.serial);
    let found = false;
    for (const single of singles) {
      const cid = children(expect(children(expect(single, TAG.SEQUENCE, "SingleResponse"))[0], TAG.SEQUENCE, "CertID"));
      const alg = oidString(expect(children(expect(cid[0], TAG.SEQUENCE, "hashAlgorithm"))[0], TAG.OID, "hash").value);
      const nameHash = expect(cid[1], TAG.OCTET_STRING, "issuerNameHash").value;
      const keyHash = expect(cid[2], TAG.OCTET_STRING, "issuerKeyHash").value;
      if (intValue(expect(cid[3], TAG.INTEGER, "serial").value) !== serial) continue;
      const h = OCSP_HASHES[alg];
      if (!h) return false;
      if (!equal(nameHash, await digest(h, issuer.rawSubject)) || !equal(keyHash, await digest(h, issuer.publicKey))) return false;
      found = true;
    }
    return found;
  } catch {
    return false;
  }
}

// ── CRL ──

export interface ParsedCRL {
  rawIssuer: Uint8Array;
  tbs: Uint8Array;
  sigAlg: Node;
  sig: Uint8Array;
  thisUpdate: GoTime;
  /** Тэг — байхгүй. */
  nextUpdate: GoTime;
  /** authorityKeyIdentifier-ийн keyIdentifier (хоосон — байхгүй). */
  authorityKeyId: Uint8Array;
  revoked: { serial: bigint; time: GoTime }[];
}

const OID_AKI = "2.5.29.35";
const isTime = (n: Node | undefined): n is Node => n !== undefined && (n.tag === TAG.UTCTime || n.tag === TAG.GeneralizedTime);

/** x509.ParseRevocationList-ийн хэрэгтэй хэсэг. */
export function parseCRL(der: Uint8Array): ParsedCRL | undefined {
  try {
    const top = children(expect(parseOne(der), TAG.SEQUENCE, "CertificateList"));
    const tbs = expect(top[0], TAG.SEQUENCE, "TBSCertList");
    const sigAlg = expect(top[1], TAG.SEQUENCE, "sigAlg");
    const sigBits = expect(top[2], TAG.BIT_STRING, "sig");
    const f = children(tbs);
    let i = 0;
    if (f[i]?.tag === TAG.INTEGER) i++;
    expect(f[i++], TAG.SEQUENCE, "signature");
    const issuer = expect(f[i++], TAG.SEQUENCE, "issuer");
    const tu = f[i++];
    if (!isTime(tu)) return undefined;
    const thisUpdate = fromPrecise(parsePreciseTime(tu));
    let nextUpdate: GoTime = { nanos: 0 };
    if (isTime(f[i])) nextUpdate = fromPrecise(parsePreciseTime(f[i++]!));
    const revoked: ParsedCRL["revoked"] = [];
    if (f[i]?.tag === TAG.SEQUENCE) {
      for (const e of children(f[i++]!)) {
        const p = children(expect(e, TAG.SEQUENCE, "entry"));
        revoked.push({ serial: intValue(expect(p[0], TAG.INTEGER, "serial").value), time: fromPrecise(parsePreciseTime(p[1]!)) });
      }
    }
    let authorityKeyId: Uint8Array = new Uint8Array();
    if (f[i]?.tag === 0xa0) {
      for (const ext of children(expect(children(f[i]!)[0], TAG.SEQUENCE, "extensions"))) {
        const e = children(ext);
        if (oidString(expect(e[0], TAG.OID, "extnID").value) !== OID_AKI) continue;
        const k = children(parseOne(expect(e[e.length - 1], TAG.OCTET_STRING, "extnValue").value)).find((x) => x.tag === 0x80);
        if (k) authorityKeyId = k.value;
      }
    }
    return { rawIssuer: issuer.raw, tbs: tbs.raw, sigAlg, sig: sigBits.value.subarray(1), thisUpdate, nextUpdate, authorityKeyId, revoked };
  } catch {
    return undefined;
  }
}

/** SHA-1/MD5 гарын үсгийн алгоритм (Go CheckSignature татгалзана). */
export const SHA1_SIG = new Set(["1.2.840.113549.1.1.5", "1.2.840.10045.4.1", "1.2.840.10040.4.3", "1.2.840.113549.1.1.4"]);

/** Go RevocationList.CheckSignatureFrom (SHA-1 татгалзана). */
export async function crlSignedBy(crl: ParsedCRL, issuer: Certificate): Promise<boolean> {
  if ((issuer.version === 3 && !issuer.basicConstraintsValid) || (issuer.basicConstraintsValid && !issuer.isCA)) return false;
  if (issuer.keyUsage !== 0 && !(issuer.keyUsage & (1 << 6))) return false;
  if (SHA1_SIG.has(oidString(children(crl.sigAlg)[0]!.value))) return false;
  try {
    return await verifySignature(issuer, crl.sigAlg, crl.tbs, crl.sig);
  } catch {
    return false;
  }
}

function subjectKeyId(c: Certificate): Uint8Array {
  const v = c.extensions.find((e) => e.oid === "2.5.29.14")?.value;
  if (!v) return new Uint8Array();
  try {
    const n = parseOne(v);
    return n.tag === TAG.OCTET_STRING ? n.value : new Uint8Array();
  } catch {
    return new Uint8Array();
  }
}

/**
 * Go validate.CRLFor — crl нь cert-ийн олгогчийнх: нэр = cert.rawIssuer = issuer.rawSubject, AKI (хоёуланд байвал) =
 * issuer-ийн SKI, гарын үсэг issuer-ийн түлхүүрээр.
 */
export async function crlFor(crl: ParsedCRL, cert: Certificate, issuer: Certificate): Promise<boolean> {
  if (!equal(crl.rawIssuer, cert.rawIssuer) || !equal(crl.rawIssuer, issuer.rawSubject)) return false;
  const ski = subjectKeyId(issuer);
  if (crl.authorityKeyId.length > 0 && ski.length > 0 && !equal(crl.authorityKeyId, ski)) return false;
  return crlSignedBy(crl, issuer);
}

/** Go validate.CRLListed — cert-ийн serial crl-д байвал цуцалсан цаг. */
export function crlListed(crl: ParsedCRL, cert: Certificate): GoTime | undefined {
  const serial = intValue(cert.serial);
  return crl.revoked.find((e) => e.serial === serial)?.time;
}

/** Олгогчийн гарын үсэгтэй «revoked» хариу (OCSP эсвэл CRL) — complete-д дахин оролдохгүй хатуу алдаа (Go ErrCertificateRevoked). */
export class CertificateRevokedError extends Error {
  constructor() {
    super("гэрчилгээ цуцлагдсан");
    this.name = "CertificateRevokedError";
  }
}
