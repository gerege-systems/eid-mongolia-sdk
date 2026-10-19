// Итгэлийн шийдвэр — CA server/internal/validate/{validate.go,ltv.go} ба Go SDK pades/{trust.go,validatepdf.go}-ийн порт.
// Гинжийг Go crypto/x509 Verify-ийн зан төлөвөөр (эх нэрийн/түлхүүрийн ID-ийн эрэмбэ, SHA-1 татгалзах, хугацаа, EKU)
// бүтээнэ — тайлан CA-ийн /v3/validate/pdf-тэй ижил JSON.

import { TAG, children, expect, intValue, oidString, parseOne, parsePreciseTime, readNode } from "../asn1.js";
import { equal, toHex } from "../bytes.js";
import { ocspFreshAt, parseOCSP, parseOCSPFrom, sameCertKey, ocspRequest, type OCSPResp } from "../ltv.js";
import { SHA1_SIG, crlFor, crlListed, freshAt, ocspCertIDMatches, parseCRL, type ParsedCRL } from "../revocation.js";
import type { Fetcher } from "../fetch.js";
import { OID, isTSASigningCert, parseCertificate, verifySignature, type Certificate } from "../x509.js";
import type { RawDSS, RawSignature, RawTimestamp } from "./extract.js";
import { addMs, after, before, commonName, formatTime, fromDate, fromPrecise, hexSerial, isZero, nameString, subjectNames, subjectSerialNumber, type GoTime } from "./gofmt.js";

export type Indication = "valid" | "invalid" | "indeterminate";

export const PROBLEMS = {
  integrity: "integrity_failed",
  malformed: "malformed_signature",
  weakAlgorithm: "weak_algorithm",
  untrusted: "untrusted_chain",
  keyUsage: "wrong_key_usage",
  revoked: "revoked",
  revokedAfter: "revoked_after_signing",
  revocationUnknown: "revocation_unavailable",
  expired: "expired",
  notYetValid: "not_yet_valid",
  modifiedAfter: "modified_after_signing",
  timestampInvalid: "timestamp_invalid",
} as const;

export interface Revocation {
  status: "good" | "revoked" | "unknown";
  revoked_at?: string;
}

export interface CertInfo {
  common_name: string;
  subject: string;
  issuer: string;
  serial: string;
  not_before: string;
  not_after: string;
  usage: "sign" | "auth" | "seal" | "document_signer" | "timestamp" | "other";
  issued_by_eid: boolean;
  revocation: Revocation;
}

export interface TimestampInfo {
  time: string;
  serial: string;
  tsa: string;
  trusted: boolean;
}

export interface LTVInfo {
  complete: boolean;
  missing: string[];
}

/** CA SignatureReport-ийн JSON (snake_case). */
export interface SignatureReport {
  indication: Indication;
  problems: string[];
  signer_name: string;
  claimed_name?: string;
  signer_name_source: "platform_attested" | "certificate" | "unverified";
  reason?: string;
  location?: string;
  claimed_time?: string;
  signing_time?: string;
  timestamp?: TimestampInfo;
  covers_whole_document: boolean;
  extended_by_signatures_only: boolean;
  later_signatures: number;
  visible_later_signature: boolean;
  visible: boolean;
  chain_trusted: boolean;
  chain: string[];
  certificate?: CertInfo;
  civil_id?: string;
  /** Зурагчийн түлхүүрийн байршил (CA !377): "token" | "phone" | "unknown". */
  key_medium: "token" | "phone" | "unknown";
  claimed_roles?: string[];
  signature_level?: "PAdES-BASELINE-B" | "PAdES-BASELINE-T" | "PAdES-BASELINE-LT";
  ltv?: LTVInfo;
  certificate_level?: "ADVANCED" | "QUALIFIED" | "QSCD";
}

export interface PdfReport {
  indication: Indication;
  signatures: SignatureReport[];
}

