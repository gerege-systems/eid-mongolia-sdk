#!/usr/bin/env node
// /convert-ийн жинхэнэ шалгалт Chromium-д: RP-ийн хэв маяг (хуудас — nonce + 'strict-dynamic' CSP, COOP/COEP;
// asset-ууд — eid-mongolia-convert-assets, worker-ийн өөрийн CSP, .br/.gz-г nginx brotli_static/gzip_static шиг) →
// test/fixtures/convert/sample.docx, .doc, rich.docx → PDF → /pades prepare (Node, golden PKI). Мөн: soffice.data-ийн
// хасалтын хүснэгт, .br/.gz-ийн агуулга, кэштэй хоёр дахь удаа татахгүй, цуцлалт, COEP-гүй хуудас NOT_ISOLATED.
// Урьдчилан `npm run build`; Playwright Chromium (`npx playwright install chromium-headless-shell`); BROWSER=webkit — WebKit.
//
//   node scripts/convert-e2e.mjs
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { X509Certificate } from "node:crypto";
import { chromium, webkit } from "playwright";

import * as pades from "../dist/pades.js";

const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "eid-convert-e2e-"));
const NONCE = "ZTJlLXRlc3Q=";
// README §3e-ийн утгууд.
const PAGE_CSP = `default-src 'self'; script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'`;
const WORKER_CSP = process.env.WORKER_CSP ?? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'";

let failed = 0;
// Гацвал CI-г цагаар биш, тодорхой алдаагаар унагана.
setTimeout(() => { console.error("FAIL 10 минутад дууссангүй"); process.exit(1); }, 10 * 60_000).unref();
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

