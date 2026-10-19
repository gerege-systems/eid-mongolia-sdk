// /convert — орчны/оролтын алдаа, татах progress + кэшгүй fallback, worker-ийн протокол (хуурамч Worker), цуцлалт,
// хуудас/фонт/хэмжээний анхааруулга. Жинхэнэ LibreOffice-ийг scripts/convert-e2e.mjs (Chromium) шалгана.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

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

test("verbose: worker URL-д rev/verbose, init-д verbose; утга солигдвол worker дахин асна", async () => {
  const orig = g.fetch as typeof fakeFetch;
  g.fetch = (u: string | URL, i?: { signal?: AbortSignal }) =>
    String(u) === BASE + "manifest.json" ? Promise.resolve(new Response(JSON.stringify({ ...manifest(), rev: "0123456789abcdef" }))) : orig(u, i);
  await convert.wordToPdf(DOCX, { assetsBase: BASE });
  assert.equal(workers[0]!.url, BASE + "2.7.2/eid-convert.worker.js?cache=eid-convert-2.7.2&v=0123456789abcdef");
  assert.equal(workers[0]!.init!.verbose, false);
  await convert.wordToPdf(DOCX, { assetsBase: BASE, verbose: true });
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.terminated, true);
  assert.equal(workers[1]!.url, BASE + "2.7.2/eid-convert.worker.js?cache=eid-convert-2.7.2&v=0123456789abcdef&verbose=1");
  assert.equal(workers[1]!.init!.verbose, true);
  await convert.wordToPdf(DOCX, { assetsBase: BASE, verbose: true });
  assert.equal(workers.length, 2);
  g.fetch = () => Promise.resolve(new Response(JSON.stringify({ ...manifest(), rev: "../x" })));
  convert.disposeConverter();
  await assert.rejects(convert.wordToPdf(DOCX, { assetsBase: BASE }), code("ASSETS_UNAVAILABLE"));
});

// ── eid-mongolia-convert-assets: лог чимээгүй болгох patch ─────────────────────────────────────

const BIN = new URL("../bin/convert-assets.mjs", import.meta.url).pathname;
const UPSTREAM = new URL("../node_modules/@matbee/libreoffice-converter/", import.meta.url).pathname;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// brotli 11 soffice.wasm-д минутууд — тестэд чанар хамаагүй (.br-ийн агуулгыг convert-e2e шалгана).
const binEnv = { ...process.env, EID_CONVERT_BROTLI_QUALITY: "1" };

function runBin(cwd: string, out: string) {
  const r = spawnSync(process.execPath, [BIN, out], { cwd, encoding: "utf8", env: binEnv });
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  return { ...r, m, dir: join(out, m.dir), worker: readFileSync(join(out, m.dir, "browser.worker.global.js")), soffice: readFileSync(join(out, m.dir, "soffice.js")) };
}

