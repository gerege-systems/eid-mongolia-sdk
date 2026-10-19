// Цуцлалтын нотолгоо (complete-ийн DSS цуглуулалт) ба гүн давхарласан PDF — Go SDK pades/revocation_test.go
// (TestCompleteRevokedIsHardFailure, TestDeepNestingNoCrash, TestCheckStructureBoundary)-ийн TS хувилбар. Offline (DSS)
// дүрэм — validate golden v4 (validate-golden.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import * as pades from "../dist/pades.js";
import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const V = new URL("./fixtures/pades/validate/", import.meta.url);
const read = (u: URL) => new Uint8Array(readFileSync(u));
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const M = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as {
  signingTime: string;
  now: string;
  http: Record<string, string>;
  cases: { name: string; input: string; prepare: Record<string, unknown>; expect: Record<string, unknown> }[];
};

const CITIZEN_OCSP = "POST http://ocsp.pki.test/04 3d432940c5514c0a";
const CRL_04 = "GET http://crl.pki.test/04.crl e3b0c44298fc1c14";

function seededNonce(seed: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(seed), Buffer.of(0)])).digest().subarray(0, 8));
}

/** Golden-ийн эхний complete тохиолдлыг override-той HTTP-ээр дуусгана. */
async function completeWith(override: Record<string, string>, sleeps: number[]): Promise<unknown> {
  const c = M.cases.find((x) => !x.expect.error && !x.input.startsWith("case:"))!;
  assert.ok(M.http[CITIZEN_OCSP] && M.http[CRL_04], "golden-д иргэний OCSP / 04 CRL түлхүүр алга");
  const p = await pades.prepare(read(new URL(c.input, G)), {
    ...(c.prepare as Partial<pades.PadesPrepareOptions>),
    signerCert: pem("citizen"),
    chain: ["04", "03", "02"].map(pem),
    signingTime: new Date(M.signingTime),
  });
  const fetch: pades.PadesCompleteOptions["fetch"] = async (url, init) => {
    const key = `${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`;
    const file = key in override ? override[key] : M.http[key];
    if (!file) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = file.startsWith("validate:") ? read(new URL(file.slice(9), V)) : read(new URL(file, G));
    return { status: 200, arrayBuffer: async () => b.slice().buffer };
  };
  try {
    await pades.complete(p.state, Buffer.from(String(c.expect.signature), "hex"), {
      tsaUrl: "http://tsa.pki.test/",
      roots: [pem("root")],
      fetch,
      httpsUpgrade: false,
      now: () => new Date(M.now),
      sleep: async (ms) => void sleeps.push(ms),
      nonce: () => seededNonce(`golden-nonce:${c.name}`),
    });
  } catch (e) {
    return e;
  }
  return undefined;
}

for (const [name, override] of [
  ["OCSP revoked", { [CITIZEN_OCSP]: "validate:http/online-revoked-0.der" }],
  ["OCSP good, CRL revoked", { [CRL_04]: "validate:http/online-crl-revoked-0.der" }],
  ["OCSP алга, CRL revoked", { [CITIZEN_OCSP]: "", [CRL_04]: "validate:http/online-crl-revoked-0.der" }],
] as const) {
  test(`complete: ${name} → LTV_UNAVAILABLE, CertificateRevokedError, дахин оролдохгүй`, async () => {
    const sleeps: number[] = [];
    const e = await completeWith(override, sleeps);
    assert.ok(e instanceof pades.PadesError, String(e));
    assert.equal(e.code, "LTV_UNAVAILABLE");
    assert.ok((e as { cause?: unknown }).cause instanceof pades.CertificateRevokedError);
    assert.equal(e.retryable, false);
    assert.ok(sleeps.every((d) => d < 1000), `revoked дээр дахин оролдсон: ${sleeps}`);
    assert.doesNotMatch(e.message, /TESTOV/); // иргэний CN (PII) мессежид үгүй
  });
}

test("complete: иргэний OCSP/CRL алга → LTV_UNAVAILABLE (retryable), мессежид CN үгүй", async () => {
  const sleeps: number[] = [];
  const e = await completeWith({ [CITIZEN_OCSP]: "", [CRL_04]: "" }, sleeps);
  assert.ok(e instanceof pades.PadesError, String(e));
  assert.equal(e.code, "LTV_UNAVAILABLE");
  assert.equal(e.retryable, true);
  assert.doesNotMatch(e.message, /TESTOV/);
});

