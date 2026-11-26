// sealPdf → sealRegistration → CA-ийн POST /seal/{orgEtsi}/registrations-ийн дүрэм (ca-eidmongolia-mn main 70c0e09c,
// server/internal/service/memory/pades_seal_register.go RegisterSealSignature + handlers_seal_register.go). Go
// pades/seal_register_test.go-ийн TS хувилбар; QR-тэй тохиолдлууд golden v13-ийн (Go reference) seal-qr-visible,
// citizen-then-seal-qr, seal-qr-then-seal-qr-ийг sealPdf({qr: true})-ээр бүтнээр нь (prepare + seal + complete) давтаж,
// гаралт output/<case>.pdf-тэй байт-ижил ба бүртгэлийн hash-ууд Go-ийн expect-тэй тэнцүү гэдгийг баталгаажуулна.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { SEAL_REGISTER_FIELDS, buildSealRegisterBody } from "../dist/index.js";
import * as pades from "../dist/pades.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const S = new URL("./fixtures/pades/seal/", import.meta.url);
const read = (u: URL) => new Uint8Array(readFileSync(u));
const readG = (p: string) => read(new URL(p, G));
const pem = (u: URL) => new Uint8Array(new X509Certificate(readFileSync(u)).raw);
const pki = (n: string) => pem(new URL(`pki/${n}.pem`, G));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Case {
  name: string;
  input: string;
  prepare: { reason?: string; docId?: string; lang?: "mn" | "en"; appearance?: pades.PadesAppearance };
  expect: Record<string, unknown> & {
    inputSha256: string;
    docId: string;
    dtbs: string;
    signature: string;
    outSha256: string;
    sigRevSha256: string;
    cmsSha256: string;
    revIndex: number;
    priorCmsSha256?: string[];
  };
}
const GM = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as { signingTime: string; now: string; http: Record<string, string>; cases: Case[] };
const gcase = (n: string) => GM.cases.find((c) => c.name === n)!;

const seeded = (seed: string) => new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(seed), Buffer.of(0)])).digest().subarray(0, 8));

function replay(http: Record<string, string>, base: URL): pades.PadesCompleteOptions["fetch"] {
  return async (url, init) => {
    const f = http[`${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`];
    if (!f) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = read(new URL(f, base));
    return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  };
}

