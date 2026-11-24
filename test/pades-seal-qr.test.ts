// Seal stamp with QR (APPEARANCE_SPEC.md §6.5, golden v13) and prepare's docId rule (§6.6) — Go pades/seal_qr_test.go and
// internal/core TestSealQRContent. Byte identity with the Go goldens is in pades-golden.test.ts (the "sealQr" cases go
// through the internal switch), the validator verdicts (§6.3: marker decides, no fallback) in validate-golden.test.ts.
// This file: the renderer's QR seal path, docIdFromStamps on synthetic documents (earliest stamp, wrong rev, citizen
// source, direct / borrowed / unverified / inherited /V, /Filter rules, read failures), the docId rule through the public
// prepare on golden outputs, and that no public API emits the QR seal stamp.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import * as pades from "../dist/pades.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const V = new URL("./fixtures/pades/validate/", import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const readG = (p: string) => new Uint8Array(readFileSync(new URL(p, G)));
const readV = (p: string) => new Uint8Array(readFileSync(new URL(p, V)));

interface Verified {
  end: number;
  seal: boolean;
}
interface Internals {
  appearanceContent(p: Record<string, unknown>): string;
  AppearanceError: new (...a: unknown[]) => Error;
  APPEARANCE_LABELS: Record<string, string>;
  SEAL_LABELS: Record<string, string>;
  PageWriter: new (reg: unknown, bld: unknown) => { glyphHex(font: number, s: string): string };
  loadFonts(): [unknown, unknown];
  docIdFromStamps(doc: Uint8Array, verified: Map<number, Verified>): string;
  precheck(doc: Uint8Array, issuers: unknown[]): Promise<{ newDoc: boolean; revIndex: number; verified: Map<number, Verified> }>;
  parseCertificate(der: Uint8Array): unknown;
  prepare(pdf: Uint8Array, o: Record<PropertyKey, unknown>): Promise<pades.PadesPrepared>;
  SEAL_QR: symbol;
}

