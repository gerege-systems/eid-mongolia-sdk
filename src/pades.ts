// @gerege-systems/eid-mongolia-sdk/pades — клиент талын PAdES (PDF eID-ийн сервер рүү ОЧИХГҮЙ).
//
// Go core (`github.com/gerege-systems/eid-mongolia-sdk-go`, package `wasm`) → WebAssembly. Нэг хэрэгжүүлэлт бүх
// платформд (Go / Node+браузер / iOS / Android / Windows) — гаралт байт-ижил (golden vectors). Урсгал:
//
//   prepare(pdf, {signerCert, …})  → {dtbs, digest, docId, state}     (браузер эсвэл Node)
//   eid.signPdfDigest({dtbs, …})   → иргэн утсаараа DTBS-д зурна       (RP backend, үндсэн entry)
//   complete(state, signature)      → {pdf, cms, outSha256, …}         (TSA + OCSP/CRL сүлжээ дотроо)
//   eid.registerSignature({cms, …}) → /verify/{docID} бүртгэл          (RP backend)
//
// Үндсэн entry (`@gerege-systems/eid-mongolia-sdk`) WASM-ыг агуулахгүй — PDF ашиглахгүй RP-ийн bundle томрохгүй.
// WASM-ыг анхны дуудлагад залхуугаар ачаална (эсвэл {@link loadPades}-аар урьдчилан / өөр URL-аас).

import { EidError } from "./errors.js";

/** Тогтвортой алдааны кодууд (Go core-ийн `code` — бүх платформд ижил). */
export type PadesErrorCode =
  | "PDF_INVALID"
  | "PDF_ENCRYPTED"
  | "PDF_LOCKED"
  | "PDF_TOO_LARGE"
  | "PDF_TOO_MANY_SIGNATURES"
  | "PDF_PRIOR_SIGNATURE_INVALID"
  /** Өмнөх гарын үсэг eID-ийн хүчинтэй B-LT биш. */
  | "PDF_FOREIGN_SIGNATURE"
  /** signerCert задрахгүй / түлхүүрийн төрөл / гинж. */
  | "SIGNER_INVALID"
  /** Options буруу (docId UUID биш, lang, үл мэдэгдэх түлхүүр г.м.). */
  | "REQUEST_INVALID"
  | "SIGNATURE_INVALID"
  | "TSA_UNAVAILABLE"
  | "LTV_UNAVAILABLE"
  | "SELF_VALIDATION_FAILED"
  | "PLACEHOLDER_OVERFLOW"
  | "STATE_INVALID"
  /** WASM ачаалагдсангүй / орчин дэмжихгүй (SDK-ийн код, core-ийнх биш). */
  | "WASM_UNAVAILABLE"
  /** Core код өгөөгүй алдаа (хувилбар зөрөх г.м.). */
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
  "WASM_UNAVAILABLE",
  "INTERNAL",
];

/**
 * PAdES core-ийн алдаа. `code`-оор салаална: SIGNATURE_INVALID — state хэвээр, дахин зуруулж болно; TSA_UNAVAILABLE /
 * LTV_UNAVAILABLE — түр, ижил state + гарын үсгээр `complete`-ийг дахин дуудна ({@link PadesError.retryable}).
 */
export class PadesError extends EidError {
  constructor(
    readonly code: PadesErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }

  get retryable(): boolean {
    return this.code === "TSA_UNAVAILABLE" || this.code === "LTV_UNAVAILABLE";
  }
}