/** Sealer: тогтмол гарын үсэг (Go reference-ийн), нөөцийг тэмдэглэнэ. */
function sealer(cert: Uint8Array, sig: Uint8Array, withReservation = true) {
  const calls: { digest: string; docId?: string; revIndex?: number }[] = [];
  const s: pades.PadesSealer = {
    getCertificate: async () => ({ certificate: cert }),
    seal: async (_org, digest) => {
      calls.push({ digest: hex(digest) });
      return { signature: sig, certificate: cert };
    },
  };
  if (withReservation) {
    s.sealForDocument = async (_org, digest, docId, revIndex) => {
      calls.push({ digest: hex(digest), docId, revIndex });
      return { signature: sig, certificate: cert };
    };
  }
  return { s, calls };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** CA dto.SealRegisterRequest-ийн JSON tag (DisallowUnknownFields). */
const CA_FIELDS = ["docID", "revIndex", "cms", "fileName", "inSha256", "sigRevSha256", "outSha256", "priorCmsSha256", "priorRevisionSha256"];

/**
 * CA-ийн шалгалтын сүлжээ/DB/TSA-гүй хэсэг: handler (≤ 64 KiB, DisallowUnknownFields), normalizeSealRegister (хэлбэр),
 * SHA-256(signedAttrs) = тамгалсан digest (sealOpFor — энд Go-ийн expect.dtbs), нөөц = бүртгэл (SEAL_DOC_MISMATCH),
 * файлын нотолгоо (validate.SignatureProof: cms_sha256, sigRev, out).
 */
function caAccepts(
  reg: pades.PadesSealRegistration | undefined,
  want: { in: string; out: string; sigRev: string; cms: string; revIndex: number; docId?: string; prior?: string[] },
  sealed: { digest: string; docId?: string; revIndex?: number },
  dtbs: string,
): Record<string, unknown> {
  assert.ok(reg, "sealRegistration алга");
  const body = buildSealRegisterBody(reg);
  const json = JSON.stringify(body);
  assert.ok(Buffer.byteLength(json) <= 64 << 10, "body ≤ 64 KiB");
  assert.deepEqual([...SEAL_REGISTER_FIELDS].sort(), [...CA_FIELDS].sort(), "SDK талбар = CA dto");
  for (const k of Object.keys(body)) assert.ok(CA_FIELDS.includes(k), `CA DisallowUnknownFields: ${k}`);
  assert.match(String(body.docID), UUID);
  if (want.docId) assert.equal(body.docID, want.docId);
  assert.equal(body.revIndex, want.revIndex);
  const cms = Buffer.from(String(body.cms), "base64");
  assert.ok(cms.length > 0 && cms.length <= 28_672);
  assert.equal(sha(cms), want.cms, "cms_sha256");
  for (const k of ["inSha256", "sigRevSha256", "outSha256"]) assert.match(String(body[k]), HEX64, k);
  assert.equal(body.inSha256, want.in, "inSha256");
  assert.equal(body.outSha256, want.out, "outSha256");
  assert.equal(body.sigRevSha256, want.sigRev, "sigRevSha256");
  const prior = (body.priorCmsSha256 as string[] | undefined) ?? [];
  assert.equal(prior.length + ((body.priorRevisionSha256 as string[] | undefined)?.length ?? 0), want.revIndex - 1, "prior тоо");
  assert.deepEqual(prior, want.prior ?? [], "priorCmsSha256");
  assert.equal(sealed.digest, dtbs, "SHA-256(signedAttrs) = тамгалсан digest (CA SEAL_NOT_FOUND)");
  if (sealed.docId !== undefined) assert.deepEqual([sealed.docId, sealed.revIndex], [body.docID, body.revIndex], "нөөц = бүртгэл (SEAL_DOC_MISMATCH)");
  return body;
}

const goldenOpts = (c: Case): pades.PadesSealOptions => ({
  qr: true,
  reason: c.prepare.reason,
  docId: c.prepare.docId,
  appearance: { ...c.prepare.appearance!, ...(c.prepare.lang ? { lang: c.prepare.lang } : {}) },
  signingTime: new Date(GM.signingTime),
  chain: ["04", "03", "02"].map(pki),
  complete: {
    tsaUrl: "http://tsa.pki.test/",
    roots: [pki("root")],
    fetch: replay(GM.http, G),
    httpsUpgrade: false,
    now: () => new Date(GM.now),
    sleep: async (ms) => assert.fail(`${c.name}: хүлээлт ${ms} мс`),
    nonce: () => seeded(`golden-nonce:${c.name}`),
  },
});

for (const name of ["seal-qr-visible", "citizen-then-seal-qr", "seal-qr-then-seal-qr"]) {
  test(`sealPdf({qr: true}) = golden v13 ${name} (байт-ижил); нөөц ба бүртгэлийн бие CA-ийн дүрэмд нийцнэ`, async () => {
    const c = gcase(name);
    const input = c.input.startsWith("case:") ? readG(`output/${c.input.slice(5)}.pdf`) : readG(c.input);
    assert.equal(sha(input), c.expect.inputSha256);
    const { s, calls } = sealer(pki("seal"), new Uint8Array(Buffer.from(c.expect.signature, "hex")));
    const done = await pades.sealPdf(s, "NTRMN-0000000", input, { ...goldenOpts(c), fileName: "Нэхэмжлэх.pdf" });
    assert.ok(Buffer.from(done.pdf).equals(readG(`output/${name}.pdf`)), "output/<case>.pdf-тэй байт-ижил");
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0]!.docId, calls[0]!.revIndex], [c.expect.docId, c.expect.revIndex], "sealForDocument нөөц");
    assert.ok(Buffer.from(done.pdf).includes(Buffer.from(`/EIDVerify <</URL (https://ca.eidmongolia.mn/verify/${c.expect.docId}/${c.expect.revIndex})>> BDC`)));
    assert.equal(done.sealRegistration?.fileName, "Нэхэмжлэх.pdf");
    caAccepts(
      done.sealRegistration,
      { in: c.expect.inputSha256, out: c.expect.outSha256, sigRev: c.expect.sigRevSha256, cms: c.expect.cmsSha256, revIndex: c.expect.revIndex,
        docId: c.expect.docId, prior: c.expect.priorCmsSha256 },
      calls[0]!,
      c.expect.dtbs,
    );
    // Өмнөх мөр бүрийн revision хос — registerSealedPdf-ийн PRIOR_MISMATCH хослол.
    assert.equal(done.sealRegistration!.priorSignatures?.length ?? 0, c.expect.revIndex - 1);
  });
}

