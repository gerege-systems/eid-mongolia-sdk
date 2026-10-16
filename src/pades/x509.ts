// X.509-ийн PAdES-д хэрэгтэй хэсэг: задлах (issuer/subject/serial/SPKI/extensions), Web Crypto-оор гарын үсэг шалгах,
// Go x509 CheckSignatureFrom-ийн хязгаарлалт, TSA гинжийн шалгалт (Go x509.Verify-ийн PAdES-д хэрэгтэй дэд хэсэг).

import { Asn1Error, TAG, children, expect, oidString, parseOne, parseTime, type Node } from "./asn1.js";
import { equal } from "./bytes.js";
import { subtle } from "./crypto.js";

export const OID = {
  rsaEncryption: "1.2.840.113549.1.1.1",
  rsaPSS: "1.2.840.113549.1.1.10",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha384WithRSA: "1.2.840.113549.1.1.12",
  sha512WithRSA: "1.2.840.113549.1.1.13",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaSHA256: "1.2.840.10045.4.3.2",
  ecdsaSHA384: "1.2.840.10045.4.3.3",
  ecdsaSHA512: "1.2.840.10045.4.3.4",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  p521: "1.3.132.0.35",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  commonName: "2.5.4.3",
  surname: "2.5.4.4",
  givenName: "2.5.4.42",
  extKeyUsage: "2.5.29.37",
  keyUsage: "2.5.29.15",
  basicConstraints: "2.5.29.19",
  crlDP: "2.5.29.31",
  aia: "1.3.6.1.5.5.7.1.1",
  ocspMethod: "1.3.6.1.5.5.7.48.1",
  kpTimeStamping: "1.3.6.1.5.5.7.3.8",
  kpOCSPSigning: "1.3.6.1.5.5.7.3.9",
  kpAny: "2.5.29.37.0",
} as const;

export interface Extension {
  oid: string;
  critical: boolean;
  value: Uint8Array;
}

export interface Certificate {
  raw: Uint8Array;
  tbs: Uint8Array;
  version: number;
  /** INTEGER агуулга (minimal two's complement). */
  serial: Uint8Array;
  sigAlg: Node;
  signature: Uint8Array;
  rawIssuer: Uint8Array;
  rawSubject: Uint8Array;
  /** SubjectPublicKeyInfo TLV. */
  spki: Uint8Array;
  keyAlg: string;
  /** EC curve OID (ECDSA). */
  curve?: string;
  /** BIT STRING-ийн түлхүүрийн байт (RightAlign). */
  publicKey: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  extensions: Extension[];
  subjectCN: string;
  issuerCN: string;
  givenName: string;
  surname: string;
  ocspServers: string[];
  crlDPs: string[];
  isCA: boolean;
  basicConstraintsValid: boolean;
  /** KeyUsage bit-үүд (0 = байхгүй). Bit 0 = digitalSignature … (Go x509.KeyUsage). */
  keyUsage: number;
  extKeyUsage: string[];
}

export class CertError extends Error {}

function bitString(n: Node): Uint8Array {
  expect(n, TAG.BIT_STRING, "BIT STRING");
  if (n.value.length === 0) throw new Asn1Error("BIT STRING хоосон");
  return n.value.subarray(1);
}

function decodeDirString(n: Node): string {
  if (n.tag === 0x1e) {
    // BMPString
    let s = "";
    for (let i = 0; i + 1 < n.value.length; i += 2) s += String.fromCharCode((n.value[i]! << 8) | n.value[i + 1]!);
    return s;
  }
  if (n.tag === TAG.UTF8String) return new TextDecoder().decode(n.value);
  return String.fromCharCode(...n.value);
}

/** Name-ээс OID-ийн эхний утга (Go pkix.Name: CN — сүүлийнх нь давамгайлна; ExtraNames-ийн дарааллаар). */
function nameAttrs(name: Node): [string, string][] {
  const out: [string, string][] = [];
  for (const rdn of children(name)) {
    for (const atv of children(rdn)) {
      const [t, v] = children(atv);
      if (!t || !v) continue;
      out.push([oidString(t.value), decodeDirString(v)]);
    }
  }
  return out;
}

