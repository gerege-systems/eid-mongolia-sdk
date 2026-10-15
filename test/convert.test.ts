// /convert — орчны/оролтын алдаа, татах progress + кэшгүй fallback, worker-ийн протокол (хуурамч Worker), цуцлалт,
// хуудас/фонт/хэмжээний анхааруулга. Жинхэнэ LibreOffice-ийг scripts/convert-e2e.mjs (Chromium) шалгана.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as convert from "../dist/convert.js";

const F = new URL("./fixtures/convert/", import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, F)));
const DOCX = read("sample.docx");
const DOC = read("sample.doc");
const PDF = read("sample.pdf");
const code = (c: convert.ConvertErrorCode) => (e: unknown) => e instanceof convert.ConvertError && e.code === c;

const g = globalThis as Record<string, unknown>;
const BASE = "https://rp.example/eid-convert/";
const SIZES = { "soffice.js": 10, "soffice.wasm": 300_000, "soffice.data": 200_000, "soffice.worker.js": 10, "browser.worker.global.js": 10, "eid-convert.worker.js": 10 };
const manifest = () => ({
  format: 1,
  converter: "@matbee/libreoffice-converter",
  version: "2.7.2",
  dir: "2.7.2/",
  files: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, { bytes: v, gzip: Math.floor(v / 3) }])),
});

let fetched: string[] = [];
let workers: FakeWorker[] = [];
/** convert-д хариулахгүй (цуцлалтын тест). */
let hang = false;
let result: Uint8Array = PDF;

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private listeners = new Set<(e: { data: unknown }) => void>();
  terminated = false;
  init: Record<string, unknown> | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    workers.push(this);
    setTimeout(() => this.emit({ type: "loaded" }), 0);
  }
  addEventListener(_t: string, f: (e: { data: unknown }) => void) { this.listeners.add(f); }
  removeEventListener(_t: string, f: (e: { data: unknown }) => void) { this.listeners.delete(f); }
  private emit(data: unknown) {
    if (this.terminated) return;
    this.onmessage?.({ data });
    for (const l of [...this.listeners]) l({ data });
  }
  postMessage(msg: { type: string; id: number; inputData?: Uint8Array }) {
    setTimeout(() => {
      if (msg.type === "init") {
        this.init = msg as unknown as Record<string, unknown>;
        this.emit({ type: "progress", id: msg.id, progress: { percent: 40, message: "lok-init" } });
        this.emit({ type: "ready", id: msg.id });
      } else if (msg.type === "convert") {
        this.emit({ type: "progress", id: msg.id, progress: { percent: 50, message: "Converting..." } });
        if (!hang) this.emit({ type: "result", id: msg.id, data: result.slice() });
      } else if (msg.type === "destroy") this.emit({ type: "ready", id: msg.id });
    }, 1);
  }
  terminate() { this.terminated = true; }
}

function fakeFetch(input: string | URL, init?: { signal?: AbortSignal }): Promise<Response> {
  const url = String(input);
  fetched.push(url);
  if (url === BASE + "manifest.json") return Promise.resolve(new Response(JSON.stringify(manifest()), { headers: { "Content-Type": "application/json" } }));
  const name = url.slice((BASE + "2.7.2/").length) as keyof typeof SIZES;
  const n = SIZES[name];
  if (!n) return Promise.resolve(new Response("nope", { status: 404 }));
  // 3 chunk — progress-ийг харахын тулд.
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (init?.signal?.aborted) return ctl.error(init.signal.reason);
      const k = Math.min(Math.ceil(n / 3), n - sent);
      if (k <= 0) return ctl.close();
      sent += k;
      ctl.enqueue(new Uint8Array(k));
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
}

