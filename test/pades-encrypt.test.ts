// /Encrypt-ийн шууд толь (`/Encrypt << … >>`, `/Encrypt<<`) — лавлагаа (`/Encrypt n g R`)-тай адил PDF_ENCRYPTED (CA !382);
// `/EncryptMetadata` нь encrypted биш. Уншигч нээгдэх (trailer түлхүүр) ба нээгдэхгүй (байтын regex) хоёр замаар.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as pades from "../dist/pades.js";
import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);

const AES256 = "/Filter /Standard /V 5 /R 6 /Length 256 /O <00> /U <00> /OE <00> /UE <00> /Perms <00> /P -4";
const RC4 = "/Filter/Standard/V 2/R 3/Length 128/O<00>/U<00>/P -4";

/** Зөв xref-тэй жижиг PDF; trailer-д нэмэлт `extra`. */
function pdf(extra: string): Uint8Array {
  let s = "%PDF-1.7\n";
  const off: number[] = [];
  const obj = (n: number, body: string) => {
    off[n] = s.length;
    s += `${n} 0 obj\n${body}\nendobj\n`;
  };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
  const x = s.length;
  const pad = (n: number) => String(n).padStart(10, "0");
  s += `xref\n0 3\n0000000000 65535 f \n${pad(off[1]!)} 00000 n \n${pad(off[2]!)} 00000 n \n`;
  s += `trailer\n<< /Size 3 /Root 1 0 R ${extra} >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, "latin1"));
}

/** Уншигч нээж чадахгүй (xref/startxref алга) — зөвхөн байтын regex. */
const broken = (extra: string) => new Uint8Array(Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< ${extra} >>\n`, "latin1"));

async function validateCode(doc: Uint8Array): Promise<string> {
  try {
    await validatePdf(doc, { offline: true });
    return "ok";
  } catch (e) {
    if (e instanceof ValidatePdfError) return e.code;
    throw e;
  }
}

async function prepareCode(doc: Uint8Array): Promise<string> {
  try {
    await pades.prepare(doc, { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem) });
    return "ok";
  } catch (e) {
    if (e instanceof pades.PadesError) return e.code;
    throw e;
  }
}

for (const [name, extra] of [
  ["AES-256 шууд толь", `/Encrypt << ${AES256} >>`],
  ["RC4 шууд толь, зайгүй", `/Encrypt<<${RC4}>>`],
] as const) {
  for (const [kind, doc] of [
    ["уншигч нээгдэнэ", pdf(extra)],
    ["уншигч нээгдэхгүй", broken(extra)],
  ] as const) {
    test(`${name} (${kind}) → PDF_ENCRYPTED`, async () => {
      assert.equal(await validateCode(doc), "PDF_ENCRYPTED");
      assert.equal(await prepareCode(doc), "PDF_ENCRYPTED");
    });
  }
}

test("/EncryptMetadata — encrypted биш", async () => {
  assert.equal(await validateCode(pdf("/EncryptMetadata false")), "PDF_NO_SIGNATURE");
  assert.equal(await validateCode(broken("/EncryptMetadata false")), "PDF_INVALID");
  assert.equal(await prepareCode(broken("/EncryptMetadata false")), "PDF_INVALID");
});