/** soffice.js-ийн file_packager хүснэгт ба remote_package_size. */
function packageTable(js) {
  const one = js.split("loadPackage({files:[").length === 2 && js.split("remote_package_size:").length === 2;
  const m = /loadPackage\(\{files:\[(.*?)\],remote_package_size:(\d+)\}/s.exec(js);
  if (!one || !m) return null;
  const entries = [...m[1].matchAll(/\{filename:"([^"]*)",start:(\d+(?:e\d+)?),end:(\d+(?:e\d+)?)\}/g)].map((e) => ({ name: e[1], start: Number(e[2]), end: Number(e[3]) }));
  return { entries, size: Number(m[2]), count: m[1].split("{filename:").length - 1 };
}

/** convert-assets-ийн гаралт: хасалтын хүснэгт тууштай, хассан зүйл үлдээгүй, үлдсэн нь upstream-тэй байт-ижил, .br/.gz зөв. */
function checkAssets(out) {
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  const d = join(out, m.dir);
  check(/^\d+\.\d+\.\d+-[0-9a-f]{12}\/$/.test(m.dir), `manifest dir ${m.dir} (хувилбар + soffice.js hash)`);
  const up = join(root, "node_modules/@matbee/libreoffice-converter/wasm/");
  const t = packageTable(readFileSync(join(d, "soffice.js"), "utf8"));
  const u = packageTable(readFileSync(up + "soffice.js", "utf8"));
  if (!t || !u) return check(false, "soffice.js: loadPackage/remote_package_size яг нэг биш");
  check(t.entries.length === t.count && u.entries.length === u.count, `хүснэгт бүрэн танигдсан (${t.count}/${u.count})`);
  let pos = 0;
  for (const e of t.entries) if (e.start === pos && e.end >= e.start) pos = e.end; else pos = NaN;
  const data = readFileSync(join(d, "soffice.data"));
  check(pos === t.size && t.size === data.length && t.size === m.files["soffice.data"].bytes,
    `soffice.data: offset тасралтгүй, нийлбэр ${pos} = remote_package_size ${t.size} = файл ${data.length} = manifest ${m.files["soffice.data"].bytes}`);
  // Хасах ёстой ангилал бүр (bin/convert-assets.mjs-ийн DATA_TRIM-ээс үл хамааран бичсэн).
  const DROPPED = [/\/LinLibertine/, /\/LinBiolinum/, /\/Amiri/, /\/Scheherazade/, /\/Noto(Sans|Serif|Kufi|Naskh)(Arabic|Hebrew|Armenian|Georgian|Lao|Lisu)/,
    /\/DejaVuSans-ExtraLight/, /Condensed/, /\/soffice\.cfg\/modules\/(scalc|simpress|sdraw|smath|schart|sglobal)\//, /\/soffice\.cfg\/simpress\//,
    /\/intro\.png$/, /\/shell\/about\.svg$/, /^\/android\//, /images_colibre\.zip$/, /\/share\/gallery\//];
  const names = t.entries.map((e) => e.name);
  const left = names.filter((n) => DROPPED.some((re) => re.test(n)));
  check(left.length === 0 && names.filter((n) => n.endsWith("/opens___.ttf")).length === 1, `хассан файл үлдээгүй, opens___.ttf нэг${left.length ? ": " + left.slice(0, 5).join(" ") : ""}`);
  // Заавал үлдэх: registry/*.xcd бүгд (math.xcd — OMML томьёо), NotoSans/NotoSerif Латин-Кирилл (Ө Ү).
  const must = u.entries.map((e) => e.name).filter((n) => /\/registry\/[^/]+\.xcd$|\/Noto(Sans|Serif)-[^/]+$/.test(n));
  const missing = must.filter((n) => !names.includes(n));
  check(must.length > 20 && missing.length === 0, `registry/*.xcd ба Noto Латин-Кирилл бүгд үлдсэн (${must.length})${missing.length ? ": " + missing.slice(0, 5).join(" ") : ""}`);
  const updata = readFileSync(up + "soffice.data");
  const byName = new Map(u.entries.map((e) => [e.name, e]));
  const diff = t.entries.filter((e) => {
    const o = byName.get(e.name);
    return !o || o.end - o.start !== e.end - e.start || !data.subarray(e.start, e.end).equals(updata.subarray(o.start, o.end));
  });
  check(diff.length === 0, `үлдсэн ${t.entries.length}/${u.entries.length} файл upstream-тэй байт-ижил${diff.length ? ": " + diff.slice(0, 3).map((e) => e.name).join(" ") : ""}`);
  // Урьдчилж шахсан хуулбар (nginx brotli_static / gzip_static).
  for (const [name, f] of Object.entries(m.files)) {
    const raw = readFileSync(join(d, name));
    const br = readFileSync(join(d, name + ".br"));
    const gz = readFileSync(join(d, name + ".gz"));
    check(raw.length === f.bytes && br.length === f.br && gz.length === f.gzip && brotliDecompressSync(br).equals(raw) && gunzipSync(gz).equals(raw),
      `${name}: .br ${f.br}, .gz ${f.gzip} → ${f.bytes} байт`);
  }
  check(readdirSync(out).filter((e) => e !== "manifest.json").length === 1, "хуучин хувилбарын хавтас үлдээгүй");
}

/** PDF-ийн ToUnicode CMap-уудын тэмдэгт ба шингээсэн фонтын нэр (LibreOffice фонтыг subset хийдэг — зөвхөн хэрэглэсэн). */
function pdfText(pdf) {
  const s = Buffer.from(pdf).toString("latin1");
  const chars = new Set();
  const fonts = new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]));
  for (const m of s.matchAll(/stream\r?\n/g)) {
    let t;
    try {
      t = inflateSync(Buffer.from(s.slice(m.index + m[0].length, s.indexOf("endstream", m.index)), "latin1")).toString("latin1");
    } catch {
      continue;
    }
    const add = (h) => { for (let i = 0; i + 4 <= h.length; i += 4) chars.add(String.fromCharCode(parseInt(h.slice(i, i + 4), 16))); };
    for (const b of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const x of b[1].matchAll(/<[0-9A-Fa-f]+>\s*<([0-9A-Fa-f]+)>/g)) add(x[1]);
    for (const b of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const x of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        for (let i = 0; i <= parseInt(x[2], 16) - parseInt(x[1], 16); i++) chars.add(String.fromCharCode(parseInt(x[3], 16) + i));
      }
    }
  }
  return { chars, fonts };
}