export interface PadesPrepareOptions {
  /** Иргэний SIGN гэрчилгээ (DER) — `signingCertificateV2`-д. Session-ий зурагч төхөөрөмжийнх байх ёстой. */
  signerCert: Uint8Array;
  /** Олгогчийн гинж (DER: 04, 03, 02). Анхдагч — core-д суулгасан eID гинж. */
  chain?: Uint8Array[];
  /** `/Name`. Хоосон бол гэрчилгээнээс. */
  signerName?: string;
  /** `/Reason` (≤ 127 UTF-16 нэгж, эс бөгөөс орхино). */
  reason?: string;
  /** Байгууллагын нэрийн өмнөөс: `organization.getRepresentations()`-ийн `claimedRole` ЯГ ХЭВЭЭР (signedAttrs-д орно). */
  claimedRole?: string;
  /** `/M` (+08:00-оор бичигдэнэ, секундээр тайрна). Анхдагч — одоо. */
  signingTime?: Date;
  /** Баримтын UUID (verify хуудас / QR). Хоосон бол core үүсгэнэ (гарын үсэгтэй баримтад хуудаснаас уншина). */
  docId?: string;
  /** Баталгаажуулах (QR) хуудас нэмэх — зөвхөн гарын үсэггүй баримтын эхний гарын үсэгт. */
  verifyPage?: boolean;
  /** Баталгаажуулах хуудасны хэл. */
  lang?: "mn" | "en";
  /** Баримтын нэр — `verifyPage` үед заавал (≤ 120 тэмдэгт). */
  fileName?: string;
  /** Итгэлийн тулгуур DER (өмнөх гарын үсгийг шалгахад). Анхдагч — Mongolian National Root CA. Тестэд л. */
  roots?: Uint8Array[];
}

export interface PadesPrepared {
  /** SHA-256(DER(signedAttrs)) — 32 байт; `eid.signPdfDigest({dtbs})` / токены `C_Sign`-ийн оролт. */
  dtbs: Uint8Array;
  /** `messageDigest` = SHA-256(ByteRange). */
  digest: Uint8Array;
  docId: string;
  /** Тунгалаг, сериалчилж хадгалж болно (PDF-тэй ижил нууцлалтай — бэлтгэсэн PDF дотор нь). */
  state: Uint8Array;
}

export interface PadesCompleteOptions {
  /** RFC 3161 TSA. Анхдагч `https://tsa.timeserver.mn/`. */
  tsaUrl?: string;
  /** Итгэлийн тулгуур DER (TSA гинж, self-validation). Анхдагч — Mongolian National Root CA. Тестэд л. */
  roots?: Uint8Array[];
}

export interface PadesCompleted {
  /** Гарын үсэгтэй PDF (PAdES-BASELINE-LT, self-validated). */
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
  /** Гарын үсгийн revision-ий SHA-256 (hex). */
  sigRevSha256: string;
  /** Өмнөх гарын үсгүүдийн CMS-ийн SHA-256 (hex). */
  priorCmsSha256: string[];
  /** Зурагчийн гэрчилгээ (DER). */
  signerCert: Uint8Array;
}

/** Core-ийн шалгалтын тайлан (CA `validate.PDFReport`-ийн хэлбэр) — JSON. */
export type PadesReport = Record<string, unknown>;

export interface PadesVerifyOptions {
  /** Шалгах цаг (цагийн тэмдэггүй гарын үсэгт). Анхдагч — одоо. */
  time?: Date;
  /** Итгэлийн тулгуур DER. Анхдагч — Mongolian National Root CA. */
  roots?: Uint8Array[];
  /** Нэмэлт завсрын CA DER. */
  intermediates?: Uint8Array[];
  /** eID-ийн олгогч гэж үзэх нэмэлт CA DER (тест). */
  issuers?: Uint8Array[];
}

/**
 * WASM-ын эх: URL (браузерт fetch, Node-д `file:`/`http(s):`), байт, эсвэл бэлэн `WebAssembly.Module`. Анхдагч — багцын
 * `eid-pades.wasm` (`new URL("./eid-pades.wasm", import.meta.url)` — Vite/webpack 5 asset болгон хуулна).
 */
export type PadesWasmSource = URL | string | ArrayBuffer | Uint8Array | WasmModule;

/** Хөрвүүлсэн `WebAssembly.Module` (DOM lib-гүй төсөлд ч type-check хийгдэхийн тулд нээлттэй). */
export type WasmModule = object;

export interface PadesLoadOptions {
  wasm?: PadesWasmSource;
}

/**
 * Go `wasm` package-ийн `globalThis.eidPades` (eid-mongolia-sdk-go `wasm/main.go`): options нь объект (Go талд
 * JSON.stringify → DisallowUnknownFields), байт нь Uint8Array; prepare/verify throw, complete reject — Error{code}.
 */
