#!/usr/bin/env node
// eid-mongolia-convert-assets <гаралтын хавтас> — `@gerege-systems/eid-mongolia-sdk/convert`-ийн хөтчийн asset-уудыг
// төслийн node_modules-ийн `@matbee/libreoffice-converter`-оос хуулна (build үед; git-д commit хийхгүй — ~250 MB).
//
//   <хавтас>/manifest.json            — богино кэш (no-cache): хувилбар, файл бүрийн хэмжээ (+ gzip хэмжээ)
//   <хавтас>/<хувилбар>/soffice.*     — урт кэш (immutable)
//   <хавтас>/<хувилбар>/eid-convert.worker.js, browser.worker.global.js
//   <хавтас>/<хувилбар>/LICENSE-MPL-2.0.txt, NOTICE.txt
//
// browser.worker.global.js-ийг (зөвхөн sha256 нь QUIET_PATCH-тай таарвал) чимээгүй болгоно: upstream LibreOffice-ийн
// stdout/stderr-ийг (print/printErr) үргэлж console.log/console.error руу илгээдэг — хувиргалт бүрд ~28 улаан мөр
// («warn:vcl…», «[LOK C++] …»). Patch-ийн дараа зөвхөн `wordToPdf({ verbose: true })` үед (worker `?verbose=1`).
// Hash таарахгүй бол patch-гүй хуулж анхааруулна (build унахгүй) — хувиргалт ажиллана, лог л гарна.
//
// soffice.js-ийн `pthreadPoolSize` 4 → 8 (POOL_PATCH, ЗААВАЛ): 4 нь удаан CPU дээр documentLoad-д deadlock (LO-ийн
// pthread-ийн MEMFS syscall нь LO worker руу sync proxy, worker нь pthread хүлээж хаагдсан); 5+ ажиллана. Hash эсвэл
// солилт таарахгүй бол build унана (patch-гүй asset гацаж болзошгүй). Зөвхөн JS — wasm/data хөндөхгүй.
//
// `wordToPdf({ assetsBase: "<URL>/" })` нь <хавтас>-ын URL-ийг авна. Хуучин хувилбарын дэд хавтсыг устгана.
import { createHash } from "node:crypto";
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

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Мэдэгдэж буй upstream файл → яг нэг удаа таарах ёстой солилтууд. */
const QUIET_PATCH = {
  file: "browser.worker.global.js",
  // @matbee/libreoffice-converter@2.7.2 dist/browser.worker.global.js
  sha256: "9401aff2213772d7114fe417e3f34eb359905ae3a4e94a735644d926d593e276",
  replace: [
    ["print:console.log,printErr:console.error}", "print:self.EID_CONVERT_VERBOSE?console.log:()=>{},printErr:self.EID_CONVERT_VERBOSE?console.error:()=>{}}"],
    // Энд (runtime асасны дараа) ENV-д бичих нь LibreOffice-д хүрдэггүй — үйлчлэх утга нь soffice.js-ийн preRun "+WARN"
    // (2026-10-16 Chromium-д хэмжсэн: "-WARN-INFO"-тэй ч «warn:» мөрүүд хэвээр). Консол руу гарахыг printErr зогсооно;
    // "+ALL"-ийг зөвхөн upstream дахин уншдаг болбол бүх лог асахгүйн тулд солино.
    ['a.ENV.SAL_LOG="+ALL"', 'a.ENV.SAL_LOG="-WARN-INFO"'],
    ['console.log("[Worker] Set SAL_LOG to +ALL")', 'console.log("[Worker] Set SAL_LOG to "+a.ENV.SAL_LOG)'],
  ],
};

