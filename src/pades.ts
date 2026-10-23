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
import type { PdfImage } from "./types.js";
import { EID_ISSUERS, INTERMEDIATES, NATIONAL_ROOT } from "./pades/assets/chain.js";
import { fromB64, toHex } from "./pades/bytes.js";
import { assembleCMS, signedAttributes, CLAIMED_ROLE_MAX_RUNES } from "./pades/cms.js";
import { randomBytes, sha256 } from "./pades/crypto.js";
import { DEFAULT_TSA_URL, Fetcher, isBrowser, type FetchFn } from "./pades/fetch.js";
import { LTVError, collectLTVWithWait, timestampToken } from "./pades/ltv.js";
import { checkStructure } from "./pades/pdf/nesting.js";
import { CertificateRevokedError } from "./pades/revocation.js";
import { MAX_INPUT_BYTES } from "./pades/limits.js";
import { AppearanceError, checkPdfImage, defaultStampPage, round100, type PdfImageData, type Visible } from "./pades/page/appearance.js";
import { appendVerifyPage } from "./pades/page/page.js";
import { appendDSS } from "./pades/pdf/dss.js";
import { embedCMS, PlaceholderOverflowError, prepareSignature, signatureContents } from "./pades/pdf/signature.js";
import { PrecheckError, UUID_RE, VERIFY_URL_PREFIX, docIdFromPage, encrypted, precheck, scanSignatures, signatureCMSList } from "./pades/precheck.js";
import { suggestVisible } from "./pades/page/suggest.js";
import { decodeState, encodeState } from "./pades/state.js";
import { OID, checkSignatureFrom, parseCertificate, verifyCitizen, type Certificate } from "./pades/x509.js";

/**
 * `complete`: OCSP/CRL-ийн (олгогчийн гарын үсэгтэй) хариугаар гинжийн гэрчилгээ цуцлагдсан — `LTV_UNAVAILABLE`-ийн
 * `cause`, дахин оролдохгүй (`retryable` false). Go `pades.ErrCertificateRevoked`.
 */
