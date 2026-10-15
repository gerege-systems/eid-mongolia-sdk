// @gerege-systems/eid-mongolia-sdk/pades — клиент талын PAdES (PDF eID-ийн сервер рүү ОЧИХГҮЙ).
//
// НАТИВ TypeScript (WASM-гүй) — Node ≥ 18 ба хөтөч (Web Crypto). Go reference
// (github.com/gerege-systems/eid-mongolia-sdk-go/pades, профайл `pades-client/1`)-тэй байт-ижил гаралт — conformance
// golden (test/fixtures/pades/golden, scripts/sync-pades-golden.mjs). Урсгал:
//
//   prepare(pdf, {signerCert, …})  → {dtbs, digest, docId, state}     (хөтөч эсвэл Node; сүлжээгүй)
//   eid.signPdfDigest({dtbs, …})   → иргэн утсаараа DTBS-д зурна       (RP backend, үндсэн entry)
//   complete(state, signature)      → {pdf, cms, outSha256, …}         (TSA + OCSP/CRL сүлжээ дотроо)
//   eid.registerSignature({cms, …}) → /verify/{docID} бүртгэл          (RP backend)
//
// Бүрэн шалгагч (validator) энд БАЙХГҮЙ — тэр нь Go backend SDK-д. Prepare нь PRECHECKS.md-ийн «хөнгөн» шалгуурыг л хийнэ.

import { EidError } from "./errors.js";
import { EID_ISSUERS, INTERMEDIATES, NATIONAL_ROOT } from "./pades/assets/chain.js";
import { fromB64, toHex } from "./pades/bytes.js";
import { assembleCMS, signedAttributes, CLAIMED_ROLE_MAX_RUNES } from "./pades/cms.js";
import { randomBytes, sha256 } from "./pades/crypto.js";
import { DEFAULT_TSA_URL, Fetcher, isBrowser, type FetchFn } from "./pades/fetch.js";
import { LTVError, collectLTVWithWait, timestampToken } from "./pades/ltv.js";
import { MAX_INPUT_BYTES } from "./pades/limits.js";
import { AppearanceError, pageCount, round100, type Visible } from "./pades/page/appearance.js";
import { appendVerifyPage } from "./pades/page/page.js";
import { appendDSS } from "./pades/pdf/dss.js";
import { embedCMS, PlaceholderOverflowError, prepareSignature, signatureContents } from "./pades/pdf/signature.js";
import { PrecheckError, UUID_RE, VERIFY_URL_PREFIX, docIdFromPage, precheck, signatureCMSList } from "./pades/precheck.js";
import { decodeState, encodeState } from "./pades/state.js";
import { OID, checkSignatureFrom, parseCertificate, verifyCitizen, type Certificate } from "./pades/x509.js";

/** PDF/CMS профайлын хувилбар (Go reference `ProfileVersion`). */
export const PROFILE_VERSION = "pades-client/1";

/** Тогтвортой алдааны кодууд (бүх платформд ижил). */
export type PadesErrorCode =
  | "PDF_INVALID"
  | "PDF_ENCRYPTED"
  | "PDF_LOCKED"
  | "PDF_TOO_LARGE"
  | "PDF_TOO_MANY_SIGNATURES"
  | "PDF_PRIOR_SIGNATURE_INVALID"
  /** Өмнөх гарын үсэг eID-ийн (CAdES + timestamp + DSS, eID олгогч) биш. */
  | "PDF_FOREIGN_SIGNATURE"
  /** signerCert задрахгүй / түлхүүрийн төрөл / гинж. */
  | "SIGNER_INVALID"
  /** Options буруу (docId UUID биш, lang, fileName, claimedRole г.м.). */
  | "REQUEST_INVALID"
  | "SIGNATURE_INVALID"
  | "TSA_UNAVAILABLE"
  | "LTV_UNAVAILABLE"
  | "SELF_VALIDATION_FAILED"
  | "PLACEHOLDER_OVERFLOW"
  | "STATE_INVALID"
  | "INTERNAL";