/** Хөтчийн Cache Storage-ийн жижиг хуурамч (Node-д алга). */
class FakeCaches {
  store = new Map<string, Map<string, { body: Uint8Array; type: string }>>();
  async open(name: string) {
    const m = this.store.get(name) ?? new Map();
    this.store.set(name, m);
    return {
      match: async (url: string) => { const e = m.get(url); return e ? new Response(e.body.slice(), { headers: { "Content-Type": e.type } }) : undefined; },
      put: async (url: string, r: Response) => { const body = new Uint8Array(await r.arrayBuffer()); m.set(url, { body, type: r.headers.get("Content-Type") ?? "" }); },
      delete: async (url: string) => m.delete(url),
    };
  }
  async keys() { return [...this.store.keys()]; }
  async delete(name: string) { return this.store.delete(name); }
}
let fakeCaches = new FakeCaches();

const saved: Record<string, unknown> = {};
beforeEach(() => {
  for (const k of ["fetch", "Worker", "window", "crossOriginIsolated", "location", "caches"]) saved[k] = g[k];
  fakeCaches = new FakeCaches();
  g.caches = fakeCaches;
  g.fetch = fakeFetch;
  g.Worker = FakeWorker;
  g.window = g;
  g.crossOriginIsolated = true;
  fetched = [];
  workers = [];
  hang = false;
  result = PDF;
});
afterEach(() => {
  convert.disposeConverter();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

test("isWordFile: өргөтгөл / File нэр / MIME", () => {
  assert.equal(convert.isWordFile("Гэрээ.DOCX"), true);
  assert.equal(convert.isWordFile("a.doc"), true);
  assert.equal(convert.isWordFile("a.pdf"), false);
  assert.equal(convert.isWordFile("a.docx.pdf"), false);
  assert.equal(convert.isWordFile(new Blob([], { type: "application/msword" })), true);
  assert.equal(convert.isWordFile(new Blob([], { type: "application/pdf" })), false);
  if (typeof File !== "undefined") {
    assert.equal(convert.isWordFile(new File([], "x.docx", { type: "application/octet-stream" })), true);
    assert.equal(convert.isWordFile(new File([], "x.txt", { type: "application/msword" })), false);
  }
});

test("орчин: Worker алга → UNSUPPORTED_ENVIRONMENT; crossOriginIsolated биш → NOT_ISOLATED (хүлээхгүй)", async () => {
  delete g.Worker;
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE }), code("UNSUPPORTED_ENVIRONMENT"));
  g.Worker = FakeWorker;
  g.crossOriginIsolated = false;
  const t = Date.now();
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE }), code("NOT_ISOLATED"));
  assert.ok(Date.now() - t < 1000);
  assert.deepEqual(fetched, []);
});

test("оролт: нэр / агуулга / хэмжээ", async () => {
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE, fileName: "a.pdf" }), code("UNSUPPORTED_FILE"));
  await assert.rejects(convert.wordToPdf(PDF, { assetsBase: BASE, fileName: "a.docx" }), code("UNSUPPORTED_FILE"));
  await assert.rejects(convert.wordToPdf(new Uint8Array(0), { assetsBase: BASE }), code("INPUT_TOO_LARGE"));
  await assert.rejects(convert.wordToPdf(new Uint8Array(convert.MAX_WORD_BYTES + 1), { assetsBase: BASE }), code("INPUT_TOO_LARGE"));
  assert.deepEqual(fetched, []);
});

test("assets: manifest 404 / буруу → ASSETS_UNAVAILABLE (retryable)", async () => {
  g.fetch = () => Promise.resolve(new Response("x", { status: 404 }));
  const e = await convert.wordToPdf(DOCX, { assetsBase: BASE }).catch((x: unknown) => x);
  assert.ok(code("ASSETS_UNAVAILABLE")(e));
  assert.equal((e as convert.ConvertError).retryable, true);
  g.fetch = () => Promise.resolve(new Response(JSON.stringify({ ...manifest(), dir: "../" })));
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE }), code("ASSETS_UNAVAILABLE"));
});

