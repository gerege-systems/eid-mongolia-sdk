// digitorus lex.go-ийн ахихгүй давталт (Go: craftzbay/pdf v0.1.3-eid.1): массив дотор `endobj`, ObjStm-ийн төгсгөлд
// хаагдаагүй массив / hex / literal мөр → PDF_INVALID, ХУРДАН. Давталт синхрон тул node:test-ийн timeout тасалж
// чадахгүй — оролт бүрийг worker thread-д ажиллуулж, хугацаа хэтэрвэл terminate хийгээд унагана.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);

/** obj 1 Catalog (/X 3 0 R), obj 2 xref stream, obj 3 = ObjStm 4-ийн объект (бие = body). */
function objStmPDF(body: string): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n%" + "x".repeat(300) + "\n", "latin1")];
  const len = () => parts.reduce((n, b) => n + b.length, 0);
  const off1 = len();
  parts.push(Buffer.from("1 0 obj\n<< /Type /Catalog /X 3 0 R >>\nendobj\n", "latin1"));
  const off4 = len();
  const data = "3 0 " + body;
  parts.push(Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`, "latin1"));
  const off2 = len();
  const row = (t: number, f2: number, f3: number) => [t, (f2 >> 8) & 0xff, f2 & 0xff, f3];
  const rows = Buffer.from([...row(0, 0, 0xff), ...row(1, off1, 0), ...row(1, off2, 0), ...row(2, 4, 0), ...row(1, off4, 0)]);
  parts.push(Buffer.from(`2 0 obj\n<< /Type /XRef /Size 5 /W [1 2 1] /Index [0 5] /Root 1 0 R /Length ${rows.length} >>\nstream\n`, "latin1"), rows);
  parts.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${off2}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

/** Хуучин xref-тэй: obj 1 Catalog, obj 2 = body (ард нь `endobj`). */
function classicPDF(body: string): Uint8Array {
  let s = "%PDF-1.7\n";
  const offs: number[] = [];
  for (const o of ["<< /Type /Catalog /X 2 0 R >>", body]) {
    offs.push(s.length);
    s += `${offs.length} 0 obj\n${o}\nendobj\n`;
  }
  const x = s.length;
  s += "xref\n0 3\n0000000000 65535 f \n" + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  s += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, "latin1"));
}

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { mode, doc, signer, chain, dist } = workerData;
  try {
    if (mode === "validate") {
      const { validatePdf } = await import(dist + "validate.js");
      await validatePdf(doc, { offline: true });
    } else {
      const pades = await import(dist + "pades.js");
      await pades.prepare(doc, { signerCert: signer, chain });
    }
    parentPort.postMessage("ok");
  } catch (e) {
    parentPort.postMessage(e && e.code ? e.code : String(e));
  }
})();
`;

function codeWithin(mode: "validate" | "prepare", doc: Uint8Array, ms: number): Promise<string> {
  const dist = new URL("../dist/", import.meta.url).href;
  const w = new Worker(WORKER, { eval: true, workerData: { mode, doc, signer: pem("citizen"), chain: ["04", "03", "02"].map(pem), dist } });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      void w.terminate();
      reject(new Error(`${mode}: ${ms} мс-д буцсангүй (мөнхийн давталт)`));
    }, ms);
    w.once("message", (m: string) => {
      clearTimeout(t);
      void w.terminate();
      resolve(m);
    });
    w.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

for (const [name, doc] of [
  ["endobj массивт", classicPDF("[1")],
  ["endobj давхар массивт", classicPDF("<< /K [[ /A")],
  ["ObjStm хаагдаагүй массив", objStmPDF("[1")],
  ["ObjStm хаагдаагүй literal мөр", objStmPDF("(abc")],
  ["ObjStm хаагдаагүй hex мөр", objStmPDF("<0a")],
] as const) {
  for (const mode of ["validate", "prepare"] as const) {
    test(`lexer давталт: ${name} → PDF_INVALID (${mode})`, async () => {
      assert.equal(await codeWithin(mode, doc, 750), "PDF_INVALID");
    });
  }
}