/** Patch хийсэн агуулга эсвэл null (hash / солилт таарахгүй — шалтгааныг хэвлэнэ). */
function quiet(buf) {
  const got = sha256(buf);
  if (got !== QUIET_PATCH.sha256) {
    console.warn(`анхааруулга: ${PKG}/dist/${QUIET_PATCH.file} sha256 ${got} — мэдэгдэж буй ${QUIET_PATCH.sha256} биш; лог чимээгүй болгох patch-гүй хуулав (хувиргалт ажиллана, консолд LibreOffice-ийн лог гарна)`);
    return null;
  }
  let s = buf.toString("utf8");
  for (const [from, to] of QUIET_PATCH.replace) {
    if (s.split(from).length !== 2) {
      console.warn(`анхааруулга: ${QUIET_PATCH.file}-д «${from}» яг нэг удаа олдсонгүй — patch-гүй хуулав`);
      return null;
    }
    s = s.replace(from, () => to);
  }
  return Buffer.from(s, "utf8");
}

/** soffice.js — мэдэгдэж буй upstream → яг нэг солилт; эс бөгөөс build унана. */
const POOL_PATCH = {
  file: "soffice.js",
  // @matbee/libreoffice-converter@2.7.2 wasm/soffice.js
  sha256: "b67acadcb30171e6ec018754fcbe5b527443a3ef1c84f352e29aecff6d210e43",
  from: "var pthreadPoolSize=4;",
  to: "var pthreadPoolSize=8;",
};
const PTHREAD_POOL_SIZE = 8;

function pool(buf) {
  const got = sha256(buf);
  const s = buf.toString("utf8");
  if (got !== POOL_PATCH.sha256 || s.split(POOL_PATCH.from).length !== 2) {
    console.error(`${PKG}/wasm/${POOL_PATCH.file} sha256 ${got} — мэдэгдэж буй ${POOL_PATCH.sha256} биш (эсвэл «${POOL_PATCH.from}» яг нэг биш); pthreadPoolSize patch-гүйгээр хувиргалт удаан CPU дээр гацдаг тул зогсов — SDK-ийн peerDependency хувилбарыг суулга`);
    process.exit(1);
  }
  return Buffer.from(s.replace(POOL_PATCH.from, () => POOL_PATCH.to), "utf8");
}

const files = {};
let patched = false;
const rev = createHash("sha256");
for (const [name, rel] of Object.entries(FILES)) {
  const from = rel === null ? new URL(name, import.meta.url).pathname : join(src, rel);
  if (!existsSync(from)) {
    console.error(`${PKG}/${rel} алга`);
    process.exit(1);
  }
  const to = join(out, dir, name);
  if (name === QUIET_PATCH.file) {
    const buf = readFileSync(from);
    const q = quiet(buf);
    patched = q !== null;
    writeFileSync(to, q ?? buf);
  } else if (name === POOL_PATCH.file) {
    writeFileSync(to, pool(readFileSync(from)));
  } else {
    copyFileSync(from, to);
  }
  // Worker-ийн скриптүүд `<хувилбар>/` дор immutable кэштэй — агуулга солигдвол (patch, SDK шинэчлэл) rev-ээр URL солино.
  if (name.endsWith(".js")) rev.update(name).update("\0").update(readFileSync(to));
  files[name] = { bytes: statSync(to).size, gzip: await gzipSize(to) };
}
// MPL-2.0 §3.2: эх кодын байршил ба лиценз дагалдана.
writeFileSync(join(out, dir, "NOTICE.txt"),
  `${PKG}@${version} (${license}) — LibreOffice WebAssembly build.\n` +
  `Source: https://github.com/matbeedotcom/libreoffice-document-converter (tag v${version}); LibreOffice: https://www.libreoffice.org/about-us/source-code/\n` +
  `License text: https://www.mozilla.org/MPL/2.0/\n`);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ format: 1, converter: PKG, version, dir, rev: rev.digest("hex").slice(0, 16), patched, pthreadPoolSize: PTHREAD_POOL_SIZE, files }, null, 2) + "\n");
const sum = (k) => Object.values(files).reduce((s, f) => s + f[k], 0);
console.log(`${PKG}@${version} → ${join(out, dir)} (${(sum("bytes") / 1e6).toFixed(1)} MB, gzip ${(sum("gzip") / 1e6).toFixed(1)} MB)${patched ? ", лог чимээгүй (patch)" : ""}`);
