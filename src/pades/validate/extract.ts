// Задлах үе шат — CA server/internal/validate/extract.go (Go SDK pades/internal/validate/extract.go)-ийн порт. Итгэлийн
// шийдвэр гаргахгүй: баримтаас баримт (байт, гэрчилгээ, криптограф таарсан эсэх) л. digitorus/pdf, pkcs7, timestamp-ийн
// зан төлөвийг (TS pdf/reader.ts нь digitorus/pdf-ийн порт) дагана.

import { TAG, children, expect, intValue, oidString, parseOne, parsePreciseTime, readNode, type Node } from "../asn1.js";
import { concat, equal, fromLatin1, toHex } from "../bytes.js";
import { digest, sha256 } from "../crypto.js";
import { StructureError, checkStructure } from "../pdf/nesting.js";
import { PRef, Reader, type Value } from "../pdf/reader.js";
import { OID, parseCertificate, verifySignature, type Certificate } from "../x509.js";
import { fromPrecise, hexSerial, pdfText, ZERO_TIME, type GoTime } from "./gofmt.js";
import { Revisions, type SigMeta } from "./revisions.js";

/** PDF-ийн дээд хэмжээ (CA MaxPDFBytes). */
export const MAX_PDF_BYTES = 10 << 20;
const MAX_SIGNATURES = 16;

const MESSAGES = {
  not_pdf: "PDF файл задарсангүй",
  encrypted: "шифрлэгдсэн PDF-ийг шалгах боломжгүй — нууцлалыг арилгаад дахин оролдоно уу",
  no_signature: "баримтад цахим гарын үсэг алга",
  too_many: "баримтад хэт олон гарын үсэг байна",
  structure: "PDF-ийн бүтэц хэт гүн давхарласан эсвэл хэт төвөгтэй",
} as const;

export class ExtractError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
  }
}

/** trailer / xref stream-ийн /Encrypt лавлагаа (Go encryptRef). */
const ENCRYPT_REF = /\/Encrypt\s+\d+\s+\d+\s+R/;

export interface RawTimestamp {
  time: GoTime;
  serial: string;
  matches: boolean;
  weakDigest: boolean;
  tsaCert?: Uint8Array;
  certs: Uint8Array[];
}

