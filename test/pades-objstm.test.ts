// PRECHECKS #2b (Go SDK chore/sdk-low-cleanup, objstm.go + nesting.go /Size): ObjStm мөчлөг (өөрийгөө / харилцан агуулах,
// толгойн /Length ObjStm дотор), /Extends мөчлөг, /Size > 2^21 → PDF_INVALID; хууль ёсны ObjStm хэвээр. Go
// TestCheckStructureObjStmGraph-ийн оролтууд + FuzzValidatePDF-ийн crash seed (regression).
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as pades from "../dist/pades.js";
import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);

/** Go xrefStreamPDF: obj 1 Catalog (/X 3 0 R), obj 2 xref stream (/Size size, W [1 2 1]), obj 3 = ObjStm 4-ийн объект. */
function xrefStreamPDF(size: string, length4: string, row3?: number[], row4?: number[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n%" + "x".repeat(300) + "\n", "latin1")];
  const len = () => parts.reduce((n, b) => n + b.length, 0);
  const off1 = len();
  parts.push(Buffer.from("1 0 obj\n<< /Type /Catalog /X 3 0 R >>\nendobj\n", "latin1"));
  const off4 = len();
  parts.push(Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${length4} >>\nstream\n3 0 << >>\nendstream\nendobj\n`, "latin1"));
  const off2 = len();
  const row = (t: number, f2: number, f3: number) => [t, (f2 >> 8) & 0xff, f2 & 0xff, f3];
  const rows = Buffer.from([...row(0, 0, 0xff), ...row(1, off1, 0), ...row(1, off2, 0), ...(row3 ?? row(2, 4, 0)), ...(row4 ?? row(1, off4, 0))]);
  parts.push(Buffer.from(`2 0 obj\n<< /Type /XRef /Size ${size} /W [1 2 1] /Index [0 5] /Root 1 0 R /Length ${rows.length} >>\nstream\n`, "latin1"), rows);
  parts.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${off2}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

const inStm = (container: number) => [2, 0, container, 0];

async function validateCode(doc: Uint8Array): Promise<string> {
  try {
    await validatePdf(doc, { offline: true });
    return "ok";
  } catch (e) {
    if (e instanceof ValidatePdfError) return e.code;
    throw e;
  }
}

/** prepare-ийн код; бүтцийн урьдчилсан шалгалтаар (уншигчийн рекурсээс өмнө) унасан бол "+structure". */
async function prepareCode(doc: Uint8Array): Promise<string> {
  try {
    await pades.prepare(doc, { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem) });
    return "ok";
  } catch (e) {
    if (e instanceof pades.PadesError) return e.code + ((e as { cause?: Error }).cause?.name === "StructureError" ? "+structure" : "");
    throw e;
  }
}

for (const [name, doc, want] of [
  ["ObjStm-д obj 3 (хууль ёсны)", xrefStreamPDF("5", "9"), "PDF_NO_SIGNATURE"],
  ["/Size 2^21 (хил)", xrefStreamPDF(String(1 << 21), "9"), "PDF_NO_SIGNATURE"],
  ["obj 3 өөрийнхөө агуулагч", xrefStreamPDF("5", "9", inStm(3)), "PDF_INVALID"],
  ["ObjStm 4 нь ObjStm 3 дотор (харилцан)", xrefStreamPDF("5", "9", undefined, inStm(3)), "PDF_INVALID"],
  ["ObjStm-ийн /Length өөрийн ObjStm дотор", xrefStreamPDF("5", "3 0 R"), "PDF_INVALID"],
  ["/Size 2^21+1", xrefStreamPDF(String((1 << 21) + 1), "9"), "PDF_INVALID"],
  ["/Size 10^10", xrefStreamPDF("10000000000", "9"), "PDF_INVALID"],
  ["fuzz seed c8b2f6dc9d5d37bf", new Uint8Array(readFileSync(new URL("./fixtures/pades/fuzz/objstm-cycle-c8b2f6dc9d5d37bf.pdf", import.meta.url))), "PDF_INVALID"],
] as const) {
  test(`ObjStm/xref бүтэц: ${name} → ${want}`, async () => {
    assert.equal(await validateCode(doc), want);
    if (want === "PDF_INVALID") assert.equal(await prepareCode(doc), "PDF_INVALID+structure");
  });
}

test("%%EOF-гүй ~10 MiB баримт — хурдан PDF_INVALID (startxref хайлт шугаман)", async () => {
  const doc = new Uint8Array((10 << 20) - 1).fill(0x41);
  doc.set(Buffer.from("%PDF-1.7\n", "latin1"));
  const t = Date.now();
  assert.equal(await validateCode(doc), "PDF_INVALID");
  assert.ok(Date.now() - t < 5000, `${Date.now() - t} мс`);
});