/** Цуцлалтын эх сурвалж (CA Store-ийн оронд): eID олгогчийн гаргасан гэрчилгээний төлөв. */
export interface CertStatus {
  issued: boolean;
  revoked: boolean;
  revokedAt?: GoTime;
}

/**
 * cert — шалгах гэрчилгээ, issuer — гинжийн (гарын үсгээр баталгаажсан) олгогч: нотолгоо (OCSP CertID, CRL issuer/гарын
 * үсэг) энэ хосынх байх ёстой. at — шалгах цаг (цагийн тэмдгийн цаг эсвэл одоо): «good» нотолгоо at-д шинэлэг (freshAt).
 */
export interface StatusSource {
  certStatus(cert: Certificate, issuer: Certificate, at: GoTime): Promise<CertStatus>;
}

export interface EvalConfig {
  roots: Certificate[];
  intermediates: Certificate[];
  issuers: Certificate[];
  status?: StatusSource;
  now: GoTime;
}

// ── гинж (Go crypto/x509 Verify) ──

/** Go Certificate.CheckSignatureFrom (SHA-1/MD5 татгалзана). */
export async function checkSigFrom(c: Certificate, parent: Certificate): Promise<boolean> {
  if ((parent.version === 3 && !parent.basicConstraintsValid) || (parent.basicConstraintsValid && !parent.isCA)) return false;
  if (parent.keyUsage !== 0 && !(parent.keyUsage & (1 << 5))) return false;
  if (SHA1_SIG.has(oidString(children(c.sigAlg)[0]!.value))) return false;
  try {
    return await verifySignature(parent, c.sigAlg, c.tbs, c.signature);
  } catch {
    return false;
  }
}

const HANDLED_CRITICAL = new Set([
  "2.5.29.15",
  "2.5.29.37",
  "2.5.29.19",
  "2.5.29.17",
  "2.5.29.30",
  "2.5.29.32",
  "2.5.29.31",
  "2.5.29.35",
  "2.5.29.14",
  "2.5.29.36",
  "2.5.29.54",
  "2.5.29.33",
]);

function extValue(c: Certificate, oid: string): Uint8Array | undefined {
  return c.extensions.find((e) => e.oid === oid)?.value;
}

function keyId(c: Certificate, oid: "2.5.29.14" | "2.5.29.35"): Uint8Array {
  const v = extValue(c, oid);
  if (!v) return new Uint8Array();
  try {
    const n = parseOne(v);
    if (oid === "2.5.29.14") return n.tag === TAG.OCTET_STRING ? n.value : new Uint8Array();
    const k = children(n).find((x) => x.tag === 0x80);
    return k ? k.value : new Uint8Array();
  } catch {
    return new Uint8Array();
  }
}

/** basicConstraints pathLenConstraint (-1 — байхгүй). */
function maxPathLen(c: Certificate): number {
  const v = extValue(c, OID.basicConstraints);
  if (!v) return -1;
  try {
    const p = children(parseOne(v)).find((x) => x.tag === TAG.INTEGER);
    return p ? Number(intValue(p.value)) : -1;
  } catch {
    return -1;
  }
}

const validAt = (c: Certificate, at: GoTime): boolean => !before(at, fromDate(c.notBefore)) && !after(at, fromDate(c.notAfter));

class CertPool {
  private readonly list: Certificate[] = [];
  add(c: Certificate): void {
    if (!this.list.some((x) => equal(x.raw, c.raw))) this.list.push(c);
  }
  contains(c: Certificate): boolean {
    return this.list.some((x) => equal(x.raw, c.raw));
  }
  /** Go findPotentialParents: AKID=SKID → нэг нь алга → зөрсөн. */
  parents(c: Certificate): Certificate[] {
    const akid = keyId(c, "2.5.29.35");
    const m: Certificate[] = [];
    const one: Certificate[] = [];
    const mis: Certificate[] = [];
    for (const p of this.list) {
      if (!equal(p.rawSubject, c.rawIssuer)) continue;
      const skid = keyId(p, "2.5.29.14");
      if (equal(skid, akid)) m.push(p);
      else if ((skid.length === 0 && akid.length > 0) || (skid.length > 0 && akid.length === 0)) one.push(p);
      else mis.push(p);
    }
    return [...m, ...one, ...mis];
  }
}

