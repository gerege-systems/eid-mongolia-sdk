// Organisation seal stamp (APPEARANCE_SPEC.md §6, golden v12): the variant rule (§6.1) on hand-made certificate shapes
// and on the golden PKI, the seal content stream (§6.2) and prepare's variant choice. Byte-identity with the Go reference
// is in pades-golden.test.ts (seal-visible, seal-visible-en, seal-visible-third); the validator verdicts (§6.3, both
// mismatch directions) in validate-golden.test.ts. sealPdf (§6.4, Go pades/seal_visible_test.go): the automatic default
// reproduces the Go goldens byte-for-byte where a recorded signature exists; the other cases compare the DTBS sealPdf
// sends with prepare's DTBS for the expected appearance (no seal private key in this repo).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { build } from "esbuild";

import { isSealCertificate } from "../dist/index.js";
import * as pades from "../dist/pades.js";

const T = new URL("./fixtures/pades/", import.meta.url);
const G = new URL("golden/", T);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pemAt = (u: URL) => new Uint8Array(new X509Certificate(readFileSync(u)).raw);
const pem = (n: string) => pemAt(new URL(`pki/${n}.pem`, G));

interface FakeCert {
  isCA: boolean;
  keyUsage: number;
  /** EKU purposes (known and unknown OIDs); [] also for an extension holding an empty SEQUENCE. */
  extKeyUsage: string[];
}
interface Internals {
  sealCertificate(c: FakeCert): boolean;
  sealCertificateDER(der: Uint8Array | undefined): boolean;
  keyUsageBits(bs: Uint8Array): number;
  appearanceContent(p: Record<string, unknown>): string;
  AppearanceError: new (...a: unknown[]) => Error;
}

const tmp = mkdtempSync(join(tmpdir(), "eid-seal-stamp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** src (NodeNext .js imports) bundled into one ESM — the rule and the content stream are internal. */
async function internals(): Promise<Internals> {
  const r = await build({
    stdin: {
      contents: [
        `export { keyUsageBits, sealCertificate, sealCertificateDER } from "./src/pades/x509.ts";`,
        `export { appearanceContent, AppearanceError } from "./src/pades/page/appearance.ts";`,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "error",
  });
  const out = join(tmp, "seal-stamp.mjs");
  writeFileSync(out, r.outputFiles[0]!.contents);
  return (await import(pathToFileURL(out).href)) as Internals;
}

const I = await internals();

const DIGITAL_SIGNATURE = 1;
const NON_REPUDIATION = 2;
const KEY_ENCIPHERMENT = 4;

test("§6.1: e-Seal = not a CA, keyUsage nonRepudiation set and digitalSignature clear, no EKU purpose (as Go / CA)", () => {
  const c = (isCA: boolean, keyUsage: number, extKeyUsage: string[] = []): FakeCert => ({ isCA, keyUsage, extKeyUsage });
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION)), true);
  // Other bits are ignored.
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION | KEY_ENCIPHERMENT)), true);
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION | DIGITAL_SIGNATURE)), false, "citizen SIGN: digitalSignature set");
  assert.equal(I.sealCertificate(c(false, DIGITAL_SIGNATURE)), false);
  assert.equal(I.sealCertificate(c(false, 0)), false, "no keyUsage extension");
  assert.equal(I.sealCertificate(c(true, NON_REPUDIATION)), false, "CA");
  // Any EKU purpose, known or unknown, is not an e-Seal certificate (Go ExtKeyUsage / UnknownExtKeyUsage).
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION, ["1.3.6.1.5.5.7.3.4"])), false, "EKU emailProtection");
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION, ["1.2.3.4.5"])), false, "unknown EKU purpose");
  // An EKU extension that is an empty SEQUENCE has no purpose → still an e-Seal certificate (Go: both lists empty).
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION, [])), true, "EKU extension = empty SEQUENCE");
});

