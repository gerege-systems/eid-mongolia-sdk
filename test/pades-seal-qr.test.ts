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
  prepare(pdf: Uint8Array, o: pades.PadesPrepareOptions): Promise<pades.PadesPrepared>;
  withSealQr<T extends object>(o: T): T;
  PdfError: new (...a: unknown[]) => Error;
}

const tmp = mkdtempSync(join(tmpdir(), "eid-seal-qr-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** src bundled into one ESM — the renderer, docIdFromStamps, precheck and the withSealQr switch are internal. */
async function internals(): Promise<Internals> {
  const r = await build({
    stdin: {
      contents: [
        `export { appearanceContent, AppearanceError, APPEARANCE_LABELS, SEAL_LABELS } from "./src/pades/page/appearance.ts";`,
        `export { PageWriter, loadFonts } from "./src/pades/page/page.ts";`,
        `export { docIdFromStamps, precheck } from "./src/pades/precheck.ts";`,
        `export { parseCertificate } from "./src/pades/x509.ts";`,
        `export { prepare } from "./src/pades.ts";`,
        `export { withSealQr } from "./src/pades/sealqr.ts";`,
        `export { PdfError } from "./src/pades/pdf/reader.ts";`,
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

test("§6.6 2.2 (Go parity): /V matches by raw reference — object number AND generation; a /V naming the widget itself is not special", () => {
  // Signature 6's xref entry has generation 0: a widget with /V 6 1 R is not its widget (never resolved, never counted).
  const wrongGen = one("").map((o, i) => (i === 0 ? o.replace("/V 6 0 R", "/V 6 1 R") : o));
  assert.equal(I.docIdFromStamps(stampPdf(wrongGen), ONE()), "", "/V 6 1 R vs xref gen 0");
  // …nor does it count as a second widget next to the genuine one.
  assert.equal(I.docIdFromStamps(stampPdf(one("", stampWidget("6 1 R", 5))), ONE()), EARLIER, "a gen-1 /V is not a borrowed widget");
  // The verified e-Seal signature dictionary 6 is itself the widget (/FT /Sig, /V 6 0 R, /AP): counted like any widget.
  const merged = [
    "<< /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R /F 4 /T (S) >>",
    stampStream(EARLIER, 1),
    "<< /Type /Sig /ByteRange [0 10 20 30] /Contents <00> /FT /Sig /V 6 0 R /AP << /N 5 0 R >> >>",
  ];
  assert.equal(I.docIdFromStamps(stampPdf(merged), ONE()), EARLIER, "self-referencing /V");
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

// Spec sentence (§6.6 2.2): "only a single-widget candidate's own /AP, /N, /Length and stream reads → PDF_INVALID;
// unreadable objects elsewhere in this walk are skipped". Objects listed in the second rawPdf argument sit at a bogus
// xref offset (loading them throws PdfError).
test("§6.6 2.2: a single-widget candidate's own unreadable /AP, /N, /Length or /DecodeParms throws PdfError (prepare → PDF_INVALID)", () => {
  const isPdfError = (e: unknown) => e instanceof I.PdfError;
  // 4 widget (/AP 7 0 R) → 5 stream, 6 sig; 7 = the /AP dictionary.
  const indirectAP = [stampWidget("6 0 R", 5).replace("/AP << /N 5 0 R >>", "/AP 7 0 R"), stampStream(EARLIER, 1), stampSig(50), "<< /N 5 0 R >>"];
  assert.equal(I.docIdFromStamps(stampPdf(indirectAP), ONE()), EARLIER, "control: indirect /AP readable");
  const cases: [string, Uint8Array][] = [
    ["/AP", stampPdf(indirectAP, [7])],
    ["/N", stampPdf(one(""), [5])],
    ["/Length 7 0 R", stampPdf([stampWidget("6 0 R", 5), stampStream(EARLIER, 1).replace(/\/Length \d+/, "/Length 7 0 R"), stampSig(50), "99"], [7])],
    ["/DecodeParms 7 0 R", stampPdf(one(" /DecodeParms 7 0 R", "<< /Columns 1 >>"), [7])],
    ["/Filter 7 0 R (unloadable)", stampPdf(one(" /Filter 7 0 R", "null"), [7])],
  ];
  for (const [name, doc] of cases) assert.throws(() => I.docIdFromStamps(doc, ONE()), isPdfError, name);
});

test("§6.6 2.2: unreadable objects elsewhere are skipped — indirect /FT, /V to a non-signature, any read on a two-widget signature", () => {
  // 7 a second widget whose indirect /FT (8) cannot be loaded: skipped, so 6 keeps one widget and wins.
  const badFT = one("", stampWidget("6 0 R", 5).replace("/FT /Sig", "/FT 8 0 R"), "/Sig");
  assert.equal(I.docIdFromStamps(stampPdf(badFT, [8]), ONE()), EARLIER, "unloadable indirect /FT");
  // 7 a widget whose /V points to 8, an unloadable object that is not a verified signature.
  const badV = one("", stampWidget("8 0 R", 5), "<< /Type /Sig >>");
  assert.equal(I.docIdFromStamps(stampPdf(badV, [8]), ONE()), EARLIER, "/V to an unloadable non-signature");
  // A widget object itself unloadable: skipped.
  assert.equal(I.docIdFromStamps(stampPdf(one("", stampWidget("6 0 R", 5)), [7]), ONE()), EARLIER, "unloadable widget object");
  // Signature 6 with two widgets (4, 7) whose /N (5, 8) both cannot be loaded: ignored entirely, never read.
  const twoBad = [stampWidget("6 0 R", 5), stampStream(EARLIER, 1), stampSig(50), stampWidget("6 0 R", 8), stampStream(FORGED, 1)];
  assert.equal(I.docIdFromStamps(stampPdf(twoBad, [5, 8]), ONE()), "", "two widgets with unreadable streams");
  // /AP not a dictionary, /N not a stream → no candidate, no error.
  assert.equal(I.docIdFromStamps(stampPdf([stampWidget("6 0 R", 5).replace("/AP << /N 5 0 R >>", "/AP 5"), "<< /N 1 >>", stampSig(50)]), ONE()), "");
  assert.equal(I.docIdFromStamps(stampPdf([stampWidget("6 0 R", 5), "<< /Type /XObject >>", stampSig(50)]), ONE()), "");
});

/** `base` + an incremental update that redefines `objs` (number → body; null = a bogus xref offset). Classic xref. */
function appendRevision(base: Uint8Array, objs: [number, string | null][]): Uint8Array {
  const s = Buffer.from(base).toString("latin1");
  const size = Number([...s.matchAll(/\/Size (\d+)/g)].at(-1)![1]);
  const rootRef = [...s.matchAll(/\/Root (\d+ \d+ R)/g)].at(-1)![1];
  const prev = Number([...s.matchAll(/startxref\s+(\d+)/g)].at(-1)![1]);
  const parts: string[] = [s.endsWith("\n") ? s : s + "\n"];
  let len = parts[0]!.length;
  // One xref subsection per run of consecutive object numbers.
  const sections: { start: number; rows: string[] }[] = [];
  let maxObj = size - 1;
  for (const [n, body] of objs) {
    let off = 1; // null body: a bogus offset inside the header → loading the object throws
    if (body !== null) {
      off = len;
      const o = `${n} 0 obj\n${body}\nendobj\n`;
      parts.push(o);
      len += o.length;
    }
    const last = sections.at(-1);
    const row = `${String(off).padStart(10, "0")} 00000 n\r\n`;
    if (last && last.start + last.rows.length === n) last.rows.push(row);
    else sections.push({ start: n, rows: [row] });
    maxObj = Math.max(maxObj, n);
  }
  parts.push("xref\n", ...sections.map((x) => `${x.start} ${x.rows.length}\n${x.rows.join("")}`));
  parts.push(`trailer\n<< /Size ${maxObj + 1} /Root ${rootRef} /Prev ${prev} >>\nstartxref\n${len}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(parts.join(""), "latin1"));
}

test("prepare: the QR seal's own /N made unreadable by an appended revision → PDF_INVALID (public prepare)", async () => {
  const base = readG("output/seal-qr-visible.pdf");
  const n = Number(/\/AP << \/N (\d+) 0 R >>/.exec(Buffer.from(base).toString("latin1"))![1]);
  const broken = appendRevision(base, [[n, null]]);
  for (const visible of [true, false]) {
    await assert.rejects(pades.prepare(broken, opts("", visible)), code("PDF_INVALID"), `visible ${visible}`);
  }
  // The same bytes through docIdFromStamps with the original document's verified signatures: the candidate's own read.
  const verified = (await I.precheck(base, ["04"].map((x) => I.parseCertificate(pem(x))))).verified;
  assert.throws(() => I.docIdFromStamps(broken, verified), (e: unknown) => e instanceof I.PdfError);
});

test("~150k forged widgets borrowing the seal's /V (appended unsigned revision): linear work; the seal is ignored as a source", async () => {
  // Attack from the review: copying the widget list on every append is ~n²/2 = 1.1e10 element copies at n = 150k. The
  // count + first-widget map is O(n). No absolute wall-clock threshold: the same walk at n/4 and n must scale like n
  // (ratio ≈ 4; quadratic bookkeeping gives ≈ 16 once it dominates) — bound 10× (+ 500 ms slack for GC/JIT noise).
  const base = readG("output/seal-qr-visible.pdf");
  const s = Buffer.from(base).toString("latin1");
  const sigObj = Number(/\/V (\d+) 0 R\n {2}\/AP << \/N \d+ 0 R >>/.exec(s)![1]);
  const size = Number([...s.matchAll(/\/Size (\d+)/g)].at(-1)![1]);
  const forgedDoc = (n: number) => {
    const forged: [number, string][] = [];
    for (let i = 0; i < n; i++) forged.push([size + i, `<</FT/Sig/V ${sigObj} 0 R>>`]);
    return appendRevision(base, forged);
  };
  const N = 150_000;
  const big = forgedDoc(N);
  const small = forgedDoc(N / 4);
  assert.ok(big.length <= (10 << 20) - (256 << 10), `${big.length} bytes over the input limit`);
  const verified = (await I.precheck(base, ["04"].map((x) => I.parseCertificate(pem(x))))).verified;
  assert.equal(I.docIdFromStamps(small, verified), "", "warm-up; two or more widgets → not a source");
  const time = (doc: Uint8Array): number => {
    const t = performance.now();
    assert.equal(I.docIdFromStamps(doc, verified), "");
    return performance.now() - t;
  };
  const t1 = time(small);
  const t2 = time(big);
  assert.ok(t2 < 10 * t1 + 500, `n/4: ${t1.toFixed(0)} ms, n: ${t2.toFixed(0)} ms — super-linear`);
  // Through the public prepare (prechecks pass: the appended revision is unsigned): the invisible citizen gets "".
  assert.equal((await pades.prepare(big, opts("", false))).docId, "");
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
  // The same options registered with the internal switch (src bundle) draw the marker at rev 2.
  const q = await I.prepare(sealQr, I.withSealQr(opts("", true, "seal")));
  assert.ok(preparedPdf(q.state).subarray(sealQr.length).includes(marker(QR_SEAL_DOC_ID, 2)));
  assert.notEqual(hex(q.dtbs), hex(p.dtbs));
  // A copy of registered options is not registered: the switch is the object's identity, never a property.
  assert.equal(hex((await I.prepare(sealQr, { ...I.withSealQr(opts("", true, "seal")) })).dtbs), hex(p.dtbs));
  const guess = await pades.prepare(sealQr, { ...opts("", true, "seal"), [Symbol.for("eid-mongolia-sdk.pades.sealQr")]: true, sealQr: true } as pades.PadesPrepareOptions);
  assert.equal(hex(guess.dtbs), hex(p.dtbs), "a registered symbol or a sealQr key does nothing");
  assert.ok(!Object.keys(pades).some((k) => /seal_?qr/i.test(k)), "no switch export");
  // state never carries the switch.
  const st = Buffer.from(q.state);
  assert.ok(!st.subarray(13, 13 + st.readUInt32BE(9)).toString().toLowerCase().includes("sealqr"));
});

/** Option keys prepare reads (PadesPrepareOptions); a Proxy answers every other key — string or symbol — with true. */
const KNOWN = new Set(["signerCert", "chain", "signerName", "reason", "claimedRole", "signingTime", "docId", "verifyPage", "verifyPagePosition", "lang", "fileName", "appearance"]);

test("a Proxy as prepare options (every unknown key and every symbol → true) still yields the QR-less stamp; no symbol is read", async () => {
  const sealQr = readG("output/seal-qr-visible.pdf");
  const plain = await pades.prepare(sealQr, opts("", true, "seal"));
  const symbolsRead: symbol[] = [];
  const target = opts("", true, "seal") as unknown as Record<PropertyKey, unknown>;
  const proxy = new Proxy(target, {
    get(t, k) {
      if (typeof k === "symbol") symbolsRead.push(k);
      return typeof k === "string" && KNOWN.has(k) ? t[k] : true;
    },
    has: () => true,
  }) as unknown as pades.PadesPrepareOptions;
  const p = await pades.prepare(sealQr, proxy);
  assert.equal(hex(p.dtbs), hex(plain.dtbs), "Proxy: QR-less");
  assert.ok(!preparedPdf(p.state).subarray(sealQr.length).includes(Buffer.from("/EIDVerify")));
  assert.deepEqual(symbolsRead, [], "prepare reads no symbol-keyed property of the options");
});

test("Object.prototype pollution (symbols and sealQr keys) changes neither prepare nor sealPdf output", async () => {
  const sealQr = readG("output/seal-qr-visible.pdf");
  const contract = readG("input/libreoffice-contract.pdf");
  const before = { prepare: hex((await pades.prepare(sealQr, opts("", true, "seal"))).dtbs), seal: await sealDtbs(contract, { reason: "Нэхэмжлэх" }) };
  const keys: PropertyKey[] = [Symbol("sealQr"), Symbol.for("eid-mongolia-sdk.pades.sealQr"), Symbol.for("sealQr"), "sealQr", "sealQR", "seal_qr"];
  const proto = Object.prototype as Record<PropertyKey, unknown>;
  try {
    for (const k of keys) proto[k] = true;
    assert.equal(hex((await pades.prepare(sealQr, opts("", true, "seal"))).dtbs), before.prepare, "prepare");
    assert.equal(await sealDtbs(contract, { reason: "Нэхэмжлэх" }), before.seal, "sealPdf");
  } finally {
    for (const k of keys) delete proto[k];
  }
  assert.equal(before.seal, gcase("seal-visible").expect.dtbs, "sealPdf = golden v12 seal-visible");
});

// ── Validator inputs used above exist (the verdicts are asserted in validate-golden.test.ts) ──────────────────────────

test("validate fixture seal-qr-docid-vs-page: verify-page docId and a different marker docId", () => {
  const b = Buffer.from(readV("input/seal-qr-docid-vs-page.pdf"));
  assert.ok(b.includes(Buffer.from(`/URI (https://ca.eidmongolia.mn/verify/${PAGE_DOC_ID})`)));
  assert.ok(b.includes(marker(OTHER_DOC_ID, 2)));
});
