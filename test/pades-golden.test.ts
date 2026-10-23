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
  prepare: { reason?: string; claimedRole?: string; docId?: string; verifyPage?: boolean; verifyPagePosition?: "last" | "first"; fileName?: string; lang?: "mn" | "en"; appearance?: pades.PadesAppearance };
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
  let nSug = 0;
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
      verifyPagePosition: c.prepare.verifyPagePosition,
      fileName: c.prepare.fileName,
      lang: c.prepare.lang,
      appearance: c.prepare.appearance,
    };
    // PLACEMENT_SPEC.md §6b (golden v7): suggestPlacement on the same input + appearance, field-for-field.
    let sug: pades.PlacementSuggestion | undefined;
    if (c.prepare.appearance) {
      if (c.expect.suggestionError) {
        await assert.rejects(
          () => pades.suggestPlacement(input, c.prepare.appearance!),
          (e: unknown) => e instanceof pades.PadesError && e.code === c.expect.suggestionError,
          `${c.name}: suggestionError ${c.expect.suggestionError}`,
        );
      } else {
        sug = await pades.suggestPlacement(input, c.prepare.appearance);
        assert.deepEqual(sug, c.expect.suggestion, `${c.name}: suggestion`);
        nSug++;
      }
    }
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
    // PLACEMENT_SPEC.md (golden v5): харагдах тохиолдол бүрд эцсийн байршил + төлөв; үл харагдахад байхгүй.
    assert.deepEqual(p.placement, c.expect.placement, `${c.name}: placement`);
    // suggestion ⊇ placement, except page0-two-verify (unsigned input carrying verify pages of the docId passed to
    // prepare — suggestPlacement has no docId there, §6b).
    if (sug && c.name !== "page0-two-verify") {
      const { page, x, y, width, height, status } = sug;
      assert.deepEqual({ page, x, y, width, height, status }, p.placement, `${c.name}: suggestion ⊇ placement`);
    }
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
    assert.ok(Buffer.from(r.pdf).equals(read(`output/${c.name}.pdf`)), `${c.name}: output/${c.name}.pdf-тэй байт-ижил`);
    assert.equal(r.revIndex, e.revIndex, `${c.name}: revIndex`);
    assert.equal(r.hasPage, e.hasPage === true, `${c.name}: hasPage`);
    assert.equal(r.pageSha256, e.pageSha256 ?? "", `${c.name}: pageSha256`);
    assert.deepEqual(r.priorCmsSha256, e.priorCmsSha256 ?? [], `${c.name}: priorCmsSha256`);
    // Өмнөх гарын үсгийн revision = тэр гарын үсгийн sigRevSha256 (CA горим A-ийн sig_rev_sha256-тай ижил тодорхойлолт:
    // doc[0 : ByteRange[2]+ByteRange[3]]) — горим A-ийн өмнөх мөрийг бүртгэлд заахад.
    // Олон өмнөх гарын үсэгтэй бол (golden v5 quartz-pdf13-visible-third) өвөг тохиолдлуудынх хуучнаас нь эхлэн.
    const prior: unknown[] = [];
    for (let ref = c; ref.input.startsWith("case:"); ) {
      ref = M.cases.find((x) => x.name === ref.input.slice(5))!;
      prior.unshift(ref.expect.sigRevSha256);
    }
    assert.deepEqual(r.priorRevisionSha256, prior, `${c.name}: priorRevisionSha256`);
    assert.equal(r.inSha256, e.inputSha256);
    assert.equal(r.docId, e.docId);
    // APPEARANCE_SPEC.md §6.6 (golden v10): images → complete().images (signature, then stamp); none → absent.
    const ap = c.prepare.appearance;
    const imgs = [
      ...(ap?.signatureImage ? [{ kind: "signature", sha256: ap.signatureImage.sha256 }] : []),
      ...(ap?.stampImage ? [{ kind: "stamp", sha256: ap.stampImage.sha256 }] : []),
    ];
    assert.deepEqual(r.images, imgs.length ? imgs : undefined, `${c.name}: images`);
    outputs.set(c.name, r.pdf);
    n++;
  }
  assert.equal(n, M.cases.length);
  // Golden v7: every visible case carries expect.suggestion (or suggestionError).
  const visible = M.cases.filter((c) => c.prepare.appearance);
  assert.ok(visible.every((c) => c.expect.suggestion || c.expect.suggestionError), "golden v7: suggestion алга");
  assert.equal(nSug, visible.filter((c) => c.expect.suggestion).length);
  // §6a: an exact request at a free spot is byte-identical to the auto placement that lands there.
  const prepSha = (name: string): unknown => M.cases.find((c) => c.name === name)?.expect.preparedSha256;
  assert.equal(prepSha("exact-free"), prepSha("table-bottom-visible"), "exact-free = table-bottom-visible");
  assert.equal(prepSha("exact-page0-after-verify"), prepSha("page0-after-verify"), "exact-page0-after-verify = page0-after-verify");
  for (const c of visible.filter((x) => x.prepare.appearance!.exact)) {
    assert.notEqual((c.expect.placement as { status?: string } | undefined)?.status, "moved", `${c.name}: exact → moved`);
  }
  assert.ok(n >= 16, "golden case цөөн");
  assert.ok(M.cases.filter((c) => c.prepare.appearance).length >= 11, "харагдах golden case цөөн");
  // Golden v10: image cases (APPEARANCE_SPEC.md §6).
  for (const name of ["img-signature", "img-signature-stamp", "img-stamp-only", "img-rotated90", "img-second", "img-bad-alpha", "img-stamp-no-role"]) {
    assert.ok(M.cases.some((c) => c.name === name), `golden v10: ${name} алга`);
  }
  for (const s of ["requested", "moved", "overlap"]) {
    assert.ok(M.cases.some((c) => (c.expect.placement as { status?: string } | undefined)?.status === s), `golden-д placement ${s} алга`);
  }
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
    verifyPagePosition: c.prepare.verifyPagePosition,
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
