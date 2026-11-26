// validatePdf hardening (Go pades/testdata/validate v14): уншигч/ASN.1-ийн DoS-ийн регресс — оролт бүр хугацааны хязгаартай
// (засварын өмнө эдгээр нь минут-цаг гацдаг эсвэл санах ой дуусгадаг байв). Корпусын тайлан (shadow, later-signature,
// platform_attested, weak algorithm) validate-golden.test.ts-д Go-той deep-equal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const F = new URL("./fixtures/pades/", import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, F)));
const root = fileURLToPath(new URL("..", import.meta.url));

// src-ийн дотоод модулиудыг нэг ESM болгон багцлана (NodeNext .js импорт).
const out = join(mkdtempSync(join(tmpdir(), "eid-hard-")), "internal.mjs");
const r = await build({
  stdin: {
    contents: [
      `export { oidString } from "./src/pades/asn1.ts";`,
      `export { Reader, PRef, isOOM } from "./src/pades/pdf/reader.ts";`,
      `export { checkStructure, StructureError } from "./src/pades/pdf/nesting.ts";`,
      `export { boundedCert, extract } from "./src/pades/validate/extract.ts";`,
      `export { parseCertificate, verifySignature } from "./src/pades/x509.ts";`,
      `export { parseOne } from "./src/pades/asn1.ts";`,
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
writeFileSync(out, r.outputFiles[0]!.contents);
const I = (await import(pathToFileURL(out).href)) as {
  oidString: (v: Uint8Array) => string;
  Reader: new (b: Uint8Array) => { xref: { ptr: { id: number; gen: number } }[]; resolve: (p: unknown, x: unknown) => { data: unknown } };
  PRef: new (id: number, gen: number) => unknown;
  isOOM: (e: unknown) => boolean;
  checkStructure: (doc: Uint8Array) => void;
  StructureError: new () => Error;
  boundedCert: (c: { serial: Uint8Array; keyAlg: string; publicKey: Uint8Array }) => boolean;
  extract: (doc: Uint8Array) => Promise<{ sigs: { dss?: { certs: Uint8Array[]; ocsps: Uint8Array[]; crls: Uint8Array[] } }[] }>;
  parseCertificate: (der: Uint8Array) => unknown;
  verifySignature: (pub: unknown, alg: unknown, data: Uint8Array, sig: Uint8Array) => Promise<boolean>;
  parseOne: (b: Uint8Array) => unknown;
};

/** f-ийг ms хугацаанд дуусгах ёстой (синхрон ажлыг тасалж чадахгүй — хэмжинэ). */
async function within<T>(name: string, ms: number, f: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now();
  const v = await f();
  const dt = performance.now() - t0;
  assert.ok(dt < ms, `${name}: ${dt.toFixed(0)} ms ≥ ${ms} ms`);
  return v;
}

const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

test("E1: OID > 128 байт / arc > 63 бит — шугаман хугацаанд татгалзана", async () => {
  const big = new Uint8Array(5 << 20).fill(0x81);
  big[big.length - 1] = 0x01;
  await within("5 MB OID", 200, () => assert.ok(throws(() => I.oidString(big))));
  const long = new Uint8Array(129).fill(0x01);
  assert.ok(throws(() => I.oidString(long)));
  assert.equal(I.oidString(new Uint8Array(128).fill(0x01)).split(".").length, 129);
  const arc63 = Uint8Array.of(0x2a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f); // 9 байт = 63 бит
  assert.equal(I.oidString(arc63), `1.2.${(1n << 63n) - 1n}`);
  assert.ok(throws(() => I.oidString(Uint8Array.of(0x2a, 0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f))));
});

test("E2: xref stream /W [0 0 0], 64 MiB тэг мөр, /Prev гинж 129 — уншигч ба validatePdf хурдан татгалзана", async () => {
  for (const n of ["xref-stream-w-zero", "xref-stream-zero-rows", "xref-prev-chain-129"]) {
    const doc = read(`validate/input/${n}.pdf`);
    // Уншигч өөрөө (урьдчилсан шалгалтгүйгээр) — мөрийн урт 0 / мөрийн тоо / гинжийн урт / тайлалтын төсөв.
    await within(`${n}: Reader`, 3000, () => assert.ok(throws(() => new I.Reader(doc)), `${n}: Reader хүлээн авсан`));
    await within(`${n}: checkStructure`, 3000, () => assert.ok(throws(() => I.checkStructure(doc))));
    await within(`${n}: validatePdf`, 5000, async () => {
      await assert.rejects(validatePdf(doc, { offline: true }), (e: unknown) => e instanceof ValidatePdfError && e.code === "PDF_INVALID");
    });
  }
});

test("E3: 200k гишүүнтэй ObjStm — уншигч толгойг нэг удаа индекслэнэ, урьдчилсан шалгалт татгалзана", async () => {
  const doc = read("validate/input/objstm-many-members.pdf");
  await within("checkStructure", 5000, () => assert.ok(throws(() => I.checkStructure(doc))));
  await within("validatePdf", 8000, async () => {
    await assert.rejects(validatePdf(doc, { offline: true }), (e: unknown) => e instanceof ValidatePdfError && e.code === "PDF_INVALID");
  });
  // Уншигч (урьдчилсан шалгалтгүй): бүх гишүүнийг задлах нь O(гишүүн + өгөгдөл) — өмнө нь гишүүн бүрд stream-ийг дахин
  // задалж толгойг эхнээс нь уншдаг байв (200k × ~3 MB).
  await within("Reader: бүх гишүүн", 15000, () => {
    const rd = new I.Reader(doc);
    let n = 0;
    for (const x of rd.xref) {
      if (x.ptr.id === 0) continue;
      rd.resolve(x.ptr, new I.PRef(x.ptr.id, x.ptr.gen));
      n++;
    }
    assert.ok(n > 200000);
  });
});

test("E4: boundedCert — RSA ≤ 8192 бит, e ≤ 2^32−1, serial ≤ 160 бит", () => {
  const rsaKey = (nBytes: Uint8Array, eBytes: Uint8Array): Uint8Array => {
    const tlv = (tag: number, v: Uint8Array): Uint8Array => {
      const len = v.length < 0x80 ? [v.length] : v.length < 0x100 ? [0x81, v.length] : [0x82, v.length >> 8, v.length & 0xff];
      return Uint8Array.from([tag, ...len, ...v]);
    };
    return tlv(0x30, Uint8Array.from([...tlv(0x02, nBytes), ...tlv(0x02, eBytes)]));
  };
  const n = (bits: number) => {
    const b = new Uint8Array(1 + Math.ceil(bits / 8));
    b[1] = 1 << ((bits - 1) % 8); // яг bits бит (тэргүүлэх 0x00 — эерэг)
    b[b.length - 1] |= 1;
    return b;
  };
  const RSA = "1.2.840.113549.1.1.1";
  const c = (bits: number, e: Uint8Array, serial: Uint8Array) => ({ serial, keyAlg: RSA, publicKey: rsaKey(n(bits), e) });
  const e65537 = Uint8Array.of(0x01, 0x00, 0x01);
  const s7 = Uint8Array.of(7);
  assert.equal(I.boundedCert(c(8192, e65537, s7)), true);
  assert.equal(I.boundedCert(c(8200, e65537, s7)), false);
  assert.equal(I.boundedCert(c(2048, Uint8Array.of(0x00, 0xff, 0xff, 0xff, 0xff), s7)), true); // 2^32−1
  assert.equal(I.boundedCert(c(2048, Uint8Array.of(0x01, 0x00, 0x00, 0x00, 0x01), s7)), false); // 2^32+1
  assert.equal(I.boundedCert(c(2048, e65537, Uint8Array.from([0x00, ...new Uint8Array(20).fill(0xff)]))), true); // 160 бит
  assert.equal(I.boundedCert(c(2048, e65537, Uint8Array.from([0x01, ...new Uint8Array(20)]))), false); // 161 бит
  assert.equal(I.boundedCert({ serial: s7, keyAlg: "1.2.840.10045.2.1", publicKey: new Uint8Array(65) }), true);
});

test("E5: DSS-ийн давхар заалт нэг удаа уншигдана", async () => {
  const base = read("golden/output/quartz-pdf13.pdf");
  const text = Buffer.from(base).toString("latin1");
  const want = (await I.extract(base)).sigs[0]!.dss!;
  // Сүүлийн DSS толийн /OCSPs-ийн эхний заалт ба /Certs /CRLs-ийг уншиж шинэ DSS + Catalog revision бичнэ.
  const dssM = [...text.matchAll(/\/OCSPs \[([^\]]*)\]/g)].pop()!;
  const firstRef = /(\d+) 0 R/.exec(dssM[1]!)![1]!;
  const certs = [...text.matchAll(/\/Certs \[([^\]]*)\]/g)].pop()![1]!;
  const crls = [...text.matchAll(/\/CRLs \[([^\]]*)\]/g)].pop()![1]!;
  const pages = /\/Pages (\d+) 0 R/.exec(text)![1]!;
  const size = Number([...text.matchAll(/\/Size (\d+)/g)].pop()![1]!);
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]!);
  let s = text;
  const dssOff = s.length;
  s += `${size} 0 obj\n<< /Certs [${certs}] /OCSPs [${`${firstRef} 0 R `.repeat(64)}] /CRLs [${crls}] >>\nendobj\n`;
  const catOff = s.length;
  s += `${size + 1} 0 obj\n<< /Type /Catalog /Pages ${pages} 0 R /DSS ${size} 0 R >>\nendobj\n`;
  const x = s.length;
  const pad = (v: number) => String(v).padStart(10, "0");
  s += `xref\n${size} 2\n${pad(dssOff)} 00000 n \n${pad(catOff)} 00000 n \ntrailer\n<< /Size ${size + 2} /Root ${size + 1} 0 R /Prev ${prev} >>\nstartxref\n${x}\n%%EOF\n`;
  const got = (await I.extract(new Uint8Array(Buffer.from(s, "latin1")))).sigs[0]!.dss!;
  assert.equal(got.ocsps.length, 1);
  assert.equal(got.certs.length, want.certs.length);
  assert.equal(got.crls.length, want.crls.length);
});