test("keyUsage: only bits 0–8 are read (Go x509); bit 32/33 do not alias digitalSignature/nonRepudiation", () => {
  // BIT STRING contents: unused-bits byte, then the bits MSB first. Bit 1 (nonRepudiation) + bit 32.
  assert.equal(I.keyUsageBits(new Uint8Array([0x07, 0x40, 0x00, 0x00, 0x00, 0x80])), NON_REPUDIATION);
  assert.equal(I.sealCertificate({ isCA: false, keyUsage: I.keyUsageBits(new Uint8Array([0x07, 0x40, 0x00, 0x00, 0x00, 0x80])), extKeyUsage: [] }), true);
  // Only bit 33 set → nothing in bits 0–8.
  assert.equal(I.keyUsageBits(new Uint8Array([0x06, 0x00, 0x00, 0x00, 0x00, 0x40])), 0);
  // Bit 8 (decipherOnly) is still read; bit 9 is not.
  assert.equal(I.keyUsageBits(new Uint8Array([0x07, 0x00, 0x80])), 1 << 8);
  assert.equal(I.keyUsageBits(new Uint8Array([0x06, 0x00, 0x40])), 0);
  assert.equal(I.keyUsageBits(new Uint8Array([0x01, 0xa0])), DIGITAL_SIGNATURE | (1 << 2));
  assert.equal(I.keyUsageBits(new Uint8Array([0x00])), 0);
});

test("§6.1 on the golden PKI; unparsable DER is not an e-Seal certificate; same answer as isSealCertificate", () => {
  const cases: [string, Uint8Array, boolean][] = [
    ["golden seal", pem("seal"), true],
    ["golden citizen", pem("citizen"), false],
    ["golden 04 (CA)", pem("04"), false],
    ["golden root", pem("root"), false],
    ["golden tsa (EKU)", pem("tsa"), false],
    ["seal fixture (ECDSA)", pemAt(new URL("seal/seal.pem", T)), true],
  ];
  for (const [name, der, want] of cases) {
    assert.equal(I.sealCertificateDER(der), want, name);
    assert.equal(isSealCertificate(der), want, `${name}: isSealCertificate`);
  }
  assert.equal(I.sealCertificateDER(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])), false);
  assert.equal(I.sealCertificateDER(undefined), false);
});

const P = { w: 22000, h: 6400, rotate: 0, name: "TEST ONLY Golden Org LLC", role: "Захирал", lang: "mn", date: "2026-10-14 12:00 (+08)", url: "" };

test("§6.2 seal content: no BDC / QR / role line, text at x = pad, frame as the citizen stamp", () => {
  const s = I.appearanceContent({ ...P, seal: true });
  assert.ok(!s.includes("EIDVerify") && !s.includes("BDC") && !s.includes("EMC"), "no marked content");
  assert.ok(!s.includes(" cm\n"), "no QR / no rotation cm");
  const lines = s.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["0.086 0.541 0.31 RG", "1 w", "0.5 0.5 219 63 re S"]);
  const td = lines.filter((l) => l.startsWith("BT "));
  assert.equal(td.length, 3, "name, label, date — the claimedRole is not drawn");
  assert.match(td[0]!, /^BT \/F2 11 Tf 4 [0-9.]+ Td <[0-9A-F]+> Tj ET$/);
  assert.match(td[1]!, /^BT \/F1 9 Tf 4 [0-9.]+ Td /);
  assert.match(td[2]!, /^BT \/F1 9 Tf 4 [0-9.]+ Td /);
  assert.deepEqual(lines.filter((l) => l.endsWith(" rg")), ["0.118 0.118 0.118 rg", "0.086 0.541 0.31 rg", "0.431 0.431 0.431 rg"]);
  // mn and en differ only in the label line.
  const en = I.appearanceContent({ ...P, seal: true, lang: "en" }).split("\n");
  assert.equal(en.filter((l, i) => l !== lines[i]).length, 1);
  // Rotation: the same q / cm / Q wrapper as the citizen stamp.
  const r = I.appearanceContent({ ...P, seal: true, rotate: 90 }).split("\n");
  assert.deepEqual(r.slice(0, 2), ["q", "0 1 -1 0 64 0 cm"]);
  assert.equal(r.at(-2), "Q");
});

test("§6.2 fit: no QR minimum — the smallest one-line-name height is 29.25 pt (f = 7); citizen needs ≥ 45 pt", () => {
  assert.match(I.appearanceContent({ ...P, seal: true, h: 2925 }), /BT \/F2 7 Tf/);
  assert.throws(() => I.appearanceContent({ ...P, seal: true, h: 2924 }), I.AppearanceError);
  assert.throws(() => I.appearanceContent({ ...P, seal: true, w: 800 }), I.AppearanceError, "tw = 0");
  assert.throws(() => I.appearanceContent({ ...P, seal: true, lang: "de" }), I.AppearanceError);
  assert.throws(
    () => I.appearanceContent({ ...P, h: 2925, url: "https://ca.eidmongolia.mn/verify/00000000-0000-4000-8000-000000000000/1" }),
    I.AppearanceError,
  );
});