export interface RawDSS {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

/** Go RawSignature. */
export interface RawSignature {
  signerName: string;
  reason: string;
  location: string;
  claimedTime?: GoTime;
  malformed: boolean;
  integrity: boolean;
  weakDigest: boolean;
  coversWhole: boolean;
  laterSignaturesOnly: boolean;
  laterSignatures: number;
  laterVisible: boolean;
  visible: boolean;
  signedEnd: number;
  objNum: number;
  byteRange?: number[];
  leaf?: Uint8Array;
  certs: Uint8Array[];
  timestamp?: RawTimestamp;
  subFilter: string;
  signingCertV2: "" | "match" | "mismatch";
  signingTimeAttr: boolean;
  claimedRoles: string[];
  cmsSha256: string;
  messageDigest: string;
  dss?: RawDSS;
}

export type Profile = "own" | "broad";

/** Extract-ийн бүх гарын үсэг + revision ангиллын мета (differential тестэд). */
export interface Extracted {
  sigs: RawSignature[];
  metas: Map<number, SigMeta>;
  docID: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AP_VERIFY_PREFIX = "https://ca.eidmongolia.mn/verify/";

/** Extract — PDF-ийн бүх /Type /Sig гарын үсгийг задална (profile own — CA-ийн prod горим). */
export async function extract(doc: Uint8Array, profile: Profile = "own"): Promise<Extracted> {
  // Reader-ийн рекурс хязгааргүй — гүн давхарласан баримтыг задлахаас өмнө (Go CheckStructure).
  try {
    checkStructure(doc);
  } catch (e) {
    if (e instanceof StructureError) throw new ExtractError("structure");
    throw e;
  }
  let rdr: Reader;
  try {
    rdr = new Reader(doc);
  } catch {
    // Go: digitorus AES-256 / нууц үгтэй баримтыг нээхгүй — /Encrypt лавлагаагаар encrypted.
    throw new ExtractError(ENCRYPT_REF.test(fromLatin1(doc)) ? "encrypted" : "not_pdf");
  }
  // /Encrypt — ямар ч шифрлэлт (хоосон нууц үгтэй ч) encrypted: Go/CA (digitorus) RC4-д /Contents-ийг эвддэг, AES-128-д
  // panic хийдэг тул гурвуулаа шалгахгүй. keys() — resolve хийхгүй (Go trailer Keys()).
  if (rdr.trailerValue().keys().includes("Encrypt")) throw new ExtractError("encrypted");
  const sigs: RawSignature[] = [];
  const visible = new Map<number, boolean>();
  let docID = "";
  let dss: RawDSS | undefined;
  try {
    for (const x of rdr.xref) {
      const obj = rdr.resolve(x.ptr, new PRef(x.ptr.id, x.ptr.gen));
      if (obj.kind() !== "dict") continue;
      if (obj.key("FT").name() === "Sig" && obj.key("V").kind() === "dict") {
        const vp = obj.key("V").ptr;
        if (vp.id !== x.ptr.id) visible.set(vp.id, (visible.get(vp.id) ?? false) || widgetVisible(obj));
      }
      if (docID === "" && obj.key("Subtype").name() === "Link") {
        const u = fromLatin1(obj.key("A").key("URI").rawString());
        if (u.startsWith(AP_VERIFY_PREFIX) && UUID_RE.test(u.slice(AP_VERIFY_PREFIX.length))) docID = u.slice(AP_VERIFY_PREFIX.length);
      }
      if (obj.key("Contents").isNull() || obj.key("ByteRange").isNull()) continue;
      const t = obj.key("Type").name();
      if (t !== "" && t !== "Sig") continue;
      if (sigs.length === MAX_SIGNATURES) throw new ExtractError("too_many");
      const s = await extractSignature(doc, obj);
      s.objNum = x.ptr.id;
      sigs.push(s);
    }
    if (sigs.length === 0) throw new ExtractError("no_signature");
    for (const s of sigs) s.visible = visible.get(s.objNum) ?? false;
    dss = extractDSS(rdr.trailerValue().key("Root").key("DSS"));
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError("not_pdf"); // Go: panic → recover → ErrNotPDF
  }
  if (dss) for (const s of sigs) s.dss = dss;
  const known = new Map<number, number[]>();
  const metas = new Map<number, SigMeta>();
  for (const s of sigs) {
    if (!s.malformed) {
      known.set(s.objNum, s.byteRange!);
      metas.set(s.objNum, { revIndex: 1, role: "", roleOK: s.claimedRoles.length <= 1 });
    }
  }
  for (const [num, m] of metas) {
    const br = known.get(num)!;
    for (const s of sigs) {
      if (!s.malformed && s.signedEnd < br[2]! + br[3]!) m.revIndex++;
      if (s.objNum === num && s.claimedRoles.length === 1) m.role = s.claimedRoles[0]!;
    }
  }
  let revs: Revisions | undefined;
  for (const s of sigs) {
    if (s.malformed || s.coversWhole) continue;
    if (!revs) {
      revs = new Revisions(doc, known, profile);
      revs.sigs = metas;
      revs.docID = docID;
    }
    const later = await revs.later(s.signedEnd);
    s.laterSignaturesOnly = later.signaturesOnly;
    s.laterSignatures = later.signatures;
    s.laterVisible = later.visible;
  }
  return { sigs, metas, docID };
}

/** widget харагдах: /AP-тэй эсвэл /Rect-ийн өргөн, өндөр хоёулаа 0 биш. */
function widgetVisible(w: Value): boolean {
  if (!w.key("AP").isNull()) return true;
  const r = w.key("Rect");
  if (r.kind() !== "array" || r.len() !== 4) return false;
  return r.index(0).float64() !== r.index(2).float64() && r.index(1).float64() !== r.index(3).float64();
}

function emptySig(obj: Value): RawSignature {
  return {
    signerName: valueText(obj.key("Name")),
    reason: valueText(obj.key("Reason")),
    location: valueText(obj.key("Location")),
    malformed: false,
    integrity: false,
    weakDigest: false,
    coversWhole: false,
    laterSignaturesOnly: false,
    laterSignatures: 0,
    laterVisible: false,
    visible: false,
    signedEnd: 0,
    objNum: 0,
    certs: [],
    subFilter: "",
    signingCertV2: "",
    signingTimeAttr: false,
    claimedRoles: [],
    cmsSha256: "",
    messageDigest: "",
  };
}

/** digitorus Value.Text(). */
function valueText(v: Value): string {
  return v.kind() === "string" ? pdfText(v.rawString()) : "";
}

async function extractSignature(doc: Uint8Array, obj: Value): Promise<RawSignature> {
  const s = emptySig(obj);
  const m = obj.key("M");
  if (!m.isNull()) {
    const t = parsePDFDate(valueText(m));
    if (t) s.claimedTime = t;
  }
  const contents = obj.key("Contents").rawString();
  const br = byteRange(obj.key("ByteRange"));
  const sb = signedBytes(doc, br, contents);
  if (!sb) {
    s.malformed = true;
    return s;
  }
  s.coversWhole = sb.whole;
  s.signedEnd = br![2]! + br![3]!;
  s.byteRange = br;
  s.subFilter = obj.key("SubFilter").name();

  const p7 = parsePKCS7(contents);
  if (!p7 || p7.signers.length !== 1) {
    s.malformed = true;
    return s;
  }
  const si = p7.signers[0]!;
  const leaf = onlySigner(p7);
  if (!leaf) {
    s.malformed = true;
    return s;
  }
  s.leaf = leaf.raw;
  const der = cmsDER(contents);
  if (der) s.cmsSha256 = toHex(await sha256(der));
  const chk = await signedAttrChecks(si.authAttrs, leaf);
  s.signingCertV2 = chk.certV2;
  s.signingTimeAttr = chk.signingTime;
  s.claimedRoles = claimedRoles(si.authAttrs);
  for (const a of si.authAttrs) {
    if (a.type === O.messageDigest) {
      const md = firstOctet(a.values);
      if (md) s.messageDigest = toHex(md);
    }
  }
  for (const c of p7.certs) if (!equal(c.raw, leaf.raw)) s.certs.push(c.raw);
  s.weakDigest = !STRONG.has(si.digestAlg);
  s.integrity = await verifyPKCS7(p7, sb.signed);
  s.timestamp = await extractTimestamp(si);
  return s;
}

// ── PKCS#7 (digitorus/pkcs7-ийн хэрэгтэй дэд хэсэг) ──

const O = {
  signedData: "1.2.840.113549.1.7.2",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertV2: "1.2.840.113549.1.9.16.2.47",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  signerAttrV2: "0.4.0.19122.1.1",
  role: "2.5.4.72",
};

const STRONG = new Set<string>([OID.sha256, OID.sha384, OID.sha512]);

interface Attr {
  type: string;
  /** SET-ийн агуулга (Go Attribute.Value.Bytes). */
  values: Uint8Array;
}

interface SignerInfo {
  issuer: Uint8Array;
  serial: bigint;
  digestAlg: string;
  authAttrs: Attr[];
  /** [0] IMPLICIT-ийн SET болгосон DER (гарын үсгийн өгөгдөл). */
  authRaw?: Uint8Array;
  encAlg: string;
  sig: Uint8Array;
  unauthAttrs: Attr[];
}

interface PKCS7 {
  content: Uint8Array;
  certs: Certificate[];
  signers: SignerInfo[];
}

/** digitorus pkcs7.Parse: эхний TLV (DER) — ContentInfo{SignedData}; гэрчилгээ бүр задрах ёстой. */
function parsePKCS7(data: Uint8Array): PKCS7 | undefined {
  try {
    if (data.length === 0) return undefined;
    const ci = children(expect(readNode(data, 0), TAG.SEQUENCE, "ContentInfo"));
    if (oidString(expect(ci[0], TAG.OID, "contentType").value) !== O.signedData) return undefined;
    const sd = children(expect(children(expect(ci[1], 0xa0, "[0]"))[0], TAG.SEQUENCE, "SignedData"));
    let i = 0;
    expect(sd[i++], TAG.INTEGER, "version");
    expect(sd[i++], TAG.SET, "digestAlgorithms");
    const eci = children(expect(sd[i++], TAG.SEQUENCE, "EncapsulatedContentInfo"));
    let content: Uint8Array = new Uint8Array();
    if (eci[1]) {
      const inner = children(expect(eci[1], 0xa0, "eContent"))[0];
      if (inner?.tag === TAG.OCTET_STRING) content = inner.value;
      else if (inner?.tag === 0x24) content = concat(children(inner).map((x) => x.value));
    }
    const certs: Certificate[] = [];
    if (sd[i]?.tag === 0xa0) {
      for (const c of children(sd[i]!)) certs.push(parseCertificate(c.raw));
      i++;
    }
    if (sd[i]?.tag === 0xa1) i++;
    const signers = children(expect(sd[i], TAG.SET, "signerInfos")).map(parseSignerInfo);
    return { content, certs, signers };
  } catch {
    return undefined;
  }
}

function parseAttrs(n: Node): Attr[] {
  return children(n).map((a) => {
    const [t, v] = children(expect(a, TAG.SEQUENCE, "Attribute"));
    return { type: oidString(expect(t, TAG.OID, "attr type").value), values: expect(v, TAG.SET, "attr values").value };
  });
}

function parseSignerInfo(n: Node): SignerInfo {
  const f = children(expect(n, TAG.SEQUENCE, "SignerInfo"));
  let i = 0;
  expect(f[i++], TAG.INTEGER, "version");
  const ias = children(expect(f[i++], TAG.SEQUENCE, "IssuerAndSerialNumber"));
  const issuer = expect(ias[0], TAG.SEQUENCE, "issuer").raw;
  const serial = intValue(expect(ias[1], TAG.INTEGER, "serial").value);
  const digestAlg = oidString(expect(children(expect(f[i++], TAG.SEQUENCE, "digestAlg"))[0], TAG.OID, "alg").value);
  let authAttrs: Attr[] = [];
  let authRaw: Uint8Array | undefined;
  if (f[i]?.tag === 0xa0) {
    authAttrs = parseAttrs(f[i]!);
    authRaw = concat([Uint8Array.of(0x31), f[i]!.raw.subarray(1)]);
    i++;
  }
  const encAlg = oidString(expect(children(expect(f[i++], TAG.SEQUENCE, "encAlg"))[0], TAG.OID, "alg").value);
  const sig = expect(f[i++], TAG.OCTET_STRING, "signature").value;
  let unauthAttrs: Attr[] = [];
  if (f[i]?.tag === 0xa1) unauthAttrs = parseAttrs(f[i++]!);
  return { issuer, serial, digestAlg, authAttrs, authRaw, encAlg, sig, unauthAttrs };
}

/** GetOnlySigner: ганц signer-ийн гэрчилгээ (RawIssuer + serial тоогоор). */
function onlySigner(p7: PKCS7): Certificate | undefined {
  if (p7.signers.length !== 1) return undefined;
  const si = p7.signers[0]!;
  return p7.certs.find((c) => equal(c.rawIssuer, si.issuer) && intValue(c.serial) === si.serial);
}

const HASH_FOR_OID: Record<string, "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"> = {
  [OID.sha1]: "SHA-1",
  "1.2.840.10045.4.1": "SHA-1",
  "1.2.840.10040.4.1": "SHA-1",
  "1.2.840.10040.4.3": "SHA-1",
  [OID.rsaEncryption]: "SHA-1",
  [OID.sha256]: "SHA-256",
  [OID.ecdsaSHA256]: "SHA-256",
  [OID.sha384]: "SHA-384",
  [OID.ecdsaSHA384]: "SHA-384",
  [OID.sha512]: "SHA-512",
  [OID.ecdsaSHA512]: "SHA-512",
};

const RSA_ENC = new Set<string>([OID.rsaEncryption, "1.2.840.113549.1.1.5", OID.sha256WithRSA, OID.sha384WithRSA, OID.sha512WithRSA]);
const ECDSA_CURVE_ENC = new Set<string>([OID.p256, OID.p384, OID.p521]);

/** digitorus getSignatureAlgorithm → x509 гарын үсгийн алгоритмын OID (undefined — дэмжигдэхгүй). */
function sigAlgOID(encAlg: string, digestAlg: string): string | undefined {
  switch (encAlg) {
    case "1.2.840.10045.4.1":
      return "1.2.840.10045.4.1";
    case OID.ecdsaSHA256:
    case OID.ecdsaSHA384:
    case OID.ecdsaSHA512:
      return encAlg;
  }
  if (RSA_ENC.has(encAlg)) {
    return { [OID.sha1]: "1.2.840.113549.1.1.5", [OID.sha256]: OID.sha256WithRSA, [OID.sha384]: OID.sha384WithRSA, [OID.sha512]: OID.sha512WithRSA }[digestAlg];
  }
  if (ECDSA_CURVE_ENC.has(encAlg)) {
    return { [OID.sha1]: "1.2.840.10045.4.1", [OID.sha256]: OID.ecdsaSHA256, [OID.sha384]: OID.ecdsaSHA384, [OID.sha512]: OID.ecdsaSHA512 }[digestAlg];
  }
  return undefined; // DSA, Ed25519 — WebCrypto/SDK дэмжихгүй (Go-д дэмжигдэнэ; eID-д хэрэглэгддэггүй)
}

function algNode(oid: string): Node {
  const o = oidBytes(oid);
  return parseOne(Uint8Array.from([0x30, o.length, ...o]));
}

function oidBytes(s: string): number[] {
  const parts = s.split(".").map((x) => BigInt(x));
  const body: number[] = [];
  const enc = (v: bigint): void => {
    const tmp: number[] = [Number(v & 0x7fn)];
    for (v >>= 7n; v > 0n; v >>= 7n) tmp.unshift(Number(v & 0x7fn) | 0x80);
    body.push(...tmp);
  };
  enc(parts[0]! * 40n + parts[1]!);
  for (const p of parts.slice(2)) enc(p);
  return [0x06, body.length, ...body];
}

/** digitorus pkcs7.Verify (truststore nil): messageDigest, signingTime ∈ cert validity, гарын үсэг (x509 CheckSignature). */
async function verifyPKCS7(p7: PKCS7, content: Uint8Array): Promise<boolean> {
  if (p7.signers.length === 0) return false;
  for (const si of p7.signers) {
    const ee = p7.certs.find((c) => equal(c.rawIssuer, si.issuer) && intValue(c.serial) === si.serial);
    if (!ee) return false;
    let signed = content;
    if (si.authAttrs.length > 0) {
      const mdAttr = si.authAttrs.find((a) => a.type === O.messageDigest);
      const md = mdAttr ? firstOctet(mdAttr.values) : undefined;
      if (!md) return false;
      const hash = HASH_FOR_OID[si.digestAlg];
      if (!hash) return false;
      if (!equal(md, await digest(hash, content))) return false;
      signed = si.authRaw!;
      const st = si.authAttrs.find((a) => a.type === O.signingTime);
      if (st) {
        const t = attrTime(st.values);
        if (t && (t.getTime() > ee.notAfter.getTime() || t.getTime() < ee.notBefore.getTime())) return false;
      }
    }
    const alg = sigAlgOID(si.encAlg, si.digestAlg);
    if (!alg) return false;
    let ok = false;
    try {
      ok = await verifySignature(ee, algNode(alg), signed, si.sig);
    } catch {
      ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

function firstOctet(values: Uint8Array): Uint8Array | undefined {
  try {
    const n = readNode(values, 0);
    return n.tag === TAG.OCTET_STRING ? n.value : undefined;
  } catch {
    return undefined;
  }
}

function attrTime(values: Uint8Array): Date | undefined {
  try {
    const n = readNode(values, 0);
    if (n.tag !== TAG.UTCTime && n.tag !== TAG.GeneralizedTime) return undefined;
    return parsePreciseTime(n).date;
  } catch {
    return undefined;
  }
}

/** /Contents-ийн эхний ASN.1 элемент (placeholder-ийн тэг дүүргэлтгүй CMS). */
function cmsDER(contents: Uint8Array): Uint8Array | undefined {
  try {
    const n = readNode(contents, 0);
    return n.tag === TAG.SEQUENCE ? n.raw : undefined;
  } catch {
    return undefined;
  }
}

// ── signedAttrs ──

/** signingCertificateV2 нь leaf-тэй таарах эсэх, signingTime байгаа эсэх (Go signedAttrChecks). */
async function signedAttrChecks(attrs: Attr[], leaf: Certificate): Promise<{ certV2: "" | "match" | "mismatch"; signingTime: boolean }> {
  let certV2: "" | "match" | "mismatch" = "";
  let signingTime = false;
  for (const a of attrs) {
    if (a.type === O.signingTime) {
      signingTime = true;
      continue;
    }
    if (a.type !== O.signingCertV2) continue;
    if (certV2 !== "") {
      certV2 = "mismatch";
      continue;
    }
    certV2 = "mismatch";
    try {
      const top = readNode(a.values, 0);
      if (top.raw.length !== a.values.length || top.tag !== TAG.SEQUENCE) continue;
      const scf = children(top);
      // Go struct{ Certs []essCertIDv2 } — нэмэлт талбар (policies) байвал Unmarshal алдаа.
      if (scf.length !== 1 || scf[0]!.tag !== TAG.SEQUENCE) continue;
      const ids = children(scf[0]!);
      if (ids.length === 0) continue;
      const id = children(expect(ids[0], TAG.SEQUENCE, "ESSCertIDv2"));
      let k = 0;
      let hash: "SHA-256" | "SHA-384" | "SHA-512" | undefined = "SHA-256";
      if (id[k]?.tag === TAG.SEQUENCE) {
        const alg = oidString(expect(children(id[k]!)[0], TAG.OID, "alg").value);
        hash = alg === OID.sha256 ? "SHA-256" : alg === OID.sha384 ? "SHA-384" : alg === OID.sha512 ? "SHA-512" : undefined;
        k++;
      }
      const certHash = expect(id[k++], TAG.OCTET_STRING, "certHash").value;
      let serial: bigint | undefined;
      if (id[k]) {
        const is = children(expect(id[k], TAG.SEQUENCE, "IssuerSerial"));
        serial = intValue(expect(is[1], TAG.INTEGER, "serial").value);
        k++;
      }
      if (k !== id.length || !hash) continue;
      if (!equal(await digest(hash, leaf.raw), certHash)) continue;
      if (serial !== undefined && serial !== intValue(leaf.serial)) continue;
      certV2 = "match";
    } catch {
      // mismatch
    }
  }
  return { certV2, signingTime };
}

const MAX_CLAIMED_ROLES = 4;
const MAX_CLAIMED_ROLE_RUNES = 900;

/** signer-attributes-v2 claimedAttributes / id-at-role (UTF8String/PrintableString). */
function claimedRoles(attrs: Attr[]): string[] {
  const out: string[] = [];
  for (const a of attrs) {
    if (a.type !== O.signerAttrV2) continue;
    try {
      const seq = readNode(a.values, 0);
      if (seq.tag !== TAG.SEQUENCE) continue;
      const first = seq.value.length > 0 ? readNode(seq.value, 0) : undefined;
      if (!first || first.tag !== 0xa0) continue;
      const list = readNode(first.value, 0);
      if (list.tag !== TAG.SEQUENCE) continue;
      let p = 0;
      while (p < list.value.length && out.length < MAX_CLAIMED_ROLES) {
        let at: Node;
        try {
          at = readNode(list.value, p);
        } catch {
          break;
        }
        p += at.raw.length;
        if (at.tag !== TAG.SEQUENCE) break;
        const parts = children(at);
        if (parts[0]?.tag !== TAG.OID || parts[1]?.tag !== TAG.SET) break;
        if (oidString(parts[0].value) !== O.role) continue;
        let q = 0;
        const vals = parts[1].value;
        while (q < vals.length && out.length < MAX_CLAIMED_ROLES) {
          let v: Node;
          try {
            v = readNode(vals, q);
          } catch {
            break;
          }
          q += v.raw.length;
          if (v.tag !== TAG.UTF8String && v.tag !== TAG.PrintableString) continue;
          const r = validClaimedRole(v.value);
          if (r !== undefined) out.push(r);
        }
      }
    } catch {
      // алгасна
    }
  }
  return out;
}

/** Go validClaimedRole: хоосон биш, хүчинтэй UTF-8, ≤ 900 rune, удирдах (Cc) ба формат (Cf) тэмдэгтгүй. */
function validClaimedRole(b: Uint8Array): string | undefined {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
  if (s === "" || [...s].length > MAX_CLAIMED_ROLE_RUNES) return undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(s)) return undefined;
  return s;
}

// ── RFC 3161 ──

const TS_HASH: Record<string, "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"> = {
  [OID.sha1]: "SHA-1",
  [OID.sha256]: "SHA-256",
  [OID.sha384]: "SHA-384",
  [OID.sha512]: "SHA-512",
};

async function extractTimestamp(si: SignerInfo): Promise<RawTimestamp | undefined> {
  for (const a of si.unauthAttrs) {
    if (a.type !== O.timeStampToken) continue;
    const out: RawTimestamp = { time: ZERO_TIME, serial: "", matches: false, weakDigest: false, certs: [] };
    // digitorus/timestamp.Parse: гэрчилгээ байвал токены гарын үсгийг шалгана, TSTInfo задална.
    const tok = parsePKCS7(a.values);
    if (!tok) return out;
    if (tok.certs.length > 0 && !(await verifyPKCS7(tok, tok.content))) return out;
    let info: Node[];
    let hashAlg: string;
    let hashed: Uint8Array;
    let time: GoTime;
    let serial: string;
    try {
      info = children(expect(parseOne(tok.content), TAG.SEQUENCE, "TSTInfo"));
      const mi = children(expect(info[2], TAG.SEQUENCE, "messageImprint"));
      hashAlg = oidString(expect(children(expect(mi[0], TAG.SEQUENCE, "alg"))[0], TAG.OID, "alg").value);
      hashed = expect(mi[1], TAG.OCTET_STRING, "hashedMessage").value;
      if (hashed.length === 0) return out;
      serial = hexSerial(expect(info[3], TAG.INTEGER, "serial").value);
      time = fromPrecise(parsePreciseTime(expect(info[4], TAG.GeneralizedTime, "genTime")));
    } catch {
      return out;
    }
    out.time = time;
    out.serial = serial;
    if (tok.signers.length !== 1) return out;
    const tsa = onlySigner(tok);
    if (!tsa) return out;
    out.tsaCert = tsa.raw;
    for (const c of tok.certs) if (!equal(c.raw, tsa.raw)) out.certs.push(c.raw);
    const h = TS_HASH[hashAlg];
    out.weakDigest = !STRONG.has(tok.signers[0]!.digestAlg) || !(h && h !== "SHA-1");
    if (!h) return out;
    out.matches = equal(await digest(h, si.sig), hashed);
    return out;
  }
  return undefined;
}

// ── ByteRange / огноо / DSS ──

/** ByteRange [0 a b c]: завсар нь ЗӨВХӨН энэ толийн /Contents-ийн <hex>. */
function signedBytes(doc: Uint8Array, br: number[] | undefined, contents: Uint8Array): { signed: Uint8Array; whole: boolean } | undefined {
  if (!br || br.length !== 4) return undefined;
  const n = doc.length;
  const [a0, l0, a1, l1] = br as [number, number, number, number];
  if (a0 !== 0 || l0 <= 0 || l1 < 0 || a1 <= l0 || a1 > n || l1 > n - a1) return undefined;
  const gap = doc.subarray(l0, a1);
  if (gap.length < 2 || gap[0] !== 0x3c || gap[gap.length - 1] !== 0x3e) return undefined;
  const hex = fromLatin1(gap, 1, gap.length - 1);
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return undefined;
  if (hex.length / 2 !== contents.length) return undefined;
  for (let i = 0; i < contents.length; i++) if (parseInt(hex.substr(i * 2, 2), 16) !== contents[i]) return undefined;
  return { signed: concat([doc.subarray(0, l0), doc.subarray(a1, a1 + l1)]), whole: a1 + l1 === n };
}

function byteRange(v: Value): number[] | undefined {
  if (v.kind() !== "array" || v.len() !== 4) return undefined;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const e = v.index(i);
    if (e.kind() !== "int") return undefined;
    out.push(e.int64());
  }
  return out;
}

/** Go parsePDFDate: "D:" хасаж, "'"-ийг устгаад 20060102150405[-0700|Z0700|Z|]. */
export function parsePDFDate(raw: string): GoTime | undefined {
  const s = (raw.startsWith("D:") ? raw.slice(2) : raw).replaceAll("'", "");
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return undefined;
  const dim = new Date(Date.UTC(2000, mo, 0)).getUTCDate();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (d > (mo === 2 ? (leap ? 29 : 28) : dim)) return undefined;
  let off = 0;
  const z = m[7];
  if (z && z !== "Z") {
    const oh = Number(z.slice(1, 3));
    const om = Number(z.slice(3, 5));
    if (oh > 24 || om > 59) return undefined;
    off = (oh * 60 + om) * 60 * (z[0] === "+" ? 1 : -1);
  }
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, se, 0);
  return { sec: Math.floor(dt.getTime() / 1000) - off, nanos: 0 };
}

const MAX_DSS_ITEMS = 64;
const MAX_DSS_STREAM = 1 << 20;

/** /DSS-ийн /Certs /OCSPs /CRLs stream-уудыг тайлж уншина; задрахгүй / хязгаар хэтэрсэнийг алгасна. */
function extractDSS(dss: Value): RawDSS | undefined {
  if (dss.kind() !== "dict") return undefined;
  const read = (key: string): Uint8Array[] => {
    const arr = dss.key(key);
    const out: Uint8Array[] = [];
    for (let i = 0; i < arr.len() && i < MAX_DSS_ITEMS; i++) {
      const e = arr.index(i);
      if (e.kind() !== "stream") continue;
      let b: Uint8Array;
      try {
        b = e.streamData();
      } catch {
        continue;
      }
      if (b.length > MAX_DSS_STREAM) continue;
      out.push(b);
    }
    return out;
  };
  return { certs: read("Certs"), ocsps: read("OCSPs"), crls: read("CRLs") };
}

