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
  prepare: { reason?: string; claimedRole?: string; docId?: string; verifyPage?: boolean; fileName?: string; lang?: "mn" | "en"; appearance?: pades.PadesAppearance };
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
      appearance: c.prepare.appearance,
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
    // Өмнөх гарын үсгийн revision = тэр гарын үсгийн sigRevSha256 (CA горим A-ийн sig_rev_sha256-тай ижил тодорхойлолт:
    // doc[0 : ByteRange[2]+ByteRange[3]]) — горим A-ийн өмнөх мөрийг бүртгэлд заахад.
    const ref = String(c.input).startsWith("case:") ? M.cases.find((x) => x.name === String(c.input).slice(5)) : undefined;
    assert.deepEqual(r.priorRevisionSha256, ref ? [ref.expect.sigRevSha256] : [], `${c.name}: priorRevisionSha256`);
    assert.equal(r.inSha256, e.inputSha256);
    assert.equal(r.docId, e.docId);
    outputs.set(c.name, r.pdf);
    n++;
  }
  assert.equal(n, M.cases.length);
  assert.ok(n >= 16, "golden case цөөн");
  assert.ok(M.cases.filter((c) => c.prepare.appearance).length >= 5, "харагдах golden case цөөн");
});

// ── LTV retry (complete, ltvRetries): OCSP/CRL түр унавал ижил state + гарын үсгээр SDK өөрөө давтана ─────────────────

/** Эхний non-error golden case-ийн prepare (LTV retry тестэд). */
async function firstPrepared(): Promise<{ c: Case; p: pades.PadesPrepared }> {
  const c = M.cases.find((x) => !x.expect.error && !x.input.startsWith("case:"))!;
  const p = await pades.prepare(read(c.input), {
    signerCert: pem("citizen"),
    chain: ["04", "03", "02"].map(pem),
    signingTime: new Date(M.signingTime),
    reason: c.prepare.reason,
    claimedRole: c.prepare.claimedRole,
    docId: c.prepare.docId,
    verifyPage: c.prepare.verifyPage,
    fileName: c.prepare.fileName,
    lang: c.prepare.lang,
    appearance: c.prepare.appearance,
  });
  return { c, p };
}

/** TSA-аас бусад (OCSP/CRL) таталт `down()` үнэн үед 404 — CRL толь түр унасантай ижил. */
function flakyFetch(down: () => boolean): pades.PadesCompleteOptions["fetch"] {
  const inner = replayFetch([]);
  return async (url, init) => {
    if (!url.startsWith("http://tsa.pki.test/") && down()) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return inner!(url, init);
  };
}

function ltvOpts(c: Case, extra: Partial<pades.PadesCompleteOptions>): pades.PadesCompleteOptions {
  return {
    tsaUrl: "http://tsa.pki.test/",
    roots: [pem("root")],
    httpsUpgrade: false,
    now: () => new Date(M.now),
    nonce: () => seededNonce(`golden-nonce:${c.name}`),
    ...extra,
  };
}

test("pades complete — LTV 2 удаа унаад 3 дахь нь амжвал байт-ижил гаралт (1 с, 3 с + jitter)", async () => {
  const { c, p } = await firstPrepared();
  const waits: number[] = [];
  const r = await pades.complete(
    p.state,
    Buffer.from(String(c.expect.signature), "hex"),
    ltvOpts(c, { fetch: flakyFetch(() => waits.length < 2), sleep: async (ms) => void waits.push(ms) }),
  );
  assert.equal(r.outSha256, c.expect.outSha256);
  assert.equal(waits.length, 2);
  assert.ok(waits[0]! >= 1000 && waits[0]! <= 1250, `1-р хүлээлт ${waits[0]}`);
  assert.ok(waits[1]! >= 3000 && waits[1]! <= 3750, `2-р хүлээлт ${waits[1]}`);
});

test("pades complete — LTV 3 оролдлого бүгд унавал LTV_UNAVAILABLE (retryable); ltvRetries 0 бол давтахгүй", async () => {
  const { c, p } = await firstPrepared();
  const sig = Buffer.from(String(c.expect.signature), "hex");
  const waits: number[] = [];
  await assert.rejects(
    () => pades.complete(p.state, sig, ltvOpts(c, { fetch: flakyFetch(() => true), sleep: async (ms) => void waits.push(ms) })),
    (e: unknown) => e instanceof pades.PadesError && e.code === "LTV_UNAVAILABLE" && e.retryable,
  );
  assert.equal(waits.length, 2);
  const none: number[] = [];
  await assert.rejects(
    () => pades.complete(p.state, sig, ltvOpts(c, { fetch: flakyFetch(() => true), sleep: async (ms) => void none.push(ms), ltvRetries: 0 })),
    (e: unknown) => e instanceof pades.PadesError && e.code === "LTV_UNAVAILABLE",
  );
  assert.equal(none.length, 0);
  await assert.rejects(
    () => pades.complete(p.state, sig, ltvOpts(c, { fetch: flakyFetch(() => true), ltvRetries: -1 })),
    (e: unknown) => e instanceof pades.PadesError && e.code === "REQUEST_INVALID",
  );
});

test("pades complete — signal: retry-ийн хүлээлтэд цуцлавал AbortError, дахин татахгүй; урьдчилан цуцалсан бол сүлжээгүй", async () => {
  const { c, p } = await firstPrepared();
  const sig = Buffer.from(String(c.expect.signature), "hex");
  const ac = new AbortController();
  let calls = 0;
  let afterAbort = 0;
  const down = flakyFetch(() => true)!;
  const fetch: pades.PadesCompleteOptions["fetch"] = async (url, init) => {
    calls++;
    if (ac.signal.aborted) afterAbort++;
    return down(url, init);
  };
  await assert.rejects(
    () =>
      pades.complete(p.state, sig, ltvOpts(c, {
        fetch,
        signal: ac.signal,
        sleep: () => {
          ac.abort();
          return new Promise(() => {}); // хэзээ ч дуусахгүй — зөвхөн abort тасална
        },
      })),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.ok(calls > 0);
  assert.equal(afterAbort, 0);
  calls = 0;
  await assert.rejects(
    () => pades.complete(p.state, sig, ltvOpts(c, { fetch, signal: AbortSignal.abort() })),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(calls, 0);
});
