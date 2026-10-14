#!/usr/bin/env node
// changelog.d/ фрагментууд ↔ CHANGELOG.md (changelog.d/README.md).
//
//   node scripts/changelog.mjs assemble <version> [YYYY-MM-DD] [fragment…]
//       Фрагментуудыг (өгөөгүй бол changelog.d/*-ийн бүгдийг, нэрийн дарааллаар) CHANGELOG.md-ийн «# Changelog»-ийн
//       доор «## <version> — <огноо>» гарчгаар оруулж, файлуудыг устгана. Release commit-д (version bump-тай хамт).
//   node scripts/changelog.mjs check-release <version>
//       Release tag-ийн шалгалт: changelog.d-д фрагмент үлдээгүй, CHANGELOG.md-д «## <version>» гарчиг бий.
//   node scripts/changelog.mjs check-pr <base-sha>
//       PR-ийн шалгалт: <base-sha>...HEAD нь changelog.d-ийн фрагмент эсвэл (release нэгтгэл) CHANGELOG.md-д хүрсэн.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const DIR = "changelog.d";
const FILE = "CHANGELOG.md";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  process.stderr.write(`changelog: ${msg}\n`);
  process.exit(1);
}

function fragments() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => join(DIR, f));
}

function hasHeading(text, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${esc}(?:\\s|$)`, "m").test(text);
}

function today() {
  // Хэрэглэгчийн бүс (+08).
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "assemble": {
    const [version, dateArg, ...files] = args;
    if (!version || !VERSION_RE.test(version)) fail("assemble <version> [YYYY-MM-DD] [fragment…]");
    const date = dateArg ?? today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`огноо буруу: ${date}`);
    const list = files.length ? files.map((f) => (f.includes("/") ? f : join(DIR, f))) : fragments();
    if (list.length === 0) fail("changelog.d-д фрагмент алга");
    const text = readFileSync(FILE, "utf8");
    if (hasHeading(text, version)) fail(`${FILE}-д «## ${version}» аль хэдийн бий`);
    const head = "# Changelog\n";
    if (!text.startsWith(head)) fail(`${FILE} «# Changelog»-оор эхлэх ёстой`);
    const body = list.map((f) => readFileSync(f, "utf8").trimEnd()).join("\n");
    writeFileSync(FILE, `${head}## ${version} — ${date}\n\n${body}\n\n${text.slice(head.length).replace(/^\n+/, "")}`);
    for (const f of list) rmSync(f);
    process.stdout.write(`${FILE}: ## ${version} — ${list.map((f) => basename(f)).join(", ")}\n`);
    break;
  }
  case "check-release": {
    const [version] = args;
    if (!version || !VERSION_RE.test(version)) fail("check-release <version>");
    const left = fragments();
    if (left.length) fail(`release ${version}: нэгтгээгүй фрагмент — ${left.join(", ")} (scripts/changelog.mjs assemble)`);
    if (!hasHeading(readFileSync(FILE, "utf8"), version)) fail(`release ${version}: ${FILE}-д «## ${version}» гарчиг алга`);
    process.stdout.write(`changelog: ${version} ✔\n`);
    break;
  }
  case "check-pr": {
    const [base] = args;
    if (!base) fail("check-pr <base-sha>");
    const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const ok = changed.some((f) => f === FILE || (f.startsWith(`${DIR}/`) && f.endsWith(".md") && f !== `${DIR}/README.md`));
    if (!ok) fail(`PR-д ${DIR}/<YYYY-MM-DD>-<сэдэв>.md фрагмент алга (${DIR}/README.md)`);
    process.stdout.write("changelog: фрагмент ✔\n");
    break;
  }
  default:
    fail("assemble | check-release | check-pr");
}