const unhandledCritical = (c: Certificate): boolean => c.extensions.some((e) => e.critical && !HANDLED_CRITICAL.has(e.oid));

async function buildChains(chain: Certificate[], roots: CertPool, inter: CertPool, at: GoTime, budget: { n: number }): Promise<Certificate[][]> {
  const c = chain[chain.length - 1]!;
  const out: Certificate[][] = [];
  const consider = async (cand: Certificate, root: boolean): Promise<void> => {
    if (chain.some((x) => equal(x.rawSubject, cand.rawSubject) && equal(x.spki, cand.spki))) return;
    if (++budget.n > 100) return;
    if (!(await checkSigFrom(c, cand))) return;
    if (unhandledCritical(cand) || !validAt(cand, at)) return;
    if (!root && (!cand.basicConstraintsValid || !cand.isCA)) return;
    const mpl = maxPathLen(cand);
    if (cand.basicConstraintsValid && mpl >= 0 && chain.length - 1 > mpl) return;
    if (root) out.push([...chain, cand]);
    else out.push(...(await buildChains([...chain, cand], roots, inter, at, budget)));
  };
  for (const r of roots.parents(c)) await consider(r, true);
  for (const p of inter.parents(c)) await consider(p, false);
  return out;
}

/** Go checkChainForKeyUsage. */
function chainAllows(chain: Certificate[], eku: string): boolean {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]!;
    if (c.extKeyUsage.length === 0) continue;
    if (c.extKeyUsage.includes(OID.kpAny)) continue;
    if (!c.extKeyUsage.includes(eku)) return false;
  }
  return true;
}

// ── Evaluator ──

export class Evaluator {
  constructor(private readonly cfg: EvalConfig) {}

  private pool(extra: Certificate[]): CertPool {
    const p = new CertPool();
    for (const c of extra) p.add(c);
    for (const c of this.cfg.intermediates) p.add(c);
    return p;
  }

  /** verifyAt — leaf-ийг үндэсний Root CA хүртэл яг at цагт (eku "" — ExtKeyUsageAny). */
  async verifyAt(leaf: Certificate, extra: Certificate[], at: GoTime, eku: string): Promise<Certificate[] | undefined> {
    if (this.cfg.roots.length === 0) return undefined;
    if (unhandledCritical(leaf) || !validAt(leaf, at)) return undefined;
    const roots = new CertPool();
    for (const r of this.cfg.roots) roots.add(r);
    if (roots.contains(leaf)) return [leaf];
    const chains = await buildChains([leaf], roots, this.pool(extra), at, { n: 0 });
    return eku === "" ? chains[0] : chains.find((ch) => chainAllows(ch, eku));
  }

  async verifyChain(leaf: Certificate, extra: Certificate[], at: GoTime): Promise<Certificate[] | undefined> {
    const ch = await this.verifyAt(leaf, extra, at, "");
    if (ch) return ch;
    const nb = fromDate(leaf.notBefore);
    const na = fromDate(leaf.notAfter);
    if (after(at, na) || before(at, nb)) {
      const mid = addMs(nb, Math.trunc((leaf.notAfter.getTime() - leaf.notBefore.getTime()) / 2));
      return this.verifyAt(leaf, extra, mid, "");
    }
    return undefined;
  }

  private isIssuer(c: Certificate): boolean {
    return this.cfg.issuers.some((is) => equal(c.rawSubject, is.rawSubject) && equal(c.spki, is.spki));
  }

