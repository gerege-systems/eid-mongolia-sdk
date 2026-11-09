// Байгууллагын цахим тамга: client.seal (CA dto.SealRequest / SealResponse / SealCertificateResponse) ба pades.sealPdf.
// fixtures/pades/seal — Go reference (eid-mongolia-sdk-go v0.24.0 `pades.SealPDF`, golden PKI) бичсэн: тамганы cert (04-өөс,
// KeyUsage = зөвхөн nonRepudiation), DTBS дээрх ECDSA гарын үсэг, TSA/OCSP/CRL хариу, Go-ийн гаралтын sha256.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { ApiError, EidClient, ForbiddenError, SEAL_REQUEST_FIELDS, ValidationError, isSealCertificate } from "../dist/index.js";
import { maskPath } from "../src/errors.ts";
import * as pades from "../dist/pades.js";

const S = new URL("./fixtures/pades/seal/", import.meta.url);
const G = new URL("./fixtures/pades/golden/", import.meta.url);
const M = JSON.parse(readFileSync(new URL("manifest.json", S), "utf8")) as {
  signingTime: string;
  now: string;
  reason: string;
  dtbs: string;
  signature: string;
  outSha256: string;
  cmsSha256: string;
  http: Record<string, string>;
};
const der = (u: URL) => new Uint8Array(new X509Certificate(readFileSync(u)).raw);
const SEAL = der(new URL("seal.pem", S));
const CITIZEN = der(new URL("pki/citizen.pem", G));
const pki = (n: string) => der(new URL(`pki/${n}.pem`, G));
const DTBS = new Uint8Array(Buffer.from(M.dtbs, "hex"));
const SIG = new Uint8Array(Buffer.from(M.signature, "base64"));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const CREDS = { rpUUID: "rp-uuid", rpName: "Нэхэмжлэлийн систем", apiSecret: "rp_sk_x" };

/** CA dto.SealResponse. */
const sealResponse = (sig: Uint8Array, cert: Uint8Array) => ({
  orgEtsi: "NTRMN-6235972",
  signature: { value: b64(sig), signatureAlgorithm: "ecdsa-with-SHA256" },
  cert: { value: b64(cert), certificateLevel: "QUALIFIED" },
  sealedAt: "2026-11-09T04:05:06Z",
});

function client(respond: (url: string, method: string) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; method: string; auth: string; body: Record<string, unknown> }[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    fetchImpl: async (url, init) => {
      const h = new Headers(init?.headers);
      calls.push({ url: String(url), method: String(init?.method), auth: String(h.get("authorization")), body: JSON.parse(String(init?.body ?? "{}")) });
      const r = respond(String(url), String(init?.method));
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
    },
  });
  return { eid, calls };
}

test("seal.seal — POST /seal/{orgEtsi} {digest, hashType}, хариуг гэрчилгээгээр шалгана", async () => {
  const { eid, calls } = client(() => ({ body: sealResponse(SIG, SEAL) }));
  const r = await eid.seal.seal("NTRMN-6235972", DTBS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/NTRMN-6235972");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.auth, "Bearer rp_sk_x");
  // CA DisallowUnknownFields — зөвхөн dto.SealRequest-ийн талбарууд.
  assert.deepEqual(Object.keys(calls[0]!.body).sort(), [...SEAL_REQUEST_FIELDS].sort());
  assert.deepEqual(calls[0]!.body, { digest: b64(DTBS), hashType: "SHA256" });
  assert.deepEqual(r.signature, SIG);
  assert.deepEqual(r.certificate, SEAL);
  assert.equal(r.orgEtsi, "NTRMN-6235972");
  assert.equal(r.signatureAlgorithm, "ecdsa-with-SHA256");
  assert.equal(r.certificateLevel, "QUALIFIED");
  assert.equal(r.sealedAt, "2026-11-09T04:05:06Z");
});

test("seal.seal — татгалзалт: digest урт, өөр гарын үсэг, тамга биш гэрчилгээ, хоосон хариу", async () => {
  const { eid, calls } = client(() => ({ body: sealResponse(SIG, SEAL) }));
  await assert.rejects(eid.seal.seal("NTRMN-6235972", DTBS, "SHA-384"), ValidationError);
  await assert.rejects(eid.seal.seal("NTRMN-6235972", DTBS.subarray(1)), ValidationError);
  assert.equal(calls.length, 0, "урт таарахгүй бол сүлжээнд гарахгүй");

  const bad = SIG.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(client(() => ({ body: sealResponse(bad, SEAL) })).eid.seal.seal("NTRMN-6235972", DTBS), ValidationError);
  const other = new Uint8Array(32).fill(7);
  await assert.rejects(client(() => ({ body: sealResponse(SIG, SEAL) })).eid.seal.seal("NTRMN-6235972", other), ValidationError);
  await assert.rejects(client(() => ({ body: sealResponse(SIG, CITIZEN) })).eid.seal.seal("NTRMN-6235972", DTBS), ValidationError);
  await assert.rejects(client(() => ({ body: { orgEtsi: "NTRMN-6235972", signature: null, cert: null } })).eid.seal.seal("NTRMN-6235972", DTBS), ValidationError);
});

test("seal.seal — 403 (SEAL эрхгүй) ForbiddenError, 429 ApiError retryable", async () => {
  await assert.rejects(
    client(() => ({ status: 403, body: { error: "RP-д энэ байгууллагын SEAL permission алга", code: "FORBIDDEN" } })).eid.seal.seal("NTRMN-6235972", DTBS),
    ForbiddenError,
  );
  await assert.rejects(
    client(() => ({ status: 429, body: { error: "хэт олон хүсэлт", code: "RATE_LIMITED" }, headers: { "Retry-After": "7" } })).eid.seal.seal("NTRMN-6235972", DTBS),
    (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryable && e.retryAfterMs === 7000,
  );
});

test("seal.getCertificate — GET /seal/certificate/{orgEtsi} (dto.SealCertificateResponse)", async () => {
  const { eid, calls } = client(() => ({
    body: {
      orgEtsi: "NTRMN-6235972", certificate: b64(SEAL), serialNumber: "88001", subjectDn: "CN=Gerege Systems LLC",
      issuerDn: "CN=eID Mongolia Organization Issuing CA", notBefore: "2026-11-01T00:00:00Z", notAfter: "2029-11-01T00:00:00Z",
      certificateLevel: "QUALIFIED",
    },
  }));
  const c = await eid.seal.getCertificate("NTRMN-6235972");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/certificate/NTRMN-6235972");
  assert.deepEqual(c.certificate, SEAL);
  assert.equal(c.serialNumber, "88001");
  assert.equal(c.notAfter, "2029-11-01T00:00:00Z");
  assert.equal(c.certificateLevel, "QUALIFIED");
});

test("isSealCertificate / maskPath", () => {
  assert.equal(isSealCertificate(SEAL), true);
  assert.equal(isSealCertificate(CITIZEN), false);
  assert.equal(isSealCertificate(pki("04")), false);
  assert.equal(maskPath("/seal/NTRMN-6235972"), "/seal/…");
  assert.equal(maskPath("/seal/certificate/NTRMN-6235972"), "/seal/certificate/…");
});

// ── pades.sealPdf — Go reference-тэй байт-ижил ──

function replay(drop: (key: string) => boolean = () => false): pades.PadesCompleteOptions["fetch"] {
  return async (url, init) => {
    const key = `${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`;
    const f = M.http[key];
    if (!f || drop(key)) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = new Uint8Array(readFileSync(new URL(f, S)));
    return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  };
}

const seededNonce = (seed: string) => new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(seed), Buffer.of(0)])).digest().subarray(0, 8));