interface CoreApi {
  prepare(pdf: Uint8Array, options: object): unknown;
  complete(state: Uint8Array, signature: Uint8Array, options: object): unknown;
  verify(pdf: Uint8Array, options: object): unknown;
  version: string;
}

type WasmImports = Record<string, Record<string, unknown>>;
type WasmInstance = object;

/** `WebAssembly`-ийн бидэнд хэрэгтэй хэсэг (lib.dom-гүйгээр). */
interface WasmApi {
  Module: new (...a: never[]) => WasmModule;
  instantiate(bytes: ArrayBuffer | Uint8Array, imports: WasmImports): Promise<{ instance: WasmInstance }>;
  instantiate(module: WasmModule, imports: WasmImports): Promise<WasmInstance>;
  instantiateStreaming?(res: Response, imports: WasmImports): Promise<{ instance: WasmInstance }>;
}

interface GoRuntime {
  importObject: WasmImports;
  run(instance: WasmInstance): Promise<void>;
}

const G = globalThis as unknown as Record<string, unknown> & { location?: { href: string } };
const wasmApi = (): WasmApi => {
  const w = G.WebAssembly as WasmApi | undefined;
  if (!w) throw new PadesError("WASM_UNAVAILABLE", "WebAssembly дэмжигдэхгүй орчин");
  return w;
};

let loading: Promise<CoreApi> | undefined;

const isNode = typeof process !== "undefined" && typeof process.versions?.node === "string" && G.window === undefined;

// Bundler-ууд node:* модулийг браузерийн bundle-д татахгүйн тулд specifier хувьсагчаар.
const nodeImport = (m: string): Promise<any> => import(/* @vite-ignore */ /* webpackIgnore: true */ m); // eslint-disable-line @typescript-eslint/no-explicit-any

async function wasmBytesOrModule(src: PadesWasmSource | undefined): Promise<ArrayBuffer | Uint8Array | WasmModule | Response> {
  if (src instanceof ArrayBuffer || src instanceof Uint8Array || (src && typeof src === "object" && src instanceof wasmApi().Module)) return src;
  const url = src === undefined ? new URL("./eid-pades.wasm", import.meta.url) : new URL(String(src), isNode ? undefined : G.location?.href);
  if (isNode && url.protocol === "file:") {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([nodeImport("node:fs/promises"), nodeImport("node:url")]);
    return readFile(fileURLToPath(url)) as Promise<Uint8Array>;
  }
  const res = await fetch(url);
  if (!res.ok) throw new PadesError("WASM_UNAVAILABLE", `${url.href}: HTTP ${res.status}`);
  return res;
}

async function instantiate(src: Awaited<ReturnType<typeof wasmBytesOrModule>>, imports: WasmImports): Promise<WasmInstance> {
  const WA = wasmApi();
  if (src instanceof WA.Module) return WA.instantiate(src as WasmModule, imports);
  if (typeof Response !== "undefined" && src instanceof Response) {
    // Сервер application/wasm-аар өгөөгүй бол streaming унана — байтаар дахин.
    if (typeof WA.instantiateStreaming === "function" && src.headers.get("content-type")?.startsWith("application/wasm")) {
      return (await WA.instantiateStreaming(src, imports)).instance;
    }
    return (await WA.instantiate(await src.arrayBuffer(), imports)).instance;
  }
  return (await WA.instantiate(src as Uint8Array, imports)).instance;
}

async function boot(opts: PadesLoadOptions): Promise<CoreApi> {
  const g = G;
  if (!g.crypto && isNode) g.crypto = (await nodeImport("node:crypto")).webcrypto; // Node 18 (global crypto үгүй)
  if (!g.Go) await import("./pades/wasm_exec.js");
  const Go = g.Go as (new () => GoRuntime) | undefined;
  if (!Go) throw new PadesError("WASM_UNAVAILABLE", "wasm_exec.js ачаалагдсангүй");
  const go = new Go();
  const instance = await instantiate(await wasmBytesOrModule(opts.wasm), go.importObject);
  // run() нь Go main дуустал (хэзээ ч) resolve болохгүй — хүлээхгүй; гарвал дараагийн ачаалалд дахин.
  void go.run(instance).finally(() => {
    loading = undefined;
    delete g.eidPades;
  });
  const api = g.eidPades as CoreApi | undefined;
  if (!api || typeof api.prepare !== "function") throw new PadesError("WASM_UNAVAILABLE", "eidPades бүртгэгдсэнгүй (wasm хувилбар зөрсөн)");
  return api;
}

