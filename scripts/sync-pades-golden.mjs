#!/usr/bin/env node
// Go reference (gerege-systems/eid-mongolia-sdk-go, бэхэлсэн commit)-оос /pades-ийн conformance fixture ба фонт asset-ийг
// хуулна:
//   pades/testdata/golden/{manifest.json,README.md,input/,http/,placement/,pki/*.pem (хувийн түлхүүргүй)} → test/fixtures/pades/golden/
//   pades/assets/fonts/{*.ttf.zlib,*.metrics.json} → src/pades/assets/fonts.ts (байт base64 + метрик — bundle-д шигтгэнэ),
//   pades/assets/fonts/OFL.txt                     → src/pades/assets/OFL.txt
//
//   node scripts/sync-pades-golden.mjs            — хуулж бичнэ (GO_SDK_DIR=<clone> өгвөл clone хийхгүй, commit-ийг шалгана)
//   node scripts/sync-pades-golden.mjs --check    — репо дахь хуулбар бэхэлсэн commit-тэй байт-ижил эсэх (CI)
//
// Бэхэлгээг солиход: GO_SDK_COMMIT-ийг засаад ажиллуулж diff-ийг commit-д оруулна.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GO_SDK_REPO = "https://github.com/gerege-systems/eid-mongolia-sdk-go";
// Go #35 (golden v6: appearance page 0 skips verify pages — PLACEMENT_SPEC §1a).
export const GO_SDK_COMMIT = "52c8dd8288a08d109588695cd9a3cd38c177f7fe";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

