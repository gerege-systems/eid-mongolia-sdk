// Байгууллагын цахим тамга: client.seal (CA dto.SealRequest / SealResponse / SealCertificateResponse) ба pades.sealPdf.
// fixtures/pades/seal — Go reference (eid-mongolia-sdk-go v0.24.0 `pades.SealPDF`, golden PKI) бичсэн: тамганы cert (04-өөс,
// KeyUsage = зөвхөн nonRepudiation), DTBS дээрх ECDSA гарын үсэг, TSA/OCSP/CRL хариу, Go-ийн гаралтын sha256.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ApiError,
  EidClient,
  ForbiddenError,
  OrgNotActiveError,
  SEAL_ERROR_CODES,
  SEAL_REQUEST_FIELDS,
  SealApproverUnavailableError,
  SealCertExpiredError,
  SealCertNotYetValidError,
  SealCertRevokedError,
  SealCertificateRequestError,
  SealKeyUnavailableError,
  SealNotIssuedError,
  SealRequestNotFoundError,
  SealServiceDisabledError,
  ValidationError,
  isSealCertificate,
} from "../dist/index.js";
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

// ── Тамганы гэрчилгээний олголт (CA !483): POST → 202 PENDING, GET …/requests/{id} → ISSUED/REJECTED/EXPIRED/FAILED ──

const ORG = "NTRMN-6235972";
const RID = "5f0c2b1e-7a40-4c11-9a51-2f6e0d3c9b11";
/** CA dto.SealCertificateRequestResponse (бичлэг). */
const sealReq = (status: string, extra: Record<string, unknown> = {}) => ({
  requestId: RID, orgEtsi: ORG, status, createdAt: "2026-11-09T05:00:00Z", expiresAt: "2026-11-09T05:07:00Z", ...extra,
});
const sealCertBody = () => ({
  orgEtsi: ORG, certificate: b64(SEAL), serialNumber: "88002", subjectDn: "CN=Gerege Systems LLC",
  issuerDn: "CN=eID Mongolia Organization Issuing CA", notBefore: "2026-11-09T05:01:00Z", notAfter: "2029-11-09T05:01:00Z",
  certificateLevel: "QUALIFIED",
});
const DECIDED = { decidedAt: "2026-11-09T05:01:00Z" };
/** Дарааллаар хариулах fake (сүүлийнхийг давтана). */
const seq = (rs: { status?: number; body: unknown; headers?: Record<string, string> }[]) => {
  let i = 0;
  return () => rs[Math.min(i++, rs.length - 1)]!;
};

test("seal.requestCertificate — POST /seal/certificate/{orgEtsi} → 202 PENDING", async () => {
  const { eid, calls } = client(() => ({ status: 202, body: sealReq("PENDING", { approvers: 2 }) }));
  const r = await eid.seal.requestCertificate(ORG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/certificate/NTRMN-6235972");
  assert.equal(calls[0]!.auth, "Bearer rp_sk_x");
  assert.equal(r.requestId, RID);
  assert.equal(r.status, "PENDING");
  assert.equal(r.approvers, 2);
  assert.equal(r.expiresAt, "2026-11-09T05:07:00Z");
  assert.equal(r.certificate, undefined);
});

test("seal.getCertificateRequest — GET …/requests/{id}; ISSUED үед certificate", async () => {
  const { eid, calls } = client(() => ({ body: sealReq("ISSUED", { ...DECIDED, certificate: sealCertBody() }) }));
  const r = await eid.seal.getCertificateRequest(ORG, RID);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `https://rp.eidmongolia.mn/seal/certificate/NTRMN-6235972/requests/${RID}`);
  assert.equal(r.status, "ISSUED");
  assert.equal(r.decidedAt, "2026-11-09T05:01:00Z");
  assert.deepEqual(r.certificate?.certificate, SEAL);
  assert.equal(r.certificate?.serialNumber, "88002");
  // ISSUED боловч certificate-гүй / requestId-гүй хариу → ValidationError.
  await assert.rejects(client(() => ({ body: sealReq("ISSUED") })).eid.seal.getCertificateRequest(ORG, RID), ValidationError);
  await assert.rejects(client(() => ({ body: { status: "PENDING" } })).eid.seal.getCertificateRequest(ORG, RID), ValidationError);
});

