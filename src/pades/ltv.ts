// RFC 3161 TSA (Go reference pades/tsa.go) ба DSS-ийн OCSP/CRL цуглуулалт (pades/ltv.go). Хүсэлтийн DER нь Go-ийн
// digitorus/timestamp ба x/crypto/ocsp-ийн гаргадагтай байт-ижил (golden fixture-ийн түлхүүр = body-ийн sha256).

import { TAG, bigFromBytes, children, expect, intFromBig, intValue, nullDer, octet, oid, oidString, parseOne, parsePreciseTime, seq, type Node, type PreciseTime } from "./asn1.js";
import { equal, toHex } from "./bytes.js";
import { parseSignedData, verifySignedData } from "./cms.js";
import { sha1, sha256 } from "./crypto.js";
import type { Fetcher } from "./fetch.js";
import { CertificateRevokedError, crlFor, crlListed, freshAt, ocspCertIDMatches, parseCRL } from "./revocation.js";
import { OID, checkSignature, checkSignatureFrom, isTSASigningCert, parseCertificate, verifyChain, verifySignature, type Certificate } from "./x509.js";
import { ZERO_TIME, fromDate, fromPrecise, isZero, type GoTime } from "./validate/gofmt.js";

const MAX_TSA_SKEW_MS = 10 * 60_000;

export interface Timestamp {
  rawToken: Uint8Array;
  time: PreciseTime;
  certificates: Certificate[];
}

const tsMs = (t: PreciseTime): number => t.date.getTime();
/** a > b (наносекундын нарийвчлалтай). */
function after(a: PreciseTime, b: PreciseTime): boolean {
  const am = Math.floor(a.date.getTime() / 1000);
  const bm = Math.floor(b.date.getTime() / 1000);
  if (am !== bm) return am > bm;
  return a.nanos > b.nanos;
}

/** TimeStampReq (digitorus Request.Marshal): version 1, messageImprint (SHA-256, NULL), nonce, certReq TRUE. */
export function tsaRequest(hash: Uint8Array, nonce: Uint8Array): Uint8Array {
  return seq(intFromBig(1n), seq(seq(oid(OID.sha256), nullDer()), octet(hash)), intFromBig(bigFromBytes(nonce)), Uint8Array.of(0x01, 0x01, 0xff));
}

/** RFC 3161 token авч БАТАЛГААЖУУЛНА (nonce, imprint, TSA гинж roots-д EKU timeStamping-тэй, genTime ±10 мин). */
export async function timestampToken(f: Fetcher, tsaURL: string, signature: Uint8Array, roots: Certificate[], inter: Certificate[], now: Date, nonce: Uint8Array): Promise<Timestamp> {
  const sum = await sha256(signature);
  const body = await f.do("POST", tsaURL, "application/timestamp-query", tsaRequest(sum, nonce));
  const top = children(expect(parseOne(body), TAG.SEQUENCE, "TimeStampResp"));
  const status = intValue(expect(children(expect(top[0], TAG.SEQUENCE, "PKIStatusInfo"))[0], TAG.INTEGER, "status").value);
  if (status > 0n) throw new Error(`TSA status ${status}`);
  const tok = top[1];
  if (!tok || tok.value.length === 0) throw new Error("no pkcs7 data in Time-Stamp response");
  const rawToken = tok.raw;
  const sd = parseSignedData(rawToken);
  if (sd.certificates.length > 0 && !(await verifySignedData(sd))) throw new Error("TSA token-ийн гарын үсэг буруу");
  const info = children(expect(parseOne(sd.content), TAG.SEQUENCE, "TSTInfo"));
  const mi = children(expect(info[2], TAG.SEQUENCE, "messageImprint"));
  const hashAlg = oidString(children(mi[0]!)[0]!.value);
  const hashed = expect(mi[1], TAG.OCTET_STRING, "hashedMessage").value;
  if (hashed.length === 0) throw new Error("Time-Stamp response contains no hashed message");
  const genTime = parsePreciseTime(expect(info[4], TAG.GeneralizedTime, "genTime"));
  let tsNonce: Uint8Array | undefined;
  for (const n of info.slice(5)) if (n.tag === TAG.INTEGER) tsNonce = n.value;
  if (!tsNonce || intValue(tsNonce) !== bigFromBytes(nonce)) throw new Error("nonce таарахгүй");
  if (!equal(hashed, sum) || hashAlg !== OID.sha256) throw new Error("timestamp hash does not match");
  // TSA гинж (Go verifyTSAChain).
  if (sd.signerInfos.length !== 1) throw new Error("TSA signer ганц биш");
  const sid = children(sd.signerInfos[0]!)[1]!;
  const [iss, ser] = children(sid);
  const signer = sd.certificates.find((c) => equal(c.rawIssuer, iss!.raw) && equal(c.serial, ser!.value));
  if (!signer) throw new Error("signer cert олдсонгүй");
  if (!isTSASigningCert(signer)) throw new Error("signer cert-ийн EKU нь critical {timeStamping} биш (RFC 3161 §2.3)");
  const pool = [...sd.certificates, ...inter].filter((c) => !equal(c.raw, signer.raw));
  if (!(await verifyChain(signer, pool, roots, genTime.date, OID.kpTimeStamping))) throw new Error("TSA cert гинж");
  const d = now.getTime() - tsMs(genTime);
  if (d > MAX_TSA_SKEW_MS || d < -MAX_TSA_SKEW_MS) throw new Error("TSA genTime локал цагаас 10 минутаас их зөрөв");
  if (sd.certificates.length === 0) throw new Error("TSA token-д гэрчилгээ алга");
  return { rawToken, time: genTime, certificates: sd.certificates };
}