export { CertificateRevokedError };

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

  /** TSA_UNAVAILABLE / LTV_UNAVAILABLE — гэхдээ гэрчилгээ цуцлагдсан (`cause` нь {@link CertificateRevokedError}) бол үгүй. */
  get retryable(): boolean {
    if ((this as { cause?: unknown }).cause instanceof CertificateRevokedError) return false;
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
  /**
   * Where the verify page goes when it is added (`verifyPage` on an unsigned document): `"last"` (default) or `"first"`
   * (it becomes page 1). `appearance.page`, {@link suggestPlacement} and `placement.page` always count the pages of the
   * input PDF as given — never the added page (PAGE_SPEC.md §8a, PLACEMENT_SPEC.md §1b). Other values → REQUEST_INVALID.
   */
  verifyPagePosition?: "last" | "first";
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
 * `x, y` нь хүссэн байрлал: тэнд хуудасны агуулга байвал дүрслэл чөлөөт зай руу шилжинэ (PLACEMENT_SPEC.md) — эцсийн
 * байрлал {@link PadesPrepared.placement}-д. `exact: true` бол яг энд зурна (шилжүүлэхгүй, §6a). Урьдчилан харах /
 * координат хөрвүүлэхэд {@link suggestPlacement}.
 *
 * `width` ба `height` хоёулаа 0 бол анхдагч хэмжээ (APPEARANCE_SPEC.md §6.3, 0.31.0+): зураггүй 220 × 64, `signatureImage`-тэй
 * 220 × 110, `stampImage`-тэй (гарын үсэгтэй/үгүй) 240 × 147.5 — {@link DEFAULT_STAMP_SIZE} г.м.
 */
export interface PadesAppearance {
  /**
   * Оролтын баримтын хуудас, 1-ээс (тодорхой дугаар — юуг ч алгасахгүй); 0/байхгүй = оролтын eID verify хуудас БИШ
   * сүүлийн хуудас: энэ prepare-ийн нэмэх ба өмнөх гарын үсгүүдийн нэмсэн verify хуудас тооцогдохгүй (0.26.0+,
   * PLACEMENT_SPEC §1a — `/Annots`-д энэ баримтын `https://ca.eidmongolia.mn/verify/<docId>` Link-тэй хуудас).
   */
  page?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `mn` | `en`; байхгүй бол `lang` (тэр нь байхгүй бол mn). */
  lang?: "mn" | "en";
  /**
   * Draw the stamp exactly at page/x/y/width/height — a position the signer chose (e.g. dragged on a page preview);
   * never moved off page content (PLACEMENT_SPEC.md §6a). The rect must still lie inside the page (else
   * `REQUEST_INVALID`, never clamped). The page is still scanned: `placement.status` is `requested` when the rect is
   * free, `overlap` when content is under it, `unscanned` when the page cannot be scanned — never `moved`.
   * false / absent (default) = the rect is only the preferred spot. Not written into the PDF. Since 0.29.0.
   */
  exact?: boolean;
  /**
   * The signer's handwritten-signature image (CA: `GET /v3/person/etsi/{etsi}/signature-image`) drawn inside the stamp
   * (APPEARANCE_SPEC.md §6). Absent = none (byte-identical to the stamp without images). Since 0.31.0.
   */
  signatureImage?: PdfImage;
  /**
   * The organization's stamp image (CA: `representations[].stampImage`); only with `claimedRole` (onBehalfOf), else
   * `REQUEST_INVALID` in {@link prepare}. The round stamp overlaps the box top-right and sticks out above it —
   * `width`/`height` are the whole widget rect (APPEARANCE_SPEC.md §6.3). Since 0.31.0.
   */
  stampImage?: PdfImage;
}

/**
 * A "PDF image" as the CA serves it — the RP-API `pdfImage` ({@link EidImage.pdfImage} from `person.signatureImage()`,
 * `Representation.stampImage`), passed to `appearance.signatureImage` / `stampImage` unchanged.
 */
export type { PdfImage } from "./types.js";

/** One image drawn in a signature's stamp, as registered with the CA (`POST /pdf/signatures` `images`, APPEARANCE_SPEC §6.6). */
export interface PadesImageRef {
  kind: "signature" | "stamp";
  sha256: string;
}

/**
 * Default stamp sizes (pt) when `appearance.width` and `height` are both 0 (APPEARANCE_SPEC.md §6.3): without images, with
 * a signature image, and with a stamp image (with or without a signature image; the height includes the stamp's overflow).
 */
export const DEFAULT_STAMP_SIZE = { width: 220, height: 64 } as const;
export const DEFAULT_SIGNATURE_STAMP_SIZE = { width: 220, height: 110 } as const;
export const DEFAULT_ORG_STAMP_SIZE = { width: 240, height: 147.5 } as const;

/** Go appearanceSize — width/height, or the default for the images when both are 0. */
function appearanceSize(a: PadesAppearance): { width: number; height: number } {
  if (a.width !== 0 || a.height !== 0) return { width: a.width, height: a.height };
  if (a.stampImage) return DEFAULT_ORG_STAMP_SIZE;
  if (a.signatureImage) return DEFAULT_SIGNATURE_STAMP_SIZE;
  return DEFAULT_STAMP_SIZE;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const BASE64_STD_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** PdfImage → page/appearance PdfImageData (alpha base64 → bytes); undefined when absent. */
function imageData(im: PdfImage | undefined): PdfImageData | undefined {
  if (im === undefined) return undefined;
  return { w: im.width, h: im.height, color: im.color, alpha: fromB64(im.alpha) };
}

export interface PadesPrepared {
  /** SHA-256(DER(signedAttrs)) — 32 байт; `eid.signPdfDigest({dtbs})` / токены `C_Sign`-ийн оролт. */
  dtbs: Uint8Array;
  /** `messageDigest` = SHA-256(ByteRange). */
  digest: Uint8Array;
  docId: string;
  /** Тунгалаг, сериалчилж хадгалж болно (бэлтгэсэн PDF дотор нь — PDF-тэй ижил нууцлалтай). Go SDK-тай нийцтэй. */
  state: Uint8Array;
  /** Харагдах дүрслэл хаана зурагдсан (Go `Prepared.Placement`, PLACEMENT_SPEC.md); `appearance`-гүй бол байхгүй. */
  placement?: PadesPlacement;
}

/**
 * The visible stamp's final rect (Go `pades.Placement`, PLACEMENT_SPEC.md) — `appearance` coordinates, pt. The stamp
 * avoids existing page content: `appearance.x/y` is the preferred spot.
 * - `requested` — drawn at `appearance.x/y` (that spot was free);
 * - `moved` — that spot overlapped page content; the stamp moved to the first free spot (mirrored column, then up in
 *   12 pt steps);
 * - `overlap` — no free spot (with `appearance.exact`: content under the rect); drawn at the requested spot over content;
 * - `unscanned` — the page could not be scanned within the limits; drawn at the requested spot.
 *
 * With `appearance.exact` the status is never `moved`. The signature is valid in every case; surface `overlap` /
 * `unscanned` to the user (e.g. a notice).
 */
export interface PadesPlacement {
  /** 1-based page of the input document the stamp is on. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  status: PadesPlacementStatus;
}

export type PadesPlacementStatus = "requested" | "moved" | "overlap" | "unscanned";

/**
 * {@link suggestPlacement}'s result (Go `pades.Suggestion`, PLACEMENT_SPEC.md §6b), pt. `page, x, y, width, height,
 * status` are exactly what {@link prepare} returns in {@link PadesPrepared.placement} for the same PDF and appearance
 * (except an unsigned input that already carries verify pages of the docId later passed to prepare). Coordinates are the
 * appearance space: origin at the visible lower-left, x right, y up. A UI that renders page `page` at `s` px/pt with a
 * top-left origin maps `left = x·s`, `top = (pageHeight − y − height)·s`; back: `x = left/s`,
 * `y = pageHeight − top/s − height`, then pass `exact: true` so the stamp stays where the user put it.
 */
export interface PlacementSuggestion {
  /** 1-based page of the input document (page 0 resolved as in prepare). */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `requested` | `moved` | `overlap` | `unscanned` (never `moved` with `exact`). */
  status: "requested" | "moved" | "overlap" | "unscanned";
  /** Visible size of `page` (CropBox, else MediaBox; after /Rotate) = `pages[page - 1]`. */
  pageWidth: number;
  pageHeight: number;
  /** Pages in /Pages tree order. */
  pageCount: number;
  /** Visible size of every page, index 0 = page 1; `{0, 0}` = that page's geometry is unreadable (no stamp there). */
  pages: { width: number; height: number }[];
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
  /**
   * OCSP/CRL (DSS) цуглуулалт унавал SDK-ийн өөрийн нэмэлт оролдлого — ижил state, гарын үсэг, TSA timestamp-аар (PIN
   * дахин асуухгүй). Анхдагч 2 (нийт 3 оролдлого; хүлээлт ~1 с, ~3 с + jitter); 0 — унтраах. Бүгд унавал `LTV_UNAVAILABLE`.
   */
  ltvRetries?: number;
  /** Цуцлалт: TSA/OCSP/CRL таталт ба retry-ийн хүлээлтийг тасална — `signal.reason` (анхдагч `AbortError`) шиднэ. */
  signal?: AbortSignal;
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
  /**
   * `prepare`-ийн `claimedRole` (signedAttrs-д орсон); "" = хувиараа. `registrationFromCompleted` үүнийг `onBehalfOf`-той
   * тулгана.
   */
  claimedRole: string;
  /**
   * The images drawn in this signature's stamp (`appearance.signatureImage`, then `stampImage`) as `{kind, sha256}`;
   * `registrationFromCompleted` sends them as `images` (APPEARANCE_SPEC.md §6.6). Absent without images. Since 0.31.0.
   */
  images?: PadesImageRef[];
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
  try {
    checkStructure(doc);
  } catch (e) {
    throw new PadesError("PDF_INVALID", "PDF-ийн бүтэц хэт гүн эсвэл төвөгтэй", { cause: e });
  }
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
  const pos = opts.verifyPagePosition as string | undefined;
  if (pos !== undefined && pos !== "" && pos !== "last" && pos !== "first") {
    throw new PadesError("REQUEST_INVALID", "verifyPagePosition: last | first");
  }
  const first = pos === "first";
  checkAppearance(opts);
  if (opts.appearance?.stampImage && !opts.claimedRole) {
    throw new PadesError("REQUEST_INVALID", "appearance: stampImage зөвхөн claimedRole (onBehalfOf)-той");
  }
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
      }, first);
    } catch (e) {
      throw new PadesError("PDF_INVALID", "PDF задарсангүй (хуудас нэмж чадсангүй)", { cause: e });
    }
    pageHex = toHex(await sha256(base));
  }
  const name = goTrim(opts.signerName ?? "") === "" ? signerDisplayName(cert) : (opts.signerName ?? "");
  const vis = opts.appearance ? visibleSpec(doc, opts, name, now, docId, pc.revIndex) : undefined;
  let prep: Awaited<ReturnType<typeof prepareSignature>>;
  try {
    // vis.page counts the input's pages; a verify page added in front shifts them by one in base (PLACEMENT_SPEC §1b).
    prep = await prepareSignature(base, now, name, opts.reason ?? "", vis && hasPage && first ? { ...vis, page: vis.page + 1 } : vis);
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
    images: prepImages(opts.appearance),
    preparedSha256: toHex(await sha256(prep.pdf)),
    pdf: prep.pdf,
  });
  const out: PadesPrepared = { dtbs: await sha256(attrs), digest: prep.digest, docId, state };
  if (vis && prep.placement) {
    const pl = prep.placement;
    out.placement = { page: vis.page, x: pl.x / 100, y: pl.y / 100, width: vis.w / 100, height: vis.h / 100, status: pl.status };
  }
  return out;
}