/** soffice.js-ийн file_packager хүснэгт (Emscripten): мөрүүд, remote_package_size, хүснэгтийг хассан үлдэгдэл. */
function packageTable(js: string) {
  assert.equal(js.split("loadPackage({files:[").length, 2);
  assert.equal(js.split("remote_package_size:").length, 2);
  const m = /loadPackage\(\{files:\[(.*?)\],remote_package_size:(\d+)\}/s.exec(js);
  assert.ok(m);
  const entries = [...m[1].matchAll(/\{filename:"([^"]*)",start:(\d+(?:e\d+)?),end:(\d+(?:e\d+)?)\}/g)].map((e) => ({ name: e[1], start: Number(e[2]), end: Number(e[3]) }));
  assert.equal(entries.length, m[1].split("{filename:").length - 1);
  return { entries, size: Number(m[2]), rest: js.replace(m[0], "") };
}

test("convert-assets: мэдэгдэж буй upstream → patch («+ALL» үгүй, print/printErr verbose-оор), manifest хэмжээ/rev таарна", () => {
  const out = mkdtempSync(join(tmpdir(), "eid-assets-"));
  try {
    const r = runBin(new URL("..", import.meta.url).pathname, out);
    assert.equal(r.status, 0, r.stderr);
    const w = r.worker.toString("utf8");
    assert.ok(!w.includes('"+ALL"'));
    assert.ok(w.includes("print:self.EID_CONVERT_VERBOSE?console.log:()=>{},printErr:self.EID_CONVERT_VERBOSE?console.error:()=>{}}"));
    assert.ok(!w.includes("print:console.log,printErr:console.error"));
    assert.ok(w.includes('a.ENV.SAL_LOG="-WARN-INFO"'));
    assert.equal(r.m.patched, true);
    assert.match(r.m.rev, /^[0-9a-f]{16}$/);
    // manifest-ийн хэмжээ = үйлчлэх (patch-тай) файлынх — wordToPdf-ийн ASSETS_UNAVAILABLE шалгалттай нийцнэ.
    assert.equal(r.m.files["browser.worker.global.js"].bytes, r.worker.length);
    assert.notEqual(r.worker.length, readFileSync(join(UPSTREAM, "dist/browser.worker.global.js")).length);
    assert.match(r.stdout, /лог чимээгүй/);
    // pthreadPoolSize 4 → 8 (удаан CPU-ийн documentLoad deadlock) ба soffice.data-ийн хүснэгт — өөр солилтгүй.
    const so = r.soffice.toString("utf8");
    const up = readFileSync(join(UPSTREAM, "wasm/soffice.js"), "utf8");
    assert.equal(so.split("var pthreadPoolSize=8;").length, 2);
    assert.ok(!so.includes("var pthreadPoolSize=4;"));
    const t = packageTable(so);
    const u = packageTable(up);
    assert.equal(t.rest, u.rest.replace("var pthreadPoolSize=4;", "var pthreadPoolSize=8;"));
    assert.equal(r.m.pthreadPoolSize, 8);
    assert.equal(r.m.files["soffice.js"].bytes, r.soffice.length);
    // Хавтас = хувилбар + soffice.js hash (хүснэгт солигдвол immutable URL ч солигдоно).
    assert.equal(r.m.dir, `2.7.2-${sha(r.soffice).slice(0, 12)}/`);

    // soffice.data: offset тасралтгүй, нийлбэр = remote_package_size = файл = manifest; хассан зүйл үлдээгүй.
    let pos = 0;
    for (const e of t.entries) {
      assert.equal(e.start, pos, e.name);
      pos = e.end;
    }
    const dataSize = statSync(join(r.dir, "soffice.data")).size;
    assert.equal(pos, t.size);
    assert.equal(t.size, dataSize);
    assert.equal(r.m.files["soffice.data"].bytes, dataSize);
    assert.equal(dataSize, 43_164_000);
    const names = t.entries.map((e) => e.name);
    for (const re of [/LinLibertine|LinBiolinum|Amiri|Scheherazade|NotoSansArabic|NotoSerifHebrew|NotoSansGeorgian/, /images_colibre\.zip$/, /\/share\/gallery\//,
      /\/soffice\.cfg\/modules\/(scalc|simpress|sdraw|smath)\//, /\/intro\.png$/, /^\/android\//]) {
      assert.deepEqual(names.filter((n) => re.test(n)), [], String(re));
    }
    assert.equal(names.filter((n) => n.endsWith("/opens___.ttf")).length, 1);
    // Заавал үлдэх: бүх registry/*.xcd (math.xcd — OMML томьёо), NotoSans/NotoSerif Латин-Кирилл (Ө Ү).
    const must = u.entries.map((e) => e.name).filter((n) => /\/registry\/[^/]+\.xcd$|\/Noto(Sans|Serif)-[^/]+$/.test(n));
    assert.ok(must.some((n) => n.endsWith("/registry/math.xcd")));
    assert.deepEqual(must.filter((n) => !names.includes(n)), []);
    // .br / .gz файл бүрийн хажууд, manifest-д хэмжээтэй.
    for (const [name, f] of Object.entries(r.m.files as Record<string, { bytes: number; gzip: number; br: number }>)) {
      assert.equal(statSync(join(r.dir, name + ".br")).size, f.br, name);
      assert.equal(statSync(join(r.dir, name + ".gz")).size, f.gzip, name);
    }
    assert.deepEqual(readdirSync(out).sort(), [r.m.dir.slice(0, -1), "manifest.json"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("convert-assets: upstream hash таарахгүй → patch-гүй хуулж анхааруулна, build унахгүй; rev өөр", () => {
  const proj = mkdtempSync(join(tmpdir(), "eid-assets-proj-"));
  try {
    const pkg = join(proj, "node_modules/@matbee/libreoffice-converter");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "wasm"), { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@matbee/libreoffice-converter", version: "2.7.2", license: "MPL-2.0" }));
    writeFileSync(join(pkg, "wasm/soffice.worker.js"), "x");
    // soffice.data-г хасахад жинхэнэ 2.7.2 хэрэгтэй (sha256) — хуулахгүй, холбоос.
    for (const f of ["soffice.wasm", "soffice.data"]) symlinkSync(join(UPSTREAM, "wasm", f), join(pkg, "wasm", f));
    copyFileSync(join(UPSTREAM, "wasm/soffice.js"), join(pkg, "wasm/soffice.js"));
    const changed = Buffer.from('a.ENV.SAL_LOG="+ALL";print:console.log,printErr:console.error}//өөр build');
    writeFileSync(join(pkg, "dist/browser.worker.global.js"), changed);
    const out = join(proj, "out");
    const r = runBin(proj, out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /анхааруулга: .*sha256/);
    assert.equal(sha(r.worker), sha(changed));
    assert.equal(r.m.patched, false);
    assert.equal(r.m.files["browser.worker.global.js"].bytes, changed.length);

    // Жинхэнэ 2.7.2 файл → hash таарч patch хийгдэнэ; worker-ийн агуулга өөр тул rev өөр (immutable кэш шинэчлэгдэнэ).
    copyFileSync(join(UPSTREAM, "dist/browser.worker.global.js"), join(pkg, "dist/browser.worker.global.js"));
    const r2 = runBin(proj, out);
    assert.equal(r2.m.patched, true);
    assert.notEqual(r2.m.rev, r.m.rev);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("convert-assets: soffice.js hash таарахгүй → pthreadPoolSize patch-гүй тул build унана (exit 1)", () => {
  const proj = mkdtempSync(join(tmpdir(), "eid-assets-proj-"));
  try {
    const pkg = join(proj, "node_modules/@matbee/libreoffice-converter");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "wasm"), { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@matbee/libreoffice-converter", version: "2.7.2", license: "MPL-2.0" }));
    for (const f of ["soffice.wasm", "soffice.data", "soffice.worker.js"]) writeFileSync(join(pkg, "wasm", f), "x");
    writeFileSync(join(pkg, "wasm/soffice.js"), "var pthreadPoolSize=4;//өөр build");
    copyFileSync(join(UPSTREAM, "dist/browser.worker.global.js"), join(pkg, "dist/browser.worker.global.js"));
    const r = spawnSync(process.execPath, [BIN, join(proj, "out")], { cwd: proj, encoding: "utf8", env: binEnv });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pthreadPoolSize/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("convert-assets: soffice.data hash таарахгүй → offset тодорхойгүй тул build унана (exit 1)", () => {
  const proj = mkdtempSync(join(tmpdir(), "eid-assets-proj-"));
  try {
    const pkg = join(proj, "node_modules/@matbee/libreoffice-converter");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "wasm"), { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@matbee/libreoffice-converter", version: "2.7.2", license: "MPL-2.0" }));
    for (const f of ["soffice.wasm", "soffice.data", "soffice.worker.js"]) writeFileSync(join(pkg, "wasm", f), "x");
    copyFileSync(join(UPSTREAM, "wasm/soffice.js"), join(pkg, "wasm/soffice.js"));
    copyFileSync(join(UPSTREAM, "dist/browser.worker.global.js"), join(pkg, "dist/browser.worker.global.js"));
    const r = spawnSync(process.execPath, [BIN, join(proj, "out")], { cwd: proj, encoding: "utf8", env: binEnv });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /soffice\.data sha256 .*зогсов/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("eid-convert.worker.js: verbose-гүй бол console.log/info/debug чимээгүй (error үлдэнэ), ?verbose=1 бол хэвээр; ?v= дамжина", () => {
  const src = readFileSync(new URL("../bin/eid-convert.worker.js", import.meta.url), "utf8");
  const run = (query: string) => {
    const logged: string[] = [];
    const con = { log: () => logged.push("log"), info: () => logged.push("info"), debug: () => logged.push("debug"), error: () => logged.push("error"), warn: () => logged.push("warn") };
    const imported: string[] = [];
    const self: Record<string, unknown> = { location: { href: "https://rp.example/eid-convert/2.7.2/eid-convert.worker.js" + query }, console: con, fetch: () => {} };
    vm.runInNewContext(src, { self, URL, importScripts: (u: string) => imported.push(u) });
    const c = self.console as typeof con;
    c.log(); c.info(); c.debug(); c.error(); c.warn();
    return { logged, imported, verbose: self.EID_CONVERT_VERBOSE };
  };
  const quiet = run("?v=abcdef0123456789");
  assert.deepEqual(quiet.logged, ["error", "warn"]);
  assert.equal(quiet.verbose, false);
  assert.deepEqual(quiet.imported, ["browser.worker.global.js?v=abcdef0123456789"]);
  const loud = run("?verbose=1");
  assert.deepEqual(loud.logged, ["log", "info", "debug", "error", "warn"]);
  assert.equal(loud.verbose, true);
  assert.deepEqual(loud.imported, ["browser.worker.global.js"]);
});