/**
 * WASM-ыг ачаална (идэмпотент). Заавал биш — функц бүр анх дуудагдахад өөрөө ачаална. CSP/CDN-ээс, эсвэл bundler
 * asset-ийг өөрөө өгөх бол `wasm`-аар. Браузерийн CSP-д `script-src 'wasm-unsafe-eval'` хэрэгтэй.
 */
export function loadPades(opts: PadesLoadOptions = {}): Promise<void> {
  return core(opts).then(() => undefined);
}

function core(opts: PadesLoadOptions = {}): Promise<CoreApi> {
  if (!loading) {
    loading = boot(opts).catch((e: unknown) => {
      loading = undefined;
      throw e instanceof PadesError ? e : new PadesError("WASM_UNAVAILABLE", e instanceof Error ? e.message : String(e));
    });
  }
  return loading;
}

const b64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesOut(v: unknown, field: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return fromB64(v);
  throw new PadesError("INTERNAL", `core хариуны ${field} байт биш`);
}

function toPadesError(e: unknown): PadesError {
  if (e instanceof PadesError) return e;
  const o = (e && typeof e === "object" ? e : {}) as { code?: unknown; message?: unknown };
  let code = typeof o.code === "string" ? o.code : undefined;
  let message = typeof o.message === "string" ? o.message : String(e);
  if (!code) {
    try {
      const j = JSON.parse(message) as { code?: unknown; message?: unknown };
      if (typeof j.code === "string") {
        code = j.code;
        message = typeof j.message === "string" ? j.message : "";
      }
    } catch {
      /* JSON биш */
    }
  }
  const known = (PADES_ERROR_CODES as readonly string[]).includes(code ?? "");
  return new PadesError(known ? (code as PadesErrorCode) : "INTERNAL", known || !code ? message : `${code}: ${message}`);
}

async function call<T>(fn: (api: CoreApi) => unknown, map: (r: unknown) => T): Promise<T> {
  const api = await core();
  let r: unknown;
  try {
    r = await fn(api);
  } catch (e) {
    throw toPadesError(e);
  }
  // Core алдааг утгаар буцааж болно ({error:{code,message}}); undefined = Go runtime унасан (дараагийн дуудлага дахин ачаална).
  if (r === undefined || r === null) throw new PadesError("INTERNAL", "PAdES core хариу өгсөнгүй (WASM runtime зогссон)");
  if (typeof r === "object" && "error" in (r as object) && !(r instanceof Uint8Array)) throw toPadesError((r as { error: unknown }).error);
  return map(r);
}

/**
 * RFC 3339 +08:00 (Asia/Ulaanbaatar, DST-гүй) — `/M` нь цагийн бүсээ хадгалдаг тул CA ба бусад платформтой байт-ижил
 * байхын тулд UTC (`Z`) биш +08:00-оор дамжуулна.
 */
function ulaanbaatarTime(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new TypeError("pades: signingTime буруу Date");
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `${t.slice(0, 19)}+08:00`;
}

/** undefined талбаргүй объект (Go тал үл мэдэгдэх / null түлхүүрийг хүлээн авахгүй). */
function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function ders(list: Uint8Array[] | undefined, name: string): string[] | undefined {
  return list?.map((c, i) => b64(u8(c, `${name}[${i}]`)));
}

function u8(v: Uint8Array | ArrayBuffer, name: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`pades: ${name} Uint8Array байх ёстой`);
}