test("seal.waitForCertificate — PENDING → APPROVED → ISSUED", async () => {
  const { eid, calls } = client(
    seq([{ body: sealReq("PENDING") }, { body: sealReq("APPROVED", DECIDED) }, { body: sealReq("ISSUED", { ...DECIDED, certificate: sealCertBody() }) }]),
  );
  const c = await eid.seal.waitForCertificate(ORG, RID, { intervalMs: 1 });
  assert.equal(calls.length, 3);
  assert.deepEqual(c.certificate, SEAL);
  assert.equal(c.notAfter, "2029-11-09T05:01:00Z");
});

test("seal.waitForCertificate — REJECTED / EXPIRED / FAILED → SealCertificateRequestError", async () => {
  const cases: [string, Record<string, unknown>, string | undefined][] = [
    ["REJECTED", DECIDED, undefined],
    ["EXPIRED", { failure: "EXPIRED" }, "EXPIRED"],
    ["FAILED", { ...DECIDED, failure: "SEAL_ISSUANCE_FAILED" }, "SEAL_ISSUANCE_FAILED"],
  ];
  for (const [status, extra, failure] of cases) {
    const { eid, calls } = client(seq([{ body: sealReq("PENDING") }, { body: sealReq(status, extra) }]));
    await assert.rejects(
      eid.seal.waitForCertificate(ORG, RID, { intervalMs: 1 }),
      (e: unknown) => e instanceof SealCertificateRequestError && e.outcome === status && e.requestId === RID && e.failure === failure,
    );
    assert.equal(calls.length, 2, status);
  }
});