export const PADES_ERROR_CODES: readonly PadesErrorCode[] = [
  "PDF_INVALID",
  "PDF_ENCRYPTED",
  "PDF_LOCKED",
  "PDF_TOO_LARGE",
  "PDF_TOO_MANY_SIGNATURES",
  "PDF_PRIOR_SIGNATURE_INVALID",
  "PDF_FOREIGN_SIGNATURE",
  "SIGNER_INVALID",
  "REQUEST_INVALID",
  "SIGNATURE_INVALID",
  "TSA_UNAVAILABLE",
  "LTV_UNAVAILABLE",
  "SELF_VALIDATION_FAILED",
  "PLACEHOLDER_OVERFLOW",
  "STATE_INVALID",
  "INTERNAL",
];

/**
 * PAdES-ийн алдаа. `code`-оор салаална: SIGNATURE_INVALID — state хэвээр, дахин зуруулж болно; TSA_UNAVAILABLE /
 * LTV_UNAVAILABLE — түр, ижил state + гарын үсгээр `complete`-ийг дахин дуудна ({@link PadesError.retryable}).
 */
export class PadesError extends EidError {
  constructor(
    readonly code: PadesErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  get retryable(): boolean {
    return this.code === "TSA_UNAVAILABLE" || this.code === "LTV_UNAVAILABLE";
  }
}

export interface PadesPrepareOptions {
  /** Иргэний SIGN гэрчилгээ (DER) — `signingCertificateV2`-д. Session-ий зурагч төхөөрөмжийнх байх ёстой. */
  signerCert: Uint8Array;
  /** Олгогчийн гинж (DER: 04, 03, 02). Анхдагч — шигтгэсэн eID гинжээс signerCert-ийн олгогчоор. */
  chain?: Uint8Array[];
  /** `/Name`. Хоосон бол гэрчилгээний GIVENNAME SURNAME (эсвэл CN). */
  signerName?: string;
  /** `/Reason` (≤ 127 UTF-16 нэгж, эс бөгөөс бичигдэхгүй). */
  reason?: string;
  /** Байгууллагын нэрийн өмнөөс: `organization.getRepresentations()`-ийн `claimedRole` ЯГ ХЭВЭЭР (signedAttrs-д орно). */
  claimedRole?: string;
  /** `/M` (+08:00-оор бичигдэнэ, секундээр). Анхдагч — одоо. */
  signingTime?: Date;
  /** Баримтын UUID (verify хуудас / QR). Хоосон бол шинээр (гарын үсэгтэй баримтад хуудаснаас уншина). */
  docId?: string;
  /** Баталгаажуулах (QR) хуудас нэмэх — зөвхөн гарын үсэггүй баримтын эхний гарын үсэгт. */
  verifyPage?: boolean;
  /** Хуудасны хэл: `mn` (анхдагч) | `en`. */
  lang?: "mn" | "en";
  /** Баримтын нэр — `verifyPage` үед заавал (≤ 120 тэмдэгт). */
  fileName?: string;
  /** Харагдах гарын үсэг (APPEARANCE_SPEC.md); байхгүй бол үл харагдах (анхдагч, өмнөхтэй байт-ижил). */
  appearance?: PadesAppearance;
}

/**
 * Харагдах гарын үсгийн байршил (Go `pades.Appearance`, APPEARANCE_SPEC.md §1). Координат нь pt, тухайн хуудасны CropBox
 * (байхгүй бол MediaBox)-ийн /Rotate-ийн ДАРААХ (дэлгэцэнд харагдах) зүүн доод булангаас; x баруун тийш, y дээш. Утга бүр
 * 0.01 pt хүртэл тойрогдоно. Өндөр ≥ 45 pt (QR), эс бөгөөс REQUEST_INVALID.
 */
export interface PadesAppearance {
  /** Оролтын баримтын хуудас, 1-ээс; 0/байхгүй = оролтын сүүлийн хуудас (энэ prepare-ийн нэмэх verify хуудас тооцогдохгүй). */
  page?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `mn` | `en`; байхгүй бол `lang` (тэр нь байхгүй бол mn). */
  lang?: "mn" | "en";
}

export interface PadesPrepared {
  /** SHA-256(DER(signedAttrs)) — 32 байт; `eid.signPdfDigest({dtbs})` / токены `C_Sign`-ийн оролт. */
  dtbs: Uint8Array;
  /** `messageDigest` = SHA-256(ByteRange). */
  digest: Uint8Array;
  docId: string;
  /** Тунгалаг, сериалчилж хадгалж болно (бэлтгэсэн PDF дотор нь — PDF-тэй ижил нууцлалтай). Go SDK-тай нийцтэй. */
  state: Uint8Array;
}

export interface PadesCompleteOptions {
  /** RFC 3161 TSA. Анхдагч `https://tsa.timeserver.mn/`. */
  tsaUrl?: string;
  /** Итгэлийн тулгуур DER (TSA гинж). Анхдагч — Mongolian National Root CA. Тестэд л. */
  roots?: Uint8Array[];
  /** HTTP (TSA/OCSP/CRL). Анхдагч `globalThis.fetch` (timeout 10 с, redirect дагахгүй). */
  fetch?: FetchFn;
  /**
   * http:// AIA/CDP-г eID allowlist (ocsp/crl.eidmongolia.mn, tsa.timeserver.mn)-д https болгох, бусдыг татахгүй.
   * Анхдагч — хөтчид true, Node-д false.
   */
  httpsUpgrade?: boolean;
  /** Цаг (тест). */
  now?: () => Date;
  /** Хүлээлт (тест). */
  sleep?: (ms: number) => Promise<void>;
  /** TSA nonce-ийн 8 байт (тест; WIRE.md §4). Анхдагч — криптограф санамсаргүй. */
  nonce?: () => Uint8Array | Promise<Uint8Array>;
}

export interface PadesCompleted {
  /** Гарын үсэгтэй PDF (PAdES-BASELINE-LT). */
  pdf: Uint8Array;
  /** CMS SignedData (DER) — `eid.registerSignature({cms})`. */
  cms: Uint8Array;
  docId: string;
  /** Гаралтын SHA-256 (hex). */
  outSha256: string;
  /** Оролтын SHA-256 (hex). */
  inSha256: string;
  /** Баталгаажуулах хуудас энэ гарын үсэгт нэмэгдсэн эсэх. */
  hasPage: boolean;
  /** Хуудастай revision-ий SHA-256 (hex); `hasPage` false бол "". */
  pageSha256: string;
  /** Энэ гарын үсгийн дугаар (1 = эхний). */
  revIndex: number;
  /** Гарын үсгийн revision-ий (DSS-ээс өмнөх) SHA-256 (hex). */
  sigRevSha256: string;
  /** Өмнөх гарын үсгүүдийн CMS-ийн SHA-256 (hex), баримтын дарааллаар. */
  priorCmsSha256: string[];
  /**
   * Өмнөх гарын үсгүүдийн revision-ий SHA-256 (hex) — `sha256(doc[0 : ByteRange[2]+ByteRange[3]])`, `priorCmsSha256`-тай
   * ижил дарааллаар. CA горим A-ийн (CA угсарсан) мөрийг үүгээр таньдаг (`priorRevisionSha256`).
   */
  priorRevisionSha256: string[];
  /** Зурагчийн гэрчилгээ (DER). */
  signerCert: Uint8Array;
}

const MAX_OUTPUT_BYTES = 10 << 20;
const MAX_FILE_NAME = 120;
const PAGE_BRAND = "eID Mongolia";
const PAGE_PROVIDER = "ca.eidmongolia.mn";
const PAGE_TRUST_URL = "https://eidmongolia.mn/trust";
const PAGE_TSA_NAME = "eID Mongolia TSA (tsa.timeserver.mn)";

/** PDF/CMS профайлын хувилбар. */
export function profileVersion(): string {
  return PROFILE_VERSION;
}

function u8(v: Uint8Array | ArrayBuffer, name: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new PadesError("REQUEST_INVALID", `${name} Uint8Array байх ёстой`);
}

const der = (b64s: string[]): Certificate[] => b64s.map((s) => parseCertificate(fromB64(s)));

function parseDERs(list: Uint8Array[], code: PadesErrorCode, what: string): Certificate[] {
  return list.map((d, i) => {
    try {
      return parseCertificate(u8(d, `${what}[${i}]`));
    } catch (e) {
      throw new PadesError(code, `${what} #${i}`, { cause: e });
    }
  });
}

/** Go signerChain: өгсөн гинж эсвэл шигтгэсэн 02–05-аас signer-ийн олгогчоор root хүртэл (root-гүй). */
async function signerChain(signer: Certificate, chain: Uint8Array[] | undefined): Promise<Certificate[]> {
  if (chain && chain.length > 0) return parseDERs(chain, "SIGNER_INVALID", "chain");
  const pool = der(INTERMEDIATES);
  const out: Certificate[] = [];
  let cur = signer;
  for (let k = 0; k < pool.length + 1; k++) {
    let next: Certificate | undefined;
    for (const c of pool) {
      if (eq(c.rawSubject, cur.rawIssuer) && (await checkSignatureFrom(cur, c))) {
        next = c;
        break;
      }
    }
    if (!next) break;
    out.push(next);
    cur = next;
  }
  if (out.length === 0) throw new PadesError("SIGNER_INVALID", "signer-ийн олгогч шигтгэсэн eID гинжид алга — chain өгнө үү");
  return out;
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Go cleanFileName: Cc/Cf/Zl/Zp (ба U+FFFD) хасаж NFC, trim; 1–120 code point. */
function cleanFileName(s: string): string | undefined {
  const out = goTrim(s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}�]/gu, "").normalize("NFC"));
  if (out === "" || Array.from(out).length > MAX_FILE_NAME) return undefined;
  return out;
}

