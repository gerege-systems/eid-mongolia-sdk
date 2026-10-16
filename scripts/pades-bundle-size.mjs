#!/usr/bin/env node
// /pades (эсвэл аргумент `validate` — /validate)-ийн хөтчийн bundle (минифай, фонт asset-тэй) gzip хэмжээ ≤ 300 KB
// (cross-SDK зорилт). dist/<entry>.js-ээс.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const LIMIT = 300 * 1024;
const entry = process.argv[2] ?? "pades";
const r = await build({
  entryPoints: [new URL(`../dist/${entry}.js`, import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "error",
});
const code = r.outputFiles[0].contents;
const gz = gzipSync(code, { level: 9 }).length;
console.log(`${entry} browser bundle: ${(code.length / 1024).toFixed(1)} KB, gzip ${(gz / 1024).toFixed(1)} KB (хязгаар ${LIMIT / 1024} KB)`);
if (gz > LIMIT) process.exit(1);