test("бүтэн урсгал: download → init → convert progress, worker-т зөв URL, хуудас/фонтын анхааруулга, worker дахин ашиглана", async () => {
  const seen: convert.WordToPdfProgress[] = [];
  const r = await convert.wordToPdf(new Blob([DOCX as BlobPart]), { assetsBase: "https://rp.example/eid-convert", fileName: "Гэрээ.docx", onProgress: (p) => seen.push(p) });
  assert.equal(r.pages, 3);
  assert.deepEqual(r.pdf, PDF);
  // Cambria (Caladea)-д кирилл байхгүй → Noto Serif fallback.
  assert.deepEqual(r.warnings.map((w) => w.code), ["FONT_FALLBACK"]);
  assert.deepEqual((r.warnings[0] as { fonts: string[] }).fonts, ["NotoSerif-Regular"]);

  const phases = [...new Set(seen.map((p) => p.phase))];
  assert.deepEqual(phases, ["download", "init", "convert"]);
  const dl = seen.filter((p) => p.phase === "download");
  assert.equal(dl[0]!.percent, 0);
  assert.equal(dl.at(-1)!.percent, 100);
  assert.equal(dl.at(-1)!.loaded, 500_000);
  assert.equal(dl.at(-1)!.total, 500_000);
  for (let i = 1; i < seen.length; i++) {
    if (seen[i]!.phase === seen[i - 1]!.phase) assert.ok(seen[i]!.percent >= seen[i - 1]!.percent, JSON.stringify(seen));
  }
  assert.equal(seen.at(-1)!.phase, "convert");
  assert.equal(seen.at(-1)!.percent, 100);

  assert.equal(workers.length, 1);
  const w = workers[0]!;
  assert.equal(w.url, BASE + "2.7.2/eid-convert.worker.js?cache=eid-convert-2.7.2");
  assert.equal(w.init!.sofficeJs, BASE + "2.7.2/soffice.js");
  assert.equal(w.init!.sofficeWorkerJs, BASE + "2.7.2/soffice.worker.js");
  assert.equal(w.init!.sofficeWasm, BASE + "2.7.2/soffice.wasm");
  assert.equal(w.init!.sofficeData, BASE + "2.7.2/soffice.data");
  const c = await fakeCaches.open("eid-convert-2.7.2");
  assert.equal((await (await c.match(BASE + "2.7.2/soffice.wasm"))!.arrayBuffer()).byteLength, 300_000);
  assert.equal((await c.match(BASE + "2.7.2/soffice.wasm"))!.headers.get("Content-Type"), "application/wasm");

  // Хоёр дахь: шинэ worker үгүй, init дахин үгүй, том файл дахин татахгүй.
  const before = fetched.length;
  const r2 = await convert.wordToPdf(DOC, { assetsBase: BASE, fileName: "a.doc" });
  assert.equal(workers.length, 1);
  assert.equal(r2.pages, 3);
  assert.deepEqual(r2.warnings, []); // .doc — фонт задлахгүй
  assert.deepEqual(fetched.slice(before), [BASE + "manifest.json"]);
});