const sealOpts = (drop?: (k: string) => boolean): pades.PadesSealOptions => ({
  reason: M.reason,
  signingTime: new Date(M.signingTime),
  chain: ["04", "03", "02"].map(pki),
  complete: {
    tsaUrl: "http://tsa.pki.test/",
    roots: [pki("root")],
    fetch: replay(drop),
    httpsUpgrade: false,
    now: () => new Date(M.now),
    sleep: async () => {},
    nonce: () => seededNonce("golden-nonce:seal"),
    ltvRetries: 0,
  },
});

function sealer(o: { cert?: Uint8Array; sig?: Uint8Array; retCert?: Uint8Array; err?: unknown } = {}) {
  const calls: { org: string; digest: Uint8Array; hash: string }[] = [];
  const s: pades.PadesSealer = {
    getCertificate: async () => ({ certificate: o.cert ?? SEAL }),
    seal: async (org, digest, hash) => {
      calls.push({ org, digest, hash });
      if (o.err) throw o.err;
      return { signature: o.sig ?? SIG, certificate: o.retCert ?? o.cert ?? SEAL };
    },
  };
  return { s, calls };
}

test("sealPdf — PAdES-B-LT, Go reference-тэй байт-ижил, verify хуудасгүй", async () => {
  const input = new Uint8Array(readFileSync(new URL("input/quartz-pdf13.pdf", G)));
  const { s, calls } = sealer();
  const out = await pades.sealPdf(s, "NTRMN-6235972", input, sealOpts());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.org, "NTRMN-6235972");
  assert.equal(calls[0]!.hash, "SHA-256");
  assert.equal(Buffer.from(calls[0]!.digest).toString("hex"), M.dtbs);
  assert.equal(out.outSha256, M.outSha256);
  assert.equal(sha(out.cms), M.cmsSha256);
  assert.equal(out.hasPage, false);
  assert.equal(out.revIndex, 1);
  assert.equal(out.claimedRole, "");
  assert.deepEqual(out.signerCert, SEAL);
});

test("sealPdf — татгалзалт", async () => {
  const input = new Uint8Array(readFileSync(new URL("input/quartz-pdf13.pdf", G)));
  const code = (c: pades.PadesErrorCode) => (e: unknown) => e instanceof pades.PadesError && e.code === c;
  // Иргэний SIGN гэрчилгээ — тамга биш; сүлжээнд гарахгүй.
  const citizen = sealer({ cert: CITIZEN });
  await assert.rejects(pades.sealPdf(citizen.s, "NTRMN-6235972", input, sealOpts()), code("SIGNER_INVALID"));
  assert.equal(citizen.calls.length, 0);
  // Тамгалах хооронд гэрчилгээ солигдсон.
  await assert.rejects(pades.sealPdf(sealer({ retCert: pki("04") }).s, "NTRMN-6235972", input, sealOpts()), code("SIGNER_INVALID"));
  // Өөр гарын үсэг.
  const bad = SIG.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(pades.sealPdf(sealer({ sig: bad }).s, "NTRMN-6235972", input, sealOpts()), code("SIGNATURE_INVALID"));
  // TSA заавал — хүрэхгүй бол тамгатай файл буцаахгүй.
  await assert.rejects(pades.sealPdf(sealer().s, "NTRMN-6235972", input, sealOpts((k) => k.includes("tsa.pki.test"))), code("TSA_UNAVAILABLE"));
  // RP-API алдаа хэвээр.
  const err = new ApiError(429, "{}", "RATE_LIMITED");
  await assert.rejects(pades.sealPdf(sealer({ err }).s, "NTRMN-6235972", input, sealOpts()), (e: unknown) => e === err);
  await assert.rejects(pades.sealPdf(undefined as unknown as pades.PadesSealer, "NTRMN-6235972", input), code("REQUEST_INVALID"));
});