// ── OCSP ──

/** x/crypto/ocsp CreateRequest (SHA-1 CertID). */
export async function ocspRequest(c: Certificate, issuer: Certificate): Promise<Uint8Array> {
  const keyHash = await sha1(issuer.publicKey);
  const nameHash = await sha1(issuer.rawSubject);
  const certID = seq(seq(oid(OID.sha1), nullDer()), octet(nameHash), octet(keyHash), Uint8Array.of(TAG.INTEGER, ...lenOf(c.serial.length), ...c.serial));
  return seq(seq(seq(seq(certID))));
}

function lenOf(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) out.unshift(x & 0xff);
  return [0x80 | out.length, ...out];
}

export interface OCSPResp {
  status: "good" | "revoked" | "unknown";
  /** certID-ийн serial. */
  serial: bigint;
  thisUpdate: PreciseTime;
  nextUpdate?: Date;
  /** nextUpdate (наносекундын нарийвчлалтай) — шинэлэг байдлын (freshAt) шалгалтад. */
  nextUpdatePrecise?: PreciseTime;
  /** revoked үед. */
  revokedAt?: PreciseTime;
  certificate?: Certificate;
}

const OID_OCSP_BASIC = "1.3.6.1.5.5.7.48.1.1";

/** x/crypto/ocsp ParseResponseForCert (+ гарын үсгийн шалгалт). */
export async function parseOCSPForCert(der: Uint8Array, c: Certificate, issuer: Certificate): Promise<OCSPResp> {
  return parseOCSP(der, intValue(c.serial), issuer);
}

/**
 * x/crypto/ocsp ParseResponseForCert: serial өгвөл тэр serial-ийн хариу, эс бөгөөс яг нэг хариу (ParseResponse). issuer
 * өгвөл гарын үсгийг шалгана: шигтгэсэн cert байвал хариу түүгээр, cert нь issuer-ээр зурагдсан байх ёстой.
 */