/** Appearance-ийн PDF-ээс үл хамаарах шалгалт (Go checkAppearance, APPEARANCE_SPEC.md §1). */
function checkAppearance(o: Pick<PadesPrepareOptions, "appearance" | "claimedRole">): void {
  const a = o.appearance;
  if (a === undefined) return;
  const bad = (msg: string): PadesError => new PadesError("REQUEST_INVALID", `appearance: ${msg}`);
  for (const v of [a.x, a.y, a.width, a.height]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 14400) throw bad("x, y, width, height нь 0…14400 pt");
  }
  const page = a.page ?? 0;
  if (!Number.isInteger(page) || page < 0) throw bad("page ≥ 0");
  if (a.lang !== undefined && (a.lang as string) !== "" && a.lang !== "mn" && a.lang !== "en") throw bad("lang: mn | en");
  if (a.exact !== undefined && typeof a.exact !== "boolean") throw bad("exact: boolean");
  const role = o.claimedRole ?? "";
  if (role !== "" && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(role)) throw bad("claimedRole-д удирдах тэмдэгт");
  // APPEARANCE_SPEC.md §6.1 (golden v10) — before the PDF is parsed, in suggestPlacement too.
  for (const [name, im] of [["signatureImage", a.signatureImage], ["stampImage", a.stampImage]] as const) {
    if (im === undefined) continue;
    if (im === null || typeof im !== "object") throw bad(`${name}: объект`);
    if (typeof im.sha256 !== "string" || !SHA256_HEX_RE.test(im.sha256)) throw bad(`${name}.sha256: жижиг hex SHA-256`);
    if (typeof im.alpha !== "string" || !BASE64_STD_RE.test(im.alpha)) throw bad(`${name}.alpha: стандарт base64`);
    try {
      checkPdfImage(imageData(im)!);
    } catch (e) {
      if (e instanceof AppearanceError) throw bad(`${name}: ${e.message.replace(/^зураг: /, "")}`);
      throw e;
    }
  }
}