test("converterStatus: татах хэмжээ = gzip-ийн нийлбэр; татсаны дараа cached; хуучин хувилбарын кэш устна", async () => {
  await fakeCaches.open("eid-convert-2.6.0");
  assert.deepEqual(await convert.converterStatus({ assetsBase: BASE }), { cached: false, downloadBytes: 100_000 + 66_666 });
  await convert.wordToPdf(DOCX, { assetsBase: BASE });
  assert.deepEqual(await convert.converterStatus({ assetsBase: BASE }), { cached: true, downloadBytes: 0 });
  convert.disposeConverter();
  fetched = [];
  const seen: string[] = [];
  await convert.wordToPdf(DOCX, { assetsBase: BASE, onProgress: (p) => seen.push(p.phase) });
  assert.ok(!seen.includes("download"));
  assert.deepEqual(fetched, [BASE + "manifest.json"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await fakeCaches.keys(), ["eid-convert-2.7.2"]);
});

test("Cache Storage хаалттай (private цонх): урьдчилж татахгүй, worker өөрөө татна", async () => {
  delete g.caches;
  const seen: string[] = [];
  const r = await convert.wordToPdf(DOCX, { assetsBase: BASE, onProgress: (p) => seen.push(p.phase) });
  assert.equal(r.pages, 3);
  assert.ok(!seen.includes("download"));
  assert.equal(workers[0]!.url, BASE + "2.7.2/eid-convert.worker.js");
  assert.deepEqual(await convert.converterStatus({ assetsBase: BASE }), { cached: false, downloadBytes: 100_000 + 66_666 });
});

test("татсан хэмжээ manifest-тэй таарахгүй → ASSETS_UNAVAILABLE, кэшэд үлдэхгүй", async () => {
  SIZES["soffice.data"] = 200_001;
  try {
    const orig = g.fetch as typeof fakeFetch;
    g.fetch = (u: string | URL, i?: { signal?: AbortSignal }) => String(u).endsWith("soffice.data") ? Promise.resolve(new Response(new Uint8Array(5))) : orig(u, i);
    await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE }), code("ASSETS_UNAVAILABLE"));
    const c = await fakeCaches.open("eid-convert-2.7.2");
    assert.equal(await c.match(BASE + "2.7.2/soffice.data"), undefined);
  } finally {
    SIZES["soffice.data"] = 200_000;
  }
});

test("цуцлалт: convert-ийн үеэр → AbortError, worker terminate; дараагийн дуудлага шинэ worker", async () => {
  hang = true;
  const ctl = new AbortController();
  const p = convert.wordToPdf(DOCX, {
    assetsBase: BASE,
    signal: ctl.signal,
    onProgress: (x) => { if (x.phase === "convert" && x.percent === 50) ctl.abort(); },
  });
  await assert.rejects(p, (e: unknown) => e instanceof Error && e.name === "AbortError");
  assert.equal(workers[0]!.terminated, true);
  hang = false;
  const r = await convert.wordToPdf(DOCX, { assetsBase: BASE });
  assert.equal(r.pages, 3);
  assert.equal(workers.length, 2);
});

test("цуцлалт: эхлэхээс өмнө / татах үед", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE, signal: ctl.signal }), (e: unknown) => e instanceof Error && e.name === "AbortError");
  assert.deepEqual(fetched, []);
  const c2 = new AbortController();
  const p = convert.wordToPdf(DOCX, { assetsBase: BASE, signal: c2.signal, onProgress: (x) => { if (x.phase === "download" && x.percent > 0) c2.abort(); } });
  await assert.rejects(p, (e: unknown) => e instanceof Error && e.name === "AbortError");
  assert.equal(workers.length, 0);
});

test("гаралт: PDF биш → CONVERT_FAILED", async () => {
  result = new TextEncoder().encode("not a pdf");
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE }), code("CONVERT_FAILED"));
});

test("fontWarnings / docxFonts / embeddedFonts", () => {
  const req = convert.docxFonts(DOCX);
  for (const f of ["Times New Roman", "Arial", "Calibri", "Cambria"]) assert.ok(req.includes(f), `${f} ∈ ${req}`);
  const emb = convert.embeddedFonts(PDF);
  assert.ok(emb.includes("LiberationSerif") && emb.includes("Carlito"), String(emb));
  // хэмжээ-нийцтэй орлуулагчтай фонт анхааруулахгүй; байхгүй нь FONT_SUBSTITUTED.
  assert.deepEqual(convert.fontWarnings(["Times New Roman", "Arial Mon"], ["LiberationSerif", "OpenSymbol"]).map((w) => [w.code, (w as { fonts: string[] }).fonts]), [
    ["FONT_SUBSTITUTED", ["Arial Mon"]],
  ]);
  assert.deepEqual(convert.fontWarnings([], ["NotoSerif"]), []);
});