export async function parseOCSP(der: Uint8Array, serial: bigint | undefined, issuer: Certificate | undefined): Promise<OCSPResp> {
  const top = children(expect(parseOne(der), TAG.SEQUENCE, "OCSPResponse"));
  if (expect(top[0], TAG.ENUMERATED, "status").value[0] !== 0) throw new Error("OCSP response status");
  const rb = children(expect(children(expect(top[1], 0xa0, "responseBytes"))[0], TAG.SEQUENCE, "ResponseBytes"));
  if (oidString(expect(rb[0], TAG.OID, "responseType").value) !== OID_OCSP_BASIC) throw new Error("bad OCSP response type");
  const basic = children(expect(parseOne(expect(rb[1], TAG.OCTET_STRING, "response").value), TAG.SEQUENCE, "BasicOCSPResponse"));
  const tbs = expect(basic[0], TAG.SEQUENCE, "tbsResponseData");
  const sigAlg = expect(basic[1], TAG.SEQUENCE, "sigAlg");
  const sigBits = expect(basic[2], TAG.BIT_STRING, "signature").value.subarray(1);
  const tf = children(tbs);
  let i = 0;
  if (tf[0]?.tag === 0xa0) i++;
  const rid = tf[i++]!;
  if (rid.tag !== 0xa1 && rid.tag !== 0xa2) throw new Error("invalid responder id tag");
  i++; // producedAt
  const responses = children(expect(tf[i], TAG.SEQUENCE, "responses"));
  let single: Node[] | undefined;
  if (serial !== undefined) {
    if (responses.length === 0) throw new Error("OCSP response contains bad number of responses");
    for (const r of responses) {
      const f = children(r);
      const cid = children(f[0]!);
      if (intValue(expect(cid[3], TAG.INTEGER, "serial").value) === serial) {
        single = f;
        break;
      }
    }
    if (!single) throw new Error("no response matching the supplied certificate");
  } else {
    if (responses.length !== 1) throw new Error("OCSP response contains bad number of responses");
    single = children(responses[0]!);
  }
  let certificate: Certificate | undefined;
  if (basic[3]?.tag === 0xa0) {
    const certs = children(expect(children(basic[3])[0], TAG.SEQUENCE, "certs"));
    if (certs[0]) certificate = parseCertificate(certs[0].raw);
  }
  if (certificate) {
    if (!(await verifySignature(certificate, sigAlg, tbs.raw, sigBits))) throw new Error("bad signature on embedded certificate");
    if (issuer && !(await checkSignature(issuer, certificate.sigAlg, certificate.tbs, certificate.signature))) throw new Error("bad OCSP signature");
  } else if (issuer && !(await verifySignature(issuer, sigAlg, tbs.raw, sigBits))) {
    throw new Error("bad OCSP signature");
  }
  const cid = children(single[0]!);
  const hashAlg = oidString(children(cid[0]!)[0]!.value);
  if (![OID.sha1, OID.sha256, OID.sha384, OID.sha512].includes(hashAlg as never)) throw new Error("unsupported issuer hash algorithm");
  const st = single[1]!;
  const status = st.tag === 0x80 ? "good" : st.tag === 0xa1 ? "revoked" : st.tag === 0x82 ? "unknown" : undefined;
  if (!status) throw new Error("OCSP certStatus");
  const revokedAt = status === "revoked" ? parsePreciseTime(expect(children(st)[0], TAG.GeneralizedTime, "revocationTime")) : undefined;
  const thisUpdate = parsePreciseTime(expect(single[2], TAG.GeneralizedTime, "thisUpdate"));
  let nextUpdatePrecise: PreciseTime | undefined;
  for (const x of single.slice(3)) {
    if (x.tag === 0xa0) nextUpdatePrecise = parsePreciseTime(children(x)[0]!);
    if (x.tag === 0xa1) {
      for (const ext of children(children(x)[0]!)) {
        const e = children(ext);
        if (e[1]?.tag === TAG.BOOLEAN && e[1].value[0] !== 0) throw new Error("unsupported critical extension");
      }
    }
  }
  return { status, serial: intValue(expect(cid[3], TAG.INTEGER, "serial").value), thisUpdate, nextUpdate: nextUpdatePrecise?.date, nextUpdatePrecise, revokedAt, certificate };
}

/** a, b нь ижил гэрчилгээ (байт-ижил) эсвэл ижил subject + түлхүүр (дахин олгосон ижил CA). */
export function sameCertKey(a: Certificate, b: Certificate): boolean {
  return equal(a.raw, b.raw) || (equal(a.rawSubject, b.rawSubject) && equal(a.spki, b.spki));
}

/**
 * parseOCSP + RFC 6960 §4.2.2.2: олгогч өөрөө зурж хариундаа ӨӨРИЙН гэрчилгээг шигтгэсэн хариуг x/crypto/ocsp
 * «bad OCSP signature» гэж татгалздаг — шигтгэсэн cert нь олгогч мөн (raw эсвэл subject+SPKI) бол хариуг олгогчийн
 * түлхүүрээр шалгана (Go SDK v0.6.0 NewOCSPChecker-ийн засвартай ижил).
 */
export async function parseOCSPFrom(der: Uint8Array, serial: bigint | undefined, issuer: Certificate): Promise<OCSPResp> {
  try {
    return await parseOCSP(der, serial, issuer);
  } catch (e) {
    let alt: OCSPResp;
    try {
      alt = await parseOCSP(der, serial, undefined);
    } catch {
      throw e;
    }
    if (alt.certificate && sameCertKey(alt.certificate, issuer) && (await ocspSignedBy(der, issuer))) return alt;
    throw e;
  }
}