/**
 * PDF-ийг гарын үсэгт бэлдэнэ (placeholder, signedAttrs). Сүлжээгүй. `dtbs`-ийг иргэнээр зуруулна
 * (`eid.signPdfDigest`), `state`-ийг `complete` хүртэл хадгална.
 *
 * @throws {PadesError} PDF_INVALID / PDF_ENCRYPTED / PDF_LOCKED / PDF_TOO_LARGE / PDF_TOO_MANY_SIGNATURES / PDF_PRIOR_SIGNATURE_INVALID
 */
export function prepare(pdf: Uint8Array | ArrayBuffer, opts: PadesPrepareOptions): Promise<PadesPrepared> {
  const o = clean({
    signerCert: b64(u8(opts.signerCert, "signerCert")),
    chain: ders(opts.chain, "chain"),
    signerName: opts.signerName,
    reason: opts.reason,
    claimedRole: opts.claimedRole,
    signingTime: opts.signingTime && ulaanbaatarTime(opts.signingTime),
    docId: opts.docId,
    verifyPage: opts.verifyPage,
    fileName: opts.fileName,
    lang: opts.lang,
    roots: ders(opts.roots, "roots"),
  });
  const bytes = u8(pdf, "pdf");
  return call(
    (api) => api.prepare(bytes, o),
    (r) => {
      const x = r as Record<string, unknown>;
      return {
        dtbs: bytesOut(x.dtbs, "dtbs"),
        digest: bytesOut(x.digest, "digest"),
        docId: String(x.docId ?? ""),
        state: bytesOut(x.state, "state"),
      };
    },
  );
}

/**
 * Иргэний гарын үсгийг (session `signature.value` — base64 мөр эсвэл байт; RSA PKCS#1 v1.5, ECDSA r‖s эсвэл DER) DTBS-д
 * шалгаад TSA → CMS → embed → OCSP/CRL (DSS) → self-validate. Сүлжээ: tsa.timeserver.mn, ocsp/crl.eidmongolia.mn.
 *
 * @throws {PadesError} SIGNATURE_INVALID / TSA_UNAVAILABLE / LTV_UNAVAILABLE / SELF_VALIDATION_FAILED / PLACEHOLDER_OVERFLOW / STATE_INVALID
 */
export function complete(state: Uint8Array | ArrayBuffer, signature: Uint8Array | string, opts: PadesCompleteOptions = {}): Promise<PadesCompleted> {
  const o = clean({ tsaUrl: opts.tsaUrl, roots: ders(opts.roots, "roots") });
  const sig = typeof signature === "string" ? fromB64(signature) : u8(signature, "signature");
  const st = u8(state, "state");
  return call(
    (api) => api.complete(st, sig, o),
    (r) => {
      const x = r as Record<string, unknown>;
      return {
        pdf: bytesOut(x.pdf, "pdf"),
        cms: bytesOut(x.cms, "cms"),
        docId: String(x.docId ?? ""),
        outSha256: String(x.outSha256 ?? ""),
        inSha256: String(x.inSha256 ?? ""),
        hasPage: x.hasPage === true,
        pageSha256: String(x.pageSha256 ?? ""),
        revIndex: Number(x.revIndex ?? 0),
        sigRevSha256: String(x.sigRevSha256 ?? ""),
        priorCmsSha256: Array.isArray(x.priorCmsSha256) ? x.priorCmsSha256.map(String) : [],
        signerCert: bytesOut(x.signerCert ?? new Uint8Array(), "signerCert"),
      };
    },
  );
}

/** PDF-ийн гарын үсгүүдийг шалгана (CA-ийн нийтийн шалгагчийн PAdES хэсэг). Тайлан JSON. */
export function verify(pdf: Uint8Array | ArrayBuffer, opts: PadesVerifyOptions = {}): Promise<PadesReport> {
  const o = clean({
    time: opts.time?.toISOString(),
    roots: ders(opts.roots, "roots"),
    intermediates: ders(opts.intermediates, "intermediates"),
    issuers: ders(opts.issuers, "issuers"),
  });
  const bytes = u8(pdf, "pdf");
  return call(
    (api) => api.verify(bytes, o),
    (r) => r as PadesReport,
  );
}

/** PDF/CMS профайлын хувилбар (`pades-client/1`). */
export function profileVersion(): Promise<string> {
  return call(
    (api) => api.version,
    (r) => String(r),
  );
}