  async certInfo(c: Certificate, chain: Certificate[] | undefined, at: GoTime): Promise<CertInfo> {
    const info: CertInfo = {
      common_name: commonName(c.rawSubject),
      subject: nameString(c.rawSubject),
      issuer: nameString(c.rawIssuer),
      serial: hexSerial(c.serial),
      not_before: formatTime(fromDate(c.notBefore)),
      not_after: formatTime(fromDate(c.notAfter)),
      usage: usageOf(c),
      issued_by_eid: false,
      revocation: { status: "unknown" },
    };
    if (!chain || chain.length < 2 || !this.isIssuer(chain[1]!)) return info;
    info.issued_by_eid = true;
    if (!this.cfg.status) return info;
    let st: CertStatus;
    try {
      st = await this.cfg.status.certStatus(c, chain[1]!, at);
    } catch {
      return info;
    }
    if (!st.issued) return info;
    if (st.revoked) {
      info.revocation = { status: "revoked", revoked_at: formatTime(st.revokedAt!) };
      this.lastRevokedAt = st.revokedAt;
    }
    else info.revocation = { status: "good" };
    return info;
  }

  async evaluateTimestamp(r: RawTimestamp): Promise<{ info: TimestampInfo; chain?: Certificate[]; ok: boolean }> {
    const info: TimestampInfo = { time: formatTime(r.time), serial: r.serial, tsa: "", trusted: false };
    let tsa: Certificate;
    try {
      tsa = parseCertificate(r.tsaCert ?? new Uint8Array());
    } catch {
      return { info, ok: false };
    }
    info.tsa = commonName(tsa.rawSubject);
    if (!r.matches || r.weakDigest || isZero(r.time) || !isTSASigningCert(tsa)) return { info, ok: false };
    const chain = await this.verifyAt(tsa, parseCerts(r.certs), r.time, OID.kpTimeStamping);
    info.trusted = chain !== undefined;
    return { info, chain, ok: info.trusted };
  }