/** The prepared PDF inside a prepare state ("EIDPADES1" ‖ uint32 ‖ JSON ‖ PDF). */
function preparedPdf(state: Uint8Array): string {
  const st = Buffer.from(state);
  return st.subarray(13 + st.readUInt32BE(9)).toString("latin1");
}

test("prepare: the signer certificate alone selects the stamp variant", async () => {
  const input = new Uint8Array(readFileSync(new URL("input/quartz-pdf13.pdf", G)));
  const chain = ["04", "03", "02"].map(pem);
  const appearance: pades.PadesAppearance = { x: 340, y: 36, width: 220, height: 64 };
  const opts = { chain, signingTime: new Date("2026-10-14T12:00:00+08:00"), appearance };
  const seal = await pades.prepare(input, { ...opts, signerCert: pem("seal") });
  const citizen = await pades.prepare(input, { ...opts, signerCert: pem("citizen") });
  assert.ok(!preparedPdf(seal.state).includes("/EIDVerify"), "seal: no /EIDVerify marker");
  assert.ok(preparedPdf(citizen.state).includes("/EIDVerify"), "citizen: /EIDVerify marker");
  assert.deepEqual(seal.placement, citizen.placement, "placement does not depend on the variant");
  // A 30 pt stamp fits the seal (no QR) but not the citizen stamp (QR module ≥ 1 pt → ≥ 45 pt).
  const small = { ...opts, appearance: { ...appearance, height: 30 } };
  await pades.prepare(input, { ...small, signerCert: pem("seal") });
  await assert.rejects(
    () => pades.prepare(input, { ...small, signerCert: pem("citizen") }),
    (e: unknown) => e instanceof pades.PadesError && e.code === "REQUEST_INVALID",
  );
});

// ── sealPdf (APPEARANCE_SPEC.md §6.4, Go pades.SealPDF) ─────────────────────────────────────────────────────────────

interface GoldenCase {
  name: string;
  input: string;
  signer?: string;
  prepare: { reason?: string; lang?: "mn" | "en"; appearance?: pades.PadesAppearance };
  expect: Record<string, unknown> & { dtbs: string; signature: string; outSha256: string; placement?: pades.PadesPlacement; revIndex: number };
}
const GM = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as { signingTime: string; now: string; http: Record<string, string>; cases: GoldenCase[] };
const gcase = (n: string) => GM.cases.find((c) => c.name === n)!;
const readG = (p: string) => new Uint8Array(readFileSync(new URL(p, G)));
const inputOf = (c: GoldenCase) => (c.input.startsWith("case:") ? readG(`output/${c.input.slice(5)}.pdf`) : readG(c.input));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ORG = "NTRMN-6235972";
const SEAL = pem("seal");
const CHAIN = ["04", "03", "02"].map(pem);
const SIGNING_TIME = new Date(GM.signingTime);
const code = (c: pades.PadesErrorCode) => (e: unknown) => e instanceof pades.PadesError && e.code === c;

/** Golden pki/seal.pem; seal() returns the Go-recorded signature of a golden seal case with that DTBS. */
function goldenSealer(): pades.PadesSealer {
  return {
    getCertificate: async () => ({ certificate: SEAL }),
    seal: async (_org, digest) => {
      const c = GM.cases.find((x) => x.signer === "seal" && x.expect.dtbs === hex(digest));
      if (!c) throw new Error(`no golden seal signature for DTBS ${hex(digest)}`);
      return { signature: new Uint8Array(Buffer.from(c.expect.signature, "hex")), certificate: SEAL };
    },
  };
}

const STOP = new Error("stop after the DTBS");

/** The DTBS sealPdf sends for `input` (the sealer stops the flow there). */
async function sealDtbs(input: Uint8Array, o: pades.PadesSealOptions = {}): Promise<string> {
  const got: string[] = [];
  const s: pades.PadesSealer = {
    getCertificate: async () => ({ certificate: SEAL }),
    seal: async (_org, digest) => {
      got.push(hex(digest));
      throw STOP;
    },
  };
  await assert.rejects(pades.sealPdf(s, ORG, input, { signingTime: SIGNING_TIME, chain: CHAIN, ...o }), (e: unknown) => e === STOP);
  assert.equal(got.length, 1);
  return got[0]!;
}

