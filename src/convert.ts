// @gerege-systems/eid-mongolia-sdk/convert — Word (.docx / .doc) → PDF ХӨТӨЧ ДОТОР (LibreOffice WASM).
//
// Баримт сервер рүү ОЧИХГҮЙ (/pades-тэй ижил зарчим): хувиргалт иргэний хөтчийн Web Worker-т,
// `@matbee/libreoffice-converter` (MPL-2.0, LibreOffice 24.8) — optional peerDependency, зөвхөн энэ entry dynamic
// import хийдэг тул Node backend-ийн хэрэглэгчдэд 250 MB нэмэгдэхгүй. Хөтчийн шаардлага (README §3e):
//   - хуудас crossOriginIsolated (COOP same-origin + COEP require-corp) — SharedArrayBuffer (pthread);
//   - asset-ууд (`eid-mongolia-convert-assets` bin-ээр хуулсан) RP-ийн өөрийн хост дээр, worker-ийн хариу
//     `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'` CSP-тэй.
// Хувиргасан PDF-ийг иргэнд гарын үсгийн ӨМНӨ заавал харуулна — гарын үсэг Word файлд биш, энэ PDF-д.

import { MAX_INPUT_BYTES } from "./pades/limits.js";
import { inflateRaw } from "./pades/pdf/inflate.js";
import { Incremental } from "./pades/pdf/incremental.js";
import type { Value } from "./pades/pdf/reader.js";

/** Хувиргагчийн peer багц — `eid-mongolia-convert-assets`-ийн хуулсан asset-уудтай ИЖИЛ хувилбар байх ёстой. */
export const CONVERTER_PACKAGE = "@matbee/libreoffice-converter";

/** Word оролтын дээд хэмжээ (50 MiB) — WASM-ийн санах ойд багтах. */
export const MAX_WORD_BYTES = 50 << 20;

/** Хувиргасан PDF-ийн хэмжээ `/pades` `prepare`-ийн хязгаарын энэ хэсгээс хэтэрвэл `PDF_NEAR_LIMIT`. */
const NEAR_LIMIT = 0.9;

export type ConvertErrorCode =
  /** `window`/`Worker`/`WebAssembly` алга (Node, хуучин хөтөч). */
  | "UNSUPPORTED_ENVIRONMENT"
  /** Хуудас crossOriginIsolated биш — COOP/COEP толгой алга (эсвэл soft navigation-аар орсон). */
  | "NOT_ISOLATED"
  /** .docx / .doc биш (өргөтгөл эсвэл эхний байт). */
  | "UNSUPPORTED_FILE"
  /** Оролт `MAX_WORD_BYTES`-аас их эсвэл хоосон. */
  | "INPUT_TOO_LARGE"
  /** `assetsBase`-ийн manifest/asset татагдсангүй, хэмжээ таарсангүй, peer багц алга. */
  | "ASSETS_UNAVAILABLE"
  /** LibreOffice баримтыг нээж/хөрвүүлж чадсангүй (эвдэрсэн, нууц үгтэй, …). */
  | "CONVERT_FAILED";