  async evaluateSignature(r: RawSignature): Promise<SignatureReport> {
    const s: SignatureReport = {
      indication: "valid",
      problems: [],
      signer_name: "",
      signer_name_source: "unverified",
      covers_whole_document: r.coversWhole,
      extended_by_signatures_only: false,
      later_signatures: 0,
      visible_later_signature: false,
      visible: r.visible,
      chain_trusted: false,
      chain: [],
      key_medium: "unknown",
    };
    if (r.signerName) s.claimed_name = r.signerName;
    if (r.reason) s.reason = r.reason;
    if (r.location) s.location = r.location;
    if (r.claimedTime) s.claimed_time = formatTime(r.claimedTime);
    if (r.claimedRoles.length > 0) s.claimed_roles = r.claimedRoles;
    if (!r.coversWhole && r.laterSignaturesOnly) {
      s.extended_by_signatures_only = true;
      s.later_signatures = r.laterSignatures;
      s.visible_later_signature = r.laterVisible;
    }
    const fail = (p: string): SignatureReport => {
      s.problems.push(p);
      s.indication = "invalid";
      return s;
    };
    if (r.malformed) return fail(PROBLEMS.malformed);
    let leaf: Certificate;
    try {
      leaf = parseCertificate(r.leaf ?? new Uint8Array());
    } catch {
      return fail(PROBLEMS.malformed);
    }
    s.signer_name = displayName(leaf);
    s.signer_name_source = "certificate";
    const civil = civilID(leaf);
    if (civil) s.civil_id = civil;
    if (!r.integrity) return fail(PROBLEMS.integrity);
    if (r.weakDigest) return fail(PROBLEMS.weakAlgorithm);
    const cades = r.subFilter === "ETSI.CAdES.detached";
    if (cades && r.signingCertV2 !== "match") return fail(PROBLEMS.malformed);

    let at = this.cfg.now;
    let signingTime: GoTime | undefined;
    let tsChain: Certificate[] | undefined;
    if (r.timestamp) {
      const ts = await this.evaluateTimestamp(r.timestamp);
      tsChain = ts.chain;
      s.timestamp = ts.info;
      if (ts.ok) {
        signingTime = r.timestamp.time;
        s.signing_time = formatTime(signingTime);
        at = signingTime;
      } else s.problems.push(PROBLEMS.timestampInvalid);
    }

    const chain = await this.verifyChain(leaf, parseCerts(r.certs), at);
    const trusted = chain !== undefined;
    s.chain_trusted = trusted;
    s.chain = chain ? chain.map((c) => commonName(c.rawSubject)) : [commonName(leaf.rawSubject)];
    this.lastRevokedAt = undefined;
    const info = await this.certInfo(leaf, chain, at);
    s.certificate = info;
    if (!trusted) s.problems.push(PROBLEMS.untrusted);
    if (!["sign", "seal", "document_signer"].includes(info.usage)) s.problems.push(PROBLEMS.keyUsage);
    if (after(at, fromDate(leaf.notAfter))) s.problems.push(PROBLEMS.expired);
    else if (before(at, fromDate(leaf.notBefore))) s.problems.push(PROBLEMS.notYetValid);
    if (info.revocation.status === "revoked") {
      const ra = this.lastRevokedAt;
      if (signingTime && ra && after(ra, signingTime)) s.problems.push(PROBLEMS.revokedAfter);
      else s.problems.push(PROBLEMS.revoked);
    } else if (info.revocation.status === "unknown" && trusted) {
      s.problems.push(PROBLEMS.revocationUnknown);
    }
    if (trusted && info.issued_by_eid && info.usage === "document_signer" && !s.problems.includes(PROBLEMS.revoked)) {
      s.signer_name = r.signerName;
      s.signer_name_source = "platform_attested";
    }
    if (cades && r.signingTimeAttr && info.issued_by_eid) s.problems.push(PROBLEMS.malformed);
    if (!r.coversWhole && !r.laterSignaturesOnly) s.problems.push(PROBLEMS.modifiedAfter);
    if (trusted) s.ltv = await ltvCoverage(r.dss, at, this.cfg.now, [chain!, tsChain ?? []]);
    if (cades) {
      s.signature_level = signingTime && s.ltv?.complete ? "PAdES-BASELINE-LT" : signingTime ? "PAdES-BASELINE-T" : "PAdES-BASELINE-B";
    }
    s.indication = indication(s.problems);
    return s;
  }

  /** certInfo-ийн сүүлийн revoked_at (GoTime — нарийвчлалтай харьцуулахад). */
  private lastRevokedAt?: GoTime;
}

export function indication(problems: string[]): Indication {
  let out: Indication = "valid";
  for (const p of problems) {
    switch (p) {
      case PROBLEMS.integrity:
      case PROBLEMS.malformed:
      case PROBLEMS.weakAlgorithm:
      case PROBLEMS.untrusted:
      case PROBLEMS.keyUsage:
      case PROBLEMS.revoked:
      case PROBLEMS.expired:
      case PROBLEMS.notYetValid:
        return "invalid";
      case PROBLEMS.revokedAfter:
        break;
      default:
        out = "indeterminate";
    }
  }
  return out;
}

export function parseCerts(ders: Uint8Array[]): Certificate[] {
  const out: Certificate[] = [];
  for (const d of ders) {
    try {
      out.push(parseCertificate(d));
    } catch {
      // алгасна
    }
  }
  return out;
}

/** eidcrypto.SubjectDisplayName. */
function displayName(c: Certificate): string {
  const { given, surname } = subjectNames(c.rawSubject);
  const n = `${given} ${surname}`.trim();
  return n !== "" ? n : commonName(c.rawSubject);
}