export function parseCertificate(der: Uint8Array): Certificate {
  try {
    const top = parseOne(der);
    expect(top, TAG.SEQUENCE, "Certificate");
    const [tbsN, sigAlg, sigN] = children(top);
    const tbs = expect(tbsN, TAG.SEQUENCE, "TBSCertificate");
    const f = children(tbs);
    let i = 0;
    let version = 1;
    if (f[0]?.tag === 0xa0) {
      const v = expect(children(f[0])[0], TAG.INTEGER, "version");
      version = v.value[0]! + 1;
      i++;
    }
    const serial = expect(f[i++], TAG.INTEGER, "serial").value;
    i++; // signature AlgorithmIdentifier
    const issuer = expect(f[i++], TAG.SEQUENCE, "issuer");
    const validity = children(expect(f[i++], TAG.SEQUENCE, "validity"));
    const subject = expect(f[i++], TAG.SEQUENCE, "subject");
    const spki = expect(f[i++], TAG.SEQUENCE, "SPKI");
    const [algN, pkN] = children(spki);
    const algParts = children(expect(algN, TAG.SEQUENCE, "AlgorithmIdentifier"));
    const keyAlg = oidString(expect(algParts[0], TAG.OID, "alg").value);
    const curve = keyAlg === OID.ecPublicKey && algParts[1]?.tag === TAG.OID ? oidString(algParts[1].value) : undefined;
    const extensions: Extension[] = [];
    for (; i < f.length; i++) {
      if (f[i]!.tag !== 0xa3) continue;
      for (const e of children(expect(children(f[i]!)[0], TAG.SEQUENCE, "extensions"))) {
        const p = children(e);
        const o = oidString(expect(p[0], TAG.OID, "ext oid").value);
        let critical = false;
        let val = p[1];
        if (val?.tag === TAG.BOOLEAN) {
          critical = val.value[0] !== 0;
          val = p[2];
        }
        extensions.push({ oid: o, critical, value: expect(val, TAG.OCTET_STRING, "ext value").value });
      }
    }
    const subj = nameAttrs(subject);
    const iss = nameAttrs(issuer);
    const last = (a: [string, string][], o: string): string => a.filter(([k]) => k === o).map(([, v]) => v).pop() ?? "";
    const cert: Certificate = {
      raw: top.raw,
      tbs: tbs.raw,
      version,
      serial,
      sigAlg: expect(sigAlg, TAG.SEQUENCE, "sigAlg"),
      signature: bitString(sigN!),
      rawIssuer: issuer.raw,
      rawSubject: subject.raw,
      spki: spki.raw,
      keyAlg,
      curve,
      publicKey: bitString(pkN!),
      notBefore: parseTime(validity[0]!),
      notAfter: parseTime(validity[1]!),
      extensions,
      subjectCN: last(subj, OID.commonName),
      issuerCN: last(iss, OID.commonName),
      // Go SignerDisplayName: Subject.Names-ийн давталтын сүүлийн утга.
      givenName: last(subj, OID.givenName),
      surname: last(subj, OID.surname),
      ocspServers: [],
      crlDPs: [],
      isCA: false,
      basicConstraintsValid: false,
      keyUsage: 0,
      extKeyUsage: [],
    };
    for (const e of extensions) parseExtension(cert, e);
    return cert;
  } catch (e) {
    throw new CertError(`гэрчилгээ задарсангүй: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseExtension(c: Certificate, e: Extension): void {
  const n = parseOne(e.value);
  switch (e.oid) {
    case OID.basicConstraints: {
      c.basicConstraintsValid = true;
      const p = children(n);
      c.isCA = p[0]?.tag === TAG.BOOLEAN && p[0].value[0] !== 0;
      break;
    }
    case OID.keyUsage: {
      const bs = n.value;
      let ku = 0;
      for (let i = 1; i < bs.length; i++) {
        for (let b = 0; b < 8; b++) if (bs[i]! & (0x80 >> b)) ku |= 1 << ((i - 1) * 8 + b);
      }
      c.keyUsage = ku;
      break;
    }
    case OID.extKeyUsage:
      c.extKeyUsage = children(n).map((x) => oidString(x.value));
      break;
    case OID.aia:
      for (const ad of children(n)) {
        const [m, loc] = children(ad);
        if (m && loc && oidString(m.value) === OID.ocspMethod && loc.tag === 0x86) c.ocspServers.push(String.fromCharCode(...loc.value));
      }
      break;
    case OID.crlDP:
      for (const dp of children(n)) {
        for (const f of children(dp)) {
          if (f.tag !== 0xa0) continue; // distributionPoint
          for (const fn of children(f)) {
            if (fn.tag !== 0xa0) continue; // fullName
            for (const gn of children(fn)) if (gn.tag === 0x86) c.crlDPs.push(String.fromCharCode(...gn.value));
          }
        }
      }
      break;
  }
}

/** Go IsTSASigningCert: EKU яг нэг, critical, яг { timeStamping }. */
export function isTSASigningCert(c: Certificate): boolean {
  const ekus = c.extensions.filter((e) => e.oid === OID.extKeyUsage);
  if (ekus.length !== 1) return false;
  const e = ekus[0]!;
  try {
    const oids = children(parseOne(e.value));
    return e.critical && oids.length === 1 && oids[0]!.tag === TAG.OID && oidString(oids[0]!.value) === OID.kpTimeStamping;
  } catch {
    return false;
  }
}

export function certEqual(a: Certificate, b: Certificate): boolean {
  return equal(a.raw, b.raw);
}

// ── гарын үсэг ──

type Hash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

const HASH_BY_OID: Record<string, Hash> = {
  [OID.sha1]: "SHA-1",
  [OID.sha256]: "SHA-256",
  [OID.sha384]: "SHA-384",
  [OID.sha512]: "SHA-512",
};

interface SigScheme {
  kind: "rsa" | "pss" | "ecdsa";
  hash: Hash;
  saltLength?: number;
}

function schemeFor(alg: Node): SigScheme {
  const p = children(alg);
  const o = oidString(expect(p[0], TAG.OID, "sigAlg").value);
  switch (o) {
    case "1.2.840.113549.1.1.5":
      return { kind: "rsa", hash: "SHA-1" };
    case OID.sha256WithRSA:
      return { kind: "rsa", hash: "SHA-256" };
    case OID.sha384WithRSA:
      return { kind: "rsa", hash: "SHA-384" };
    case OID.sha512WithRSA:
      return { kind: "rsa", hash: "SHA-512" };
    case "1.2.840.10045.4.1": // ecdsa-with-SHA1 (Go CheckSignature зөвшөөрдөг; гинжид validate/evaluate.ts татгалзана)
      return { kind: "ecdsa", hash: "SHA-1" };
    case OID.ecdsaSHA256:
      return { kind: "ecdsa", hash: "SHA-256" };
    case OID.ecdsaSHA384:
      return { kind: "ecdsa", hash: "SHA-384" };
    case OID.ecdsaSHA512:
      return { kind: "ecdsa", hash: "SHA-512" };
    case OID.rsaPSS: {
      // RSASSA-PSS-params { [0] hashAlgorithm, [1] maskGen, [2] saltLength }
      let hash: Hash = "SHA-1";
      let salt = 20;
      for (const f of p[1] ? children(p[1]) : []) {
        if (f.tag === 0xa0) hash = HASH_BY_OID[oidString(children(children(f)[0]!)[0]!.value)] ?? hash;
        if (f.tag === 0xa2) salt = Number(children(f)[0]!.value[0]);
      }
      return { kind: "pss", hash, saltLength: salt };
    }
  }
  throw new CertError(`гарын үсгийн алгоритм дэмжигдэхгүй: ${o}`);
}

const CURVES: Record<string, { name: string; size: number }> = {
  [OID.p256]: { name: "P-256", size: 32 },
  [OID.p384]: { name: "P-384", size: 48 },
  [OID.p521]: { name: "P-521", size: 66 },
};

/** ECDSA DER (SEQUENCE{r,s}) → r‖s (Web Crypto). */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
  const [r, s] = children(parseOne(der));
  const out = new Uint8Array(2 * size);
  const put = (v: Uint8Array, at: number): void => {
    let x = v;
    while (x.length > 0 && x[0] === 0) x = x.subarray(1);
    if (x.length > size) throw new CertError("ECDSA утга хэт урт");
    out.set(x, at + size - x.length);
  };
  put(expect(r, TAG.INTEGER, "r").value, 0);
  put(expect(s, TAG.INTEGER, "s").value, size);
  return out;
}

/** `pub`-ийн түлхүүрээр `data`-д `alg`-ийн гарын үсэг (DER/PKCS#1) зөв эсэх. */
export async function verifySignature(pub: Certificate, alg: Node, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const sch = schemeFor(alg);
  return verifyWith(pub, sch, data, sig);
}

async function verifyWith(pub: Certificate, sch: SigScheme, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const s = await subtle();
  try {
    if (sch.kind === "ecdsa") {
      if (pub.keyAlg !== OID.ecPublicKey) return false;
      const c = CURVES[pub.curve ?? ""];
      if (!c) return false;
      const key = await s.importKey("spki", pub.spki, { name: "ECDSA", namedCurve: c.name }, false, ["verify"]);
      return await s.verify({ name: "ECDSA", hash: sch.hash }, key, ecdsaDerToRaw(sig, c.size), data);
    }
    if (pub.keyAlg !== OID.rsaEncryption) return false;
    if (sch.kind === "pss") {
      const key = await s.importKey("spki", pub.spki, { name: "RSA-PSS", hash: sch.hash }, false, ["verify"]);
      return await s.verify({ name: "RSA-PSS", saltLength: sch.saltLength ?? 32 }, key, sig, data);
    }
    const key = await s.importKey("spki", pub.spki, { name: "RSASSA-PKCS1-v1_5", hash: sch.hash }, false, ["verify"]);
    return await s.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data);
  } catch {
    return false;
  }
}

/** Иргэний гарын үсэг (DTBS = SHA-256(signedAttrs)): RSA PKCS#1 v1.5 эсвэл ECDSA (r‖s / DER). CMS-д бичих хэлбэр. */
export async function verifyCitizen(cert: Certificate, signedAttrs: Uint8Array, sig: Uint8Array): Promise<Uint8Array | undefined> {
  if (cert.keyAlg === OID.rsaEncryption) {
    return (await verifyWith(cert, { kind: "rsa", hash: "SHA-256" }, signedAttrs, sig)) ? sig : undefined;
  }
  if (cert.keyAlg === OID.ecPublicKey) {
    const c = CURVES[cert.curve ?? ""];
    if (!c) return undefined;
    if (sig.length === 2 * c.size) {
      const der = rawToEcdsaDer(sig, c.size);
      if (await verifyWith(cert, { kind: "ecdsa", hash: "SHA-256" }, signedAttrs, der)) return der;
    }
    try {
      return (await verifyWith(cert, { kind: "ecdsa", hash: "SHA-256" }, signedAttrs, sig)) ? sig : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** r‖s → Go asn1.Marshal(struct{R,S *big.Int}) (эерэг бүхэл, minimal). */
function rawToEcdsaDer(raw: Uint8Array, size: number): Uint8Array {
  const int = (v: Uint8Array): number[] => {
    let x = Array.from(v);
    while (x.length > 1 && x[0] === 0) x = x.slice(1);
    if (x.length === 1 && x[0] === 0) return [0x02, 0x01, 0x00];
    if (x[0]! & 0x80) x = [0, ...x];
    return [0x02, x.length, ...x];
  };
  const body = [...int(raw.subarray(0, size)), ...int(raw.subarray(size))];
  return Uint8Array.from(body.length < 0x80 ? [0x30, body.length, ...body] : [0x30, 0x81, body.length, ...body]);
}

/** Go x509 CheckSignature(alg, signed, sig) — хязгаарлалтгүй. */
export function checkSignature(parent: Certificate, alg: Node, signed: Uint8Array, sig: Uint8Array): Promise<boolean> {
  return verifySignature(parent, alg, signed, sig);
}

/** Go Certificate.CheckSignatureFrom: parent нь CA (v3 + basicConstraints), keyUsage байвал certSign. */
export async function checkSignatureFrom(c: Certificate, parent: Certificate): Promise<boolean> {
  if ((parent.version === 3 && !parent.basicConstraintsValid) || (parent.basicConstraintsValid && !parent.isCA)) return false;
  if (parent.keyUsage !== 0 && !(parent.keyUsage & (1 << 5))) return false;
  return verifySignature(parent, c.sigAlg, c.tbs, c.signature);
}

/**
 * TSA гинж (Go verifyTSAChain → x509.Verify): signer-ээс root хүртэл нэр + гарын үсэг, CA-ийн хязгаарлалт, хугацаа
 * (at), leaf-ийн EKU (timeStamping). roots — итгэлийн тулгуур, pool — завсрын CA.
 */
export async function verifyChain(leaf: Certificate, pool: Certificate[], roots: Certificate[], at: Date, eku: string): Promise<boolean> {
  const valid = (c: Certificate): boolean => c.notBefore.getTime() <= at.getTime() && at.getTime() <= c.notAfter.getTime();
  if (!valid(leaf)) return false;
  if (leaf.extKeyUsage.length > 0 && !leaf.extKeyUsage.includes(eku) && !leaf.extKeyUsage.includes(OID.kpAny)) return false;
  if (hasUnhandledCritical(leaf)) return false;
  const walk = async (cur: Certificate, depth: number): Promise<boolean> => {
    if (depth > 8) return false;
    for (const r of roots) {
      if (equal(r.rawSubject, cur.rawIssuer) && (await checkSignatureFrom(cur, r))) return true;
    }
    for (const p of pool) {
      if (equal(p.raw, cur.raw) || !equal(p.rawSubject, cur.rawIssuer) || !valid(p) || hasUnhandledCritical(p)) continue;
      // Go: завсрын CA-ийн EKU (байвал) хүссэн EKU-г зөвшөөрөх ёстой.
      if (p.extKeyUsage.length > 0 && !p.extKeyUsage.includes(eku) && !p.extKeyUsage.includes(OID.kpAny)) continue;
      if ((await checkSignatureFrom(cur, p)) && (await walk(p, depth + 1))) return true;
    }
    return false;
  };
  return walk(leaf, 0);
}

const HANDLED = new Set<string>([
  OID.keyUsage,
  OID.extKeyUsage,
  OID.basicConstraints,
  "2.5.29.17", // SAN
  "2.5.29.30", // name constraints
  "2.5.29.32", // policies
  OID.crlDP,
  OID.aia,
  "2.5.29.14",
  "2.5.29.35",
]);

function hasUnhandledCritical(c: Certificate): boolean {
  return c.extensions.some((e) => e.critical && !HANDLED.has(e.oid));
}