/** /convert-ийн алдаа. Цуцлалт (`signal`) нь `DOMException` `AbortError` — энэ биш. */
export class ConvertError extends Error {
  constructor(
    readonly code: ConvertErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`);
    this.name = "ConvertError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  /** Сүлжээ/asset-ийн түр алдаа — дахин оролдох утгатай. */
  get retryable(): boolean {
    return this.code === "ASSETS_UNAVAILABLE";
  }
}

export type ConvertWarning =
  /** Баримтад заасан фонт хувиргагчид байхгүй, хэмжээ-нийцтэй орлуулагч ч алга — мөр/хуудас шилжиж болно. */
  | { code: "FONT_SUBSTITUTED"; fonts: string[]; message: string }
  /** Зарим тэмдэгтийг (ихэвчлэн кирилл) өөр фонтоор зурсан — үсгийн хэлбэр өөр харагдана. */
  | { code: "FONT_FALLBACK"; fonts: string[]; message: string }
  /** PDF гарын үсгийн хязгаарт (`/pades` `prepare`) ойрхон — баталгаажуулах хуудас нэмэгдэхэд хэтэрч болно. */
  | { code: "PDF_NEAR_LIMIT"; bytes: number; limit: number; message: string }
  /** PDF гарын үсгийн хязгаараас их — `prepare` `PDF_TOO_LARGE`-аар татгалзана. */
  | { code: "PDF_TOO_LARGE"; bytes: number; limit: number; message: string };

export interface WordToPdfProgress {
  /** download — asset-ууд (зөвхөн эхний удаа, Cache Storage-д үлдэнэ); init — LibreOffice асах; convert — хувиргалт. */
  phase: "download" | "init" | "convert";
  /** 0–100, тухайн үе шатын дотор. */
  percent: number;
  /** download: татсан байт (задарсан) — `total`-тай хамт. */
  loaded?: number;
  total?: number;
}

export interface WordToPdfOptions {
  /** `eid-mongolia-convert-assets`-ийн гаралтын хавтасны URL (`manifest.json`-той), ж: "/eid-convert/". */
  assetsBase: string;
  onProgress?: (p: WordToPdfProgress) => void;
  /** Цуцлах: татах явц зогсож, worker устана (дараагийн дуудлага шинээр асна — татсан нь кэшэд). */
  signal?: AbortSignal;
  /** Оролт `Uint8Array` бол өргөтгөл таних нэр (".docx" / ".doc"). `File` бол түүний нэр. */
  fileName?: string;
}

export interface WordToPdfResult {
  pdf: Uint8Array;
  pages: number;
  warnings: ConvertWarning[];
}

export interface ConverterStatus {
  /** Бүх asset кэшэд бий — татах шаардлагагүй. */
  cached: boolean;
  /** Татах хэмжээ (байт): manifest-ийн gzip хэмжээ (сервер шахдаг бол), эс бөгөөс задарсан. Кэштэй бол 0. */
  downloadBytes: number;
}

// ── asset manifest ────────────────────────────────────────────────────────────────────────────

/** `eid-mongolia-convert-assets`-ийн бичдэг файлууд. `eid-convert.worker.js` = SDK-ийн worker (Cache Storage shim). */
const ASSETS = ["soffice.js", "soffice.wasm", "soffice.data", "soffice.worker.js", "browser.worker.global.js", "eid-convert.worker.js"] as const;
type AssetName = (typeof ASSETS)[number];
/** Cache Storage-д (progress-той) урьдчилж татах том файлууд; worker тэднийг кэшээс уншина. */
const BIG: readonly AssetName[] = ["soffice.wasm", "soffice.data"];
const CACHE_PREFIX = "eid-convert-";

interface Manifest {
  format: 1;
  converter: string;
  version: string;
  /** asset-уудын дэд хавтас (`<version>/`) — урт кэштэй. */
  dir: string;
  files: Record<AssetName, { bytes: number; gzip?: number }>;
}

function parseManifest(v: unknown): Manifest {
  const m = v as Partial<Manifest> | null;
  if (!m || m.format !== 1 || m.converter !== CONVERTER_PACKAGE || typeof m.version !== "string" || typeof m.dir !== "string" ||
    !/^(?!\.{1,2}\/$)[A-Za-z0-9._-]+\/$/.test(m.dir) || !m.files) {
    throw new ConvertError("ASSETS_UNAVAILABLE", "manifest.json буруу — `eid-mongolia-convert-assets`-ээр дахин үүсгэ");
  }
  for (const a of ASSETS) {
    const f = m.files[a];
    if (!f || !Number.isSafeInteger(f.bytes) || f.bytes <= 0) throw new ConvertError("ASSETS_UNAVAILABLE", `manifest.json-д ${a} алга`);
  }
  return m as Manifest;
}

function base(assetsBase: string): string {
  if (typeof assetsBase !== "string" || assetsBase === "") throw new TypeError("assetsBase заавал");
  return new URL(assetsBase.endsWith("/") ? assetsBase : assetsBase + "/", globalThis.location?.href).href;
}

async function loadManifest(root: string, signal?: AbortSignal): Promise<Manifest> {
  let res: Response;
  try {
    res = await fetch(root + "manifest.json", { cache: "no-cache", signal });
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw new ConvertError("ASSETS_UNAVAILABLE", "manifest.json татагдсангүй", { cause: e });
  }
  if (!res.ok) throw new ConvertError("ASSETS_UNAVAILABLE", `manifest.json HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new ConvertError("ASSETS_UNAVAILABLE", "manifest.json JSON биш", { cause: e });
  }
  return parseManifest(json);
}