// QR-гүй (Go v0.24 reference fixture, invisible): sealPdf нөөцлөхгүй, бүртгэлийн бие мөн бэлэн (docId — санамсаргүй).
test("sealPdf (QR-гүй, анхдагч зам) — нөөцгүй; sealRegistration CA-ийн дүрэмд нийцнэ", async () => {
  const M = JSON.parse(readFileSync(new URL("manifest.json", S), "utf8")) as {
    signingTime: string; now: string; reason: string; dtbs: string; signature: string; outSha256: string; cmsSha256: string; http: Record<string, string>;
  };
  const input = readG("input/quartz-pdf13.pdf");
  const { s, calls } = sealer(pem(new URL("seal.pem", S)), new Uint8Array(Buffer.from(M.signature, "base64")));
  const done = await pades.sealPdf(s, "NTRMN-6235972", input, {
    invisible: true,
    reason: M.reason,
    signingTime: new Date(M.signingTime),
    chain: ["04", "03", "02"].map(pki),
    complete: {
      tsaUrl: "http://tsa.pki.test/", roots: [pki("root")], fetch: replay(M.http, S), httpsUpgrade: false, now: () => new Date(M.now),
      sleep: async () => {}, nonce: () => seeded("golden-nonce:seal"), ltvRetries: 0,
    },
  });
  assert.equal(done.outSha256, M.outSha256, "QR-гүй гаралт өөрчлөгдөөгүй");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.docId, undefined, "seal (нөөцгүй)");
  assert.equal(done.sealRegistration?.fileName, undefined);
  caAccepts(done.sealRegistration, { in: sha(input), out: M.outSha256, sigRev: done.sigRevSha256, cms: M.cmsSha256, revIndex: 1, docId: done.docId }, calls[0]!, M.dtbs);
  assert.deepEqual(pades.sealRegistration(done), done.sealRegistration);
});

test("sealPdf({qr}) — татгалзалт сүлжээнд гарахаас өмнө; sealRegistration-ийн татгалзалт", async () => {
  const code = (c: string) => (e: unknown) => e instanceof pades.PadesError && e.code === c;
  const c = gcase("seal-qr-visible");
  const input = readG(c.input);
  const sig = new Uint8Array(Buffer.from(c.expect.signature, "hex"));
  const plain = sealer(pki("seal"), sig, false);
  await assert.rejects(pades.sealPdf(plain.s, "NTRMN-0000000", input, goldenOpts(c)), code("REQUEST_INVALID"), "sealForDocument-гүй sealer");
  assert.equal(plain.calls.length, 0);
  const s = sealer(pki("seal"), sig);
  await assert.rejects(pades.sealPdf(s.s, "NTRMN-0000000", input, { ...goldenOpts(c), invisible: true }), code("REQUEST_INVALID"), "qr + invisible");
  await assert.rejects(pades.sealPdf(s.s, "NTRMN-0000000", input, { ...goldenOpts(c), fileName: "а".repeat(121) }), code("REQUEST_INVALID"), "fileName > 120");
  // QR-гүй (v12) тамгатай, verify хуудасгүй баримт: олдох docId алга, өгөөгүй → QR REQUEST_INVALID (тамгалахгүй).
  const v12 = readG("output/seal-visible.pdf");
  await assert.rejects(pades.sealPdf(s.s, "NTRMN-0000000", v12, { ...goldenOpts(c), docId: undefined }), code("REQUEST_INVALID"), "docId алга");
  assert.equal(s.calls.length, 0, "тамгалах хүсэлт явсангүй");
  // Object.prototype.qr QR-ийг асаахгүй (өөрийн property л).
  const proto = Object.prototype as Record<string, unknown>;
  const stop = new Error("stop");
  const digests: string[] = [];
  const stopper: pades.PadesSealer = {
    getCertificate: async () => ({ certificate: pki("seal") }),
    seal: async (_o, d) => {
      digests.push(hex(d));
      throw stop;
    },
  };
  try {
    proto.qr = true;
    await assert.rejects(pades.sealPdf(stopper, "NTRMN-0000000", readG("input/libreoffice-contract.pdf"), { reason: "Нэхэмжлэх", signingTime: new Date(GM.signingTime), chain: ["04", "03", "02"].map(pki) }), (e: unknown) => e === stop);
  } finally {
    delete proto.qr;
  }
  assert.equal(digests[0], gcase("seal-visible").expect.dtbs, "QR-гүй дардас (golden v12)");
  // sealRegistration: docId-гүй эсвэл иргэний гарын үсэг → REQUEST_INVALID.
  const fake = { docId: "", signerCert: pki("seal") } as unknown as pades.PadesCompleted;
  assert.throws(() => pades.sealRegistration(fake), code("REQUEST_INVALID"));
  assert.throws(() => pades.sealRegistration({ ...fake, docId: c.expect.docId, signerCert: pki("citizen") }), code("REQUEST_INVALID"));
});
