#!/usr/bin/env node
// /convert-ийн жинхэнэ шалгалт Chromium-д: RP-ийн хэв маяг (хуудас — nonce + 'strict-dynamic' CSP, COOP/COEP;
// asset-ууд — eid-mongolia-convert-assets, worker-ийн өөрийн CSP) → test/fixtures/convert/sample.docx ба .doc →
// PDF → /pades prepare (Node, golden PKI). Мөн: кэштэй хоёр дахь удаа татахгүй, цуцлалт, COEP-гүй хуудас NOT_ISOLATED.
// Урьдчилан `npm run build`; Playwright Chromium (`npx playwright install chromium-headless-shell`); BROWSER=webkit — WebKit.
//
//   node scripts/convert-e2e.mjs
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
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
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

try {
  const r = spawnSync(process.execPath, [join(root, "bin/convert-assets.mjs"), join(tmp, "eid-convert")], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error("convert-assets унав");
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
window.run = async (path, name, abortAt) => {
  const log = [];
  const ctl = new AbortController();
  try {
    const file = new File([await (await fetch(path)).arrayBuffer()], name);
    const t = performance.now();
    const r = await c.wordToPdf(file, { assetsBase: "/eid-convert/", signal: ctl.signal, onProgress: (p) => {
      log.push(p.phase + " " + p.percent);
      if (abortAt && p.phase === abortAt) ctl.abort();
    } });
    let b = ""; for (let i = 0; i < r.pdf.length; i += 0x8000) b += String.fromCharCode(...r.pdf.subarray(i, i + 0x8000));
    return { ok: true, ms: Math.round(performance.now() - t), pages: r.pages, warnings: r.warnings, pdf: btoa(b), log };
  } catch (e) { return { ok: false, name: e.name, code: e.code, message: String(e.message) + (e.cause ? " ← " + String(e.cause?.message ?? e.cause) : ""), log }; }
};
window.ready = true;
</script>`;
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
    res.writeHead(200, { ...h, "Content-Type": types[extname(f)] ?? "application/octet-stream", "Content-Length": statSync(f).size, "Cache-Control": u.endsWith("manifest.json") ? "no-cache" : "max-age=31536000, immutable" });
    createReadStream(f).pipe(res);
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
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    p.on("response", (r) => {
      if (!r.url().includes("/eid-convert/")) return;
      bytes += Number(r.headers()["content-length"] ?? 0);
      if (/soffice\.(wasm|data)$/.test(r.url())) big.push(r.url());
    });
    await p.goto(origin + "/");
    await p.waitForFunction(() => window.ready);
    check(await p.evaluate(() => crossOriginIsolated), "хуудас crossOriginIsolated");

    const G = join(root, "test/fixtures/pades/golden/pki/");
    const pem = (n) => new Uint8Array(new X509Certificate(readFileSync(G + n + ".pem")).raw);
    for (const [path, name] of [["/fixtures/convert/sample.docx", "Гэрээ.docx"], ["/fixtures/convert/sample.doc", "Гэрээ.doc"]]) {
      const r = await p.evaluate(([a, b]) => window.run(a, b), [path, name]);
      check(r.ok, `${name}: wordToPdf ${r.ok ? `${r.ms} ms, ${r.pages} хуудас, warnings ${JSON.stringify(r.warnings.map((w) => w.code))}` : `${r.code ?? r.name}: ${r.message}`}`);
      if (!r.ok) continue;
      console.log("     progress:", [...new Set(r.log)].join(" · "));
      const pdf = new Uint8Array(Buffer.from(r.pdf, "base64"));
      check(r.pages >= 2, `${name}: хуудас ≥ 2`);
      try {
        const prep = await pades.prepare(pdf, { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem), verifyPage: true, fileName: "Гэрээ.pdf", lang: "mn" });
        check(prep.dtbs.length > 0, `${name}: pades.prepare OK (docId ${prep.docId})`);
      } catch (e) {
        check(false, `${name}: pades.prepare ${e.code}: ${e.message}`);
      }
    }
    const first = bytes;
    check(first > 240e6, `эхний удаа татсан ${(first / 1e6).toFixed(1)} MB`);

    // Цуцлалт хөрвүүлэлтийн үеэр → AbortError; дараагийнх нь кэшээс (wasm/data дахин татахгүй).
    const a = await p.evaluate(() => window.run("/fixtures/convert/sample.docx", "a.docx", "convert"));
    check(!a.ok && a.name === "AbortError", `цуцлалт: ${a.name}`);
    big = [];
    const again = await p.evaluate(() => window.run("/fixtures/convert/sample.docx", "a.docx"));
    check(again.ok && !again.log.some((l) => l.startsWith("download")), `цуцалсны дараа: download үе шатгүй (кэш), ${again.ms} ms`);
    check(big.length === 0, `цуцалсны дараа soffice.wasm/.data сүлжээнээс дахин аваагүй${big.length ? ": " + big.join(" ") : ""}`);
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