function cacheName(m: Manifest): string {
  return CACHE_PREFIX + m.version;
}

/** Cache Storage (байхгүй / хаалттай — private цонх — бол null). */
async function openCache(m: Manifest): Promise<Cache | null> {
  try {
    return globalThis.caches ? await globalThis.caches.open(cacheName(m)) : null;
  } catch {
    return null;
  }
}

/** Кэшэд бүрэн хуулбар бий эсэх: тасарсан `put` хадгалагддаггүй, хэмжээ нь татах үед шалгагдсан. */
async function has(cache: Cache | null, url: string): Promise<boolean> {
  try {
    return !!cache && !!(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * Хувиргагчийн asset кэшэд байгаа эсэх, татах хэмжээ — иргэнд (мобайл дата) татахаас ӨМНӨ хэлэхэд.
 * Сүлжээгээр зөвхөн жижиг manifest.json-ийг асууна.
 */
export async function converterStatus(opts: { assetsBase: string; signal?: AbortSignal }): Promise<ConverterStatus> {
  const root = base(opts.assetsBase);
  const m = await loadManifest(root, opts.signal);
  const cache = await openCache(m);
  let missing = 0;
  for (const a of BIG) {
    const f = m.files[a];
    if (!(await has(cache, root + m.dir + a))) missing += f.gzip ?? f.bytes;
  }
  return { cached: missing === 0, downloadBytes: missing };
}

/**
 * Том asset-уудыг (progress-той) Cache Storage-д татна; worker (`eid-convert.worker.js`) тэднийг `fetch`-ээр кэшээс
 * авна. Blob URL биш: WebKit 147 MB-ийн (wasm) кэшийн blob-ийг worker-т уншиж чаддаггүй (2026-10-15 шалгасан), HTTP
 * кэш ч ийм том файлыг (Firefox 50 MB) хадгалдаггүй. Кэш хаалттай бол null — worker өөрөө (progress-гүй) татна. Хуучин хувилбарын кэшийг устгана.
 */
async function prefetch(root: string, m: Manifest, onProgress: ((p: WordToPdfProgress) => void) | undefined, signal?: AbortSignal): Promise<string | null> {
  const cache = await openCache(m);
  if (!cache) return null;
  const total = BIG.reduce((s, a) => s + m.files[a].bytes, 0);
  const need: AssetName[] = [];
  let loaded = 0;
  for (const a of BIG) {
    if (await has(cache, root + m.dir + a)) loaded += m.files[a].bytes;
    else need.push(a);
  }
  if (need.length === 0) return cacheName(m);
  const report = () => onProgress?.({ phase: "download", percent: Math.min(100, Math.floor((loaded * 100) / total)), loaded, total });
  report();
  for (const a of need) {
    const url = root + m.dir + a;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      throw new ConvertError("ASSETS_UNAVAILABLE", `${a} татагдсангүй`, { cause: e });
    }
    if (!res.ok || !res.body) throw new ConvertError("ASSETS_UNAVAILABLE", `${a} HTTP ${res.status}`);
    let last = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          loaded += chunk.byteLength;
          const now = Date.now();
          if (now - last > 100) {
            last = now;
            report();
          }
          ctl.enqueue(chunk);
        },
      }),
    );
    const type = a.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    try {
      // Санах ойд барихгүй: stream шууд кэш рүү. Тасарвал put reject — бичлэг үүсэхгүй.
      await cache.put(url, new Response(counted, { headers: { "Content-Type": type } }));
      const size = (await (await cache.match(url))?.blob())?.size;
      if (size !== m.files[a].bytes) {
        await cache.delete(url);
        throw new ConvertError("ASSETS_UNAVAILABLE", `${a}: хэмжээ manifest-тэй таарсангүй (${size ?? 0} ≠ ${m.files[a].bytes})`);
      }
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      if (e instanceof ConvertError) throw e;
      throw new ConvertError("ASSETS_UNAVAILABLE", `${a} татах явц тасарлаа`, { cause: e });
    }
    report();
  }
  void dropOldCaches(m);
  return cacheName(m);
}