/** Go prepare: Completed.Images — signatureImage, then stampImage (those given); undefined without images. */
function prepImages(a: PadesAppearance | undefined): PadesImageRef[] | undefined {
  const out: PadesImageRef[] = [];
  if (a?.signatureImage) out.push({ kind: "signature", sha256: a.signatureImage.sha256 });
  if (a?.stampImage) out.push({ kind: "stamp", sha256: a.stampImage.sha256 });
  return out.length ? out : undefined;
}

/** Go visibleSpec: хуудас (0 → verify биш сүүлийн — PLACEMENT_SPEC §1a), h100, хэл, огноо (+08), verify URL. */
function visibleSpec(doc: Uint8Array, o: PadesPrepareOptions, name: string, now: Date, docId: string, revIndex: number): Visible {
  const a = o.appearance!;
  if (docId === "") throw new PadesError("REQUEST_INVALID", "appearance: docId заавал (баримтад verify хуудас алга)");
  // page 0 / байхгүй = eID verify хуудас БИШ сүүлийн хуудас (PLACEMENT_SPEC §1a); тодорхой дугаар хэвээр.
  let last: number, n: number;
  try {
    ({ page: last, n } = defaultStampPage(doc, VERIFY_URL_PREFIX + docId));
  } catch (e) {
    throw new PadesError("PDF_INVALID", "PDF задарсангүй", { cause: e });
  }
  const page = a.page || last;
  if (page > n) throw new PadesError("REQUEST_INVALID", `appearance: page ${page} > хуудасны тоо ${n}`);
  const z = new Date(now.getTime() + 8 * 3600_000);
  const p2 = (v: number): string => String(v).padStart(2, "0");
  const size = appearanceSize(a);
  return {
    page,
    x: round100(a.x),
    y: round100(a.y),
    w: round100(size.width),
    h: round100(size.height),
    sig: imageData(a.signatureImage),
    stamp: imageData(a.stampImage),
    name: goTrim(name),
    role: o.claimedRole ?? "",
    lang: a.lang || o.lang || "mn",
    date: `${String(z.getUTCFullYear()).padStart(4, "0")}-${p2(z.getUTCMonth() + 1)}-${p2(z.getUTCDate())} ${p2(z.getUTCHours())}:${p2(z.getUTCMinutes())} (+08)`,
    url: `${VERIFY_URL_PREFIX}${docId}/${revIndex}`,
    avoid: true,
    exact: a.exact === true,
  };
}

