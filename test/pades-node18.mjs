// /pades smoke on old Node (≥18: global crypto үгүй, --experimental-strip-types үгүй) — CI-ийн node18 job.
// ESM ба CJS entry хоёулаа WASM ачаалж, НАТИВ Go-той ижил DTBS гаргана.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { X509Certificate } from "node:crypto";
import * as esm from "../dist/pades.js";

const fix = (n) => new URL(`./fixtures/pades/${n}`, import.meta.url);
const der = (n) => new Uint8Array(new X509Certificate(readFileSync(fix(n))).raw);
const V = JSON.parse(readFileSync(fix("vectors.json"), "utf8"));
const v = V.prepare.find((x) => x.name === "objstm-nopage");
const cjs = createRequire(import.meta.url)("../dist/pades.cjs");

for (const [name, m] of [["esm", esm], ["cjs", cjs]]) {
  const p = await m.prepare(new Uint8Array(readFileSync(fix(v.input))), {
    signerCert: der("leaf.pem"), chain: [der("root.pem")], signingTime: new Date(v.options.signingTime), docId: v.options.docId,
  });
  assert.equal(Buffer.from(p.dtbs).toString("hex"), v.dtbs, `${name}: dtbs`);
  console.log(`ok ${name} ${process.version}`);
}