async function dropOldCaches(m: Manifest): Promise<void> {
  try {
    for (const k of await globalThis.caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== cacheName(m)) await globalThis.caches.delete(k);
  } catch {
    // заавал биш
  }
}

// ── converter (нэг worker, дахин ашиглана) ────────────────────────────────────────────────────

interface Converter {
  initialize(): Promise<void>;
  convert(input: Uint8Array, options: { outputFormat: "pdf" }, filename?: string): Promise<{ data: Uint8Array }>;
  destroy(): Promise<void>;
}
type ConverterModule = {
  WorkerBrowserConverter: new (opts: Record<string, unknown>) => Converter;
};

interface Live {
  key: string;
  conv: Converter;
  /** Одоогийн дуудлагын progress (init/convert-ийн worker мэдэгдэл). */
  sink: ((p: { percent: number }) => void) | null;
}

let live: Live | null = null;
let starting: Promise<Live> | null = null;
/** LibreOffice re-entrant биш — дуудлагууд дараалалд. */
let queue: Promise<unknown> = Promise.resolve();

/** Worker-ийг шууд зогсооно (`destroy()` нь завгүй worker-ийн хариуг хүлээдэг тул биш). */
function kill(l: Live): void {
  const w = (l.conv as unknown as { worker?: { terminate(): void } | null }).worker;
  try {
    w?.terminate();
  } catch {
    // аль хэдийн зогссон
  }
  if (live === l) live = null;
}

/** Хувиргагчийн worker-ийг зогсоож санах ойг чөлөөлнө (кэшийн asset-ууд үлдэнэ). Дараагийн `wordToPdf` дахин асаана. */
export function disposeConverter(): void {
  if (live) kill(live);
  starting = null;
}

async function start(opts: WordToPdfOptions, signal?: AbortSignal): Promise<Live> {
  const root = base(opts.assetsBase);
  const m = await loadManifest(root, signal);
  const key = root + m.dir;
  if (live && live.key === key) return live;
  if (live) kill(live);
  let mod: ConverterModule;
  try {
    mod = (await import("@matbee/libreoffice-converter/browser")) as unknown as ConverterModule;
  } catch (e) {
    throw new ConvertError("ASSETS_UNAVAILABLE", `${CONVERTER_PACKAGE} суугаагүй (optional peerDependency)`, { cause: e });
  }
  const cache = await prefetch(root, m, opts.onProgress, signal);
  const l: Live = { key, conv: null as unknown as Converter, sink: null };
  l.conv = new mod.WorkerBrowserConverter({
    sofficeJs: key + "soffice.js",
    sofficeWasm: key + "soffice.wasm",
    sofficeData: key + "soffice.data",
    sofficeWorkerJs: key + "soffice.worker.js",
    browserWorkerJs: key + "eid-convert.worker.js" + (cache ? "?cache=" + encodeURIComponent(cache) : ""),
    onProgress: (p: { percent: number }) => l.sink?.(p),
  });
  live = l;
  return l;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Цуцлагдсан", "AbortError");
}

/** `work`-ийг `signal`-аар тасалж болох болгоно; тасарвал `onAbort` (worker устгах). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      onAbort();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

// ── оролт ───────────────────────────────────────────────────────────────────────────────────

const WORD_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

/** .docx / .doc эсэх — нэр (өргөтгөл) эсвэл `File`/`Blob`-ийн нэр, MIME-ээр. Агуулгыг `wordToPdf` эхний байтаар дахин шалгана. */
export function isWordFile(file: Blob | File | string): boolean {
  if (typeof file === "string") return /\.(docx|doc)$/i.test(file.trim());
  const name = (file as File).name;
  if (typeof name === "string" && name !== "") return /\.(docx|doc)$/i.test(name.trim());
  return WORD_MIME.has(file.type);
}