/** prepare with the seal certificate (as sealPdf calls it) — DTBS, placement, prepared PDF length. */
async function sealPrepared(input: Uint8Array, appearance?: pades.PadesAppearance) {
  const p = await pades.prepare(input, { signerCert: SEAL, chain: CHAIN, signingTime: SIGNING_TIME, appearance });
  const st = Buffer.from(p.state);
  return { dtbs: hex(p.dtbs), placement: p.placement, length: st.length - 13 - st.readUInt32BE(9) };
}

function goldenComplete(name: string): pades.PadesCompleteOptions {
  return {
    tsaUrl: "http://tsa.pki.test/",
    roots: [pem("root")],
    fetch: async (url, init) => {
      const f = GM.http[`${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`];
      if (!f) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      const b = readG(f);
      return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
    },
    httpsUpgrade: false,
    now: () => new Date(GM.now),
    sleep: async (ms) => assert.fail(`${name}: wait ${ms} ms`),
    nonce: () => new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(`golden-nonce:${name}`), Buffer.of(0)])).digest().subarray(0, 8)),
  };
}

/** One page w × h pt with "RECEIPT" at the top (Go smallPDF); `pad` bytes of an unreferenced stream inflate the file. */
function makePdf(w: number, h: number, pad = 0): Uint8Array {
  const content = `BT /F1 6 Tf 4 ${h - 12} Td (RECEIPT) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (pad > 0) objs.push(`<< /Length ${pad} >>\nstream\n${" ".repeat(pad)}\nendstream`);
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

test("sealPdf default = Go golden byte-for-byte: seal-visible (unsigned → moved off the footer), seal-visible-third (after two visible citizen signatures)", async () => {
  for (const name of ["seal-visible", "seal-visible-third"]) {
    const c = gcase(name);
    const input = inputOf(c);
    assert.equal(sha(input), c.expect.inputSha256, `${name}: input`);
    const r = await pades.sealPdf(goldenSealer(), ORG, input, { reason: c.prepare.reason, signingTime: SIGNING_TIME, chain: CHAIN, complete: goldenComplete(name) });
    assert.equal(r.outSha256, c.expect.outSha256, `${name}: outSha256`);
    assert.ok(Buffer.from(r.pdf).equals(Buffer.from(readG(`output/${name}.pdf`))), `${name}: output/${name}.pdf`);
    assert.ok(Buffer.from(r.pdf.subarray(0, input.length)).equals(Buffer.from(input)), `${name}: the input is a byte prefix`);
    assert.deepEqual(r.placement, c.expect.placement, `${name}: placement`);
    assert.equal(r.revIndex, c.expect.revIndex);
    assert.equal(r.hasPage, false);
  }
  // Every signature of these outputs is valid (earlier ones extended by signatures only): validate golden cases
  // seal-visible and seal-after-two-citizens run on the same bytes.
  assert.deepEqual(gcase("seal-visible-third").expect.placement, { page: 2, x: 356, y: 204, width: 220, height: 64, status: "moved" });
});

test("sealPdf explicit appearance = Go golden seal-visible-en byte-for-byte", async () => {
  const c = gcase("seal-visible-en");
  const r = await pades.sealPdf(goldenSealer(), ORG, inputOf(c), {
    signingTime: SIGNING_TIME,
    chain: CHAIN,
    appearance: { ...c.prepare.appearance!, lang: "en" },
    complete: goldenComplete(c.name),
  });
  assert.equal(r.outSha256, c.expect.outSha256);
  assert.deepEqual(r.placement, c.expect.placement);
});

test("sealPdf automatic placement (Go TestSealPDFAutoPlacement): requested / overlap at (pw − 256, 36), page resolved once", async () => {
  const cases: [string, pades.PadesPlacement][] = [
    ["input/quartz-pdf13.pdf", { page: 1, x: 356, y: 36, width: 220, height: 64, status: "requested" }],
    ["input/full-page.pdf", { page: 1, x: 356, y: 36, width: 220, height: 64, status: "overlap" }],
  ];
  for (const [file, want] of cases) {
    const input = readG(file);
    const p = await sealPrepared(input, { page: 1, x: 356, y: 36, width: 220, height: 64 });
    assert.deepEqual(p.placement, want, file);
    assert.equal(await sealDtbs(input), p.dtbs, `${file}: sealPdf DTBS = prepare with the automatic appearance`);
  }
});

test("sealPdf after a verify page in front (Go TestSealPDFVerifyPageFirst): the stamp goes on the last non-verify page 3", async () => {
  const input = readG("output/vpfirst-multi.pdf");
  const p = await sealPrepared(input, { page: 3, x: 356, y: 36, width: 220, height: 64 });
  assert.equal(p.placement?.page, 3);
  assert.equal(p.placement?.width, 220);
  assert.equal(p.placement?.height, 64);
  assert.equal(await sealDtbs(input), p.dtbs);
});

test("sealPdf explicit appearance (Go TestSealPDFExplicitAppearance): exact never moves; an explicit verify page is kept", async () => {
  const signed = readG("output/libreoffice-contract-visible.pdf");
  const exact: pades.PadesAppearance = { page: 1, x: 36, y: 600, width: 200, height: 60, lang: "en", exact: true };
  const pe = await sealPrepared(signed, exact);
  assert.equal(pe.placement?.page, 1);
  assert.equal(pe.placement?.x, 36);
  assert.equal(pe.placement?.y, 600);
  assert.notEqual(pe.placement?.status, "moved");
  assert.equal(await sealDtbs(signed, { appearance: exact }), pe.dtbs);
  const onVerify: pades.PadesAppearance = { page: 3, x: 340, y: 36, width: 220, height: 64 };
  const pv = await sealPrepared(signed, onVerify);
  assert.equal(pv.placement?.page, 3);
  assert.equal(await sealDtbs(signed, { appearance: onVerify }), pv.dtbs);
});

test("sealPdf small pages (Go TestSealPDFSmallPages): 164 pt receipt → fitted 156 × 64 at x = 4; tiny page → invisible; explicit → REQUEST_INVALID", async () => {
  const receipt = makePdf(164, 600);
  const p = await sealPrepared(receipt, { page: 1, x: 4, y: 36, width: 156, height: 64 });
  assert.deepEqual(p.placement, { page: 1, x: 4, y: 36, width: 156, height: 64, status: "requested" });
  assert.equal(await sealDtbs(receipt), p.dtbs);

  const tiny = makePdf(40, 60);
  assert.equal(await sealDtbs(tiny), (await sealPrepared(tiny)).dtbs, "tiny page: the invisible seal");
  await assert.rejects(
    pades.sealPdf(goldenSealer(), ORG, tiny, { signingTime: SIGNING_TIME, chain: CHAIN, appearance: { x: 0, y: 0, width: 40, height: 60 } }),
    code("REQUEST_INVALID"),
  );
});

test("sealPdf automatic stamp over the output size limit → invisible; explicit appearance → PDF_TOO_LARGE", async () => {
  const MAX_INPUT = (10 << 20) - (256 << 10);
  const stamp: pades.PadesAppearance = { page: 1, x: 356, y: 36, width: 220, height: 64 };
  // Measure the invisible and visible revision sizes on a small file, then pad the input to halfway between them.
  const small = makePdf(612, 792, 1);
  const inv = (await sealPrepared(small)).length - small.length;
  const vis = (await sealPrepared(small, stamp)).length - small.length;
  assert.ok(vis - inv > 20_000, `visible − invisible = ${vis - inv}`);
  const big = makePdf(612, 792, 1 + MAX_INPUT - small.length - Math.round((inv + vis) / 2));
  assert.ok(big.length <= MAX_INPUT);
  await assert.rejects(pades.prepare(big, { signerCert: SEAL, chain: CHAIN, signingTime: SIGNING_TIME, appearance: stamp }), code("PDF_TOO_LARGE"));
  assert.equal(await sealDtbs(big), (await sealPrepared(big)).dtbs, "automatic → invisible seal");
  await assert.rejects(
    pades.sealPdf(goldenSealer(), ORG, big, { signingTime: SIGNING_TIME, chain: CHAIN, appearance: stamp }),
    code("PDF_TOO_LARGE"),
  );
});
