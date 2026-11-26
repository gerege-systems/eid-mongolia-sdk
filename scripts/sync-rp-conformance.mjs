#!/usr/bin/env node
// Go reference (gerege-systems/eid-mongolia-sdk-go, бэхэлсэн commit)-оос RP SDK-ийн conformance корпусыг хуулна:
//   testdata/conformance/** (pki/keys/ — генераторын хувийн түлхүүр — хуулахгүй) → test/fixtures/conformance/
//
//   node scripts/sync-rp-conformance.mjs            — хуулж бичнэ (GO_SDK_DIR=<clone> өгвөл clone хийхгүй, commit-ийг шалгана)
//   node scripts/sync-rp-conformance.mjs --check    — репо дахь хуулбар бэхэлсэн commit-тэй байт-ижил эсэх (CI)
//
// Бэхэлгээг солиход: RP_CONFORMANCE_COMMIT-ийг засаад ажиллуулж diff-ийг commit-д оруулна. Формат:
// test/fixtures/conformance/README.md; ажиллуулагч: test/conformance.test.ts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GO_SDK_REPO = "https://github.com/gerege-systems/eid-mongolia-sdk-go";
// rp-conformance/1 — Go PR «test/rp-conformance-v1» (tag rp-conformance-v1 merge-ийн дараа).
export const RP_CONFORMANCE_COMMIT = "a0b00e248680dd00de23135330ede19b538417b0";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const SRC = "testdata/conformance";
const DST = "test/fixtures/conformance";

function goSource() {
  const dir = process.env.GO_SDK_DIR;
  if (dir) {
    const got = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (got !== RP_CONFORMANCE_COMMIT) throw new Error(`GO_SDK_DIR ${got} ≠ бэхэлсэн ${RP_CONFORMANCE_COMMIT}`);
    return { dir, cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "eid-go-sdk-"));
  const git = (...a) => execFileSync("git", ["-C", tmp, ...a], { stdio: ["ignore", "ignore", "inherit"] });
  git("init", "-q");
  git("fetch", "-q", "--depth", "1", GO_SDK_REPO, RP_CONFORMANCE_COMMIT);
  git("checkout", "-q", "FETCH_HEAD");
  return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function walk(base, rel, out) {
  const abs = join(base, rel);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(base, r, out);
    else out.push(r);
  }
  return out;
}

/** Хүлээгдэх файлууд: репо дахь зам → агуулга. */
function expected(src) {
  const out = new Map();
  for (const f of walk(join(src, SRC), "", [])) {
    if (f.startsWith("pki/keys/")) continue;
    out.set(`${DST}/${f}`, readFileSync(join(src, SRC, f)));
  }
  if (!out.has(`${DST}/manifest.json`)) throw new Error(`${SRC}/manifest.json алга (Go ${RP_CONFORMANCE_COMMIT})`);
  return out;
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
    for (const p of walk(root, DST, [])) if (!want.has(p)) bad.push(`${p} (илүү)`);
    if (bad.length) {
      console.error(`rp conformance: бэхэлсэн Go ${RP_CONFORMANCE_COMMIT}-тэй зөрөв (node scripts/sync-rp-conformance.mjs):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`rp conformance: ${want.size} файл Go ${RP_CONFORMANCE_COMMIT.slice(0, 12)}-тэй ижил`);
  } else {
    rmSync(join(root, DST), { recursive: true, force: true });
    for (const [p, b] of want) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), b);
    }
    console.log(`rp conformance: ${want.size} файл хуулав (Go ${RP_CONFORMANCE_COMMIT.slice(0, 12)})`);
  }
} finally {
  cleanup();
}