try {
  const r = spawnSync(process.execPath, [join(root, "bin/convert-assets.mjs"), join(tmp, "eid-convert")], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error("convert-assets унав");
  checkAssets(join(tmp, "eid-convert"));
  await build({
    entryPoints: [join(root, "dist/convert.js")],
    outfile: join(tmp, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "error",
  });

  const page = (coi) => `<!doctype html><meta charset="utf-8"><title>convert e2e</title><body><script type="module" nonce="${NONCE}">
import * as c from "/app.js";
window.c = c;
window.run = async (path, name, abortAt, verbose) => {
  const log = [];
  const ctl = new AbortController();
  try {
    const file = new File([await (await fetch(path)).arrayBuffer()], name);
    const t = performance.now();
    const r = await c.wordToPdf(file, { assetsBase: "/eid-convert/", signal: ctl.signal, verbose, onProgress: (p) => {
      log.push(p.phase + " " + p.percent);
      if (abortAt && p.phase === abortAt) ctl.abort();
    } });
    let b = ""; for (let i = 0; i < r.pdf.length; i += 0x8000) b += String.fromCharCode(...r.pdf.subarray(i, i + 0x8000));
    return { ok: true, ms: Math.round(performance.now() - t), pages: r.pages, warnings: r.warnings, pdf: btoa(b), log };
  } catch (e) { return { ok: false, name: e.name, code: e.code, message: String(e.message) + (e.cause ? " ← " + String(e.cause?.message ?? e.cause) : ""), log }; }
};
window.ready = true;
</script>`;
  const encodings = new Set();
  const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".data": "application/octet-stream", ".docx": "application/octet-stream", ".doc": "application/octet-stream" };
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x").pathname;
    const coi = !u.startsWith("/nocoi");
    const h = coi ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {};
    if (u === "/" || u === "/nocoi") {
      res.writeHead(200, { ...h, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP });
      return res.end(page(coi));
    }
    const f = u.startsWith("/fixtures/") ? join(root, "test", normalize(u)) : join(tmp, normalize(u));
    if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    if (u.startsWith("/eid-convert/") && f.endsWith(".js")) h["Content-Security-Policy"] = WORKER_CSP;
    // nginx brotli_static / gzip_static: хөтөч зөвшөөрвөл урьдчилж шахсан хуулбар.
    let body = f;
    const ae = String(req.headers["accept-encoding"] ?? "");
    for (const [enc, ext] of [["br", ".br"], ["gzip", ".gz"]]) {
      if (u.startsWith("/eid-convert/") && new RegExp(`\\b${enc}\\b`).test(ae) && existsSync(f + ext)) {
        h["Content-Encoding"] = enc;
        h["Vary"] = "Accept-Encoding";
        body = f + ext;
        if (/soffice\.(wasm|data)$/.test(u)) encodings.add(enc);
        break;
      }
    }
    res.writeHead(200, { ...h, "Content-Type": types[extname(f)] ?? "application/octet-stream", "Content-Length": statSync(body).size, "Cache-Control": u.endsWith("manifest.json") ? "no-cache" : "max-age=31536000, immutable" });
    createReadStream(body).pipe(res);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let bytes = 0;
  let big = [];
  const browser = await (process.env.BROWSER === "webkit" ? webkit : chromium).launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors = [];
    // Хувиргагчийн оношилгооны лог (LibreOffice stdout/stderr, upstream worker-ийн console.log) — verbose-гүй бол 0.
    const LO_LOG = /^(warn:|info:|\[LOK|\[Worker\]|\[FS |\[Fonts\]|\[LibreOfficeConverter\])/;
    const loLog = [];
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 300));
      if (LO_LOG.test(m.text())) loLog.push(m.type() + " " + m.text().slice(0, 120));
    });
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    p.on("response", (r) => {
      if (!r.url().includes("/eid-convert/")) return;
      bytes += Number(r.headers()["content-length"] ?? 0);
      if (/soffice\.(wasm|data)$/.test(r.url())) big.push(r.url());
    });
    await p.goto(origin + "/");
    await p.waitForFunction(() => window.ready);
    check(await p.evaluate(() => crossOriginIsolated), "хуудас crossOriginIsolated");

    const mf = JSON.parse(readFileSync(join(tmp, "eid-convert/manifest.json"), "utf8")).files;
    const st0 = await p.evaluate(() => window.c.converterStatus({ assetsBase: "/eid-convert/" }));
    check(!st0.cached && st0.downloadBytes === mf["soffice.wasm"].br + mf["soffice.data"].br, `converterStatus татахаас өмнө ${JSON.stringify(st0)} (br хэмжээ)`);

    const G = join(root, "test/fixtures/pades/golden/pki/");
    const pem = (n) => new Uint8Array(new X509Certificate(readFileSync(G + n + ".pem")).raw);
    for (const [path, name] of [["/fixtures/convert/sample.docx", "Гэрээ.docx"], ["/fixtures/convert/sample.doc", "Гэрээ.doc"], ["/fixtures/convert/rich.docx", "Стресс.docx"]]) {
      const r = await p.evaluate(([a, b]) => window.run(a, b), [path, name]);
      check(r.ok, `${name}: wordToPdf ${r.ok ? `${r.ms} ms, ${r.pages} хуудас, warnings ${JSON.stringify(r.warnings.map((w) => w.code))}` : `${r.code ?? r.name}: ${r.message}`}`);
      if (!r.ok) continue;
      console.log("     progress:", [...new Set(r.log)].join(" · "));
      const pdf = new Uint8Array(Buffer.from(r.pdf, "base64"));
      check(r.pages >= 2, `${name}: хуудас ≥ 2`);
      if (path.endsWith("rich.docx")) {
        // rich.docx: хүснэгт, зураг, диаграм, OMML томьёо, текст хайрцаг, 11 фонтоор Ө ө Ү ү.
        const { chars, fonts } = pdfText(pdf);
        check(r.pages === 2, `${name}: яг 2 хуудас (${r.pages})`);
        check([..."ӨөҮү"].every((c) => chars.has(c)) && [...fonts].some((f) => /^Noto(Sans|Serif)-/.test(f)), `${name}: Ө ө Ү ү PDF-д, Noto фонт шингэсэн (${[...fonts].filter((f) => f.startsWith("Noto")).join(", ")})`);
        check(chars.has("√") && fonts.has("OpenSymbol"), `${name}: OMML томьёо (√, OpenSymbol) PDF-д`);
      }
      try {
        const prep = await pades.prepare(pdf, { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem), verifyPage: true, fileName: "Гэрээ.pdf", lang: "mn" });
        check(prep.dtbs.length > 0, `${name}: pades.prepare OK (docId ${prep.docId})`);
      } catch (e) {
        check(false, `${name}: pades.prepare ${e.code}: ${e.message}`);
      }
    }
    check(loLog.length === 0, `verbose-гүй: хувиргагчийн консол лог 0${loLog.length ? ` (${loLog.length}): ${loLog.slice(0, 3).join(" | ")}` : ""}`);
    const first = bytes;
    const m = JSON.parse(readFileSync(join(tmp, "eid-convert/manifest.json"), "utf8"));
    const gz = Object.values(m.files).reduce((s, f) => s + f.gzip, 0);
    check(encodings.size > 0 && first > 0.5 * gz && first <= gz * 1.02, `эхний удаа татсан ${(first / 1e6).toFixed(1)} MB (${[...encodings].join("/")}; gzip нийт ${(gz / 1e6).toFixed(1)} MB)`);

    // Цуцлалт хөрвүүлэлтийн үеэр → AbortError; дараагийнх нь кэшээс (wasm/data дахин татахгүй).
    const a = await p.evaluate(() => window.run("/fixtures/convert/sample.docx", "a.docx", "convert"));
    check(!a.ok && a.name === "AbortError", `цуцлалт: ${a.name}`);
    big = [];
    const again = await p.evaluate(() => window.run("/fixtures/convert/sample.docx", "a.docx"));
    check(again.ok && !again.log.some((l) => l.startsWith("download")), `цуцалсны дараа: download үе шатгүй (кэш), ${again.ms} ms`);
    check(big.length === 0, `цуцалсны дараа soffice.wasm/.data сүлжээнээс дахин аваагүй${big.length ? ": " + big.join(" ") : ""}`);
    // verbose: true — worker дахин асаж лог гарна (оношилгоо).
    loLog.length = 0;
    const vb = await p.evaluate(() => window.run("/fixtures/convert/sample.docx", "v.docx", undefined, true));
    check(vb.ok && loLog.length > 0, `verbose: true — хувиргагчийн лог ${loLog.length} мөр`);
    const st = await p.evaluate(() => window.c.converterStatus({ assetsBase: "/eid-convert/" }));
    check(st.cached && st.downloadBytes === 0, `converterStatus ${JSON.stringify(st)}`);

    // COOP/COEP-гүй хуудас — шууд NOT_ISOLATED.
    const p2 = await ctx.newPage();
    await p2.goto(origin + "/nocoi");
    await p2.waitForFunction(() => window.ready);
    const t = Date.now();
    const n2 = await p2.evaluate(async () => {
      try { await window.c.wordToPdf(new File([new Uint8Array([0x50, 0x4b, 3, 4])], "a.docx"), { assetsBase: "/eid-convert/" }); return "ok"; }
      catch (e) { return e.code; }
    });
    check(n2 === "NOT_ISOLATED" && Date.now() - t < 5000, `COEP-гүй: ${n2}`);
    const csp = errors.filter((e) => /Content Security Policy|Refused/i.test(e));
    check(csp.length === 0, `CSP зөрчилгүй${csp.length ? ": " + csp.join(" | ") : ""}`);
  } finally {
    await browser.close();
    server.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) {
  console.error(`${failed} шалгалт унав`);
  process.exit(1);
}