/** Go v4DeepPDF: Catalog-д (эсвэл FlateDecode ObjStm-д) depth түвшний массив. */
function deepPDF(depth: number, objstm: boolean): Uint8Array {
  const nest = "[".repeat(depth) + "]".repeat(depth);
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n", "latin1")];
  const len = () => parts.reduce((n, b) => n + b.length, 0);
  const off: Record<number, number> = {};
  const obj = (n: number, body: string) => {
    off[n] = len();
    parts.push(Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, "latin1"));
  };
  const pad = (n: number) => String(n).padStart(10, "0");
  if (!objstm) {
    obj(1, `<< /Type /Catalog /Pages 3 0 R /X ${nest} >>`);
    obj(3, "<< /Type /Pages /Kids [] /Count 0 >>");
    const x = len();
    parts.push(Buffer.from(`xref\n0 4\n0000000000 65535 f \n${pad(off[1]!)} 00000 n \n0000000000 65535 f \n${pad(off[3]!)} 00000 n \n`, "latin1"));
    parts.push(Buffer.from(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, "latin1"));
    return new Uint8Array(Buffer.concat(parts));
  }
  obj(1, "<< /Type /Catalog /Pages 3 0 R /X 2 0 R >>");
  obj(3, "<< /Type /Pages /Kids [] /Count 0 >>");
  const head = "2 0 ";
  const z = deflateSync(Buffer.from(head + nest, "latin1"));
  off[4] = len();
  parts.push(Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 1 /First ${head.length} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, "latin1"), z);
  parts.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  const row = (t: number, f2: number, f3: number) => {
    const r = Buffer.alloc(7);
    r[0] = t;
    r.writeUInt32BE(f2, 1);
    r.writeUInt16BE(f3, 5);
    return r;
  };
  off[5] = len();
  const rows = Buffer.concat([row(0, 0, 65535), row(1, off[1]!, 0), row(2, 4, 0), row(1, off[3]!, 0), row(1, off[4]!, 0), row(1, off[5]!, 0)]);
  parts.push(Buffer.from(`5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Root 1 0 R /Length ${rows.length} >>\nstream\n`, "latin1"), rows);
  parts.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${off[5]}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

async function validateCode(doc: Uint8Array): Promise<string> {
  try {
    await validatePdf(doc, { offline: true });
    return "ok";
  } catch (e) {
    if (e instanceof ValidatePdfError) return e.code;
    throw e;
  }
}

for (const objstm of [false, true]) {
  test(`гүн давхарлалт (~3 MB, objstm=${objstm}) → PDF_INVALID / STATE_INVALID`, async () => {
    const doc = deepPDF(3 << 20, objstm);
    assert.equal(await validateCode(doc), "PDF_INVALID");
    await assert.rejects(
      () => pades.prepare(doc, { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem) }),
      (e: unknown) => e instanceof pades.PadesError && e.code === "PDF_INVALID",
    );
    const h = Buffer.from(
      JSON.stringify({ docId: "x", signerCert: Buffer.from(pem("citizen")).toString("base64"), signedAttrs: "AQ==", byteRange: [0, 0, 0, 0], revIndex: 1, preparedSha256: sha(doc) }),
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(h.length);
    const state = new Uint8Array(Buffer.concat([Buffer.from("EIDPADES1"), len, h, doc]));
    await assert.rejects(
      () => pades.complete(state, new Uint8Array([1]), { fetch: async () => assert.fail("сүлжээ рүү гарсан") }),
      (e: unknown) => e instanceof pades.PadesError && e.code === "STATE_INVALID",
    );
  });

  test(`гүн давхарлалтын хил (objstm=${objstm}): 256 зөвшөөрнө, 257 татгалзана`, async () => {
    // Сонгодог хувилбарт Catalog толь = 1 түвшин; ObjStm-д объект нь массив өөрөө.
    const n = objstm ? 256 : 255;
    assert.equal(await validateCode(deepPDF(n, objstm)), "PDF_NO_SIGNATURE");
    assert.equal(await validateCode(deepPDF(n + 1, objstm)), "PDF_INVALID");
  });
}