test("E6: isOOM — санах ойн RangeError-ийг (стек хэтрэлтээс бусад) ялгана", () => {
  assert.equal(I.isOOM(new RangeError("Invalid array length")), true);
  assert.equal(I.isOOM(new RangeError("Array buffer allocation failed")), true);
  assert.equal(I.isOOM(new RangeError("Maximum call stack size exceeded")), false);
  assert.equal(I.isOOM(new Error("x")), false);
});

test("D: RSA-PSS-ийн параметр — SHA-256/384/512, ижил MGF1, salt = hLen (Go x509)", async () => {
  const pub = I.parseCertificate(new Uint8Array(new X509Certificate(readFileSync(new URL("golden/pki/04.pem", F))).raw));
  const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/\s+/g, ""), "hex"));
  const PSS = "06092a864886f70d01010a";
  const sha256 = "300d0609608648016503040201 0500";
  const sha1 = "300906052b0e03021a 0500";
  const mgf = (h: string) => seq("06092a864886f70d010108", h);
  // AlgorithmIdentifier { id-RSASSA-PSS, params }
  const alg = (params: string) => {
    const p = hex(params);
    const body = Uint8Array.from([...hex(PSS), ...p]);
    return I.parseOne(Uint8Array.from([0x30, body.length, ...body]));
  };
  const seq = (...parts: string[]) => {
    const b = hex(parts.join(""));
    return Buffer.from(Uint8Array.from([0x30, b.length, ...b])).toString("hex");
  };
  const ctx = (n: number, inner: string) => {
    const b = hex(inner);
    return Buffer.from(Uint8Array.from([0xa0 + n, b.length, ...b])).toString("hex");
  };
  const reject = async (name: string, a: unknown) => {
    let ok = false;
    try {
      ok = await I.verifySignature(pub, a, new Uint8Array(1), new Uint8Array(256));
    } catch {
      ok = false;
    }
    assert.equal(ok, false, name);
    await assert.rejects(I.verifySignature(pub, a, new Uint8Array(1), new Uint8Array(256)), name);
  };
  await reject("параметргүй (SHA-1 анхдагч)", alg("3000"));
  await reject("SHA-1", alg(seq(ctx(0, sha1), ctx(1, mgf(sha1)), ctx(2, "020114"))));
  await reject("MGF1 hash зөрсөн", alg(seq(ctx(0, sha256), ctx(1, mgf(sha1)), ctx(2, "020120"))));
  await reject("salt ≠ hLen", alg(seq(ctx(0, sha256), ctx(1, mgf(sha256)), ctx(2, "020114"))));
  await reject("saltLength алга", alg(seq(ctx(0, sha256), ctx(1, mgf(sha256)))));
  // Зөв параметр — гарын үсэг таарахгүй (false), алгоритм дэмжигдэнэ (шидэхгүй).
  assert.equal(await I.verifySignature(pub, alg(seq(ctx(0, sha256), ctx(1, mgf(sha256)), ctx(2, "020120"))), new Uint8Array(1), new Uint8Array(256)), false);
});