type Kind = "docx" | "doc";

function sniff(b: Uint8Array): Kind | null {
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "docx";
  if (b.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((x, i) => b[i] === x)) return "doc";
  return null;
}

// ── гаралт: хуудас, фонт ─────────────────────────────────────────────────────────────────────

/** PDF-ийн хуудасны тоо — `/pades`-ийн ижил parser-аар (энэ нь гаралт `prepare`-д уншигдахыг ч баталгаажуулна). */
function pageCount(pdf: Uint8Array): number {
  const inc = new Incremental(pdf);
  let n = 0;
  const walk = (v: Value, depth: number): void => {
    if (depth > 32 || n > 1 << 16) return;
    const t = v.key("Type").name();
    if (t === "Page") n++;
    else if (t === "Pages") {
      const kids = v.key("Kids");
      for (let i = 0; i < kids.len(); i++) walk(kids.index(i), depth + 1);
    }
  };
  walk(inc.root().key("Pages"), 0);
  return n;
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

/** PDF-д шигтгэсэн фонтын нэрс (subset угтваргүй). LibreOffice object stream хэрэглэдэггүй тул /BaseFont шууд харагдана. */
export function embeddedFonts(pdf: Uint8Array): string[] {
  const out = new Set<string>();
  for (const m of latin1(pdf).matchAll(/\/BaseFont\s*\/([^\s/<>[\]()%]+)/g)) {
    const name = m[1]!.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/^[A-Z]{6}\+/, "");
    out.add(name);
  }
  return [...out];
}

/** Microsoft-ын фонт → LibreOffice-д буй хэмжээ-нийцтэй (metric-compatible) орлуулагч: мөр, хуудас шилжихгүй. */
const METRIC_ALIASES: Record<string, string> = {
  timesnewroman: "liberationserif",
  arial: "liberationsans",
  helvetica: "liberationsans",
  couriernew: "liberationmono",
  calibri: "carlito",
  cambria: "caladea",
};
/** Тэмдэгтийн (bullet, тэмдэг) фонт — fallback гэж тооцохгүй. */
const SYMBOL_FONTS = ["opensymbol", "symbol", "wingdings"];

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Хүссэн фонт ↔ шигтгэсэн фонтоор анхааруулга (docx-ийн heuristic: баримтын run/docDefaults/хэрэглэсэн style-ийн фонт). */
export function fontWarnings(requested: string[], embedded: string[]): ConvertWarning[] {
  const emb = embedded.map(norm);
  const explained = new Set<number>();
  const missing: string[] = [];
  for (const r of requested) {
    const n = norm(r);
    if (n === "") continue;
    const alias = METRIC_ALIASES[n];
    let ok = false;
    emb.forEach((e, i) => {
      if (e.startsWith(n) || (alias && e.startsWith(alias))) {
        ok = true;
        explained.add(i);
      }
    });
    if (!ok) missing.push(r);
  }
  const fallback = embedded.filter((_, i) => !explained.has(i) && !SYMBOL_FONTS.some((s) => emb[i]!.startsWith(s)));
  const out: ConvertWarning[] = [];
  if (missing.length) {
    out.push({ code: "FONT_SUBSTITUTED", fonts: missing, message: `Хувиргагчид байхгүй фонт: ${missing.join(", ")} — өөр фонтоор, мөр/хуудас шилжсэн байж болно` });
  }
  if (fallback.length && requested.length) {
    out.push({ code: "FONT_FALLBACK", fonts: fallback, message: `Зарим тэмдэгтийг өөр фонтоор зурсан: ${fallback.join(", ")}` });
  }
  return out;
}

// docx = ZIP. Зөвхөн хэрэгтэй хэдэн XML-ийг central directory-оос уншина (stored / deflate).
function zipEntries(b: Uint8Array, want: (name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= b.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!want(name) || usize > 16 << 20 || local + 30 > b.length || dv.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(start, start + csize);
    try {
      if (method === 0) out.set(name, dec.decode(data));
      else if (method === 8) out.set(name, dec.decode(inflateRaw(data, 16 << 20)));
    } catch {
      // эвдэрсэн entry — анхааруулгагүй үлдэнэ
    }
  }
  return out;
}