function civilID(c: Certificate): string {
  const sn = subjectSerialNumber(c.rawSubject);
  return sn.startsWith("PNOMN-") ? sn.slice(6) : "";
}

const EKU_DOCUMENT_SIGNING = "1.3.6.1.5.5.7.3.36";
const GO_KNOWN_EKU = new Set([
  "2.5.29.37.0",
  "1.3.6.1.5.5.7.3.1",
  "1.3.6.1.5.5.7.3.2",
  "1.3.6.1.5.5.7.3.3",
  "1.3.6.1.5.5.7.3.4",
  "1.3.6.1.5.5.7.3.5",
  "1.3.6.1.5.5.7.3.6",
  "1.3.6.1.5.5.7.3.7",
  "1.3.6.1.5.5.7.3.8",
  "1.3.6.1.5.5.7.3.9",
  "1.3.6.1.4.1.311.10.3.3",
  "2.16.840.1.113730.4.1",
  "1.3.6.1.4.1.311.2.1.22",
  "1.3.6.1.4.1.311.61.1.1",
]);

/** CA usageOf: KU/EKU-аар профайл. */
function usageOf(c: Certificate): CertInfo["usage"] {
  const known = c.extKeyUsage.filter((e) => GO_KNOWN_EKU.has(e));
  for (const e of known) {
    if (e === OID.kpTimeStamping) return "timestamp";
    if (e === OID.kpOCSPSigning) return "other";
  }
  if (c.isCA) return "other";
  if (c.extKeyUsage.includes(EKU_DOCUMENT_SIGNING)) return "document_signer";
  const cc = (c.keyUsage & (1 << 1)) !== 0;
  const ds = (c.keyUsage & 1) !== 0;
  if (cc && !ds && known.length === 0) return "seal";
  if (cc) return "sign";
  if (ds && known.includes("1.3.6.1.5.5.7.3.2")) return "auth";
  return "other";
}

// ── LTV (ltv.go) ──

const OID_OCSP_NOCHECK = "1.3.6.1.5.5.7.48.1.5";

/**
 * Go ltvCoverage — гинжийн (leaf → root) ба TSA гинжийн root-оос бусад гэрчилгээ бүрд DSS-д олгогчийн (эсвэл delegated
 * nocheck responder-ийн) зурсан, CertID таарсан, `good`, at-д шинэлэг (freshAt) OCSP эсвэл олгогчийн, шинэлэг, тэр
 * гэрчилгээг агуулаагүй CRL. now — шалгагчийн одоо (ирээдүйн thisUpdate-ийг татгалзана).
 */
async function ltvCoverage(dss: RawDSS | undefined, at: GoTime, now: GoTime, chains: Certificate[][]): Promise<LTVInfo> {
  const out: LTVInfo = { complete: false, missing: [] };
  const crls: ParsedCRL[] = [];
  for (const der of dss?.crls ?? []) {
    const c = parseCRL(der);
    if (c) crls.push(c);
  }
  const seen: Uint8Array[] = [];
  for (const chain of chains) {
    for (let i = 0; i + 1 < chain.length; i++) {
      const cert = chain[i]!;
      const issuer = chain[i + 1]!;
      if (seen.some((x) => equal(x, cert.raw))) continue;
      seen.push(cert.raw);
      if (!(await covered(cert, issuer, at, now, dss?.ocsps ?? [], crls))) out.missing.push(commonName(cert.rawSubject));
    }
  }
  out.complete = out.missing.length === 0 && seen.length > 0;
  return out;
}