function goTrim(s: string): string {
  const sp = (c: number): boolean =>
    (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  let lo = 0;
  let hi = s.length;
  while (lo < hi && sp(s.charCodeAt(lo))) lo++;
  while (hi > lo && sp(s.charCodeAt(hi - 1))) hi--;
  return s.slice(lo, hi);
}

async function randUUID(): Promise<string> {
  const b = await randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Go SignerDisplayName: GIVENNAME SURNAME, хоёулаа алга бол CN. */
function signerDisplayName(c: Certificate): string {
  const n = goTrim(`${c.givenName} ${c.surname}`);
  return n !== "" ? n : c.subjectCN;
}

/**
 * PDF-ийг гарын үсэгт бэлдэнэ (PRECHECKS → [verify хуудас] → гарын үсгийн revision → signedAttrs). Сүлжээгүй.
 * `dtbs`-ийг иргэнээр зуруулна (`eid.signPdfDigest`), `state`-ийг `complete` хүртэл хадгална.
 *
 * @throws {PadesError} PDF_INVALID / PDF_ENCRYPTED / PDF_LOCKED / PDF_TOO_LARGE / PDF_TOO_MANY_SIGNATURES /
 *   PDF_PRIOR_SIGNATURE_INVALID / PDF_FOREIGN_SIGNATURE / SIGNER_INVALID / REQUEST_INVALID
 */
export async function prepare(pdf: Uint8Array | ArrayBuffer, opts: PadesPrepareOptions): Promise<PadesPrepared> {
  const doc = u8(pdf, "pdf");
  if (doc.length > MAX_INPUT_BYTES) throw new PadesError("PDF_TOO_LARGE", "PDF 9.75 MB-аас их байна");
  if (doc.length < 5 || String.fromCharCode(...doc.subarray(0, 5)) !== "%PDF-") throw new PadesError("PDF_INVALID", "PDF биш эсвэл эвдэрсэн");
  let cert: Certificate;
  try {
    cert = parseCertificate(u8(opts.signerCert, "signerCert"));
  } catch (e) {
    throw new PadesError("SIGNER_INVALID", "signerCert задарсангүй", { cause: e });
  }
  if (cert.keyAlg !== OID.rsaEncryption && cert.keyAlg !== OID.ecPublicKey) {
    throw new PadesError("SIGNER_INVALID", "гэрчилгээний түлхүүрийн төрөл дэмжигдэхгүй");
  }
  const chain = await signerChain(cert, opts.chain);
  const docIdOpt = opts.docId ?? "";
  if (docIdOpt !== "" && !UUID_RE.test(docIdOpt)) throw new PadesError("REQUEST_INVALID", "docId нь жижиг үсгийн UUID байх ёстой");
  if (opts.lang !== undefined && (opts.lang as string) !== "" && opts.lang !== "mn" && opts.lang !== "en") {
    throw new PadesError("REQUEST_INVALID", "lang: mn | en");
  }
  checkAppearance(opts);
  const now = opts.signingTime ?? new Date();
  if (Number.isNaN(now.getTime())) throw new PadesError("REQUEST_INVALID", "signingTime буруу Date");
  // Go: секундээс доош хэсэг /M-д орохгүй (формат секундээр).

  const inHex = toHex(await sha256(doc));
  let pc: { newDoc: boolean; revIndex: number };
  try {
    pc = await precheck(doc, [...der(EID_ISSUERS), chain[0]!]);
  } catch (e) {
    if (e instanceof PrecheckError) throw new PadesError(e.code, e.message, { cause: e });
    throw new PadesError("PDF_INVALID", "PDF биш эсвэл эвдэрсэн", { cause: e });
  }
  let docId = docIdOpt;
  let base = doc;
  let pageHex = "";
  const hasPage = pc.newDoc && opts.verifyPage === true;
  if (!pc.newDoc) {
    const fromPage = docIdFromPage(doc);
    if (fromPage !== "") {
      if (docId !== "" && docId !== fromPage) throw new PadesError("REQUEST_INVALID", "docId нь баримтын хуудсан дээрхтэй таарахгүй");
      docId = fromPage;
    }
  }
  if (pc.newDoc && docId === "") docId = await randUUID();
  if (hasPage) {
    const fileName = cleanFileName(opts.fileName ?? "");
    if (fileName === undefined) throw new PadesError("REQUEST_INVALID", "fileName заавал, ≤ 120 тэмдэгт");
    try {
      base = appendVerifyPage(doc, {
        brand: PAGE_BRAND,
        fileName,
        documentHash: inHex,
        fileSize: doc.length,
        docId,
        verifyUrl: VERIFY_URL_PREFIX + docId,
        trustUrl: PAGE_TRUST_URL,
        caName: cert.issuerCN,
        tsaName: PAGE_TSA_NAME,
        provider: PAGE_PROVIDER,
        lang: opts.lang ?? "",
      });
    } catch (e) {
      throw new PadesError("PDF_INVALID", "PDF задарсангүй (хуудас нэмж чадсангүй)", { cause: e });
    }
    pageHex = toHex(await sha256(base));
  }
  const name = goTrim(opts.signerName ?? "") === "" ? signerDisplayName(cert) : (opts.signerName ?? "");
  const vis = opts.appearance ? visibleSpec(doc, opts, name, now, docId, pc.revIndex) : undefined;
  let prep: Awaited<ReturnType<typeof prepareSignature>>;
  try {
    prep = await prepareSignature(base, now, name, opts.reason ?? "", vis);
  } catch (e) {
    if (e instanceof AppearanceError) throw new PadesError("REQUEST_INVALID", `appearance: ${e.message}`, { cause: e });
    throw new PadesError("PDF_INVALID", "PDF-д гарын үсгийн revision бичиж чадсангүй", { cause: e });
  }
  if (prep.pdf.length + (256 << 10) > MAX_OUTPUT_BYTES) throw new PadesError("PDF_TOO_LARGE", "гарын үсэгтэй гаралт 10 MB-аас хэтэрнэ");
  const role = opts.claimedRole ?? "";
  if (role !== "" && Array.from(role).length > CLAIMED_ROLE_MAX_RUNES) throw new PadesError("REQUEST_INVALID", "claimedRole хэт урт");
  let attrs: Uint8Array;
  try {
    attrs = await signedAttributes(prep.digest, cert, role);
  } catch (e) {
    throw new PadesError("REQUEST_INVALID", "claimedRole", { cause: e });
  }
  const state = encodeState({
    docId,
    signerCert: cert.raw,
    chain: chain.map((c) => c.raw),
    signedAttrs: attrs,
    byteRange: prep.byteRange,
    revIndex: pc.revIndex,
    inSha256: inHex,
    hasPage,
    pageSha256: pageHex,
    claimedRole: role,
    preparedSha256: toHex(await sha256(prep.pdf)),
    pdf: prep.pdf,
  });
  return { dtbs: await sha256(attrs), digest: prep.digest, docId, state };
}

/** Appearance-ийн PDF-ээс үл хамаарах шалгалт (Go checkAppearance, APPEARANCE_SPEC.md §1). */
function checkAppearance(o: PadesPrepareOptions): void {
  const a = o.appearance;
  if (a === undefined) return;
  const bad = (msg: string): PadesError => new PadesError("REQUEST_INVALID", `appearance: ${msg}`);
  for (const v of [a.x, a.y, a.width, a.height]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 14400) throw bad("x, y, width, height нь 0…14400 pt");
  }
  const page = a.page ?? 0;
  if (!Number.isInteger(page) || page < 0) throw bad("page ≥ 0");
  if (a.lang !== undefined && (a.lang as string) !== "" && a.lang !== "mn" && a.lang !== "en") throw bad("lang: mn | en");
  const role = o.claimedRole ?? "";
  if (role !== "" && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(role)) throw bad("claimedRole-д удирдах тэмдэгт");
}

/** Go visibleSpec: хуудас (0 → оролтын сүүлийн), h100, хэл, огноо (+08), verify URL. */
function visibleSpec(doc: Uint8Array, o: PadesPrepareOptions, name: string, now: Date, docId: string, revIndex: number): Visible {
  const a = o.appearance!;
  if (docId === "") throw new PadesError("REQUEST_INVALID", "appearance: docId заавал (баримтад verify хуудас алга)");
  let n: number;
  try {
    n = pageCount(doc);
  } catch (e) {
    throw new PadesError("PDF_INVALID", "PDF задарсангүй", { cause: e });
  }
  const page = a.page || n;
  if (page > n) throw new PadesError("REQUEST_INVALID", `appearance: page ${page} > хуудасны тоо ${n}`);
  const z = new Date(now.getTime() + 8 * 3600_000);
  const p2 = (v: number): string => String(v).padStart(2, "0");
  return {
    page,
    x: round100(a.x),
    y: round100(a.y),
    w: round100(a.width),
    h: round100(a.height),
    name: goTrim(name),
    role: o.claimedRole ?? "",
    lang: a.lang || o.lang || "mn",
    date: `${String(z.getUTCFullYear()).padStart(4, "0")}-${p2(z.getUTCMonth() + 1)}-${p2(z.getUTCDate())} ${p2(z.getUTCHours())}:${p2(z.getUTCMinutes())} (+08)`,
    url: `${VERIFY_URL_PREFIX}${docId}/${revIndex}`,
  };
}

/**
 * Иргэний гарын үсгийг (session `signature.value` — base64 мөр эсвэл байт; RSA PKCS#1 v1.5, ECDSA r‖s эсвэл DER) DTBS-д
 * шалгаад TSA → CMS → embed → OCSP/CRL (genTime-ийн дараа) → DSS revision. Сүлжээ: tsa.timeserver.mn, AIA/CDP.
 *
 * @throws {PadesError} SIGNATURE_INVALID / TSA_UNAVAILABLE / LTV_UNAVAILABLE / PLACEHOLDER_OVERFLOW / STATE_INVALID /
 *   PDF_TOO_LARGE / SELF_VALIDATION_FAILED
 */
export async function complete(state: Uint8Array | ArrayBuffer, signature: Uint8Array | string, opts: PadesCompleteOptions = {}): Promise<PadesCompleted> {
  let st: Awaited<ReturnType<typeof decodeState>>;
  let cert: Certificate;
  let chain: Certificate[];
  try {
    st = await decodeState(u8(state, "state"));
    cert = parseCertificate(st.signerCert);
    chain = st.chain.map((c) => parseCertificate(c));
  } catch (e) {
    throw new PadesError("STATE_INVALID", "state задарсангүй", { cause: e });
  }
  const roots = opts.roots && opts.roots.length > 0 ? parseDERs(opts.roots, "REQUEST_INVALID", "roots") : der(NATIONAL_ROOT);
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchFn = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as unknown as FetchFn | undefined);
  if (!fetchFn) throw new PadesError("TSA_UNAVAILABLE", "fetch алга (Node ≥ 18 эсвэл opts.fetch)");
  let sigBytes: Uint8Array;
  try {
    sigBytes = typeof signature === "string" ? fromB64(signature) : u8(signature, "signature");
  } catch (e) {
    throw new PadesError("SIGNATURE_INVALID", "гарын үсэг base64 биш", { cause: e });
  }
  const sig = await verifyCitizen(cert, st.signedAttrs, sigBytes);
  if (!sig) throw new PadesError("SIGNATURE_INVALID", "гарын үсэг DTBS-тэй таарсангүй");
  const f = new Fetcher(fetchFn, opts.httpsUpgrade ?? isBrowser());
  let ts: Awaited<ReturnType<typeof timestampToken>>;
  try {
    const nonce = opts.nonce ? await opts.nonce() : await randomBytes(8);
    if (nonce.length !== 8) throw new Error("nonce 8 байт биш");
    ts = await timestampToken(f, opts.tsaUrl || DEFAULT_TSA_URL, sig, roots, chain, now(), nonce);
  } catch (e) {
    throw new PadesError("TSA_UNAVAILABLE", "TSA timestamp авч чадсангүй", { cause: e });
  }
  let cms: Uint8Array;
  try {
    cms = assembleCMS(st.signedAttrs, cert, chain, sig, ts.rawToken);
  } catch (e) {
    throw new PadesError("SELF_VALIDATION_FAILED", "CMS угсарч чадсангүй", { cause: e });
  }
  let signed: Uint8Array;
  try {
    signed = embedCMS(st.pdf, st.byteRange, cms);
  } catch (e) {
    if (e instanceof PlaceholderOverflowError) throw new PadesError("PLACEHOLDER_OVERFLOW", "CMS placeholder-т багтсангүй", { cause: e });
    throw new PadesError("STATE_INVALID", "CMS-ийг placeholder-т бичиж чадсангүй", { cause: e });
  }
  let dss: Awaited<ReturnType<typeof collectLTVWithWait>>;
  try {
    dss = await collectLTVWithWait(f, now, sleep, ts.time, roots, [[cert, ...chain], ts.certificates]);
  } catch (e) {
    throw new PadesError("LTV_UNAVAILABLE", `OCSP/CRL бүрэн авч чадсангүй${e instanceof LTVError ? ": " + e.message : ""}`, { cause: e });
  }
  let out: Uint8Array;
  try {
    out = await appendDSS(signed, { ...dss, contents: signatureContents(signed, st.byteRange) });
  } catch (e) {
    throw new PadesError("SELF_VALIDATION_FAILED", "DSS revision бичиж чадсангүй", { cause: e });
  }
  if (out.length > MAX_OUTPUT_BYTES) throw new PadesError("PDF_TOO_LARGE", "гаралт 10 MiB-аас их");
  // Өмнөх гарын үсгүүдийн CMS ба revision (Go: Extract(out)-ийн сүүлийнхээс бусад) — бүртгэлд.
  const prior: string[] = [];
  const priorRev: string[] = [];
  try {
    const list = signatureCMSList(signed);
    for (const s of list.slice(0, -1)) {
      prior.push(s.cms ? toHex(await sha256(s.cms)) : "");
      priorRev.push(s.end !== undefined ? toHex(await sha256(signed.subarray(0, s.end))) : "");
    }
  } catch (e) {
    throw new PadesError("SELF_VALIDATION_FAILED", "гаралтыг задалж чадсангүй", { cause: e });
  }
  return {
    pdf: out,
    cms,
    docId: st.docId,
    outSha256: toHex(await sha256(out)),
    inSha256: st.inSha256,
    hasPage: st.hasPage,
    pageSha256: st.pageSha256,
    revIndex: st.revIndex,
    sigRevSha256: toHex(await sha256(signed)),
    priorCmsSha256: prior,
    priorRevisionSha256: priorRev,
    signerCert: cert.raw,
  };
}