/**
 * Runs {@link prepare}'s stamp placement (page 0 resolution, page scan, candidate search; `appearance.exact`) on `pdf`
 * without signing — no certificate, no network (PLACEMENT_SPEC.md §6b). A UI shows the default stamp position and the
 * page sizes before signing, maps the user's drag back to `appearance` coordinates and passes `exact: true` to prepare.
 *
 * Checks, in order: size (`PDF_TOO_LARGE`), `%PDF-` header and structure (`PDF_INVALID`), the appearance values
 * (`REQUEST_INVALID`), encryption (`PDF_ENCRYPTED`), the signature scan (`PDF_INVALID`), page > page count / page box /
 * `/Rotate` / rect outside the page (`REQUEST_INVALID`). Not checked (prepare does): prior signatures
 * (`PDF_FOREIGN_SIGNATURE`, `PDF_PRIOR_SIGNATURE_INVALID`, `PDF_LOCKED`, `PDF_TOO_MANY_SIGNATURES`), the signer, `docId`,
 * whether the name/role fit the stamp. Page 0 skips this document's eID verify pages using the docId read from its
 * verify page; an unsigned document skips no page (the last page). Since 0.29.0.
 *
 * @throws {PadesError} PDF_TOO_LARGE / PDF_INVALID / REQUEST_INVALID / PDF_ENCRYPTED
 */
