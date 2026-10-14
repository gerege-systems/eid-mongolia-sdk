// /pades — алдааны кодууд, хөтчийн https upgrade / CRL толин хуулбар, үндсэн entry-д pades код орохгүй.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as pades from "../dist/pades.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, G)));
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const M = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as {
  signingTime: string;
  now: string;
  http: Record<string, string>;
  cases: { name: string; input: string; prepare: Record<string, string | boolean>; expect: Record<string, string> }[];
};
const CASE = M.cases.find((c) => c.name === "quartz-pdf13")!;
const base: pades.PadesPrepareOptions = {
  signerCert: pem("citizen"),
  chain: ["04", "03", "02"].map(pem),
  signingTime: new Date(M.signingTime),
  docId: CASE.prepare.docId as string,
  verifyPage: true,
  fileName: "a.pdf",
};
const code = (c: pades.PadesErrorCode) => (e: unknown) => e instanceof pades.PadesError && e.code === c;

function replay(drop: (key: string) => boolean = () => false): pades.PadesCompleteOptions["fetch"] {
  return async (url, init) => {
    const key = `${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`;
    const f = M.http[key];
    if (!f || drop(key)) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = read(f);
    return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  };
}

const nonce = (name: string) => () =>
  new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(`golden-nonce:${name}`), Buffer.of(0)])).digest().subarray(0, 8));

const completeOpts = (drop?: (k: string) => boolean): pades.PadesCompleteOptions => ({
  tsaUrl: "http://tsa.pki.test/",
  roots: [pem("root")],
  fetch: replay(drop),
  httpsUpgrade: false,
  now: () => new Date(M.now),
  sleep: async () => {},
  nonce: nonce(CASE.name),
});

test("PadesError — код, retryable", () => {
  const e = new pades.PadesError("TSA_UNAVAILABLE", "x");
  assert.equal(e.retryable, true);
  assert.equal(e.message, "TSA_UNAVAILABLE: x");
  assert.equal(new pades.PadesError("SIGNATURE_INVALID", "x").retryable, false);
  assert.ok(pades.PADES_ERROR_CODES.includes("PDF_LOCKED"));
  assert.equal(pades.profileVersion(), "pades-client/1");
});

test("prepare — оролт/options-ийн алдаа", async () => {
  const pdf = read(CASE.input);
  await assert.rejects(() => pades.prepare(new TextEncoder().encode("hello"), base), code("PDF_INVALID"));
  await assert.rejects(() => pades.prepare(new Uint8Array((10 << 20) - (256 << 10) + 1), base), code("PDF_TOO_LARGE"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, signerCert: new Uint8Array([1, 2]) }), code("SIGNER_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, lang: "de" as "en" }), code("REQUEST_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, docId: "NOT-A-UUID" }), code("REQUEST_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, fileName: " ​ " }), code("REQUEST_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, claimedRole: "x".repeat(901) }), code("REQUEST_INVALID"));
  // Шигтгэсэн (бодит) eID гинжид тестийн иргэний олгогч алга → chain шаардана.
  await assert.rejects(() => pades.prepare(pdf, { ...base, chain: undefined }), code("SIGNER_INVALID"));
  // Санамсаргүй docId (v4 UUID), state хадгалагдана.
  const p = await pades.prepare(pdf, { ...base, docId: undefined, verifyPage: false });
  assert.match(p.docId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(p.dtbs.length, 32);
});

test("complete — SIGNATURE_INVALID / STATE_INVALID / TSA_UNAVAILABLE / LTV_UNAVAILABLE; дараа нь амжилттай", async () => {
  const p = await pades.prepare(read(CASE.input), { ...base, fileName: CASE.prepare.fileName as string, lang: "mn" });
  const sig = Buffer.from(CASE.expect.signature!, "hex");
  await assert.rejects(() => pades.complete(p.state, new Uint8Array(256).fill(1), completeOpts()), (e: unknown) => code("SIGNATURE_INVALID")(e) && !(e as pades.PadesError).retryable);
  await assert.rejects(() => pades.complete(new Uint8Array([1, 2, 3]), sig, completeOpts()), code("STATE_INVALID"));
  const tampered = p.state.slice();
  tampered[tampered.length - 10] ^= 1;
  await assert.rejects(() => pades.complete(tampered, sig, completeOpts()), code("STATE_INVALID"));
  await assert.rejects(() => pades.complete(p.state, sig, completeOpts((k) => k.includes("tsa.pki.test"))), (e: unknown) => code("TSA_UNAVAILABLE")(e) && (e as pades.PadesError).retryable);
  await assert.rejects(() => pades.complete(p.state, sig, completeOpts((k) => k.includes("/04 ") || k.includes("04.crl"))), code("LTV_UNAVAILABLE"));
  // base64 мөрөөр (session signature.value) — ижил state-ээр дахин оролдоно.
  const r = await pades.complete(p.state, sig.toString("base64"), completeOpts());
  assert.equal(r.outSha256, CASE.expect.outSha256);

  // Гарын үсэгтэй баримтад өөр docId → REQUEST_INVALID; docId хуудаснаас.
  await assert.rejects(() => pades.prepare(r.pdf, { ...base, docId: "00000000-0000-4000-8000-000000000000" }), code("REQUEST_INVALID"));
  const p2 = await pades.prepare(r.pdf, { ...base, docId: undefined });
  assert.equal(p2.docId, CASE.prepare.docId);
  // Гарын үсгийн revision-ийг эвдвэл өмнөх гарын үсэг хүчингүй.
  const broken = r.pdf.slice();
  broken[100] ^= 1;
  await assert.rejects(() => pades.prepare(broken, base), code("PDF_PRIOR_SIGNATURE_INVALID"));
});

test("complete — хөтөч: http → https зөвхөн allowlist-д, бусдыг татахгүй", async () => {
  const p = await pades.prepare(read(CASE.input), { ...base, fileName: CASE.prepare.fileName as string, lang: "mn" });
  const sig = Buffer.from(CASE.expect.signature!, "hex");
  const urls: string[] = [];
  const spy: pades.PadesCompleteOptions["fetch"] = async (url) => {
    urls.push(url);
    return { status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(() => pades.complete(p.state, sig, { fetch: spy, httpsUpgrade: true, tsaUrl: "http://tsa.timeserver.mn/" }), code("TSA_UNAVAILABLE"));
  assert.deepEqual(urls, ["https://tsa.timeserver.mn/"]);
  urls.length = 0;
  await assert.rejects(() => pades.complete(p.state, sig, { fetch: spy, httpsUpgrade: true, tsaUrl: "http://tsa.pki.test/" }), code("TSA_UNAVAILABLE"));
  assert.deepEqual(urls, [], "allowlist-ээс гадуурх http-г татахгүй");
});

test("үндсэн entry /pades-ийн кодыг агуулахгүй", () => {
  const main = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.ok(!main.includes("EIDPADES1") && !main.includes("NotoSans"), "үндсэн entry pades татаж байна");
});
