#!/usr/bin/env node
// eid-mongolia-convert-assets <гаралтын хавтас> — `@gerege-systems/eid-mongolia-sdk/convert`-ийн хөтчийн asset-уудыг
// төслийн node_modules-ийн `@matbee/libreoffice-converter`-оос хуулна (build үед; git-д commit хийхгүй — ~190 MB + .br/.gz).
//
//   <хавтас>/manifest.json            — богино кэш (no-cache): хувилбар, файл бүрийн хэмжээ (+ gzip, br хэмжээ)
//   <хавтас>/<хувилбар>-<hash>/soffice.*     — урт кэш (immutable); <hash> = soffice.js-ийн агуулга (data-ийн хүснэгт)
//   <хавтас>/<хувилбар>-<hash>/eid-convert.worker.js, browser.worker.global.js
//   <хавтас>/<хувилбар>-<hash>/NOTICE.txt
//   <файл>.br, <файл>.gz — урьдчилж шахсан хуулбар (nginx brotli_static / gzip_static), .js/.wasm/.data бүрт
//
// browser.worker.global.js-ийг (зөвхөн sha256 нь QUIET_PATCH-тай таарвал) чимээгүй болгоно: upstream LibreOffice-ийн
// stdout/stderr-ийг (print/printErr) үргэлж console.log/console.error руу илгээдэг — хувиргалт бүрд ~28 улаан мөр
// («warn:vcl…», «[LOK C++] …»). Patch-ийн дараа зөвхөн `wordToPdf({ verbose: true })` үед (worker `?verbose=1`).
// Hash таарахгүй бол patch-гүй хуулж анхааруулна (build унахгүй) — хувиргалт ажиллана, лог л гарна.
//
// soffice.js-ийн `pthreadPoolSize` 4 → 8 (POOL_PATCH, ЗААВАЛ): 4 нь удаан CPU дээр documentLoad-д deadlock (LO-ийн
// pthread-ийн MEMFS syscall нь LO worker руу sync proxy, worker нь pthread хүлээж хаагдсан); 5+ ажиллана. Hash эсвэл
// солилт таарахгүй бол build унана (patch-гүй asset гацаж болзошгүй).
//
// soffice.data-г багасгана (DATA_TRIM, ЗААВАЛ): Writer → PDF-д хэрэггүй фонт, Calc/Impress/Draw/Math-ийн UI тохиргоо,
// дүрсний сан (99.7 MB → 43.2 MB). Emscripten file_packager-ийн хүснэгт (`loadPackage({files:[…],remote_package_size:N`)
// soffice.js дотор — offset-уудыг дахин бичнэ. soffice.data эсвэл soffice.js-ийн sha256 мэдэгдэж буй 2.7.2 биш бол
// build унана (offset тодорхойгүй). wasm хөндөхгүй.
//
// Шахалт: .br (brotli 11; `EID_CONVERT_BROTLI_QUALITY=0…11`-ээр бууруулж болно — soffice.wasm-д 11 нь M4 Pro дээр ~4
// мин) ба .gz (gzip 9). Сервер `Content-Encoding`-оор өгсөн ч SDK задарсан байтыг тоолж manifest-ийн `bytes`-тэй тулгана.
//
// `wordToPdf({ assetsBase: "<URL>/" })` нь <хавтас>-ын URL-ийг авна. Хуучин хувилбарын дэд хавтсыг устгана.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, copyFileSync, writeFileSync, writeSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createBrotliCompress, createGzip, constants as Z } from "node:zlib";
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

const BROTLI_QUALITY = process.env.EID_CONVERT_BROTLI_QUALITY?.trim() ? Number(process.env.EID_CONVERT_BROTLI_QUALITY) : 11;
if (!Number.isInteger(BROTLI_QUALITY) || BROTLI_QUALITY < 0 || BROTLI_QUALITY > 11) {
  console.error("EID_CONVERT_BROTLI_QUALITY нь 0…11 бүхэл тоо");
  process.exit(2);
}

