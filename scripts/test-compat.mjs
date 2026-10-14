#!/usr/bin/env node
// `npm test`-ийн тестүүдийг type stripping-гүй Node (18/20)-д ажиллуулна: test/*.test.ts → test/*.compat.mjs (esbuild,
// ../dist/* ба пакетууд external — БҮТЭЭСЭН dist-ийг тестэлнэ; ../src/*.ts импортыг bundle хийнэ), дараа нь node --test.
// Урьдчилан `npm run build` (эсвэл CI-д dist artifact). Тестийн жагсаалт = package.json scripts.test.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tests = pkg.scripts.test.match(/test\/[\w-]+\.test\.ts/g);
const outs = tests.map((t) => t.replace(/\.test\.ts$/, ".compat.mjs"));
try {
  for (let i = 0; i < tests.length; i++) {
    await build({
      entryPoints: [join(root, tests[i])],
      outfile: join(root, outs[i]),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      packages: "external",
      external: ["../dist/*"],
      logLevel: "error",
    });
  }
  const r = spawnSync(process.execPath, ["--test", ...outs], { cwd: root, stdio: "inherit" });
  process.exitCode = r.status ?? 1;
} finally {
  for (const o of outs) rmSync(join(root, o), { force: true });
}