export async function suggestPlacement(pdf: Uint8Array, appearance: PadesAppearance): Promise<PlacementSuggestion> {
  const doc = u8(pdf, "pdf");
  if (doc.length > MAX_INPUT_BYTES) throw new PadesError("PDF_TOO_LARGE", "PDF 9.75 MB-аас их байна");
  if (doc.length < 5 || String.fromCharCode(...doc.subarray(0, 5)) !== "%PDF-") throw new PadesError("PDF_INVALID", "PDF биш эсвэл эвдэрсэн");
  try {
    checkStructure(doc);
  } catch (e) {
    throw new PadesError("PDF_INVALID", "PDF-ийн бүтэц хэт гүн эсвэл төвөгтэй", { cause: e });
  }
  if (appearance === null || typeof appearance !== "object") throw new PadesError("REQUEST_INVALID", "appearance заавал");
  checkAppearance({ appearance });
  if (encrypted(doc)) throw new PadesError("PDF_ENCRYPTED", "шифрлэгдсэн PDF дэмжигдэхгүй");
  let signed: boolean;
  try {
    signed = scanSignatures(doc).sigs.length > 0;
  } catch (e) {
    throw new PadesError("PDF_INVALID", "PDF биш эсвэл эвдэрсэн", { cause: e });
  }
  let verifyUri = "";
  if (signed) {
    const id = docIdFromPage(doc);
    if (id !== "") verifyUri = VERIFY_URL_PREFIX + id;
  }
  const size = appearanceSize(appearance);
  const w = round100(size.width);
  const h = round100(size.height);
  let s: ReturnType<typeof suggestVisible>;
  try {
    s = suggestVisible(doc, verifyUri, appearance.page ?? 0, round100(appearance.x), round100(appearance.y), w, h, appearance.exact === true);
  } catch (e) {
    if (e instanceof AppearanceError) throw new PadesError("REQUEST_INVALID", `appearance: ${e.message}`, { cause: e });
    throw new PadesError("PDF_INVALID", "PDF задарсангүй", { cause: e });
  }
  const pages = s.pages.map((p) => (p ? { width: p.w / 100, height: p.h / 100 } : { width: 0, height: 0 }));
  const cur = pages[s.page - 1]!;
  return {
    page: s.page,
    x: s.placement.x / 100,
    y: s.placement.y / 100,
    width: w / 100,
    height: h / 100,
    status: s.placement.status,
    pageWidth: cur.width,
    pageHeight: cur.height,
    pageCount: pages.length,
    pages,
  };
}

const DEFAULT_LTV_RETRIES = 2;
const MAX_LTV_RETRIES = 10;
const LTV_BACKOFF_MS = [1000, 3000];