const tmp = mkdtempSync(join(tmpdir(), "eid-seal-qr-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** src bundled into one ESM — the renderer, docIdFromStamps, precheck and the SEAL_QR switch are internal. */
async function internals(): Promise<Internals> {
  const r = await build({
    stdin: {
      contents: [
        `export { appearanceContent, AppearanceError, APPEARANCE_LABELS, SEAL_LABELS } from "./src/pades/page/appearance.ts";`,
        `export { PageWriter, loadFonts } from "./src/pades/page/page.ts";`,
        `export { docIdFromStamps, precheck } from "./src/pades/precheck.ts";`,
        `export { parseCertificate } from "./src/pades/x509.ts";`,
        `export { prepare } from "./src/pades.ts";`,
        `export { SEAL_QR } from "./src/pades/sealqr.ts";`,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
      sourcefile: "seal-qr-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "error",
  });
  const out = join(tmp, "seal-qr.mjs");
  writeFileSync(out, r.outputFiles[0]!.contents);
  return (await import(pathToFileURL(out).href)) as Internals;
}

const I = await internals();

const QR_SEAL_DOC_ID = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f"; // golden seal-qr-visible
const PAGE_DOC_ID = "6f0c2b9e-3a1d-4c55-9b7e-0a1b2c3d4e5f"; // golden quartz-pdf13 (verify page)
const OTHER_DOC_ID = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const URL1 = `https://ca.eidmongolia.mn/verify/${QR_SEAL_DOC_ID}/1`;

// ── §6.5 renderer ────────────────────────────────────────────────────────────────────────────────────────────────────

test("§6.5 content = the citizen stamp (role \"\") with the seal label's glyphs; a claimedRole is never drawn; url \"\" = §6.2", () => {
  const [reg, bld] = I.loadFonts();
  const w = new I.PageWriter(reg, bld);
  for (const lang of ["mn", "en"]) {
    for (const rotate of [0, 90, 180, 270]) {
      const p = { w: 22000, h: 6400, rotate, name: "TEST ONLY Golden Org LLC", role: "Захирал, Тест ХХК", lang, date: "2026-10-14 12:00 (+08)", url: URL1 };
      const citizen = I.appearanceContent({ ...p, role: "" });
      const seal = I.appearanceContent({ ...p, seal: true });
      const want = citizen.replace(w.glyphHex(1, I.APPEARANCE_LABELS[lang]!), w.glyphHex(1, I.SEAL_LABELS[lang]!));
      assert.notEqual(want, citizen, `${lang} rot ${rotate}: label glyphs`);
      assert.equal(seal, want, `${lang} rot ${rotate}: QR seal = citizen + seal label`);
      assert.ok(seal.startsWith(`/EIDVerify <</URL (${URL1})>> BDC\n`) && seal.endsWith("EMC\n"), `${lang} rot ${rotate}: marked content`);
      const plain = I.appearanceContent({ ...p, seal: true, url: "" });
      assert.ok(!plain.includes("EIDVerify") && !plain.includes(" re\n"), `${lang} rot ${rotate}: QR-less seal stamp unchanged`);
    }
  }
  // QR module ≥ 1 pt: n = 37 for the 72-byte URL → H ≥ 45 pt (REQUEST_INVALID below).
  const p = { w: 22000, h: 4499, rotate: 0, name: "TEST ONLY Golden Org LLC", role: "", lang: "mn", date: "2026-10-14 12:00 (+08)", url: URL1, seal: true };
  assert.throws(() => I.appearanceContent(p), I.AppearanceError, "44.99 pt");
  assert.doesNotThrow(() => I.appearanceContent({ ...p, h: 4500 }), "45 pt");
});

// ── §6.6 step 2.2: docIdFromStamps on synthetic documents (Go TestDocIDFromStampsEarliest) ────────────────────────────

/** Go rawPDF: objects 1… in order, xref table, trailer. */
function rawPdf(objs: string[], badOffset: number[] = []): Uint8Array {
  let out = "%PDF-1.7\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(badOffset.includes(i + 1) ? 1 : out.length); // offset 1 = inside the header → "not an objdef"
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n\r\n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
/** 1 Catalog, 2 Pages, 3 Page, then objs from 4. */
const stampPdf = (objs: string[], badOffset: number[] = []) =>
  rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>", ...objs], badOffset);
function stampStream(docId: string, rev: number | string, extra = ""): string {
  const c = `/EIDVerify <</URL (https://ca.eidmongolia.mn/verify/${docId}/${rev})>> BDC\nEMC\n`;
  return `<< /Length ${c.length}${extra} >>\nstream\n${c}endstream`;
}
const stampWidget = (sig: string, form: number) => `<< /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R /F 4 /FT /Sig /T (S) /V ${sig} /AP << /N ${form} 0 R >> >>`;
const stampSig = (end: number) => `<< /Type /Sig /ByteRange [0 10 20 ${end - 20}] /Contents <00> >>`;
const seal = (end: number): Verified => ({ end, seal: true });
const citizen = (end: number): Verified => ({ end, seal: false });

const LATER = "11111111-1111-4111-8111-111111111111";
const EARLIER = "22222222-2222-4222-8222-222222222222";
const FORGED = "33333333-3333-4333-8333-333333333333";
// 4 widget (later, lower numbers) → 6 sig (end 200, position 2); 7 widget (earlier, higher numbers) → 9 sig (end 50, position 1).
const BASE = [stampWidget("6 0 R", 5), stampStream(LATER, 2), stampSig(200), stampWidget("9 0 R", 8), stampStream(EARLIER, 1), stampSig(50)];
const SEALS = () => new Map([[6, seal(200)], [9, seal(50)]]);
const plus = (...extra: string[]) => [...BASE, ...extra];
/** One e-Seal signature (6, end 50, position 1) whose stamp stream carries `extra` in its dictionary. */
const one = (extra: string, ...more: string[]) => [stampWidget("6 0 R", 5), stampStream(EARLIER, 1, extra), stampSig(50), ...more];
const ONE = () => new Map([[6, seal(50)]]);

test("§6.6 2.2: the earliest-signed marked e-Seal stamp wins whatever the object numbers; rev must equal the position", () => {
  const cases: [string, string[], Map<number, Verified>, string][] = [
    ["earliest-signed stamp has the higher object numbers", BASE, SEALS(), EARLIER],
    [
      "earliest stamp's marker rev 2 ≠ position 1 → ignored",
      [stampWidget("6 0 R", 5), stampStream(LATER, 2), stampSig(200), stampWidget("9 0 R", 8), stampStream(EARLIER, 2), stampSig(50)],
      SEALS(),
      LATER,
    ],
    [
      "later stamp's marker rev 1 ≠ position 2 → ignored",
      [stampWidget("6 0 R", 5), stampStream(LATER, 1), stampSig(200), stampWidget("9 0 R", 8), stampStream(EARLIER, 3), stampSig(50)],
      SEALS(),
      "",
    ],
    ["rev written 02 never matches the marker regex", one("").map((o, i) => (i === 1 ? stampStream(EARLIER, "02") : o)), ONE(), ""],
    ["no verified e-Seal signature", BASE, new Map(), ""],
  ];
  for (const [name, objs, verified, want] of cases) assert.equal(I.docIdFromStamps(stampPdf(objs), verified), want, name);
  // Tie with valid markers: both at position 1.
  const tie = [stampWidget("6 0 R", 5), stampStream(LATER, 1), stampSig(50), stampWidget("9 0 R", 8), stampStream(EARLIER, 1), stampSig(50)];
  assert.equal(I.docIdFromStamps(stampPdf(tie), new Map([[6, seal(50)], [9, seal(50)]])), LATER, "tie → object 6");
});

test("§6.6 2.2: a citizen signature's stamp is never a source (documents signed only by citizens resolve as in 0.48.x)", () => {
  // 9 (earlier) is a citizen signature: its marker is ignored, the e-Seal 6 (position 2) wins.
  assert.equal(I.docIdFromStamps(stampPdf(BASE), new Map([[6, seal(200)], [9, citizen(50)]])), LATER);
  // Citizens only → nothing found, whatever their markers say.
  assert.equal(I.docIdFromStamps(stampPdf(BASE), new Map([[6, citizen(200)], [9, citizen(50)]])), "");
});

test("§6.6 2.2: direct, borrowed, unverified and inherited /V or /FT are ignored", () => {
  const cases: [string, string[], string][] = [
    // 10 widget with a direct /V dictionary, 11 its stamp.
    ["direct /V dictionary", plus("<< /FT /Sig /V << /Type /Sig /ByteRange [0 0 0 0] /Contents <00> >> /AP << /N 11 0 R >> >>", stampStream(FORGED, 1)), EARLIER],
    // 10 a second widget for 9 → 9 ignored entirely.
    ["borrowed /V (two widgets for 9)", plus(stampWidget("9 0 R", 11), stampStream(FORGED, 1)), LATER],
    // 10 widget → 12, a signature dictionary prechecks never verified.
    ["/V to an unverified signature", plus(stampWidget("12 0 R", 11), stampStream(FORGED, 1), stampSig(30)), EARLIER],
  ];
  for (const [name, objs, want] of cases) assert.equal(I.docIdFromStamps(stampPdf(objs), SEALS()), want, name);
  // Only e-Seal 6 (end 50, position 1); its widget 4 inherits /V or /FT from the parent field 7 → no widget → "".
  const inheritV = [
    "<< /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R /F 4 /FT /Sig /Parent 7 0 R /AP << /N 5 0 R >> >>",
    stampStream(EARLIER, 1),
    stampSig(50),
    "<< /V 6 0 R /T (S) /Kids [4 0 R] >>",
  ];
  const inheritFT = [
    "<< /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R /F 4 /V 6 0 R /Parent 7 0 R /AP << /N 5 0 R >> >>",
    stampStream(EARLIER, 1),
    stampSig(50),
    "<< /FT /Sig /T (S) /Kids [4 0 R] >>",
  ];
  assert.equal(I.docIdFromStamps(stampPdf(inheritV), ONE()), "", "inherited /V");
  assert.equal(I.docIdFromStamps(stampPdf(inheritFT), ONE()), "", "inherited /FT");
  // Control: the same widget with its own /FT and /V is a candidate.
  assert.equal(I.docIdFromStamps(stampPdf(one("")), ONE()), EARLIER, "own /FT /V");
});

test("§6.6 2.2: /Filter absent or a direct null only — [] , a name, an indirect reference (even to null) are not candidates", () => {
  const cases: [string, string[], string][] = [
    ["/Filter absent", one(""), EARLIER],
    ["/Filter null (direct)", one(" /Filter null"), EARLIER],
    ["/Filter []", one(" /Filter []"), ""],
    ["/Filter /FlateDecode", one(" /Filter /FlateDecode"), ""],
    ["/Filter 7 0 R → null", one(" /Filter 7 0 R", "null"), ""],
    ["/Filter 99 0 R (missing object)", one(" /Filter 99 0 R"), ""],
  ];
  for (const [name, objs, want] of cases) assert.equal(I.docIdFromStamps(stampPdf(objs), ONE()), want, name);
});

test("§6.6 2.2: a failure reading the candidate's own /N throws (prepare → PDF_INVALID); an unrelated unreadable object is skipped", () => {
  // Object 5 (the candidate's /N stream) sits at a bogus xref offset.
  assert.throws(() => I.docIdFromStamps(stampPdf(one(""), [5]), ONE()));
  // A fake widget 8 (not a candidate's own read) at a bogus offset: skipped, the candidate still wins.
  assert.equal(I.docIdFromStamps(stampPdf(one("", stampWidget("6 0 R", 5)), [7]), ONE()), EARLIER);
  // A widget's /AP that is not a dictionary / /N not a stream → no candidate, no error.
  assert.equal(I.docIdFromStamps(stampPdf([stampWidget("6 0 R", 5).replace("/AP << /N 5 0 R >>", "/AP 5 0 R"), "<< /N 1 >>", stampSig(50)]), ONE()), "");
  assert.equal(I.docIdFromStamps(stampPdf([stampWidget("6 0 R", 5), "<< /Type /XObject >>", stampSig(50)]), ONE()), "");
});

test("§6.6 2.2 on golden bytes: QR seal → its docId; QR-less seal → none; the citizen stamp after a QR seal is not a source", async () => {
  const issuers = ["04"].map((n) => I.parseCertificate(pem(n)));
  const qr = readG("output/seal-qr-visible.pdf");
  const pq = await I.precheck(qr, issuers);
  assert.deepEqual([...pq.verified.values()].map((s) => s.seal), [true]);
  assert.equal(I.docIdFromStamps(qr, pq.verified), QR_SEAL_DOC_ID);
  const v12 = readG("output/seal-visible.pdf");
  assert.equal(I.docIdFromStamps(v12, (await I.precheck(v12, issuers)).verified), "");
  // seal (position 1, marker …/1) then citizen (position 2, marker …/2): only the e-Seal signature is a source.
  const two = readG("output/seal-qr-then-citizen.pdf");
  const p2 = await I.precheck(two, issuers);
  assert.equal(p2.revIndex, 3);
  assert.deepEqual([...p2.verified.values()].map((s) => s.seal).sort(), [false, true]);
  assert.equal(I.docIdFromStamps(two, p2.verified), QR_SEAL_DOC_ID);
  const citizensOnly = new Map([...p2.verified].filter(([, s]) => !s.seal));
  assert.ok(Buffer.from(two).includes(Buffer.from(`/verify/${QR_SEAL_DOC_ID}/2)>> BDC\n`)), "the citizen stamp carries a valid marker");
  assert.equal(I.docIdFromStamps(two, citizensOnly), "", "a citizen marker is never a source");
});

// ── §6.6 through the public prepare (Go TestResolveDocID / TestPrepareDocIDRule / TestCitizenOnlyDocIDUnchanged) ────

const CHAIN = ["04", "03", "02"].map(pem);
const SIGNING_TIME = new Date("2026-10-14T12:00:00+08:00");
const STAMP: pades.PadesAppearance = { x: 340, y: 36, width: 220, height: 64 };
const opts = (docId: string, visible: boolean, signer = "citizen"): pades.PadesPrepareOptions => ({
  signerCert: pem(signer),
  chain: CHAIN,
  signingTime: SIGNING_TIME,
  ...(docId !== "" ? { docId } : {}),
  ...(visible ? { appearance: STAMP } : {}),
});
const code = (c: pades.PadesErrorCode) => (e: unknown) => e instanceof pades.PadesError && e.code === c;
/** The prepared PDF inside a prepare state ("EIDPADES1" ‖ uint32 ‖ JSON ‖ PDF). */
function preparedPdf(state: Uint8Array): Buffer {
  const st = Buffer.from(state);
  return st.subarray(13 + st.readUInt32BE(9));
}
const marker = (id: string, rev: number) => Buffer.from(`/EIDVerify <</URL (https://ca.eidmongolia.mn/verify/${id}/${rev})>> BDC\n`);

test("prepare §6.6 (1): unsigned → opts.docId, else a random lowercase UUID", async () => {
  const unsigned = readG("input/quartz-pdf13.pdf");
  const a = await pades.prepare(unsigned, opts("", false));
  const b = await pades.prepare(unsigned, opts("", false));
  assert.match(a.docId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.docId, b.docId);
  assert.equal((await pades.prepare(unsigned, opts(OTHER_DOC_ID, false))).docId, OTHER_DOC_ID);
  // Format: lowercase 8-4-4-4-12 hex, version/variant nibbles not checked; uppercase → REQUEST_INVALID.
  const noVersion = "0f1e2d3c-4b5a-0968-0776-5a4b3c2d1e0f";
  assert.equal((await pades.prepare(unsigned, opts(noVersion, false))).docId, noVersion);
  await assert.rejects(pades.prepare(unsigned, opts(OTHER_DOC_ID.toUpperCase(), false)), code("REQUEST_INVALID"));
});

test("prepare §6.6 (2.1): the verify-page link wins; a different opts.docId → REQUEST_INVALID", async () => {
  const paged = readG("output/quartz-pdf13.pdf");
  assert.equal((await pades.prepare(paged, opts("", false))).docId, PAGE_DOC_ID);
  assert.equal((await pades.prepare(paged, opts(PAGE_DOC_ID, true))).docId, PAGE_DOC_ID);
  await assert.rejects(pades.prepare(paged, opts(OTHER_DOC_ID, false)), code("REQUEST_INVALID"));
});

test("prepare §6.6 (2.2): after a QR seal stamp, a citizen (visible and invisible) takes the seal's docId; ≠ opts.docId → REQUEST_INVALID", async () => {
  const sealQr = readG("output/seal-qr-visible.pdf");
  const vis = await pades.prepare(sealQr, opts("", true));
  assert.equal(vis.docId, QR_SEAL_DOC_ID);
  assert.ok(preparedPdf(vis.state).subarray(sealQr.length).includes(marker(QR_SEAL_DOC_ID, 2)), "rev 2 marker with the seal's docId");
  assert.equal((await pades.prepare(sealQr, opts("", false))).docId, QR_SEAL_DOC_ID, "invisible signer (documented behaviour change)");
  assert.equal((await pades.prepare(sealQr, opts(QR_SEAL_DOC_ID, true))).docId, QR_SEAL_DOC_ID);
  for (const visible of [true, false]) {
    await assert.rejects(pades.prepare(sealQr, opts(OTHER_DOC_ID, visible)), code("REQUEST_INVALID"), `visible ${visible}`);
  }
});

test("prepare §6.6 (3)/(4): after a QR-less seal or an invisible citizen nothing is found — opts.docId, else \"\" (never random)", async () => {
  const sealV12 = readG("output/seal-visible.pdf");
  await assert.rejects(pades.prepare(sealV12, opts("", true)), code("REQUEST_INVALID"), "visible citizen without a docId");
  const withId = await pades.prepare(sealV12, opts(OTHER_DOC_ID, true));
  assert.equal(withId.docId, OTHER_DOC_ID);
  assert.ok(preparedPdf(withId.state).subarray(sealV12.length).includes(marker(OTHER_DOC_ID, 2)));
  assert.equal((await pades.prepare(sealV12, opts("", false))).docId, "");
  // Citizen-signed, no verify page (invisible prior signature): exactly as in 0.48.x.
  const invisible = readG("output/quartz-pdf13-nopage.pdf");
  assert.equal((await pades.prepare(invisible, opts("", false))).docId, "");
  assert.equal((await pades.prepare(invisible, opts(OTHER_DOC_ID, false))).docId, OTHER_DOC_ID);
  assert.equal((await pades.prepare(invisible, opts(OTHER_DOC_ID, true))).docId, OTHER_DOC_ID);
  await assert.rejects(pades.prepare(invisible, opts("", true)), code("REQUEST_INVALID"));
  // A QR-less seal on such a document proceeds with the empty docId.
  assert.equal((await pades.prepare(invisible, opts("", true, "seal"))).docId, "");
});

// ── No public API emits the QR seal stamp (Go TestSealPDFStillQRless) ─────────────────────────────────────────────────

interface GoldenCase {
  name: string;
  input: string;
  sealQr?: boolean;
  expect: { dtbs: string };
}
const GM = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as { cases: GoldenCase[] };
const gcase = (n: string) => GM.cases.find((c) => c.name === n)!;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SEAL = pem("seal");
const STOP = new Error("stop after the DTBS");

/** The DTBS sealPdf sends (the sealer stops the flow there). */
async function sealDtbs(input: Uint8Array, o: pades.PadesSealOptions = {}): Promise<string> {
  const got: string[] = [];
  const s: pades.PadesSealer = {
    getCertificate: async () => ({ certificate: SEAL }),
    seal: async (_org, digest) => {
      got.push(hex(digest));
      throw STOP;
    },
  };
  await assert.rejects(pades.sealPdf(s, "NTRMN-0000000", input, { signingTime: SIGNING_TIME, chain: CHAIN, ...o }), (e: unknown) => e === STOP);
  return got[0]!;
}

test("sealPdf still draws the QR-less stamp: DTBS = golden v12 seal-visible / seal-visible-en, ≠ the v13 QR cases", async () => {
  const contract = readG("input/libreoffice-contract.pdf");
  const auto = await sealDtbs(contract, { reason: "Нэхэмжлэх" });
  assert.equal(auto, gcase("seal-visible").expect.dtbs);
  const quartz = readG("input/quartz-pdf13.pdf");
  const en = await sealDtbs(quartz, { appearance: { ...STAMP, lang: "en" } });
  assert.equal(en, gcase("seal-visible-en").expect.dtbs);
  assert.notEqual(en, gcase("seal-qr-visible-en").expect.dtbs);
});

test("public prepare / sealPdf on a QR-sealed document: the new seal stamp has no marker; the switch is not reachable from dist", async () => {
  const sealQr = readG("output/seal-qr-visible.pdf");
  const p = await pades.prepare(sealQr, opts("", true, "seal"));
  assert.equal(p.docId, QR_SEAL_DOC_ID, "docId from the earlier e-Seal stamp");
  assert.ok(!preparedPdf(p.state).subarray(sealQr.length).includes(Buffer.from("/EIDVerify")), "QR-less stamp");
  assert.equal(await sealDtbs(sealQr, { appearance: STAMP }), hex(p.dtbs), "sealPdf = public prepare");
  // The same options with the internal switch (src bundle) draw the marker at rev 2 — dist has no way to set it.
  const q = await I.prepare(sealQr, { ...opts("", true, "seal"), [I.SEAL_QR]: true });
  assert.ok(preparedPdf(q.state).subarray(sealQr.length).includes(marker(QR_SEAL_DOC_ID, 2)));
  assert.notEqual(hex(q.dtbs), hex(p.dtbs));
  const guess = await pades.prepare(sealQr, { ...opts("", true, "seal"), [Symbol.for("eid-mongolia-sdk.pades.sealQr")]: true, sealQr: true } as pades.PadesPrepareOptions);
  assert.equal(hex(guess.dtbs), hex(p.dtbs), "a registered symbol or a sealQr key does nothing");
  assert.ok(!Object.keys(pades).some((k) => /seal_?qr/i.test(k)), "no SEAL_QR export");
  // state never carries the switch.
  const st = Buffer.from(q.state);
  assert.ok(!st.subarray(13, 13 + st.readUInt32BE(9)).toString().toLowerCase().includes("sealqr"));
});

// ── Validator inputs used above exist (the verdicts are asserted in validate-golden.test.ts) ──────────────────────────

test("validate fixture seal-qr-docid-vs-page: verify-page docId and a different marker docId", () => {
  const b = Buffer.from(readV("input/seal-qr-docid-vs-page.pdf"));
  assert.ok(b.includes(Buffer.from(`/URI (https://ca.eidmongolia.mn/verify/${PAGE_DOC_ID})`)));
  assert.ok(b.includes(marker(OTHER_DOC_ID, 2)));
});