const RFONT_ATTR = /\bw:(ascii|hAnsi|cs|eastAsia)(Theme)?="([^"]+)"/g;

function rFonts(xml: string, theme: { major?: string; minor?: string }, into: Set<string>): void {
  for (const tag of xml.matchAll(/<w:rFonts\b([^>]*)\/?>/g)) {
    for (const a of tag[1]!.matchAll(RFONT_ATTR)) {
      if (a[2]) {
        const t = a[3]!.startsWith("major") ? theme.major : theme.minor;
        if (t) into.add(t);
      } else into.add(a[3]!);
    }
  }
}

/** docx-д заасан (хэрэглэгдэж буй) фонтууд. */
export function docxFonts(docx: Uint8Array): string[] {
  const files = zipEntries(docx, (n) => /^word\/(document|styles|header\d*|footer\d*)\.xml$|^word\/theme\/theme1\.xml$/.test(n));
  const themeXml = files.get("word/theme/theme1.xml") ?? "";
  const face = (tag: string) => new RegExp(`<a:${tag}>[\\s\\S]*?<a:latin\\s+typeface="([^"]*)"`).exec(themeXml)?.[1] || undefined;
  const theme = { major: face("majorFont"), minor: face("minorFont") };
  const fonts = new Set<string>();
  const body = [...files].filter(([n]) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)).map(([, x]) => x).join("\n");
  rFonts(body, theme, fonts);
  const styles = files.get("word/styles.xml") ?? "";
  const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)?.[0] ?? "";
  rFonts(defaults, theme, fonts);
  // Хэрэглэгдсэн style (pStyle/rStyle/tblStyle + анхдагч paragraph style) ба тэдгээрийн basedOn гинж.
  const byId = new Map<string, string>();
  for (const s of styles.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g)) byId.set(s[1]!, s[0]);
  const used = new Set<string>();
  for (const u of body.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\s+w:val="([^"]+)"/g)) used.add(u[1]!);
  for (const s of styles.matchAll(/<w:style\b[^>]*\bw:type="paragraph"[^>]*\bw:default="1"[^>]*\bw:styleId="([^"]+)"|<w:style\b[^>]*\bw:default="1"[^>]*\bw:type="paragraph"[^>]*\bw:styleId="([^"]+)"/g)) {
    used.add((s[1] ?? s[2])!);
  }
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || depth > 16) return;
    seen.add(id);
    const xml = byId.get(id);
    if (!xml) return;
    rFonts(xml, theme, fonts);
    const based = /<w:basedOn\s+w:val="([^"]+)"/.exec(xml)?.[1];
    if (based) visit(based, depth + 1);
  };
  for (const id of used) visit(id, 0);
  return [...fonts];
}

function sizeWarnings(bytes: number): ConvertWarning[] {
  const limit = MAX_INPUT_BYTES;
  const mb = (n: number) => (n / (1 << 20)).toFixed(2);
  if (bytes > limit) return [{ code: "PDF_TOO_LARGE", bytes, limit, message: `PDF ${mb(bytes)} MB — гарын үсгийн хязгаар ${mb(limit)} MB` }];
  if (bytes > limit * NEAR_LIMIT) return [{ code: "PDF_NEAR_LIMIT", bytes, limit, message: `PDF ${mb(bytes)} MB — гарын үсгийн хязгаарт (${mb(limit)} MB) ойрхон` }];
  return [];
}

// ── үндсэн функц ─────────────────────────────────────────────────────────────────────────────