test("seal.waitForCertificate — timeoutMs дуусвал TIMEOUT; signal тасалбал reason", async () => {
  const { eid } = client(() => ({ body: sealReq("PENDING") }));
  await assert.rejects(
    eid.seal.waitForCertificate(ORG, RID, { intervalMs: 5, timeoutMs: 30 }),
    (e: unknown) => e instanceof SealCertificateRequestError && e.outcome === "TIMEOUT" && e.failure === undefined,
  );
  const ac = new AbortController();
  const p = eid.seal.waitForCertificate(ORG, RID, { intervalMs: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(new Error("цуцалсан")), 20);
  await assert.rejects(p, /цуцалсан/);
});

test("seal.waitForCertificate — 429 Retry-After-ийг дагана, бусад алдаа шууд", async () => {
  const { eid, calls } = client(
    seq([
      { status: 429, body: { error: "хэт олон", code: "RATE_LIMITED" }, headers: { "Retry-After": "1" } },
      { body: sealReq("ISSUED", { ...DECIDED, certificate: sealCertBody() }) },
    ]),
  );
  const t0 = Date.now();
  const c = await eid.seal.waitForCertificate(ORG, RID, { intervalMs: 1 });
  assert.ok(Date.now() - t0 >= 950, "Retry-After 1 с хүлээсэн");
  assert.equal(calls.length, 2);
  assert.deepEqual(c.certificate, SEAL);

  await assert.rejects(
    client(() => ({ status: 404, body: { error: "олдсонгүй", code: "SEAL_REQUEST_NOT_FOUND" } })).eid.seal.waitForCertificate(ORG, RID, { intervalMs: 1 }),
    (e: unknown) => e instanceof SealRequestNotFoundError && e instanceof ApiError && e.status === 404 && e.code === "SEAL_REQUEST_NOT_FOUND",
  );
});

test("seal.requestCertificate — алдаа: 409 SEAL_APPROVER_UNAVAILABLE, 409 байгууллага, 403, 429", async () => {
  await assert.rejects(
    client(() => ({ status: 409, body: { error: "ADMIN алга", code: "SEAL_APPROVER_UNAVAILABLE" } })).eid.seal.requestCertificate(ORG),
    (e: unknown) => e instanceof SealApproverUnavailableError && e instanceof ApiError && e.status === 409 && !e.retryable,
  );
  await assert.rejects(
    client(() => ({ status: 409, body: { error: "байгууллага ACTIVE биш" } })).eid.seal.requestCertificate(ORG),
    (e: unknown) => e instanceof ApiError && !(e instanceof SealApproverUnavailableError) && e.status === 409,
  );
  await assert.rejects(
    client(() => ({ status: 403, body: { error: "SEAL эрхгүй", code: "PERMISSION_DENIED" } })).eid.seal.requestCertificate(ORG),
    ForbiddenError,
  );
  await assert.rejects(
    client(() => ({ status: 429, body: { error: "хэт олон", code: "RATE_LIMITED" }, headers: { "Retry-After": "3600" } })).eid.seal.requestCertificate(ORG),
    (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryable && e.retryAfterMs === 3_600_000,
  );
});

// ── Үйлчилгээний унтраалга (CA 2026-11-12): 503 {"error","code":"SEAL_SERVICE_DISABLED","service"} — Retry-After-гүй ──

/** CA `sealServiceDisabled` хариу (бичлэг). */
const disabled = (service?: unknown, headers?: Record<string, string>) => ({
  status: 503,
  body: { error: "үйлчилгээ түр унтраалттай байна", code: "SEAL_SERVICE_DISABLED", ...(service === undefined ? {} : { service }) },
  ...(headers ? { headers } : {}),
});
const isDisabled = (service: string | undefined) => (e: unknown) =>
  e instanceof SealServiceDisabledError &&
  e instanceof ApiError &&
  e.status === 503 &&
  e.code === "SEAL_SERVICE_DISABLED" &&
  e.service === service &&
  e.retryable === false;

test("seal.requestCertificate — 503 SEAL_SERVICE_DISABLED → SealServiceDisabledError (issuance), давтахгүй", async () => {
  const { eid, calls } = client(() => disabled("issuance"));
  await assert.rejects(
    eid.seal.requestCertificate(ORG),
    (e: unknown) => isDisabled("issuance")(e) && (e as ApiError).retryAfterMs === undefined && /SEAL_SERVICE_DISABLED/.test((e as ApiError).body),
  );
  assert.equal(calls.length, 1, "нэг л хүсэлт");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/certificate/NTRMN-6235972");
});

test("seal.seal — 503 SEAL_SERVICE_DISABLED → SealServiceDisabledError (sealing), давтахгүй", async () => {
  const { eid, calls } = client(() => disabled("sealing"));
  await assert.rejects(eid.seal.seal(ORG, DTBS), isDisabled("sealing"));
  assert.equal(calls.length, 1, "нэг л хүсэлт");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/NTRMN-6235972");
});

test("SealServiceDisabledError — service алга/танигдаагүй → undefined; Retry-After байсан ч retryable биш", async () => {
  await assert.rejects(client(() => disabled()).eid.seal.seal(ORG, DTBS), isDisabled(undefined));
  await assert.rejects(client(() => disabled("other")).eid.seal.seal(ORG, DTBS), isDisabled(undefined));
  await assert.rejects(client(() => disabled(7)).eid.seal.requestCertificate(ORG), isDisabled(undefined));
  await assert.rejects(
    client(() => disabled("sealing", { "Retry-After": "5" })).eid.seal.seal(ORG, DTBS),
    (e: unknown) => isDisabled("sealing")(e) && (e as ApiError).retryAfterMs === 5000,
  );
});

test("seal — бусад 503 хэвээр ApiError (SealServiceDisabledError биш)", async () => {
  await assert.rejects(
    client(() => ({ status: 503, body: { error: "түр", code: "STATE_UNAVAILABLE" }, headers: { "Retry-After": "5" } })).eid.seal.seal(ORG, DTBS),
    (e: unknown) => e instanceof ApiError && !(e instanceof SealServiceDisabledError) && e.status === 503 && e.retryable && e.retryAfterMs === 5000,
  );
  await assert.rejects(
    client(() => ({ status: 503, body: { error: "upstream" } })).eid.seal.requestCertificate(ORG),
    (e: unknown) => e instanceof ApiError && !(e instanceof SealServiceDisabledError) && e.status === 503 && e.code === undefined && !e.retryable,
  );
  // 503 + Retry-After (code-гүй) — retryable хэвээр.
  await assert.rejects(
    client(() => ({ status: 503, body: { error: "upstream" }, headers: { "Retry-After": "2" } })).eid.seal.requestCertificate(ORG),
    (e: unknown) => e instanceof ApiError && !(e instanceof SealServiceDisabledError) && e.retryable && e.retryAfterMs === 2000,
  );
});

// ── Тогтвортой code-ууд (CA 2026-11-12): тамганы 409 бүр {"error","code"} — статус хэвээр; GET /seal/certificate 409 ──

/** code → ApiError-ийн дэд анги (409). */
const SEAL_409 = [
  ["ORG_NOT_ACTIVE", OrgNotActiveError],
  ["SEAL_NOT_ISSUED", SealNotIssuedError],
  ["SEAL_CERT_REVOKED", SealCertRevokedError],
  ["SEAL_KEY_UNAVAILABLE", SealKeyUnavailableError],
  ["SEAL_CERT_EXPIRED", SealCertExpiredError],
  ["SEAL_CERT_NOT_YET_VALID", SealCertNotYetValidError],
] as const;
const conflict = (code: string) => () => ({ status: 409, body: { error: "тамгалах боломжгүй", code } });
const is409 = (Cls: (typeof SEAL_409)[number][1], code: string) => (e: unknown) =>
  e instanceof Cls &&
  e instanceof ApiError &&
  e.constructor === Cls &&
  e.status === 409 &&
  e.code === code &&
  !e.retryable &&
  SEAL_409.every(([, Other]) => Other === Cls || !(e instanceof Other));

test("seal.seal — 409 code бүр өөрийн ApiError дэд анги; давтахгүй", async () => {
  for (const [code, Cls] of SEAL_409) {
    const { eid, calls } = client(conflict(code));
    await assert.rejects(eid.seal.seal(ORG, DTBS), is409(Cls, code), code);
    assert.equal(calls.length, 1, `${code}: нэг л хүсэлт`);
    assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/NTRMN-6235972");
  }
});

test("seal.getCertificate — идэвхтэй гэрчилгээгүй бол 409 (SEAL_NOT_ISSUED | SEAL_CERT_REVOKED | SEAL_CERT_EXPIRED | SEAL_CERT_NOT_YET_VALID)", async () => {
  for (const [code, Cls] of SEAL_409.filter(([c]) => c.startsWith("SEAL_CERT_") || c === "SEAL_NOT_ISSUED")) {
    const { eid, calls } = client(conflict(code));
    await assert.rejects(eid.seal.getCertificate(ORG), is409(Cls, code), code);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/certificate/NTRMN-6235972");
  }
});

test("seal.requestCertificate — 409 ORG_NOT_ACTIVE → OrgNotActiveError; code-гүй 409 хэвээр ApiError", async () => {
  await assert.rejects(client(conflict("ORG_NOT_ACTIVE")).eid.seal.requestCertificate(ORG), is409(OrgNotActiveError, "ORG_NOT_ACTIVE"));
  await assert.rejects(
    client(() => ({ status: 409, body: { error: "байгууллага ACTIVE биш" } })).eid.seal.requestCertificate(ORG),
    (e: unknown) => e instanceof ApiError && e.constructor === ApiError && e.code === undefined && SEAL_409.every(([, C]) => !(e instanceof C)),
  );
  // Танигдаагүй code — ApiError хэвээр, code дамжина.
  await assert.rejects(
    client(conflict("SEAL_SOMETHING_NEW")).eid.seal.seal(ORG, DTBS),
    (e: unknown) => e instanceof ApiError && e.constructor === ApiError && e.code === "SEAL_SOMETHING_NEW",
  );
});

test("seal — 403 (эрхгүй / байгууллага зөвшөөрөөгүй / onBehalfOf ORG_NOT_ACTIVE) хэвээр ForbiddenError", async () => {
  await assert.rejects(
    client(() => ({ status: 403, body: { error: "SEAL эрхгүй", code: "PERMISSION_DENIED" } })).eid.seal.seal(ORG, DTBS),
    (e: unknown) => e instanceof ForbiddenError && e.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    client(() => ({ status: 403, body: { error: "идэвхгүй", code: "ORG_NOT_ACTIVE" } })).eid.seal.seal(ORG, DTBS),
    (e: unknown) => e instanceof ForbiddenError && !(e instanceof ApiError) && e.code === "ORG_NOT_ACTIVE",
  );
});

test("SEAL_ERROR_CODES — тамганы замуудын тогтвортой code-ууд", () => {
  assert.deepEqual(
    [...SEAL_ERROR_CODES].sort(),
    [...SEAL_409.map(([c]) => c), "SEAL_APPROVER_UNAVAILABLE", "SEAL_REQUEST_NOT_FOUND", "SEAL_SERVICE_DISABLED"].sort(),
  );
});

test("seal.waitForCertificate — SEAL_SERVICE_DISABLED: 503 шууд шидэгдэнэ (poll давтахгүй); FAILED + failure", async () => {
  // Retry-After-тай байсан ч хүлээхгүй, дахин асуухгүй.
  const off = client(() => disabled("issuance", { "Retry-After": "1" }));
  const t0 = Date.now();
  await assert.rejects(off.eid.seal.waitForCertificate(ORG, RID, { intervalMs: 1 }), isDisabled("issuance"));
  assert.equal(off.calls.length, 1, "нэг л poll");
  assert.ok(Date.now() - t0 < 900, "Retry-After хүлээгээгүй");

  // ADMIN баталсан ч олголт унтраалттай → FAILED, failure = SEAL_SERVICE_DISABLED.
  const { eid, calls } = client(seq([{ body: sealReq("PENDING") }, { body: sealReq("FAILED", { ...DECIDED, failure: "SEAL_SERVICE_DISABLED" }) }]));
  await assert.rejects(
    eid.seal.waitForCertificate(ORG, RID, { intervalMs: 1 }),
    (e: unknown) => e instanceof SealCertificateRequestError && e.outcome === "FAILED" && e.requestId === RID && e.failure === "SEAL_SERVICE_DISABLED",
  );
  assert.equal(calls.length, 2);
});

test("isSealCertificate", () => {
  assert.equal(isSealCertificate(SEAL), true);
  assert.equal(isSealCertificate(CITIZEN), false);
  assert.equal(isSealCertificate(pki("04")), false);
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

test("sealPdf — 409 SEAL_CERT_REVOKED: гэрчилгээ татахад SealCertRevokedError, тамгалах хүсэлт явахгүй", async () => {
  const input = new Uint8Array(readFileSync(new URL("input/quartz-pdf13.pdf", G)));
  const { eid, calls } = client(conflict("SEAL_CERT_REVOKED"));
  await assert.rejects(pades.sealPdf(eid.seal, ORG, input, sealOpts()), is409(SealCertRevokedError, "SEAL_CERT_REVOKED"));
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);

  // Гэрчилгээ татсаны дараа цуцлагдсан: POST /seal 409 — хэвээр дамжина, давтахгүй.
  const late = client((_url, method) =>
    method === "GET"
      ? { body: { orgEtsi: ORG, certificate: b64(SEAL), serialNumber: "88001", certificateLevel: "QUALIFIED" } }
      : conflict("SEAL_CERT_REVOKED")(),
  );
  await assert.rejects(pades.sealPdf(late.eid.seal, ORG, input, sealOpts()), is409(SealCertRevokedError, "SEAL_CERT_REVOKED"));
  assert.deepEqual(late.calls.map((c) => c.method), ["GET", "POST"]);
});

test("sealPdf — 503 SEAL_SERVICE_DISABLED: SealServiceDisabledError хэвээр, дахин оролдохгүй", async () => {
  const input = new Uint8Array(readFileSync(new URL("input/quartz-pdf13.pdf", G)));
  // Орлуулсан sealer: яг тэр алдаа, seal нэг л удаа.
  const err = new SealServiceDisabledError(503, JSON.stringify({ error: "x", code: "SEAL_SERVICE_DISABLED", service: "sealing" }), "SEAL_SERVICE_DISABLED");
  assert.equal(err.service, "sealing");
  const fake = sealer({ err });
  await assert.rejects(pades.sealPdf(fake.s, ORG, input, sealOpts()), (e: unknown) => e === err);
  assert.equal(fake.calls.length, 1);

  // Жинхэнэ EidClient.seal: гэрчилгээ татна (унтардаггүй) → POST /seal 503 → нэг GET + нэг POST.
  const { eid, calls } = client((_url, method) =>
    method === "GET"
      ? { body: { orgEtsi: ORG, certificate: b64(SEAL), serialNumber: "88001", certificateLevel: "QUALIFIED" } }
      : disabled("sealing"),
  );
  await assert.rejects(pades.sealPdf(eid.seal, ORG, input, sealOpts()), isDisabled("sealing"));
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  assert.equal(calls[1]!.url, "https://rp.eidmongolia.mn/seal/NTRMN-6235972");
});
