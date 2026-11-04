// ObjStm-ийн zip bomb / гүний хамгаалалтыг тойрох замууд (Go SDK v0.21.1, CA !466 — 2026-11-04):
// (1) checkStructure нь /Encrypt-ийг түүхий байтын regex-ээр таньж ObjStm-ийн бүх шалгалтыг алгасдаг байв — `% /Encrypt <<`
//     тайлбар, мөр эсвэл stream өгөгдөл хангалттай (~33 KB → 33 MiB задрал, уншигч хязгааргүй задална);
// (2) scanner ба уншигч /Filter-ийг өөрөөр уншдаг байв — `[/FlateDecode /FlateDecode]` (уншигч гинжлэн задална), давхар
//     түлхүүр `null` / `[]` (уншигч сүүлийнхийг түүхийгээр уншина), массив доторх лавлагаа `[6 0 R]` (уншигч resolve хийнэ).
// Go objstm_encrypt_test.go + encrypt_test.go-ийн оролтууд; fixture test/fixtures/pades/encrypted-objstm/ = Go
// pades/testdata/encrypted-objstm/ (qpdf 12.4.2 `--object-streams=generate --encrypt`, байт-ижил).
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { deflateSync, constants } from "node:zlib";

import * as pades from "../dist/pades.js";
import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const E = new URL("./fixtures/pades/encrypted-objstm/", import.meta.url);
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);

const MAX_OBJSTM_BYTES = 32 << 20;
const MAX_NESTING = 256;
const latin1 = (s: string) => Buffer.from(s, "latin1");
const deflate = (b: Uint8Array) => deflateSync(b);

async function validateCode(doc: Uint8Array): Promise<string> {
  try {
    await validatePdf(doc, { offline: true });
    return "ok";
  } catch (e) {
    if (e instanceof ValidatePdfError) return e.code;
    throw e;
  }
}

/** PadesError-ийн код; бүтцийн урьдчилсан шалгалтаар (уншигчаас өмнө) унасан бол "+structure". */
function padesCode(e: unknown): string {
  if (e instanceof pades.PadesError) return e.code + ((e as { cause?: Error }).cause?.name === "StructureError" ? "+structure" : "");
  throw e;
}

async function prepareCode(doc: Uint8Array): Promise<string> {
  try {
    await pades.prepare(doc, { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem) });
    return "ok";
  } catch (e) {
    return padesCode(e);
  }
}

async function placementCode(doc: Uint8Array): Promise<string> {
  try {
    await pades.suggestPlacement(doc, { x: 36, y: 36, width: 200, height: 60 });
    return "ok";
  } catch (e) {
    return padesCode(e);
  }
}

/** "4 0 " толгой + MAX_OBJSTM_BYTES-ээс их хоосон зай; задлахад ~33 MiB, шахсан нь ~33 KB. */
let bomb: Buffer | undefined;
const zipBombStream = () =>
  (bomb ??= deflateSync(Buffer.concat([latin1("4 0 "), Buffer.alloc(MAX_OBJSTM_BYTES + (1 << 20), 0x20)]), { level: constants.Z_BEST_COMPRESSION }));