/** BasicOCSPResponse-ийн гарын үсэг k-ийн түлхүүрээр. */
async function ocspSignedBy(der: Uint8Array, k: Certificate): Promise<boolean> {
  const top = children(parseOne(der));
  const rb = children(children(top[1]!)[0]!);
  const basic = children(parseOne(rb[1]!.value));
  return verifySignature(k, basic[1]!, basic[0]!.raw, basic[2]!.value.subarray(1));
}

function responderOK(resp: OCSPResp, issuer: Certificate): boolean {
  if (!resp.certificate || equal(resp.certificate.raw, issuer.raw)) return true;
  return resp.certificate.extKeyUsage.includes(OID.kpOCSPSigning);
}

class NotFresh extends Error {}

/** OCSP SingleResponse-ийн thisUpdate/nextUpdate-ийг freshAt-д (тэг nextUpdate — байхгүй). */
export function ocspFreshAt(resp: OCSPResp, at: GoTime, now: GoTime): boolean {
  return freshAt(fromPrecise(resp.thisUpdate), resp.nextUpdatePrecise ? fromPrecise(resp.nextUpdatePrecise) : ZERO_TIME, at, now);
}

/**
 * Go fetchOCSP: SHA-1 CertID (RFC 5019) = энэ гэрчилгээ + олгогч, олгогч (эсвэл delegated) зурсан, good, одоо шинэлэг
 * (freshAt), fresh өгвөл thisUpdate > fresh. revoked → CertificateRevokedError. Алдааны мессежид гэрчилгээний нэр (PII) үгүй.
 */
async function fetchOCSP(f: Fetcher, url: string, c: Certificate, issuer: Certificate, now: Date, fresh: PreciseTime | undefined, signal?: AbortSignal): Promise<[Uint8Array, OCSPResp]> {
  const der = await f.do("POST", url, "application/ocsp-request", await ocspRequest(c, issuer), signal);
  const resp = await parseOCSPForCert(der, c, issuer);
  if (!responderOK(resp, issuer)) throw new Error("OCSP responder-ийн EKU OCSPSigning биш");
  if (!(await ocspCertIDMatches(der, c, issuer))) throw new Error("OCSP CertID энэ гэрчилгээ/олгогчийнх биш");
  if (resp.status === "revoked") throw new CertificateRevokedError();
  const n = fromDate(now);
  if (resp.status !== "good" || !ocspFreshAt(resp, n, n)) throw new Error(`OCSP status ${resp.status}`);
  if (fresh && !after(resp.thisUpdate, fresh)) throw new NotFresh("OCSP thisUpdate нь timestamp-аас хожуу биш");
  return [der, resp];
}

/**
 * Go crlCovers: der нь c-ийн олгогчийн (нэр/AKI, гарын үсэг шалгасан) CRL, nextUpdate-тэй, одоо шинэлэг (freshAt), c-г
 * агуулаагүй. c жагсаалтад байвал CertificateRevokedError.
 */
async function crlCovers(der: Uint8Array, c: Certificate, issuer: Certificate, now: Date): Promise<boolean> {
  const crl = parseCRL(der);
  if (!crl || !(await crlFor(crl, c, issuer))) return false;
  if (crlListed(crl, c)) throw new CertificateRevokedError();
  const n = fromDate(now);
  return !isZero(crl.nextUpdate) && freshAt(crl.thisUpdate, crl.nextUpdate, n, n);
}