function goSource() {
  const dir = process.env.GO_SDK_DIR;
  if (dir) {
    const got = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (got !== GO_SDK_COMMIT) throw new Error(`GO_SDK_DIR ${got} ≠ бэхэлсэн ${GO_SDK_COMMIT}`);
    return { dir, cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "eid-go-sdk-"));
  const git = (...a) => execFileSync("git", ["-C", tmp, ...a], { stdio: ["ignore", "ignore", "inherit"] });
  git("init", "-q");
  git("fetch", "-q", "--depth", "1", GO_SDK_REPO, GO_SDK_COMMIT);
  git("checkout", "-q", "FETCH_HEAD");
  return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** Хүлээгдэх файлууд: репо дахь зам → агуулга. */
function expected(src) {
  const out = new Map();
  const g = join(src, "pades/testdata/golden");
  const dst = "test/fixtures/pades/golden";
  for (const f of ["manifest.json", "README.md"]) out.set(`${dst}/${f}`, readFileSync(join(g, f)));
  for (const sub of ["input", "http"]) {
    for (const f of readdirSync(join(g, sub)).sort()) out.set(`${dst}/${sub}/${f}`, readFileSync(join(g, sub, f)));
  }
  // Байршлын scanner-ийн conformance (PLACEMENT_SPEC.md §8): vectors.json + placement/input/*.pdf.
  out.set(`${dst}/placement/vectors.json`, readFileSync(join(g, "placement/vectors.json")));
  for (const f of readdirSync(join(g, "placement/input")).sort()) {
    out.set(`${dst}/placement/input/${f}`, readFileSync(join(g, "placement/input", f)));
  }
  for (const f of readdirSync(join(g, "pki")).sort()) {
    if (f.endsWith(".pem") && !f.endsWith(".key.pem")) out.set(`${dst}/pki/${f}`, readFileSync(join(g, "pki", f)));
  }
  // validatePdf conformance (Go pades/testdata/validate): golden/output-ийн PDF-үүд оролт болно.
  for (const f of readdirSync(join(g, "output")).sort()) out.set(`${dst}/output/${f}`, readFileSync(join(g, "output", f)));
  const v = join(src, "pades/testdata/validate");
  const vdst = "test/fixtures/pades/validate";
  for (const f of ["manifest.json", "README.md"]) out.set(`${vdst}/${f}`, readFileSync(join(v, f)));
  for (const sub of ["input", "http", "pki"]) {
    for (const f of readdirSync(join(v, sub)).sort()) {
      if (!f.endsWith(".key.pem")) out.set(`${vdst}/${sub}/${f}`, readFileSync(join(v, sub, f)));
    }
  }
  const fonts = join(src, "pades/assets/fonts");
  const fdst = "src/pades/assets";
  out.set(`${fdst}/OFL.txt`, readFileSync(join(fonts, "OFL.txt")));
  out.set(`${fdst}/chain.ts`, Buffer.from(chainModule(join(src, "pades/internal/eidcrypto/chain"))));
  out.set(`${fdst}/fonts.ts`, Buffer.from(fontsModule(fonts)));
  return out;
}

function fontsModule(dir) {
  const font = (name) => {
    const m = JSON.parse(readFileSync(join(dir, `${name}.metrics.json`), "utf8"));
    const z = readFileSync(join(dir, `${name}.ttf.zlib`)).toString("base64");
    return `{
  psName: ${JSON.stringify(m.psName)},
  length1: ${m.length1},
  ascent: ${m.ascent},
  descent: ${m.descent},
  capHeight: ${m.capHeight},
  bbox: ${JSON.stringify(m.bbox)} as [number, number, number, number],
  widths: ${JSON.stringify(m.widths)},
  cmap: ${JSON.stringify(m.cmap)} as [number, number][],
  stream: ${JSON.stringify(z)},
}`;
  };
  return `// ҮҮСГЭСЭН ФАЙЛ — бүү зас. scripts/sync-pades-golden.mjs (Go reference ${GO_SDK_COMMIT.slice(0, 12)} pades/assets/fonts).
// Noto Sans Regular/Bold (subset), SIL OFL 1.1 — ./OFL.txt. stream = FontFile2-ийн байт (zlib, тогтмол), base64.

export interface FontAsset {
  psName: string;
  length1: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  /** glyph ID → өргөн (1/1000 em). */
  widths: number[];
  /** [Unicode code point, glyph ID], code point-оор эрэмбэлсэн. */
  cmap: [number, number][];
  /** FontFile2 stream-ийн байт (base64). */
  stream: string;
}

export const REGULAR: FontAsset = ${font("NotoSans-Regular")};

export const BOLD: FontAsset = ${font("NotoSans-Bold")};
`;
}

/** Шигтгэсэн нийтийн eID гинж (01 root, 02–05) — DER base64. */
function chainModule(dir) {
  const der = (f) => {
    const pem = readFileSync(join(dir, f), "utf8");
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
    if (!m) throw new Error(`${f}: PEM алга`);
    return m[1].replace(/\s+/g, "");
  };
  const files = readdirSync(dir).filter((f) => f.endsWith(".pem")).sort();
  const root = files.filter((f) => f.startsWith("01-"));
  const inter = files.filter((f) => !f.startsWith("01-"));
  const issuers = files.filter((f) => f.startsWith("04-") || f.startsWith("05-"));
  const list = (fs) => "[\n" + fs.map((f) => `  // ${f}\n  ${JSON.stringify(der(f))},\n`).join("") + "]";
  return `// ҮҮСГЭСЭН ФАЙЛ — бүү зас. scripts/sync-pades-golden.mjs (Go reference ${GO_SDK_COMMIT.slice(0, 12)} pades/internal/eidcrypto/chain).
// Нийтийн PKI гинж (DER base64). Итгэлийн тулгуур нь зөвхөн 01; бусад нь гинж бүтээх завсрын CA; 04/05 — eID олгогч.

export const NATIONAL_ROOT: string[] = ${list(root)};

export const INTERMEDIATES: string[] = ${list(inter)};

export const EID_ISSUERS: string[] = ${list(issuers)};
`;
}

function listRepo() {
  const files = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk("test/fixtures/pades/golden");
  walk("test/fixtures/pades/validate");
  walk("src/pades/assets");
  return files;
}

const { dir, cleanup } = goSource();
try {
  const want = expected(dir);
  if (check) {
    const bad = [];
    for (const [p, b] of want) {
      const abs = join(root, p);
      if (!existsSync(abs) || !readFileSync(abs).equals(b)) bad.push(p);
    }
    for (const p of listRepo()) if (!want.has(p)) bad.push(`${p} (илүү)`);
    if (bad.length) {
      console.error(`pades golden: бэхэлсэн Go ${GO_SDK_COMMIT}-тэй зөрөв (node scripts/sync-pades-golden.mjs):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`pades golden: ${want.size} файл Go ${GO_SDK_COMMIT.slice(0, 12)}-тэй ижил`);
  } else {
    rmSync(join(root, "test/fixtures/pades/golden"), { recursive: true, force: true });
    rmSync(join(root, "test/fixtures/pades/validate"), { recursive: true, force: true });
    for (const [p, b] of want) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), b);
    }
    console.log(`pades golden: ${want.size} файл хуулав (Go ${GO_SDK_COMMIT.slice(0, 12)})`);
  }
} finally {
  cleanup();
}
