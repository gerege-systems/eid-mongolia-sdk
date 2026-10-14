// CMS SignedData (CAdES baseline, detached) — Go reference core/cms.go-той байт-ижил: signedAttrs (SET OF DER эрэмбэ),
// signer-attributes-v2 (claimedRole), AssembleCMS. Мөн TSA token-ийг задлах/шалгах (digitorus pkcs7.Verify-ийн дэд хэсэг).

import { TAG, children, ctx, expect, intFromBig, nullDer, octet, oid, oidString, parseOne, parseTime, seq, set, tlv, type Node } from "./asn1.js";
import { compare, concat, enc, equal } from "./bytes.js";
import { digest, sha256 } from "./crypto.js";
import { OID, parseCertificate, verifySignature, type Certificate } from "./x509.js";

const O = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertV2: "1.2.840.113549.1.9.16.2.47",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  signerAttrV2: "0.4.0.19122.1.1",
  role: "2.5.4.72",
};

export const CLAIMED_ROLE_MAX_RUNES = 900;

/** DER SET OF Attribute (tag 0x31): contentType, messageDigest, signingCertificateV2 (+ claimedRole). */
export async function signedAttributes(messageDigest: Uint8Array, signer: Certificate, claimedRole: string): Promise<Uint8Array> {
  if (messageDigest.length !== 32) throw new Error("pades: messageDigest SHA-256 биш");
  if (claimedRole !== "" && ([...claimedRole].length > CLAIMED_ROLE_MAX_RUNES || /[\ud800-\udfff]/.test(claimedRole.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")))) {
    throw new Error("pades: claimed role буруу эсвэл хэт урт");
  }
  const certHash = await sha256(signer.raw);
  const attr = (o: string, ...vals: Uint8Array[]): Uint8Array => seq(oid(o), set(...vals));
  const attrs = [
    attr(O.contentType, oid(O.data)),
    attr(O.messageDigest, octet(messageDigest)),
    attr(
      O.signingCertV2,
      seq(seq(seq(octet(certHash), seq(seq(ctx(4, true, signer.rawIssuer)), tlv(TAG.INTEGER, signer.serial))))),
    ),
  ];
  if (claimedRole !== "") {
    attrs.push(attr(O.signerAttrV2, seq(ctx(0, true, seq(seq(oid(O.role), set(tlv(TAG.UTF8String, enc.encode(claimedRole)))))))));
  }
  attrs.sort(compare);
  return set(...attrs);
}

/** AssembleCMS: ContentInfo{SignedData}; certificates = signer + chain (signer-тэй давхардсаныг хасна), DER эрэмбэ. */
export function assembleCMS(signedAttrs: Uint8Array, signer: Certificate, chain: Certificate[], signature: Uint8Array, tst: Uint8Array): Uint8Array {
  if (signedAttrs.length < 2 || signedAttrs[0] !== 0x31) throw new Error("pades: signedAttrs нь DER SET биш");
  let sigAlg: Uint8Array;
  if (signer.keyAlg === OID.rsaEncryption) sigAlg = seq(oid(OID.sha256WithRSA), nullDer());
  else if (signer.keyAlg === OID.ecPublicKey) sigAlg = seq(oid(OID.ecdsaSHA256));
  else throw new Error("pades: гарын үсгийн түлхүүрийн төрөл дэмжигдэхгүй");
  const implicitAttrs = signedAttrs.slice();
  implicitAttrs[0] = 0xa0;
  const certs = [signer.raw];
  for (const c of chain) if (!equal(c.raw, signer.raw)) certs.push(c.raw);
  certs.sort(compare);
  const sha256Alg = seq(oid(OID.sha256));
  const unsigned = tst.length > 0 ? [ctx(1, true, seq(oid(O.timeStampToken), set(tst)))] : [];
  const signerInfo = seq(
    intFromBig(1n),
    seq(signer.rawIssuer, tlv(TAG.INTEGER, signer.serial)),
    sha256Alg,
    implicitAttrs,
    sigAlg,
    octet(signature),
    ...unsigned,
  );
  const sd = seq(intFromBig(1n), set(sha256Alg), seq(oid(O.data)), ctx(0, true, ...certs), set(signerInfo));
  return seq(oid(O.signedData), ctx(0, true, sd));
}

// ── SignedData задлах (TSA token) ──

export interface ParsedSignedData {
  /** EncapsulatedContentInfo-ийн eContent (OCTET STRING-ийн агуулга). */
  content: Uint8Array;
  certificates: Certificate[];
  signerInfos: Node[];
  digestAlgs: Node[];
}

export function parseSignedData(contentInfo: Uint8Array): ParsedSignedData {
  const ci = children(expect(parseOne(contentInfo), TAG.SEQUENCE, "ContentInfo"));
  if (oidString(expect(ci[0], TAG.OID, "contentType").value) !== O.signedData) throw new Error("pkcs7: SignedData биш");
  const sd = children(expect(children(expect(ci[1], 0xa0, "[0]"))[0], TAG.SEQUENCE, "SignedData"));
  let i = 1;
  const digestAlgs = children(expect(sd[i++], TAG.SET, "digestAlgorithms"));
  const eci = children(expect(sd[i++], TAG.SEQUENCE, "EncapsulatedContentInfo"));
  let content: Uint8Array = new Uint8Array();
  if (eci[1]) {
    const inner = children(expect(eci[1], 0xa0, "eContent"))[0];
    if (inner?.tag === TAG.OCTET_STRING) content = inner.value;
    else if (inner?.tag === 0x24) content = concat(children(inner).map((x) => x.value)); // BER constructed
  }
  const certificates: Certificate[] = [];
  if (sd[i]?.tag === 0xa0) {
    for (const c of children(sd[i]!)) if (c.tag === TAG.SEQUENCE) certificates.push(parseCertificate(c.raw));
    i++;
  }
  if (sd[i]?.tag === 0xa1) i++; // crls
  const signerInfos = children(expect(sd[i], TAG.SET, "signerInfos"));
  return { content, certificates, signerInfos, digestAlgs };
}

const HASHES: Record<string, "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"> = {
  [OID.sha1]: "SHA-1",
  [OID.sha256]: "SHA-256",
  [OID.sha384]: "SHA-384",
  [OID.sha512]: "SHA-512",
};

/** SignerInfo-ийн гэрчилгээг (issuerAndSerialNumber эсвэл subjectKeyIdentifier) олно. */
export function signerCert(sd: ParsedSignedData, si: Node): Certificate | undefined {
  const f = children(si);
  const sid = f[1]!;
  if (sid.tag === TAG.SEQUENCE) {
    const [iss, ser] = children(sid);
    return sd.certificates.find((c) => equal(c.rawIssuer, iss!.raw) && equal(c.serial, ser!.value));
  }
  return undefined;
}

/** digitorus pkcs7.Verify (сертификат байгаа үед): signer бүрийн messageDigest ба гарын үсэг. */
export async function verifySignedData(sd: ParsedSignedData): Promise<boolean> {
  if (sd.signerInfos.length === 0) return false;
  for (const si of sd.signerInfos) {
    const cert = signerCert(sd, si);
    if (!cert) return false;
    const f = children(si);
    let i = 2;
    const digAlg = oidString(children(f[i++]!)[0]!.value);
    const hash = HASHES[digAlg];
    if (!hash) return false;
    let attrs: Node | undefined;
    if (f[i]?.tag === 0xa0) attrs = f[i++];
    const sigAlg = f[i++]!;
    const sig = expect(f[i++], TAG.OCTET_STRING, "signature").value;
    let signed = sd.content;
    if (attrs) {
      let md: Uint8Array | undefined;
      let signingTime: Date | undefined;
      for (const a of children(attrs)) {
        const [t, v] = children(a);
        if (!t || !v) continue;
        const o = oidString(t.value);
        if (o === O.messageDigest) md = children(v)[0]?.value;
        if (o === O.signingTime) {
          const n = children(v)[0];
          if (n) signingTime = parseTime(n);
        }
      }
      if (!md || !equal(md, await digest(hash, sd.content))) return false;
      // digitorus pkcs7: signingTime байвал гэрчилгээний хүчинтэй хугацаанд.
      if (signingTime && (signingTime > cert.notAfter || signingTime < cert.notBefore)) return false;
      signed = concat([Uint8Array.of(0x31), attrs.raw.subarray(1)]);
    }
    // SignatureAlgorithm нь rsaEncryption (hash-гүй) байж болно — digestAlgorithm-аар.
    let alg = sigAlg;
    const so = oidString(children(sigAlg)[0]!.value);
    if (so === OID.rsaEncryption) {
      const m: Record<string, string> = { "SHA-1": "1.2.840.113549.1.1.5", "SHA-256": OID.sha256WithRSA, "SHA-384": OID.sha384WithRSA, "SHA-512": OID.sha512WithRSA };
      alg = parseOne(seq(oid(m[hash]!), nullDer()));
    } else if (so === OID.ecPublicKey) {
      const m: Record<string, string> = { "SHA-256": OID.ecdsaSHA256, "SHA-384": OID.ecdsaSHA384, "SHA-512": OID.ecdsaSHA512 };
      if (!m[hash]) return false;
      alg = parseOne(seq(oid(m[hash]!)));
    }
    if (!(await verifySignature(cert, alg, signed, sig))) return false;
  }
  return true;
}
