// /pades smoke on old Node (≥ 18: global crypto үгүй, --experimental-strip-types үгүй) — CI-ийн node18 job.
// ESM ба CJS entry хоёулаа Go reference golden-ий 2 тохиолдлыг (хуудастай / хуудасгүй) БҮТЭН (prepare + complete)
// байт-ижил гаргана.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as esm from "../dist/pades.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const read = (p) => new Uint8Array(readFileSync(new URL(p, G)));
const pem = (n) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const M = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8"));
const cjs = createRequire(import.meta.url)("../dist/pades.cjs");

const fetchReplay = async (url, init) => {
  const key = `${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`;
  const f = M.http[key];
  if (!f) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  const b = read(f);
  return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};

for (const [name, m] of [["esm", esm], ["cjs", cjs]]) {
  for (const c of M.cases.filter((x) => x.name === "quartz-pdf13" || x.name === "quartz-objstm-nopage")) {
    const p = await m.prepare(read(c.input), {
      signerCert: pem("citizen"),
      chain: ["04", "03", "02"].map(pem),
      signingTime: new Date(M.signingTime),
      docId: c.prepare.docId,
      verifyPage: c.prepare.verifyPage,
      fileName: c.prepare.fileName,
      lang: c.prepare.lang,
    });
    assert.equal(Buffer.from(p.dtbs).toString("hex"), c.expect.dtbs, `${name} ${c.name}: dtbs`);
    const r = await m.complete(p.state, Buffer.from(c.expect.signature, "hex"), {
      tsaUrl: "http://tsa.pki.test/",
      roots: [pem("root")],
      fetch: fetchReplay,
      httpsUpgrade: false,
      now: () => new Date(M.now),
      nonce: () => new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(`golden-nonce:${c.name}`), Buffer.of(0)])).digest().subarray(0, 8)),
    });
    assert.equal(r.outSha256, c.expect.outSha256, `${name} ${c.name}: outSha256`);
  }
  console.log(`ok ${name} ${process.version}`);
}