export interface DSSMaterial {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

/**
 * Хүчинтэй CRL-тэй CA гэрчилгээний (гинжийн эхнийхээс бусад) OCSP-г цуглуулалт эхэлснээс хойш хамгийн ихдээ ийм хугацаа
 * хүлээгээд цуцална (LT-г CRL хангана). Гинжийн эхний (навч: иргэн, TSA) гэрчилгээний OCSP ба хүчинтэй CRL-гүй гэрчилгээний
 * OCSP нь Fetcher-ийн энгийн timeout-ыг бүтнээр авна — шинэхэн цуцлагдсан навч дахин гаргаагүй CRL-ээр гарахгүй,
 * «timestamp-аас хожуу» дүрэм бүтэн цонхтой, fail-closed хэвээр. TCP хүлээж аваад хариулдаггүй responder (үндэсний CA-ийн
 * гэрчилгээнүүдийн AIA OCSP) гэрчилгээ бүрт 10 с идэхгүй.
 */
export const OCSP_GRACE_MS = 3000;

/** OCSP-ийн цонхны цаг — тестэд хуурамч цаг. `after` нь цуцлах функц буцаана. */
export interface GraceClock {
  now(): number;
  after(ms: number, fn: () => void): () => void;
}

const REAL_CLOCK: GraceClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

/** Нэг гэрчилгээний OCSP-ийн үр дүн. revoked — гинжийн дарааллаар шидэгдэнэ. */
interface OCSPOutcome {
  der?: Uint8Array;
  resp?: OCSPResp;
  freshErr?: NotFresh;
  revoked?: CertificateRevokedError;
}

/**
 * Нэг гэрчилгээний AIA OCSP-ууд дарааллаар (эхний хүчинтэй хариу) — шалгалт fetchOCSP-д өөрчлөлтгүй. Хэзээ ч reject
 * хийхгүй (unhandled rejection үгүй): revoked нь outcome-д. `signal` (цонх) цуцлагдсан бол үлдсэн URL-ийг асуухгүй.
 */
async function ocspOutcome(f: Fetcher, c: Certificate, issuer: Certificate, now: Date, fresh: PreciseTime | undefined, signal: AbortSignal): Promise<OCSPOutcome> {
  let freshErr: NotFresh | undefined;
  for (const u of c.ocspServers) {
    try {
      const [der, resp] = await fetchOCSP(f, u, c, issuer, now, fresh, signal);
      return { der, resp };
    } catch (e) {
      if (e instanceof CertificateRevokedError) return { revoked: e };
      if (e instanceof NotFresh) freshErr = e;
      if (signal.aborted) break;
    }
  }
  return { freshErr };
}

interface LTVJob {
  c: Certificate;
  issuer: Certificate | undefined;
  /** Олгогч хайхад гарсан алдаа — гинжийн дарааллаар (энэ гэрчилгээний ээлжинд) шидэгдэнэ. */
  issuerErr?: { e: unknown };
  /** Гинжийн эхний (навч) гэрчилгээ: OCSP thisUpdate нь timestamp-аас хожуу байх ёстой; OCSP-д цонх үгүй. */
  leaf: boolean;
  fresh: PreciseTime | undefined;
  ctl?: AbortController;
  ocsp?: Promise<OCSPOutcome>;
  settled: boolean;
}

/**
 * Go collectLTV: chains (leaf → … root-оос өмнөх) бүрийн гэрчилгээнд OCSP (AIA) ба CRL (CDP). Бүх гэрчилгээний OCSP-г
 * зэрэг эхлүүлж, CRL-ийг гинжийн дарааллаар татна; үр дүнг гинжийн дарааллаар DSS-д нэмнэ — DSS-ийн агуулга/дараалал ба
 * алдааны давуу эрэмбэ дараалсан хувилбартай ижил. Хүчинтэй CRL-тэй CA гэрчилгээний OCSP — {@link OCSP_GRACE_MS} хүртэл
 * (навчных — бүрэн timeout).
 */
export async function collectLTV(
  f: Fetcher,
  now: Date,
  fresh: PreciseTime,
  roots: Certificate[],
  chains: Certificate[][],
  clock: GraceClock = REAL_CLOCK,
): Promise<DSSMaterial> {
  const d: DSSMaterial = { certs: [], ocsps: [], crls: [] };
  const addTo = (list: Uint8Array[], der: Uint8Array): void => {
    if (!list.some((b) => equal(b, der))) list.push(der);
  };
  const pool = chains.flat();
  const issuerOf = async (c: Certificate): Promise<Certificate | undefined> => {
    for (const cand of [...pool, ...roots]) if (equal(cand.rawSubject, c.rawIssuer) && (await checkSignatureFrom(c, cand))) return cand;
    return undefined;
  };
  const isRoot = (c: Certificate): boolean => roots.some((r) => equal(r.raw, c.raw));
  const seen = new Set<string>();
  const jobs: LTVJob[] = [];
  for (const ch of chains) {
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i]!;
      const k = toHex(c.raw);
      if (seen.has(k) || isRoot(c)) continue;
      seen.add(k);
      const j: LTVJob = { c, issuer: undefined, leaf: i === 0, fresh: i === 0 ? fresh : undefined, settled: false };
      try {
        j.issuer = await issuerOf(c);
      } catch (e) {
        j.issuerErr = { e };
      }
      jobs.push(j);
    }
  }
  const started = clock.now();
  for (const j of jobs) {
    if (!j.issuer) continue;
    const ctl = new AbortController();
    j.ctl = ctl;
    j.ocsp = ocspOutcome(f, j.c, j.issuer, now, j.fresh, ctl.signal);
    void j.ocsp.then(() => (j.settled = true));
  }
  const cancels: (() => void)[] = [];
  try {
    for (const j of jobs) {
      const c = j.c;
      addTo(d.certs, c.raw);
      if (j.issuerErr) throw j.issuerErr.e;
      const { issuer, ocsp, ctl } = j;
      if (!issuer || !ocsp || !ctl) throw new LTVError(`гинжийн гэрчилгээний олгогч олдсонгүй`);
      let ok = false;
      // CRL-ийн revoked — тэр дор нь (OCSP-ийн revoked-тэй ижил алдаа). Бусад алдааг OCSP-ийн revoked давна (өмнөх эрэмбэ).
      let crlErr: { e: unknown } | undefined;
      try {
        for (const u of c.crlDPs) {
          let der: Uint8Array;
          try {
            der = await f.do("GET", u, "");
          } catch {
            continue;
          }
          if (await crlCovers(der, c, issuer, now)) {
            addTo(d.crls, der);
            ok = true;
          }
        }
      } catch (e) {
        if (e instanceof CertificateRevokedError) throw e;
        crlErr = { e };
      }
      if (ok && !crlErr && !j.leaf && !j.settled) {
        // CA гэрчилгээ, хүчинтэй CRL бий — OCSP-г цонхны үлдсэн хугацаанд л хүлээнэ (цонх дууссан бол одоо цуцална).
        const left = OCSP_GRACE_MS - (clock.now() - started);
        if (left > 0) cancels.push(clock.after(left, () => ctl.abort()));
        else ctl.abort();
      }
      const o = await ocsp;
      if (o.revoked) throw o.revoked;
      if (crlErr) throw crlErr.e;
      if (o.der && o.resp) {
        addTo(d.ocsps, o.der);
        if (o.resp.certificate && !equal(o.resp.certificate.raw, issuer.raw)) addTo(d.certs, o.resp.certificate.raw);
        ok = true;
      }
      const freshErr = o.freshErr;
      if (!ok) {
        if (freshErr) throw freshErr;
        throw new LTVError(`гинжийн гэрчилгээнд хүчинтэй OCSP/CRL алга`);
      }
      if (j.fresh && freshErr && c.ocspServers.length > 0 && !(await hasFreshOCSP(d.ocsps, c, issuer, fresh))) throw freshErr;
    }
  } finally {
    // Алдаагаар гарвал үлдсэн OCSP-г цуцална (ocspOutcome хэзээ ч reject хийхгүй).
    for (const x of cancels) x();
    for (const j of jobs) j.ctl?.abort();
  }
  return d;
}