/** Go zipBombObjStmPDF: сонгодог xref, obj 3 = zip bomb FlateDecode ObjStm; inject толгойн дараа (xref-д бүртгэлгүй). */
function zipBombObjStmPDF(inject: string, trailerExtra: string): Uint8Array {
  const z = zipBombStream();
  const parts: Buffer[] = [latin1(`%PDF-1.7\n${inject}\n`)];
  const len = () => parts.reduce((n, b) => n + b.length, 0);
  const offs: number[] = [];
  offs.push(len());
  parts.push(latin1("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  offs.push(len());
  parts.push(latin1("2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"));
  offs.push(len());
  parts.push(latin1(`3 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`), z, latin1("\nendstream\nendobj\n"));
  const x = len();
  let s = "xref\n0 4\n0000000000 65535 f \n";
  for (const o of offs) s += `${String(o).padStart(10, "0")} 00000 n \n`;
  s += `trailer\n<< /Size 4 /Root 1 0 R ${trailerExtra}>>\nstartxref\n${x}\n%%EOF\n`;
  parts.push(latin1(s));
  return new Uint8Array(Buffer.concat(parts));
}

const ID = "<abababababababababababababababab>";
for (const [name, doc] of [
  ["шифрлэлтгүй", () => zipBombObjStmPDF("", "")],
  ["%-тайлбарт `/Encrypt <<`", () => zipBombObjStmPDF("% /Encrypt <<", "")],
  ["%-тайлбарт `/Encrypt N 0 R`", () => zipBombObjStmPDF("% /Encrypt 9 0 R", "")],
  ["мөр дотор", () => zipBombObjStmPDF("5 0 obj\n(/Encrypt <<)\nendobj", "")],
  ["stream өгөгдөл дотор", () => zipBombObjStmPDF("5 0 obj\n<< /Length 11 >>\nstream\n/Encrypt <<\nendstream\nendobj", "")],
  [
    "trailer-ийн жинхэнэ /Encrypt",
    () =>
      zipBombObjStmPDF(
        "",
        `/ID [${ID} ${ID}] /Encrypt << /Filter /Standard /V 2 /R 3 /Length 128 /O <${"55".repeat(32)}> /U <${"66".repeat(32)}> /P -4 >> `,
      ),
  ],
] as const) {
  test(`ObjStm zip bomb (${name}) → PDF_INVALID (бүтэц)`, async () => {
    const d = doc();
    assert.equal(await validateCode(d), "PDF_INVALID");
    assert.equal(await prepareCode(d), "PDF_INVALID+structure");
    assert.equal(await placementCode(d), "PDF_INVALID+structure");
  });
}

// Бодит шифрлэгдсэн, ObjStm-тэй баримт (хэрэглэгчийн нууц үг хоосон): ObjStm-ийн ciphertext-ийг шалгах нь хуурамч
// бүтцийн татгалзалт өгөхгүй — validatePdf / prepare / suggestPlacement бүгд PDF_ENCRYPTED хэвээр.
const encFiles = readdirSync(E).filter((f) => f.endsWith(".pdf")).sort();
test("encrypted-objstm fixture 4 ширхэг", () => assert.deepEqual(encFiles, ["aes128.pdf", "aes256.pdf", "rc4-uncompressed.pdf", "rc4.pdf"]));
for (const f of encFiles) {
  test(`шифрлэгдсэн ObjStm (${f}) → PDF_ENCRYPTED`, async () => {
    const doc = new Uint8Array(readFileSync(new URL(f, E)));
    const s = Buffer.from(doc).toString("latin1");
    assert.ok(s.includes("/ObjStm") && s.includes("/Encrypt"), "ObjStm / Encrypt алга — тестийн өгөгдөл буруу");
    assert.equal(await validateCode(doc), "PDF_ENCRYPTED");
    assert.equal(await prepareCode(doc), "PDF_ENCRYPTED");
    assert.equal(await placementCode(doc), "PDF_ENCRYPTED");
  });
}

/** Go objStmXrefPDF: xref stream-тэй PDF, obj 3 нь ObjStm 4 дотор (толгойн нэмэлт hdr, түүхий stream өгөгдөл data). */
function objStmXrefPDF(hdr: string, data: Uint8Array): Uint8Array {
  const parts: Buffer[] = [latin1("%PDF-1.7\n")];
  const len = () => parts.reduce((n, b) => n + b.length, 0);
  const offs = new Map<number, number>();
  offs.set(1, len());
  parts.push(latin1("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  offs.set(2, len());
  parts.push(latin1("2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"));
  offs.set(4, len());
  parts.push(latin1(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 ${hdr} /Length ${data.length} >>\nstream\n`), Buffer.from(data), latin1("\nendstream\nendobj\n"));
  offs.set(5, len());
  const xr: number[] = [];
  for (let i = 0; i <= 5; i++) {
    const o = offs.get(i);
    if (i === 3) xr.push(2, 0, 0, 0, 4, 0, 0);
    else if (o !== undefined) xr.push(1, (o >>> 24) & 0xff, (o >>> 16) & 0xff, (o >>> 8) & 0xff, o & 0xff, 0, 0);
    else xr.push(0, 0, 0, 0, 0, 0xff, 0xff);
  }
  parts.push(latin1(`5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Root 1 0 R /Length ${xr.length} >>\nstream\n`), Buffer.from(xr));
  parts.push(latin1(`\nendstream\nendobj\nstartxref\n${offs.get(5)}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const deep = Buffer.concat([latin1("3 0 "), Buffer.alloc(MAX_NESTING + 10, 0x5b)]);
const ok3 = latin1("3 0 << >>");
for (const [name, hdr, data, bad] of [
  ["хууль ёсны [/FlateDecode]", "/Filter [/FlateDecode]", deflate(ok3), false],
  ["хууль ёсны шүүлтүүргүй", "", ok3, false],
  ["[/FlateDecode] гүн", "/Filter [/FlateDecode]", deflate(deep), true],
  ["[/FlateDecode /FlateDecode]", "/Filter [/FlateDecode /FlateDecode]", deflate(deflate(ok3)), true],
  ["давхар түлхүүр /FlateDecode → null", "/Filter /FlateDecode /Filter null", deep, true],
  ["давхар түлхүүр /FlateDecode → []", "/Filter /FlateDecode /Filter []", deep, true],
  ["давхар түлхүүр [] → /FlateDecode", "/Filter [] /Filter /FlateDecode", deflate(deep), true],
  ["давхар түлхүүр /ASCIIHex → [] (гүн)", "/Filter /ASCIIHexDecode /Filter []", deep, true],
  ["[6 0 R] (лавлагаа массив дотор)", "/Filter [6 0 R]", deflate(deep), true],
  ["[/FlateDecode 6 0 R]", "/Filter [/FlateDecode 6 0 R]", deflate(deflate(deep)), true],
] as const) {
  test(`ObjStm /Filter scanner ↔ уншигч: ${name} → ${bad ? "PDF_INVALID (бүтэц)" : "PDF_NO_SIGNATURE"}`, async () => {
    const doc = objStmXrefPDF(hdr, data);
    assert.equal(await validateCode(doc), bad ? "PDF_INVALID" : "PDF_NO_SIGNATURE");
    if (bad) assert.equal(await prepareCode(doc), "PDF_INVALID+structure");
    else assert.notEqual(await prepareCode(doc), "PDF_INVALID+structure");
  });
}