/**
 * Word (.docx / .doc) баримтыг ХӨТӨЧ ДОТОР PDF болгоно. Файл хаашаа ч илгээгдэхгүй.
 *
 * Эхний удаа ~250 MB (gzip ~77 MB) asset-ийг `assetsBase`-ээс татаж Cache Storage-д хадгална (`converterStatus`-аар
 * урьдчилж мэд); дараагийн дуудлагууд нэг worker-ийг дахин ашиглана. Үр дүнг иргэнд ХАРУУЛЖ, зөвшөөрүүлсний дараа л
 * `/pades` `prepare`-д өг — хувиргалтад загвар (фонт, мөр, хуудас) өөрчлөгдөж болно (`warnings`).
 *
 * @throws {ConvertError} UNSUPPORTED_ENVIRONMENT / NOT_ISOLATED / UNSUPPORTED_FILE / INPUT_TOO_LARGE / ASSETS_UNAVAILABLE / CONVERT_FAILED
 * @throws {DOMException} `AbortError` — `signal` цуцлагдвал.
 */
export async function wordToPdf(file: Blob | Uint8Array, opts: WordToPdfOptions): Promise<WordToPdfResult> {
  const signal = opts.signal;
  if (signal?.aborted) throw abortError(signal);
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined" || typeof window === "undefined") {
    throw new ConvertError("UNSUPPORTED_ENVIRONMENT", "зөвхөн хөтөч (Worker + WebAssembly)");
  }
  if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer === "undefined") {
    throw new ConvertError("NOT_ISOLATED", "хуудас crossOriginIsolated биш — COOP: same-origin, COEP: require-corp толгой хэрэгтэй (hard navigation)");
  }
  const name = opts.fileName ?? (file instanceof Blob ? (file as File).name : undefined) ?? "";
  if (name !== "" && !isWordFile(name)) throw new ConvertError("UNSUPPORTED_FILE", ".docx эсвэл .doc биш");
  const size = file instanceof Blob ? file.size : file.byteLength;
  if (size === 0 || size > MAX_WORD_BYTES) throw new ConvertError("INPUT_TOO_LARGE", `Word файл 1 байт – ${MAX_WORD_BYTES >> 20} MB байх ёстой`);
  const bytes = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(file);
  const kind = sniff(bytes);
  if (!kind) throw new ConvertError("UNSUPPORTED_FILE", ".docx эсвэл .doc биш (агуулга)");

  const run = async (): Promise<WordToPdfResult> => {
    let l: Live | null = null;
    const onAbort = () => {
      if (l) kill(l);
      else disposeConverter();
    };
    try {
      starting ??= start(opts, signal);
      l = await abortable(starting, signal, () => {});
    } catch (e) {
      starting = null;
      throw e;
    }
    starting = null;
    const cur = l;
    try {
      cur.sink = (p) => opts.onProgress?.({ phase: "init", percent: clamp(p.percent) });
      opts.onProgress?.({ phase: "init", percent: 0 });
      await abortable(cur.conv.initialize(), signal, onAbort);
      opts.onProgress?.({ phase: "init", percent: 100 });
      cur.sink = (p) => opts.onProgress?.({ phase: "convert", percent: clamp(p.percent) });
      opts.onProgress?.({ phase: "convert", percent: 0 });
      // worker оролтын buffer-ийг transfer хийдэг — хуулбар өгнө.
      const out = await abortable(cur.conv.convert(bytes.slice(), { outputFormat: "pdf" }, `document.${kind}`), signal, onAbort);
      const pdf = out.data instanceof Uint8Array ? out.data : new Uint8Array(out.data as ArrayBuffer);
      let pages: number;
      try {
        pages = pageCount(pdf);
      } catch (e) {
        throw new ConvertError("CONVERT_FAILED", "хувиргасан PDF уншигдсангүй", { cause: e });
      }
      if (pages === 0) throw new ConvertError("CONVERT_FAILED", "хувиргасан PDF хоосон");
      const warnings = [...sizeWarnings(pdf.length), ...(kind === "docx" ? fontWarnings(docxFonts(bytes), embeddedFonts(pdf)) : [])];
      opts.onProgress?.({ phase: "convert", percent: 100 });
      return { pdf, pages, warnings };
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      if (e instanceof ConvertError) throw e;
      // LibreOffice-ийн алдааны текст (LOAD_FAILED …) — нууц үгтэй/эвдэрсэн баримт ч энд.
      throw new ConvertError("CONVERT_FAILED", "LibreOffice баримтыг хувиргасангүй", { cause: e });
    } finally {
      cur.sink = null;
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}