async function covered(cert: Certificate, issuer: Certificate, at: GoTime, now: GoTime, ocsps: Uint8Array[], crls: ParsedCRL[]): Promise<boolean> {
  for (const der of ocsps) {
    let resp: OCSPResp;
    try {
      resp = await parseOCSP(der, intValue(cert.serial), issuer);
    } catch {
      continue;
    }
    if (resp.status !== "good" || !(await ocspCertIDMatches(der, cert, issuer))) continue;
    if (resp.certificate && !equal(resp.certificate.raw, issuer.raw) && !resp.certificate.extensions.some((e) => e.oid === OID_OCSP_NOCHECK)) continue;
    if (ocspFreshAt(resp, at, now)) return true;
  }
  for (const crl of crls) {
    if (!(await crlFor(crl, cert, issuer)) || !freshAt(crl.thisUpdate, crl.nextUpdate, at, now)) continue;
    if (crlListed(crl, cert)) continue;
    return true;
  }
  return false;
}

// ── цуцлалтын эх сурвалж ──

function responderOK(resp: OCSPResp, issuer: Certificate): boolean {
  if (!resp.certificate || equal(resp.certificate.raw, issuer.raw)) return true;
  return resp.certificate.extKeyUsage.includes(OID.kpOCSPSigning);
}

/** Go ocspFor — der нь cert-ийн (CertID = issuer + serial) хариу, олгогч эсвэл түүний OCSPSigning responder зурсан. */
async function ocspFor(der: Uint8Array, cert: Certificate, issuer: Certificate): Promise<OCSPResp | undefined> {
  let resp: OCSPResp;
  try {
    resp = await parseOCSPFrom(der, intValue(cert.serial), issuer);
  } catch {
    return undefined;
  }
  if (resp.serial !== intValue(cert.serial) || !(await ocspCertIDMatches(der, cert, issuer)) || !responderOK(resp, issuer)) return undefined;
  return resp;
}

/**
 * Go dssStatus: баримтын DSS-ийн OCSP/CRL-ээс. Нотолгоо нь ЭНЭ гэрчилгээ + түүний гинжийн олгогчийнх байх ёстой (OCSP
 * CertID, CRL нэр/AKI/гарын үсэг). Цуцалсан нотолгоо аль нэг нь байвал revoked (шинэлэг эсэхээс үл хамааран, хамгийн
 * эрт цаг — «good»-ийг давна); үгүй бол at-д шинэлэг good нотолгоо байвал good; эс бөгөөс issued=false (unknown).
 */
export class DSSStatus implements StatusSource {
  constructor(
    private readonly dss: RawDSS | undefined,
    private readonly now: GoTime,
  ) {}

  async certStatus(cert: Certificate, issuer: Certificate, at: GoTime): Promise<CertStatus> {
    let revoked: GoTime | undefined;
    const markRevoked = (t: GoTime): void => {
      if (!revoked || before(t, revoked)) revoked = t;
    };
    let good = false;
    for (const der of this.dss?.ocsps ?? []) {
      const resp = await ocspFor(der, cert, issuer);
      if (!resp) continue;
      if (resp.status === "revoked") markRevoked(fromPrecise(resp.revokedAt!));
      else if (resp.status === "good") good ||= ocspFreshAt(resp, at, this.now);
    }
    for (const der of this.dss?.crls ?? []) {
      const crl = parseCRL(der);
      if (!crl || !(await crlFor(crl, cert, issuer))) continue;
      const t = crlListed(crl, cert);
      if (t) markRevoked(t);
      else good ||= freshAt(crl.thisUpdate, crl.nextUpdate, at, this.now);
    }
    if (revoked) return { issued: true, revoked: true, revokedAt: revoked };
    if (good) return { issued: true, revoked: false };
    return { issued: false, revoked: false };
  }
}

const ONLINE_OCSP_MAX = 16 << 10;

/**
 * Go onlineStatus: AIA OCSP, эс бөгөөс CDP CRL (одоогийн төлөв, now-д шинэлэг); хариугүй бол fallback (DSS). Онлайн
 * «good» байсан ч fallback-д олгогчийн гарын үсэгтэй цуцалсан нотолгоо байвал revoked (цуцлалт буцахгүй).
 */
export class OnlineStatus implements StatusSource {
  private readonly cache = new Map<string, CertStatus>();