/** `<файл>.br` (brotli) ба `<файл>.gz` (gzip 9) — nginx brotli_static / gzip_static; хэмжээг буцаана. */
async function compress(path) {
  const size = statSync(path).size;
  const one = async (ext, z) => {
    await pipeline(createReadStream(path), z, createWriteStream(path + ext));
    return statSync(path + ext).size;
  };
  // zlib нь libuv-ийн thread pool-д — файлууд зэрэгцээ шахагдана (soffice.wasm-ийн brotli хамгийн удаан).
  const [br, gzip] = await Promise.all([
    one(".br", createBrotliCompress({ params: { [Z.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [Z.BROTLI_PARAM_SIZE_HINT]: size } })),
    one(".gz", createGzip({ level: 9 })),
  ]);
  return { bytes: size, gzip, br };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function sha256File(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), new Writable({ write(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest("hex");
}

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

/**
 * soffice.data-аас (Emscripten file_packager) Word → PDF-д хэрэггүй файлуудыг хасна. 2026-10-19 хэмжсэн: sample.docx,
 * sample.doc, бодит гэрээ, стресс docx (хүснэгт, зураг, диаграм, OMML томьёо, текст хайрцаг, 11 фонтоор Ө ө Ү ү) — PDF
 * пиксел-ижил. Хасахгүй (тусгайлан):
 *   - NotoSans / NotoSerif Латин-Кирилл — Cambria (Caladea-д кирилл алга) зэрэг фонтын Ө Ү-г эдгээрээр орлуулдаг;
 *   - registry/*.xcd бүгд — жишээ нь math.xcd-гүй бол .docx-ийн OMML томьёо PDF-ээс алга болдог.
 */
const DATA_TRIM = {
  // @matbee/libreoffice-converter@2.7.2 wasm/soffice.data ба wasm/soffice.js (POOL_PATCH-аас өмнө)
  data: "8f4e98aa67e108e161cecc7906d7ac0dd3941ef9347f999c3b9dbc049f165020",
  js: "b67acadcb30171e6ec018754fcbe5b527443a3ef1c84f352e29aecff6d210e43",
  drop: [
    // Фонт: Writer-ийн баримтад ердийн бус бичиг (араб, еврей, армян, гүрж, лао, лису) ба тусгай гэр бүл.
    /\/fonts\/truetype\/(LinLibertine|LinBiolinum|Amiri|Scheherazade|ReemKufi|Rubik|Alef|David|Frank|Miriam|Nachlieli|GenBas|GenBkBas|Noto(Sans|Serif|Kufi|Naskh)(Arabic|Hebrew|Armenian|Georgian|Lao|Lisu)|NotoKufiArabic|NotoNaskhArabic|DejaVuSans-ExtraLight|DejaVuSansCondensed|DejaVuSerifCondensed)/,
    // Writer-ээс бусад модулийн UI тохиргоо (толгойгүй хувиргалтад ачаалагддаггүй).
    /\/soffice\.cfg\/modules\/(scalc|simpress|sdraw|sweb|swform|swreport|swxform|sbibliography|dbapp|dbbrowser|dbquery|dbrelation|dbtable|dbtdata|sabpilot|scanner|spropctrlr|BasicIDE|smath|schart|sglobal)\//,
    /\/soffice\.cfg\/simpress\//,
    // Нүүр зураг, About, Android жишээ баримт, дүрсний сан, gallery.
    /\/intro(-highres)?\.png$|\/shell\/about\.svg$|^\/android\//,
    /images_colibre\.zip$|\/share\/gallery\//,
  ],
  /** `opens___.ttf` (OpenSymbol) хэд хэдэн замд давхардсан — эхнийхийг үлдээнэ. */
  dedupe: /opens___\.ttf$/,
};

const LOAD_PACKAGE = "loadPackage({files:";
const PACKAGE_SIZE = "remote_package_size:";
// Минификатор тоог заримдаа «14924e3» гэж бичдэг.
const ENTRY = /\{filename:"([^"]*)",start:(\d+(?:e\d+)?),end:(\d+(?:e\d+)?)\}/g;

/** soffice.js-ийн file_packager хүснэгт: [ { name, start, end } ], хүснэгтийн [from, to) байрлал, нийт хэмжээ. */
function packageTable(js) {
  if (js.split(LOAD_PACKAGE + "[").length !== 2 || js.split(PACKAGE_SIZE).length !== 2) {
    console.error(`soffice.js-д «${LOAD_PACKAGE}[» ба «${PACKAGE_SIZE}» тус бүр яг нэг биш — DATA_TRIM зогсов`);
    process.exit(1);
  }
  const from = js.indexOf(LOAD_PACKAGE) + LOAD_PACKAGE.length;
  const sizeAt = js.indexOf("]," + PACKAGE_SIZE, from);
  const num = /^(\d+)\}/.exec(js.slice(sizeAt + 2 + PACKAGE_SIZE.length));
  if (sizeAt < 0 || !num) {
    console.error("soffice.js-ийн file_packager хүснэгт танигдсангүй — DATA_TRIM зогсов");
    process.exit(1);
  }
  const body = js.slice(from + 1, sizeAt);
  const entries = [...body.matchAll(ENTRY)].map((m) => ({ raw: m[0], name: m[1], start: Number(m[2]), end: Number(m[3]) }));
  // Бүх мөр танигдсан (өөр талбаргүй), offset-ууд тасралтгүй, нийлбэр = remote_package_size.
  let pos = 0;
  for (const e of entries) {
    if (e.start !== pos || e.end < e.start) {
      console.error(`soffice.js-ийн хүснэгт тасралттай (${e.name}) — DATA_TRIM зогсов`);
      process.exit(1);
    }
    pos = e.end;
  }
  if (entries.map((e) => e.raw).join(",") !== body || pos !== Number(num[1])) {
    console.error("soffice.js-ийн file_packager хүснэгт хүлээгдсэн хэлбэрийн биш — DATA_TRIM зогсов");
    process.exit(1);
  }
  return { entries, from, to: sizeAt + 2 + PACKAGE_SIZE.length + num[1].length, size: pos };
}

/** Хасах эсэх (`seen` — давхардсан файлын нэг дэх нь өнгөрсөн эсэх). */
function dropped(name, seen) {
  if (DATA_TRIM.dedupe.test(name)) {
    if (seen.has("dedupe")) return true;
    seen.add("dedupe");
    return false;
  }
  return DATA_TRIM.drop.some((re) => re.test(name));
}

/**
 * Upstream soffice.js (patch-аас өмнө — `upstream`) ба soffice.data-г sha256-аар шалгаж хасах төлөвлөгөө гаргана;
 * хүснэгтийг `patched` (POOL_PATCH-тай) js-д дахин бичнэ — гаралт нэг soffice.js.
 */
async function trimPlan(upstream, patched, dataPath) {
  const [gotJs, gotData] = [sha256(upstream), await sha256File(dataPath)];
  if (gotJs !== DATA_TRIM.js || gotData !== DATA_TRIM.data) {
    console.error(`${PKG}/wasm/soffice.js sha256 ${gotJs}, soffice.data sha256 ${gotData} — мэдэгдэж буй ${DATA_TRIM.js} / ${DATA_TRIM.data} биш; soffice.data-ийн offset тодорхойгүй тул зогсов — SDK-ийн peerDependency хувилбарыг суулга`);
    process.exit(1);
  }
  const js = patched.toString("utf8");
  const t = packageTable(js);
  if (t.size !== statSync(dataPath).size) {
    console.error(`soffice.data ${statSync(dataPath).size} байт, хүснэгтэд ${t.size} — DATA_TRIM зогсов`);
    process.exit(1);
  }
  const seen = new Set();
  const keep = t.entries.filter((e) => !dropped(e.name, seen));
  let pos = 0;
  const table = keep.map((e) => {
    const s = pos;
    pos += e.end - e.start;
    return `{filename:"${e.name}",start:${s},end:${pos}}`;
  });
  return { js: Buffer.from(js.slice(0, t.from) + "[" + table.join(",") + "]," + PACKAGE_SIZE + pos + js.slice(t.to), "utf8"), keep, files: t.entries.length };
}

/** Үлдэх мөрүүдийг upstream soffice.data-аас дарааллаар нь хуулна (бүтэн файлыг санах ойд барихгүй). */
function writeTrimmed(from, to, keep) {
  const src = openSync(from, "r");
  const dst = openSync(to, "w");
  try {
    let buf = Buffer.alloc(1 << 20);
    for (const e of keep) {
      const n = e.end - e.start;
      if (buf.length < n) buf = Buffer.alloc(n);
      if (readSync(src, buf, 0, n, e.start) !== n) throw new Error(`soffice.data: ${e.name} дутуу уншигдав`);
      writeSync(dst, buf, 0, n);
    }
  } finally {
    closeSync(src);
    closeSync(dst);
  }
}

// soffice.js (POOL_PATCH + DATA_TRIM-ийн хүснэгт) — хавтасны нэрийг агуулгаар нь тогтооно: soffice.js/.data-г
// `<хувилбар>/` дор immutable кэшлэдэг тул агуулга солигдвол (хуучин хүснэгт + шинэ data) URL ч солигдох ёстой.
const upstreamJs = readFileSync(join(src, FILES["soffice.js"]));
const plan = await trimPlan(upstreamJs, pool(upstreamJs), join(src, FILES["soffice.data"]));
const sofficeJs = plan.js;
const dir = `${version}-${sha256(sofficeJs).slice(0, 12)}/`;
mkdirSync(join(out, dir), { recursive: true });
for (const e of readdirSync(out)) {
  if (e + "/" !== dir && e !== "manifest.json" && statSync(join(out, e)).isDirectory() && /^\d+\.\d+\.\d+/.test(e)) rmSync(join(out, e), { recursive: true });
}

let patched = false;
const rev = createHash("sha256");
const written = [];
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
    writeFileSync(to, sofficeJs);
  } else if (name === "soffice.data") {
    writeTrimmed(from, to, plan.keep);
  } else {
    copyFileSync(from, to);
  }
  // Worker-ийн скриптүүд `<хувилбар>/` дор immutable кэштэй — агуулга солигдвол (patch, SDK шинэчлэл) rev-ээр URL солино.
  if (name.endsWith(".js")) rev.update(name).update("\0").update(readFileSync(to));
  written.push([name, to]);
}
const t0 = Date.now();
const files = Object.fromEntries(await Promise.all(written.map(async ([name, to]) => [name, await compress(to)])));
// MPL-2.0 §3.2: эх кодын байршил ба лиценз дагалдана.
writeFileSync(join(out, dir, "NOTICE.txt"),
  `${PKG}@${version} (${license}) — LibreOffice WebAssembly build.\n` +
  `Source: https://github.com/matbeedotcom/libreoffice-document-converter (tag v${version}); LibreOffice: https://www.libreoffice.org/about-us/source-code/\n` +
  `License text: https://www.mozilla.org/MPL/2.0/\n`);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ format: 1, converter: PKG, version, dir, rev: rev.digest("hex").slice(0, 16), patched, pthreadPoolSize: PTHREAD_POOL_SIZE, files }, null, 2) + "\n");
const sum = (k) => Object.values(files).reduce((s, f) => s + f[k], 0);
console.log(`${PKG}@${version} → ${join(out, dir)} (${(sum("bytes") / 1e6).toFixed(1)} MB, gzip ${(sum("gzip") / 1e6).toFixed(1)} MB, br ${(sum("br") / 1e6).toFixed(1)} MB — шахалт ${Math.round((Date.now() - t0) / 1000)} с)` +
  `, soffice.data ${plan.keep.length}/${plan.files} файл${patched ? ", лог чимээгүй (patch)" : ""}`);
