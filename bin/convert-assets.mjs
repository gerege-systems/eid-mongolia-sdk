#!/usr/bin/env node
// eid-mongolia-convert-assets <гаралтын хавтас> — `@gerege-systems/eid-mongolia-sdk/convert`-ийн хөтчийн asset-уудыг
// төслийн node_modules-ийн `@matbee/libreoffice-converter`-оос хуулна (build үед; git-д commit хийхгүй — ~250 MB).
//
//   <хавтас>/manifest.json            — богино кэш (no-cache): хувилбар, файл бүрийн хэмжээ (+ gzip хэмжээ)
//   <хавтас>/<хувилбар>/soffice.*     — урт кэш (immutable)
//   <хавтас>/<хувилбар>/eid-convert.worker.js, browser.worker.global.js
//   <хавтас>/<хувилбар>/LICENSE-MPL-2.0.txt, NOTICE.txt
//
// `wordToPdf({ assetsBase: "<URL>/" })` нь <хавтас>-ын URL-ийг авна. Хуучин хувилбарын дэд хавтсыг устгана.
import { createRequire } from "node:module";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

const PKG = "@matbee/libreoffice-converter";
const FILES = {
  "eid-convert.worker.js": null, // SDK-ийнх (bin/)
  "soffice.js": "wasm/soffice.js",
  "soffice.wasm": "wasm/soffice.wasm",
  "soffice.data": "wasm/soffice.data",
  "soffice.worker.js": "wasm/soffice.worker.js",
  "browser.worker.global.js": "dist/browser.worker.global.js",
};

const out = process.argv[2];
if (!out || process.argv.length > 3) {
  console.error("хэрэглээ: eid-mongolia-convert-assets <гаралтын хавтас>");
  process.exit(2);
}

let pkgJson;
try {
  pkgJson = createRequire(join(process.cwd(), "package.json")).resolve(`${PKG}/package.json`);
} catch {
  console.error(`${PKG} олдсонгүй — \`npm install ${PKG}@<SDK-ийн peerDependency хувилбар>\``);
  process.exit(1);
}
const src = dirname(pkgJson);
const { version, license } = JSON.parse(readFileSync(pkgJson, "utf8"));
const peer = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).peerDependencies?.[PKG];
if (peer && peer !== version) {
  console.error(`${PKG}@${version} суусан, SDK ${peer}-тэй л шалгагдсан — хувилбараа тааруул`);
  process.exit(1);
}

const dir = `${version}/`;
mkdirSync(join(out, dir), { recursive: true });
for (const e of readdirSync(out)) {
  if (e !== version && e !== "manifest.json" && statSync(join(out, e)).isDirectory() && /^\d+\.\d+\.\d+/.test(e)) rmSync(join(out, e), { recursive: true });
}

async function gzipSize(path) {
  let n = 0;
  await pipeline(createReadStream(path), createGzip({ level: 6 }), new Writable({ write(c, _e, cb) { n += c.length; cb(); } }));
  return n;
}

const files = {};
for (const [name, rel] of Object.entries(FILES)) {
  const from = rel === null ? new URL(name, import.meta.url).pathname : join(src, rel);
  if (!existsSync(from)) {
    console.error(`${PKG}/${rel} алга`);
    process.exit(1);
  }
  const to = join(out, dir, name);
  copyFileSync(from, to);
  files[name] = { bytes: statSync(to).size, gzip: await gzipSize(to) };
}
// MPL-2.0 §3.2: эх кодын байршил ба лиценз дагалдана.
writeFileSync(join(out, dir, "NOTICE.txt"),
  `${PKG}@${version} (${license}) — LibreOffice WebAssembly build.\n` +
  `Source: https://github.com/matbeedotcom/libreoffice-document-converter (tag v${version}); LibreOffice: https://www.libreoffice.org/about-us/source-code/\n` +
  `License text: https://www.mozilla.org/MPL/2.0/\n`);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ format: 1, converter: PKG, version, dir, files }, null, 2) + "\n");
const sum = (k) => Object.values(files).reduce((s, f) => s + f[k], 0);
console.log(`${PKG}@${version} → ${join(out, dir)} (${(sum("bytes") / 1e6).toFixed(1)} MB, gzip ${(sum("gzip") / 1e6).toFixed(1)} MB)`);
