// Visible stamp placement (PLACEMENT_SPEC.md): the occupancy scanner and candidate search against the Go reference's
// vectors (test/fixtures/pades/golden/placement/vectors.json, synced by scripts/sync-pades-golden.mjs) box-for-box, and
// a deterministic fuzz-style robustness test — arbitrary content bytes never throw anything but "unscannable", and every
// limit of §5 ends in "unscannable". The golden v5 PDFs themselves are checked in pades-golden.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type Box = [number, number, number, number];
interface Internals {
  occupancy(page: unknown, box: Box): Box[];
  placeVisible(box: number[], rot: number, x: number, y: number, w: number, h: number, occ: Box[]): [number, number] | undefined;
  placeCandidates(vw: number, vh: number, x: number, y: number, w: number, h: number): [number, number][];
  UnscannableError: new (...a: unknown[]) => Error;
  nthPage(root: unknown, n: number): { key(k: string): unknown } | undefined;
  pageGeometry(page: unknown): { box: number[]; rot: number };
  round100(v: number): number;
  defaultStampPage(doc: Uint8Array, verifyUri: string): { page: number; n: number };
  Incremental: new (b: Uint8Array) => { root(): { key(k: string): unknown } };
}

/** src (NodeNext .js imports) bundled into one ESM — the scanner is internal, not part of the /pades API. */
async function internals(): Promise<Internals> {
  const r = await build({
    stdin: {
      contents: [
        `export { occupancy, placeVisible, placeCandidates, UnscannableError } from "./src/pades/page/occupancy.ts";`,
        `export { nthPage, pageGeometry, round100, defaultStampPage } from "./src/pades/page/appearance.ts";`,
        `export { Incremental } from "./src/pades/pdf/incremental.ts";`,
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
  const out = join(mkdtempSync(join(tmpdir(), "eid-placement-")), "placement.mjs");
  writeFileSync(out, r.outputFiles[0]!.contents);
  return (await import(pathToFileURL(out).href)) as Internals;
}

const I = await internals();

interface Vector {
  name: string;
  input: string;
  page: number;
  request: [number, number, number, number];
  expect: { box: Box; rotate: number; boxes: Box[] | null; x: number; y: number; status: string };
}

/** Go runPlacementVector (pades/internal/core/placement_test.go). */
function runVector(v: Vector): Vector["expect"] {
  const doc = new Uint8Array(readFileSync(new URL(v.input, G)));
  const page = I.nthPage(new I.Incremental(doc).root().key("Pages"), v.page);
  assert.ok(page, `${v.name}: page ${v.page}`);
  const { box, rot } = I.pageGeometry(page);
  const [x, y, w, h] = v.request.map(I.round100) as Box;
  const got: Vector["expect"] = { box: box as Box, rotate: rot, boxes: null, x, y, status: "" };
  let occ: Box[];
  try {
    occ = I.occupancy(page, box as Box);
  } catch (e) {
    assert.ok(e instanceof I.UnscannableError, `${v.name}: ${String(e)}`);
    got.status = "unscanned";
    return got;
  }
  got.boxes = occ;
  const at = I.placeVisible(box, rot, x, y, w, h, occ);
  if (!at) got.status = "overlap";
  else if (at[0] === x && at[1] === y) got.status = "requested";
  else [got.x, got.y, got.status] = [at[0], at[1], "moved"];
  return got;
}

test("placement vectors — Go reference-тэй хайрцаг бүрээр ижил (PLACEMENT_SPEC.md §8)", () => {
  const vectors = JSON.parse(readFileSync(new URL("placement/vectors.json", G), "utf8")) as Vector[];
  assert.ok(vectors.length >= 21, `vectors цөөн: ${vectors.length}`);
  for (const v of vectors) assert.deepStrictEqual(runVector(v), v.expect, v.name);
  const status = new Set(vectors.map((v) => v.expect.status));
  for (const s of ["requested", "moved", "overlap", "unscanned"]) assert.ok(status.has(s), `vectors-д ${s} алга`);
});

test("placement candidates — A4, порталын анхдагч хүсэлт (Go TestPlacementCandidates)", () => {
  const c = I.placeCandidates(59528, 84189, 34000, 3600, 22000, 6400);
  assert.deepEqual(c.slice(0, 3), [
    [34000, 3600],
    [3528, 3600],
    [34000, 4800],
  ]);
  const n = Math.floor((84189 - 3600 - 3600 - 6400) / 1200);
  assert.equal(c.length, 2 + 2 * n);
  assert.deepEqual(c[2 + n], [3528, 4800]);
  const centred = I.placeCandidates(1000, 3000, 400, 0, 200, 100);
  assert.equal(centred.length, 3);
  assert.deepEqual(centred[1], [400, 1200]);
});

// ── Robustness: fixture PDF (Go fxPDF / fxPage) whose page and self-referencing form X run the same content ─────────

const LETTER: Box = [0, 0, 61200, 79200];

function fxPDF(objs: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let len = 0;
  const put = (b: Uint8Array | string): void => {
    const u = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(u);
    len += u.length;
  };
  put("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(len);
    put(`${i + 1} 0 obj\n`);
    put(o);
    put("\nendobj\n");
  });
  const x = len;
  put(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (const o of offs) put(`${String(o).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const fxStream = (dict: string, data: Uint8Array): Uint8Array =>
  Buffer.concat([Buffer.from(`<< ${dict}/Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);

const s = (t: string): Uint8Array => Buffer.from(t, "latin1");

function fuzzDoc(content: Uint8Array): Uint8Array {
  return fxPDF([
    s("<< /Type /Catalog /Pages 2 0 R >>"),
    s("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >> /Contents 4 0 R >>"),
    fxStream("", content),
    s("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /Widths [250 300 350] >>"),
    fxStream("/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /X 6 0 R >> >> ", content),
  ]);
}

/** "boxes" or "unscanned"; anything else thrown fails the test. Boxes must be finite integers within the clamp. */
function scan(content: Uint8Array): Box[] | "unscanned" {
  const page = I.nthPage(new I.Incremental(fuzzDoc(content)).root().key("Pages"), 1)!;
  let occ: Box[];
  try {
    occ = I.occupancy(page, LETTER);
  } catch (e) {
    if (e instanceof I.UnscannableError) return "unscanned";
    throw e;
  }
  for (const b of occ) {
    assert.ok(b.every((v) => Number.isInteger(v) && Math.abs(v) <= 1e9 && !Object.is(v, -0)), `box ${b}`);
    assert.ok(b[0] <= b[2] && b[1] <= b[3], `box ${b}`);
  }
  I.placeVisible(LETTER, 0, 34000, 3600, 22000, 6400, occ);
  return occ;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "q", "Q", "cm", "w", "g", "G", "rg", "RG", "k", "K", "cs", "scn", "SC", "m", "l", "c", "v", "y", "h", "re", "S", "s", "f",
  "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*", "BT", "ET", "Tc", "Tw", "Tz", "TL", "Ts", "Tf", "Td", "TD", "T*", "Tm",
  "Tj", "'", '"', "TJ", "Do", "BI", "ID", "EI", "sh", "BDC", "EMC", "/F1", "/X", "/Missing", "(", ")", "(abc)", "<414243>",
  "<", ">", "<<", ">>", "[", "]", "{", "}", "%", "\n", "\r", "\\", "1", "0", "-1", "12", "0.5", "-.5", "+3.", "1e5", "1.2.3",
  "99999999999999999999999999999999", "999999999999999999999999999999999", "true", "null", "/", "#", "/A#4", "1e308",
];

test("placement fuzz — дурын content байт: «unscanned»-аас өөр алдаа гарахгүй", () => {
  const r = rng(0x5eed);
  let unscanned = 0;
  for (let it = 0; it < 3000; it++) {
    let content: Uint8Array;
    if (it % 3 === 0) {
      // Raw random bytes, biased to PDF delimiters and digits.
      const n = Math.floor(r() * 400);
      const b = new Uint8Array(n);
      const pick = " ()<>[]{}/%\\0123456789.-+EIBTfmlre\n\r\t\0";
      for (let i = 0; i < n; i++) b[i] = r() < 0.6 ? pick.charCodeAt(Math.floor(r() * pick.length)) : Math.floor(r() * 256);
      content = b;
    } else {
      // Token soup from the operator/operand vocabulary.
      const n = Math.floor(r() * 120);
      const parts: string[] = [];
      for (let i = 0; i < n; i++) parts.push(VOCAB[Math.floor(r() * VOCAB.length)]!);
      content = s(parts.join(r() < 0.5 ? " " : ""));
    }
    if (scan(content) === "unscanned") unscanned++;
  }
  assert.ok(unscanned > 0, "fuzz: unscanned хэзээ ч гарсангүй (self-referencing form X)");
});

test("placement fuzz — placement/input-ийн content stream-үүдийг эвдэж ажиллуулна", () => {
  const r = rng(42);
  const seeds: Uint8Array[] = [];
  for (const f of ["text-state", "fonts", "paths", "xobjects", "malformed", "many-ops", "limit-save", "rotate270"]) {
    const b = Buffer.from(readFileSync(new URL(`placement/input/${f}.pdf`, G)));
    const i = b.indexOf("stream\n");
    const j = b.indexOf("\nendstream", i);
    if (i > 0 && j > i) seeds.push(new Uint8Array(b.subarray(i + 7, j)));
  }
  assert.ok(seeds.length >= 6);
  for (let it = 0; it < 1500; it++) {
    const src = seeds[it % seeds.length]!;
    const b = Uint8Array.from(src);
    const edits = 1 + Math.floor(r() * 8);
    for (let e = 0; e < edits && b.length > 0; e++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    const cut = r() < 0.3 ? b.subarray(0, Math.floor(r() * b.length)) : b;
    scan(cut);
  }
});

test("placement limits (§5) — хязгаар бүр «unscanned», хязгаарт багтвал хайрцагтай", () => {
  const rep = (t: string, n: number): string => t.repeat(n);
  // q depth 64 ok, 65 → unscanned
  assert.notEqual(scan(s(rep("q ", 64) + "0 g 10 10 10 10 re f")), "unscanned");
  assert.equal(scan(s(rep("q ", 65) + "0 g 10 10 10 10 re f")), "unscanned");
  // array nesting 32 ok, 33 → unscanned
  assert.notEqual(scan(s(rep("[", 32) + rep("]", 32) + " TJ")), "unscanned");
  assert.equal(scan(s(rep("[", 33) + rep("]", 33) + " TJ")), "unscanned");
  // operands: 65 536 pending ok, 65 537 → unscanned
  assert.notEqual(scan(s(rep("1 ", 65_536) + "n")), "unscanned");
  assert.equal(scan(s(rep("1 ", 65_537) + "n")), "unscanned");
  assert.equal(scan(s("[" + rep("1 ", 65_536) + "] TJ")), "unscanned");
  // operators: 100 000 ok, 100 001 → unscanned (the form is not run here)
  assert.notEqual(scan(s(rep("n ", 100_000))), "unscanned");
  assert.equal(scan(s(rep("n ", 100_001))), "unscanned");
  // form depth: the self-referencing form X recurses past 8
  assert.equal(scan(s("/X Do")), "unscanned");
  // decoded bytes: 4 MiB in total (page content + every form run)
  assert.notEqual(scan(new Uint8Array(4 << 20).fill(0x20)), "unscanned");
  assert.equal(scan(new Uint8Array((4 << 20) + 1).fill(0x20)), "unscanned");
  // non-finite CTM / text matrix
  assert.equal(scan(s(rep("99999999999999999999999999999 0 0 99999999999999999999999999999 0 0 cm ", 12))), "unscanned");
  // inline image without EI ends the content; with EI it is one unit-square box
  assert.deepEqual(scan(s("q 10 0 0 10 100 100 cm BI /W 1 ID xx")), []);
  assert.deepEqual(scan(s("q 10 0 0 10 100 100 cm BI /W 1 ID xx EI Q")), [[10000, 10000, 11000, 11000]]);
});

// ── Cross-checks against the Go reference (b5c1fdc Occupancy run on the same objects; its results are pasted below) ──

function onePage(pageKeys: string, contents: Uint8Array, ...extra: string[]): Uint8Array {
  return fxPDF([
    s("<< /Type /Catalog /Pages 2 0 R >>"),
    s("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    s(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${pageKeys} /Contents 4 0 R >>`),
    contents,
    ...extra.map(s),
  ]);
}

function occ(doc: Uint8Array): Box[] | "unscanned" {
  const page = I.nthPage(new I.Incremental(doc).root().key("Pages"), 1)!;
  try {
    return I.occupancy(page, LETTER);
  } catch (e) {
    assert.ok(e instanceof I.UnscannableError, String(e));
    return "unscanned";
  }
}

test("placement zlib — тасархай/буруу Adler-32 → unscanned, FDICT зөвхөн DICTID 1 (Go compress/zlib)", () => {
  const z = deflateSync(Buffer.from("0 g 10 10 50 50 re f"), { level: 9 });
  const fdict = (id: number): Buffer => {
    let flg = 0x20;
    while (((0x78 << 8) | flg) % 31 !== 0) flg++;
    const h = Buffer.from([0x78, flg, 0, 0, 0, 0]);
    h.writeUInt32BE(id, 2);
    return Buffer.concat([h, z.subarray(2)]);
  };
  const bad = Buffer.from(z);
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
  const box: Box[] = [[1000, 1000, 6000, 6000]];
  const cases: [string, Uint8Array, Box[] | "unscanned"][] = [
    ["ok", z, box],
    ["trailing bytes after Adler-32", Buffer.concat([z, Buffer.from("garbage")]), box],
    ["FDICT, DICTID 1 = adler32(empty)", fdict(1), box],
    ["FDICT, DICTID 2", fdict(2), "unscanned"],
    ["no Adler-32", z.subarray(0, z.length - 4), "unscanned"],
    ["half Adler-32", z.subarray(0, z.length - 2), "unscanned"],
    ["wrong Adler-32", bad, "unscanned"],
    ["truncated deflate data", z.subarray(0, z.length >> 1), "unscanned"],
  ];
  for (const [name, data, want] of cases) assert.deepStrictEqual(occ(onePage("", fxStream("/Filter /FlateDecode ", data))), want, name);
});

test("placement fonts — нэг объект доторх шууд фонтууд нэг cache мөр хуваалцана (Go GetPtr id)", () => {
  const doc = onePage(
    "/Resources << /Font 5 0 R >>",
    fxStream("", s("BT /A 10 Tf 72 700 Td (aaaa) Tj ET BT /B 10 Tf 72 600 Td (aaaa) Tj ET BT /C 10 Tf 72 500 Td (aaaa) Tj ET")),
    "<< /A << /Subtype /Type1 /FirstChar 97 /Widths [100] >> /B << /Subtype /Type1 /FirstChar 97 /Widths [900] >> /C 6 0 R >>",
    "<< /Subtype /Type1 /FirstChar 97 /Widths [500] >>",
  );
  // /B is measured with /A's widths (both direct in object 5); /C (object 6) with its own.
  assert.deepStrictEqual(occ(doc), [
    [7200, 69700, 7600, 71000],
    [7200, 59700, 7600, 61000],
    [7200, 49700, 9200, 51000],
  ]);
});

test("placement fonts — хэт том /FirstChar, /W CID нь saturating int (Go)", () => {
  const huge = "99999999999999999999999999999999.0";
  const doc = onePage(
    "/Resources << /Font << /S 5 0 R /N 6 0 R /T 7 0 R /U 9 0 R >> >>",
    fxStream("", s("BT /S 10 Tf 72 700 Td (aaaa) Tj ET BT /N 10 Tf 72 600 Td (aaaa) Tj ET BT /T 10 Tf 72 500 Td <00010002> Tj ET BT /U 10 Tf 72 400 Td <00010002> Tj ET")),
    `<< /Subtype /Type1 /FirstChar ${huge} /Widths [100 100 100] >>`,
    `<< /Subtype /Type1 /FirstChar -${huge} /Widths [100 100 100] >>`,
    "<< /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [8 0 R] >>",
    `<< /Subtype /CIDFontType2 /DW 300 /W [${huge} 1 2000 -${huge} [700 800]] >>`,
    "<< /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [10 0 R] >>",
    `<< /Subtype /CIDFontType2 /DW 300 /W [-${huge} ${huge} 1500] >>`,
  );
  assert.deepStrictEqual(occ(doc), [
    [7200, 69700, 11200, 71000],
    [7200, 59700, 11200, 61000],
    [7200, 49700, 7800, 51000],
    [7200, 39700, 10200, 41000],
  ]);
});

// ── appearance.page 0 = the last page that is not this document's eID verify page (PLACEMENT_SPEC §1a; Go
// TestDefaultStampPage) ──

test("defaultStampPage — skips only the document's own verify pages", () => {
  const docA = "f5a6b7c8-d9e0-4f1a-8b2c-3d4e5f607182";
  const quartzDoc = "6f0c2b9e-3a1d-4c55-9b7e-0a1b2c3d4e5f";
  const uri = (id: string): string => `https://ca.eidmongolia.mn/verify/${id}`;
  const rd = (f: string): Uint8Array => readFileSync(new URL(f, G));
  const cases: [string, Uint8Array, string, number, number][] = [
    ["no verify page", rd("input/quartz-pdf13.pdf"), uri(quartzDoc), 1, 1],
    ["one verify page (first signature)", rd("output/quartz-pdf13.pdf"), uri(quartzDoc), 1, 2],
    ["two verify pages", rd("input/two-verify.pdf"), uri(docA), 1, 3],
    ["other docId", rd("output/quartz-pdf13.pdf"), uri(docA), 2, 2],
    ["fake verify (other docId, /rev suffix)", rd("input/fake-verify.pdf"), uri(docA), 2, 2],
  ];
  const page = (annots: string): Uint8Array =>
    fxPDF([
      s("<< /Type /Catalog /Pages 2 0 R >>"),
      s("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      s(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots ${annots} >>`),
      s(`<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (${uri(docA)}) >> >>`),
    ]);
  // Every page is a verify page → the last page; a direct annotation dictionary counts too.
  cases.push(["only verify pages", page("[4 0 R]"), uri(docA), 1, 1]);
  cases.push(["direct annotation", page(`[<< /Subtype /Link /A << /S /URI /URI (${uri(docA)}) >> >>]`), uri(docA), 1, 1]);
  cases.push(["byte-different URI", page("[4 0 R]"), uri(docA) + "/", 1, 1]);
  for (const [name, doc, u, p, n] of cases) assert.deepEqual(I.defaultStampPage(doc, u), { page: p, n }, name);
});
