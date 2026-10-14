// /pades conformance: Go reference-ийн golden (test/fixtures/pades/golden, scripts/sync-pades-golden.mjs-ээр бэхэлсэн
// commit) — prepare (digest, DTBS, signedAttrs, prepared/page sha256, ByteRange, docId, алдааны код) ба complete-ийн БҮТЭН
// гаралт (outSha256, CMS, sigRev, priorCms) байт-ижил. TSA/OCSP/CRL = тогтмол fixture (сүлжээгүй), nonce = WIRE.md §4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as pades from "../dist/pades.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, G)));
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Case {
  name: string;
  input: string;
  prepare: { reason?: string; claimedRole?: string; docId?: string; verifyPage?: boolean; fileName?: string; lang?: "mn" | "en" };
  expect: Record<string, unknown> & { error?: string };
}
interface Manifest {
  profile: string;
  signingTime: string;
  now: string;
  http: Record<string, string>;
  cases: Case[];
}
const M = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as Manifest;

/** WIRE.md §4: блок k = SHA-256(prev ‖ k), prev = seed эхэндээ. */
function seededNonce(seed: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(seed), Buffer.of(0)])).digest().subarray(0, 8));
}

function replayFetch(log: string[]): pades.PadesCompleteOptions["fetch"] {
  return async (url, init) => {
    const body = init.body ?? new Uint8Array();
    const key = `${init.method} ${url} ${sha(body).slice(0, 16)}`;
    log.push(key);
    const file = M.http[key];
    if (!file) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = read(file);
    return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  };
}

test("pades golden — Go reference-тэй байт-ижил (prepare + complete)", async () => {
  assert.equal(M.profile, pades.PROFILE_VERSION);
  const chain = ["04", "03", "02"].map(pem);
  const outputs = new Map<string, Uint8Array>();
  let n = 0;
  for (const c of M.cases) {
    const input = c.input.startsWith("case:") ? outputs.get(c.input.slice(5)) : read(c.input);
    assert.ok(input, `${c.name}: оролт алга`);
    assert.equal(sha(input), c.expect.inputSha256, `${c.name}: inputSha256`);
    const opts: pades.PadesPrepareOptions = {
      signerCert: pem("citizen"),
      chain,
      signingTime: new Date(M.signingTime),
      reason: c.prepare.reason,
      claimedRole: c.prepare.claimedRole,
      docId: c.prepare.docId,
      verifyPage: c.prepare.verifyPage,
      fileName: c.prepare.fileName,
      lang: c.prepare.lang,
    };
    if (c.expect.error) {
      await assert.rejects(
        () => pades.prepare(input, opts),
        (e: unknown) => e instanceof pades.PadesError && e.code === c.expect.error,
        `${c.name}: ${c.expect.error}`,
      );
      n++;
      continue;
    }
    const p = await pades.prepare(input, opts);
    const e = c.expect as Record<string, string | number[] | string[] | boolean | number | undefined>;
    assert.equal(hex(p.digest), e.digest, `${c.name}: digest`);
    assert.equal(hex(p.dtbs), e.dtbs, `${c.name}: dtbs`);
    assert.equal(p.docId, e.docId, `${c.name}: docId`);
    // state (Go state.go формат): "EIDPADES1" ‖ uint32 ‖ JSON ‖ prepared PDF.
    const st = Buffer.from(p.state);
    assert.equal(st.subarray(0, 9).toString(), "EIDPADES1");
    const hl = st.readUInt32BE(9);
    const head = JSON.parse(st.subarray(13, 13 + hl).toString()) as { byteRange: number[]; preparedSha256: string; signedAttrs: string };
    assert.equal(sha(st.subarray(13 + hl)), e.preparedSha256, `${c.name}: preparedSha256`);
    assert.equal(head.preparedSha256, e.preparedSha256);
    assert.deepEqual(head.byteRange, e.byteRange, `${c.name}: byteRange`);
    assert.equal(Buffer.from(head.signedAttrs, "base64").toString("hex"), e.signedAttrs, `${c.name}: signedAttrs`);
    const log: string[] = [];
    const r = await pades.complete(p.state, Buffer.from(String(e.signature), "hex"), {
      tsaUrl: "http://tsa.pki.test/",
      roots: [pem("root")],
      fetch: replayFetch(log),
      httpsUpgrade: false,
      now: () => new Date(M.now),
      sleep: async (ms) => assert.fail(`${c.name}: хүлээлт ${ms} мс (now нь genTime+2с-ээс хойш)`),
      nonce: () => seededNonce(`golden-nonce:${c.name}`),
    });
    assert.equal(sha(r.cms), e.cmsSha256, `${c.name}: cmsSha256`);
    assert.equal(r.sigRevSha256, e.sigRevSha256, `${c.name}: sigRevSha256`);
    assert.equal(r.outSha256, e.outSha256, `${c.name}: outSha256`);
    assert.equal(sha(r.pdf), e.outSha256);
    assert.equal(r.revIndex, e.revIndex, `${c.name}: revIndex`);
    assert.equal(r.hasPage, e.hasPage === true, `${c.name}: hasPage`);
    assert.equal(r.pageSha256, e.pageSha256 ?? "", `${c.name}: pageSha256`);
    assert.deepEqual(r.priorCmsSha256, e.priorCmsSha256 ?? [], `${c.name}: priorCmsSha256`);
    assert.equal(r.inSha256, e.inputSha256);
    assert.equal(r.docId, e.docId);
    outputs.set(c.name, r.pdf);
    n++;
  }
  assert.equal(n, M.cases.length);
  assert.ok(n >= 11, "golden case цөөн");
});