/** LTV retry-ийн хүлээлт: 1 с, 3 с (цааш 3 с) + 0–25% jitter. */
function ltvBackoffMs(attempt: number): number {
  const base = LTV_BACKOFF_MS[Math.min(attempt, LTV_BACKOFF_MS.length - 1)]!;
  return Math.round(base * (1 + Math.random() * 0.25));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Цуцлагдсан", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** `sleep(ms)`-ийг `signal`-аар тасалж болох болгоно. */
function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Иргэний гарын үсгийг (session `signature.value` — base64 мөр эсвэл байт; RSA PKCS#1 v1.5, ECDSA r‖s эсвэл DER) DTBS-д
 * шалгаад TSA → CMS → embed → OCSP/CRL (genTime-ийн дараа) → DSS revision. Сүлжээ: tsa.timeserver.mn, AIA/CDP.
 *
 * OCSP/CRL цуглуулалт унавал `ltvRetries` (анхдагч 2) удаа өөрөө дахин оролдоно (PIN дахин асуухгүй).
 *
 * @throws {PadesError} SIGNATURE_INVALID / TSA_UNAVAILABLE / LTV_UNAVAILABLE / PLACEHOLDER_OVERFLOW / STATE_INVALID /
 *   PDF_TOO_LARGE / SELF_VALIDATION_FAILED / REQUEST_INVALID (`ltvRetries`; `fetch` алга — тохиргоо, retryable биш)
 * @throws `signal.reason` (анхдагч `DOMException` `AbortError`) — `signal` цуцлагдвал.
 */
export async function complete(state: Uint8Array | ArrayBuffer, signature: Uint8Array | string, opts: PadesCompleteOptions = {}): Promise<PadesCompleted> {
  let st: Awaited<ReturnType<typeof decodeState>>;
  let cert: Certificate;
  let chain: Certificate[];
  try {
    st = await decodeState(u8(state, "state"));
  } catch (e) {
    throw new PadesError("STATE_INVALID", "state задарсангүй", { cause: e });
  }
  try {
    checkStructure(st.pdf);
  } catch (e) {
    throw new PadesError("STATE_INVALID", "state-ийн PDF-ийн бүтэц хэт гүн эсвэл төвөгтэй", { cause: e });
  }
  try {
    cert = parseCertificate(st.signerCert);
    chain = st.chain.map((c) => parseCertificate(c));
  } catch (e) {
    throw new PadesError("STATE_INVALID", "state задарсангүй", { cause: e });
  }
  const roots = opts.roots && opts.roots.length > 0 ? parseDERs(opts.roots, "REQUEST_INVALID", "roots") : der(NATIONAL_ROOT);
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchFn = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as unknown as FetchFn | undefined);
  // Тохиргооны (байнгын) алдаа — TSA_UNAVAILABLE биш (retryable биш, давтах нь утгагүй).
  if (!fetchFn) throw new PadesError("REQUEST_INVALID", "fetch алга (Node ≥ 18 эсвэл opts.fetch)");
  const ltvRetries = opts.ltvRetries ?? DEFAULT_LTV_RETRIES;
  if (!Number.isInteger(ltvRetries) || ltvRetries < 0 || ltvRetries > MAX_LTV_RETRIES) {
    throw new PadesError("REQUEST_INVALID", `ltvRetries 0–${MAX_LTV_RETRIES} бүхэл тоо`);
  }
  const signal = opts.signal;
  throwIfAborted(signal);
  let sigBytes: Uint8Array;
  try {
    sigBytes = typeof signature === "string" ? fromB64(signature) : u8(signature, "signature");
  } catch (e) {
    throw new PadesError("SIGNATURE_INVALID", "гарын үсэг base64 биш", { cause: e });
  }
  const sig = await verifyCitizen(cert, st.signedAttrs, sigBytes);
  if (!sig) throw new PadesError("SIGNATURE_INVALID", "гарын үсэг DTBS-тэй таарсангүй");
  const f = new Fetcher(fetchFn, opts.httpsUpgrade ?? isBrowser(), signal);
  let ts: Awaited<ReturnType<typeof timestampToken>>;
  try {
    const nonce = opts.nonce ? await opts.nonce() : await randomBytes(8);
    if (nonce.length !== 8) throw new Error("nonce 8 байт биш");
    ts = await timestampToken(f, opts.tsaUrl || DEFAULT_TSA_URL, sig, roots, chain, now(), nonce);
  } catch (e) {
    throwIfAborted(signal);
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
  // OCSP/CRL түр унавал (ж: CRL толь 404) ижил TSA token-оор дахин цуглуулна — амжсан таталт Fetcher-ийн cache-д.
  let dss: Awaited<ReturnType<typeof collectLTVWithWait>>;
  for (let attempt = 0; ; attempt++) {
    try {
      dss = await collectLTVWithWait(f, now, sleep, ts.time, roots, [[cert, ...chain], ts.certificates]);
      break;
    } catch (e) {
      throwIfAborted(signal);
      if (e instanceof CertificateRevokedError) throw new PadesError("LTV_UNAVAILABLE", "гэрчилгээ цуцлагдсан", { cause: e });
      if (attempt >= ltvRetries) {
        throw new PadesError("LTV_UNAVAILABLE", `OCSP/CRL бүрэн авч чадсангүй${e instanceof LTVError ? ": " + e.message : ""}`, { cause: e });
      }
      await abortableSleep(sleep, ltvBackoffMs(attempt), signal);
    }
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
    claimedRole: st.claimedRole,
    ...(st.images?.length ? { images: st.images.map((x) => ({ ...x })) } : {}),
  };
}