  constructor(
    private readonly f: Fetcher,
    private readonly fallback: StatusSource | undefined,
    private readonly now: GoTime,
  ) {}

  async certStatus(cert: Certificate, issuer: Certificate, at: GoTime): Promise<CertStatus> {
    const key = toHex(cert.raw) + ":" + toHex(issuer.raw);
    const hit = this.cache.get(key);
    if (hit) return hit;
    let st = (await this.ocsp(cert, issuer)) ?? (await this.crl(cert, issuer));
    if (this.fallback && (!st || !st.revoked)) {
      const fst = await this.fallback.certStatus(cert, issuer, at);
      if (!st || fst.revoked) st = fst;
    }
    st ??= { issued: false, revoked: false };
    this.cache.set(key, st);
    return st;
  }

  private async ocsp(cert: Certificate, issuer: Certificate): Promise<CertStatus | undefined> {
    let req: Uint8Array;
    try {
      req = await ocspRequest(cert, issuer);
    } catch {
      return undefined;
    }
    const now = this.now;
    for (const u of cert.ocspServers) {
      let der: Uint8Array;
      try {
        der = await this.f.do("POST", u, "application/ocsp-request", req);
      } catch {
        continue;
      }
      if (der.length > ONLINE_OCSP_MAX) continue;
      const resp = await ocspFor(der, cert, issuer);
      if (!resp) continue;
      const rc = resp.certificate;
      if (rc && !sameCertKey(rc, issuer) && !validAt(rc, now)) continue;
      if (resp.status === "revoked") return { issued: true, revoked: true, revokedAt: fromPrecise(resp.revokedAt!) };
      if (!ocspFreshAt(resp, now, now)) continue;
      if (resp.status === "good") return { issued: true, revoked: false };
      return { issued: false, revoked: false };
    }
    return undefined;
  }

  private async crl(cert: Certificate, issuer: Certificate): Promise<CertStatus | undefined> {
    for (const u of cert.crlDPs) {
      let crl: ParsedCRL | undefined;
      try {
        crl = parseCRL(await this.f.do("GET", u, ""));
      } catch {
        continue;
      }
      if (!crl || !(await crlFor(crl, cert, issuer))) continue;
      const t = crlListed(crl, cert);
      if (t) return { issued: true, revoked: true, revokedAt: t };
      if (freshAt(crl.thisUpdate, crl.nextUpdate, this.now, this.now)) return { issued: true, revoked: false };
    }
    return undefined;
  }
}

// ── түвшин (eid.CertificateLevelOf, RAW_DIGEST_SIGNATURE) ──

const OID_QC_STATEMENTS = "1.3.6.1.5.5.7.1.3";
const OID_QC_COMPLIANCE = "0.4.0.1862.1.1";
const OID_QC_SSCD = "0.4.0.1862.1.4";

/** qcStatements-д QcCompliance → QUALIFIED (+ QcSSCD → QSCD), бусад → ADVANCED; гэмтсэн бол undefined. */
export function signLevelOf(c: Certificate): SignatureReport["certificate_level"] {
  const e = c.extensions.find((x) => x.oid === OID_QC_STATEMENTS);
  if (!e) return "ADVANCED";
  try {
    const seq = parseOne(e.value);
    if (seq.tag !== TAG.SEQUENCE) return undefined;
    let compliance = false;
    let sscd = false;
    for (const st of children(seq)) {
      if (st.tag !== TAG.SEQUENCE) return undefined;
      const id = readNode(st.value, 0);
      if (id.tag !== TAG.OID) return undefined;
      const o = oidString(id.value);
      compliance ||= o === OID_QC_COMPLIANCE;
      sscd ||= o === OID_QC_SSCD;
    }
    return !compliance ? "ADVANCED" : sscd ? "QSCD" : "QUALIFIED";
  } catch {
    return undefined;
  }
}