async function hasFreshOCSP(list: Uint8Array[], c: Certificate, issuer: Certificate, fresh: PreciseTime): Promise<boolean> {
  for (const der of list) {
    try {
      if (after((await parseOCSPForCert(der, c, issuer)).thisUpdate, fresh) && (await ocspCertIDMatches(der, c, issuer))) return true;
    } catch {
      /* өөр гэрчилгээний хариу */
    }
  }
  return false;
}

export class LTVError extends Error {}

const OCSP_AFTER_TS_MS = 2000;
const OCSP_WAIT_MAX_MS = 5000;
const OCSP_RETRY_MS = 1000;

/** Go collectLTVWithWait: genTime-ийн секундын эхнээс 2 с хүлээж, freshness-ийн алдаанд 1 с тутам (нийт ≤ 5 с). */
export async function collectLTVWithWait(
  f: Fetcher,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
  genTime: PreciseTime,
  roots: Certificate[],
  chains: Certificate[][],
): Promise<DSSMaterial> {
  let waited = 0;
  const genSec = Math.floor(genTime.date.getTime() / 1000) * 1000;
  let d = Math.min(genSec + OCSP_AFTER_TS_MS - now().getTime(), OCSP_WAIT_MAX_MS);
  for (;;) {
    if (d > 0) {
      await sleep(d);
      waited += d;
    }
    try {
      return await collectLTV(f, now(), genTime, roots, chains);
    } catch (e) {
      if (!(e instanceof NotFresh) || waited + OCSP_RETRY_MS > OCSP_WAIT_MAX_MS) throw e;
    }
    d = OCSP_RETRY_MS;
  }
}
