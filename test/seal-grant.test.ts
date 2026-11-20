// RP-ийн санаачилсан тамганы эрхийн хүсэлт (CA V156): client.seal.requestGrant / grantStatus / waitForGrant ба
// client.organization.sealGrants. Хариуны хэлбэр — CA `dto.RPSealGrantStatus`, `dto.PersonOrgSealGrantsResponse`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  AuthSessionAlreadyUsedError,
  AuthSessionNotCompletedError,
  AuthSessionNotFoundError,
  AuthSessionTooOldError,
  AuthSessionWrongFlowError,
  EidClient,
  ForbiddenError,
  OrgNotActiveError,
  RequestInvalidError,
  RpNotActiveError,
  RpPermissionsFullError,
  SEAL_GRANT_ERROR_CODES,
  SEAL_GRANT_REQUEST_FIELDS,
  SealApproverUnavailableError,
  SealGrantAlreadyApprovedError,
  SealGrantNotFoundError,
  SealGrantRequestError,
  ValidationError,
} from "../dist/index.js";

const CREDS = { rpUUID: "rp-uuid", rpName: "Нэхэмжлэлийн систем", apiSecret: "rp_sk_x" };
const ORG = "NTRMN-6235972";
const SID = "9a1c3f60-5b7e-4f0e-8d2a-0c6f1e2b7a44";
const GID = "5f0c2b1e-7a40-4c11-9a51-2f6e0d3c9b11";

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

function client(respond: (url: string, method: string) => Reply) {
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
const seq = (rs: Reply[]) => {
  let i = 0;
  return () => rs[Math.min(i++, rs.length - 1)]!;
};
/** CA dto.RPSealGrantStatus. */
const grant = (status: string, extra: Record<string, unknown> = {}) => ({ grantId: GID, orgEtsi: ORG, status, expiresAt: "2026-11-20T10:07:00Z", ...extra });
const APPROVED = { approvedAt: "2026-11-20T10:02:00Z" };

test("seal.requestGrant — POST /seal/grants {orgEtsi, sessionId} → 202 PENDING", async () => {
  const { eid, calls } = client(() => ({ status: 202, body: grant("PENDING") }));
  const g = await eid.seal.requestGrant(ORG, SID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/seal/grants");
  assert.equal(calls[0]!.auth, "Bearer rp_sk_x");
  assert.deepEqual(Object.keys(calls[0]!.body).sort(), [...SEAL_GRANT_REQUEST_FIELDS].sort());
  assert.deepEqual(calls[0]!.body, { orgEtsi: ORG, sessionId: SID });
  assert.equal(g.grantId, GID);
  assert.equal(g.orgEtsi, ORG);
  assert.equal(g.status, "PENDING");
  assert.equal(g.expiresAt, "2026-11-20T10:07:00Z");
  assert.equal(g.approvedAt, undefined);
});

test("seal.requestGrant — оролтыг сүлжээнд гарахаас өмнө шалгана; хариуны grantId/status алга бол ValidationError", async () => {
  const { eid, calls } = client(() => ({ status: 202, body: grant("PENDING") }));
  await assert.rejects(eid.seal.requestGrant("", SID), ValidationError);
  await assert.rejects(eid.seal.requestGrant(ORG, " "), ValidationError);
  await assert.rejects(eid.seal.requestGrant(ORG, "x".repeat(65)), ValidationError);
  assert.equal(calls.length, 0);
  await assert.rejects(client(() => ({ status: 202, body: { status: "PENDING" } })).eid.seal.requestGrant(ORG, SID), ValidationError);
  await assert.rejects(client(() => ({ status: 202, body: { grantId: GID } })).eid.seal.requestGrant(ORG, SID), ValidationError);
});

test("seal.requestGrant — 409 / 404 / 400 code бүр өөрийн ApiError дэд анги; давтахгүй", async () => {
  const cases: [number, string, typeof ApiError][] = [
    [400, "REQUEST_INVALID", RequestInvalidError],
    [404, "AUTH_SESSION_NOT_FOUND", AuthSessionNotFoundError],
    [409, "AUTH_SESSION_WRONG_FLOW", AuthSessionWrongFlowError],
    [409, "AUTH_SESSION_NOT_COMPLETED", AuthSessionNotCompletedError],
    [409, "AUTH_SESSION_TOO_OLD", AuthSessionTooOldError],
    [409, "AUTH_SESSION_ALREADY_USED", AuthSessionAlreadyUsedError],
    [409, "ORG_NOT_ACTIVE", OrgNotActiveError],
    [409, "RP_NOT_ACTIVE", RpNotActiveError],
    [409, "SEAL_GRANT_ALREADY_APPROVED", SealGrantAlreadyApprovedError],
    [409, "RP_PERMISSIONS_FULL", RpPermissionsFullError],
    [409, "SEAL_APPROVER_UNAVAILABLE", SealApproverUnavailableError],
  ];
  for (const [status, code, Cls] of cases) {
    const { eid, calls } = client(() => ({ status, body: { error: "алдаа", code } }));
    await assert.rejects(
      eid.seal.requestGrant(ORG, SID),
      (e: unknown) => e instanceof Cls && e instanceof ApiError && e.status === status && e.code === code && !e.retryable,
      code,
    );
    assert.equal(calls.length, 1, `${code}: нэг л хүсэлт`);
  }
  // ORG_NOT_FOUND — тусгай анги үгүй, ApiError.code-оор салаална.
  await assert.rejects(
    client(() => ({ status: 404, body: { error: "байгууллага бүртгэлгүй", code: "ORG_NOT_FOUND" } })).eid.seal.requestGrant(ORG, SID),
    (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "ORG_NOT_FOUND",
  );
});

test("seal.requestGrant — 403 RP_NOT_REGISTERED | NOT_ORG_CEO → ForbiddenError(code); 429 retryable", async () => {
  for (const code of ["RP_NOT_REGISTERED", "NOT_ORG_CEO"]) {
    await assert.rejects(
      client(() => ({ status: 403, body: { error: "татгалзсан", code } })).eid.seal.requestGrant(ORG, SID),
      (e: unknown) => e instanceof ForbiddenError && e.code === code,
      code,
    );
  }
  await assert.rejects(
    client(() => ({ status: 429, body: { error: "хэт олон", code: "RATE_LIMITED" }, headers: { "Retry-After": "120" } })).eid.seal.requestGrant(ORG, SID),
    (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryable && e.retryAfterMs === 120_000,
  );
});

test("SEAL_GRANT_ERROR_CODES — CA-ийн /seal/grants кодууд", () => {
  assert.deepEqual(
    [...SEAL_GRANT_ERROR_CODES].sort(),
    [
      "REQUEST_INVALID", "RP_NOT_REGISTERED", "NOT_ORG_CEO", "AUTH_SESSION_NOT_FOUND", "ORG_NOT_FOUND", "SEAL_GRANT_NOT_FOUND",
      "AUTH_SESSION_WRONG_FLOW", "AUTH_SESSION_NOT_COMPLETED", "AUTH_SESSION_TOO_OLD", "AUTH_SESSION_ALREADY_USED", "ORG_NOT_ACTIVE",
      "RP_NOT_ACTIVE", "SEAL_GRANT_ALREADY_APPROVED", "RP_PERMISSIONS_FULL", "SEAL_APPROVER_UNAVAILABLE", "RATE_LIMITED",
    ].sort(),
  );
});

test("seal.grantStatus — GET /seal/grants/{grantId}; APPROVED / REVOKED талбарууд", async () => {
  const { eid, calls } = client(() => ({ body: grant("APPROVED", APPROVED) }));
  const g = await eid.seal.grantStatus(GID);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `https://rp.eidmongolia.mn/seal/grants/${GID}`);
  assert.equal(g.status, "APPROVED");
  assert.equal(g.approvedAt, "2026-11-20T10:02:00Z");
  assert.equal(g.revokedAt, undefined);
  const r = await client(() => ({ body: grant("REVOKED", { ...APPROVED, revokedAt: "2026-11-21T08:00:00Z", failure: "CANCELLED" }) })).eid.seal.grantStatus(GID);
  assert.equal(r.status, "REVOKED");
  assert.equal(r.revokedAt, "2026-11-21T08:00:00Z");
  assert.equal(r.failure, "CANCELLED");
  await assert.rejects(eid.seal.grantStatus(""), ValidationError);
  // grantId URL-д кодлогдоно.
  const enc = client(() => ({ body: grant("PENDING") }));
  await enc.eid.seal.grantStatus("a/b");
  assert.equal(enc.calls[0]!.url, "https://rp.eidmongolia.mn/seal/grants/a%2Fb");
});

test("seal.grantStatus — өөр RP-ийн / олдоогүй → SealGrantNotFoundError 404", async () => {
  await assert.rejects(
    client(() => ({ status: 404, body: { error: "олдсонгүй", code: "SEAL_GRANT_NOT_FOUND" } })).eid.seal.grantStatus(GID),
    (e: unknown) => e instanceof SealGrantNotFoundError && e instanceof ApiError && e.status === 404 && e.code === "SEAL_GRANT_NOT_FOUND",
  );
});

test("seal.waitForGrant — PENDING → APPROVED", async () => {
  const { eid, calls } = client(seq([{ body: grant("PENDING") }, { body: grant("PENDING") }, { body: grant("APPROVED", APPROVED) }]));
  const g = await eid.seal.waitForGrant(GID, { intervalMs: 1 });
  assert.equal(calls.length, 3);
  assert.equal(g.status, "APPROVED");
  assert.equal(g.approvedAt, "2026-11-20T10:02:00Z");
});

test("seal.waitForGrant — REJECTED / EXPIRED / FAILED / REVOKED → SealGrantRequestError", async () => {
  const cases: [string, Record<string, unknown>, string | undefined][] = [
    ["REJECTED", {}, undefined],
    ["EXPIRED", { failure: "EXPIRED" }, "EXPIRED"],
    ["FAILED", { failure: "PUSH_FAILED" }, "PUSH_FAILED"],
    ["REVOKED", { ...APPROVED, revokedAt: "2026-11-21T08:00:00Z" }, undefined],
  ];
  for (const [status, extra, failure] of cases) {
    const { eid, calls } = client(seq([{ body: grant("PENDING") }, { body: grant(status, extra) }]));
    await assert.rejects(
      eid.seal.waitForGrant(GID, { intervalMs: 1 }),
      (e: unknown) => e instanceof SealGrantRequestError && e.outcome === status && e.grantId === GID && e.failure === failure,
    );
    assert.equal(calls.length, 2, status);
  }
});

test("seal.waitForGrant — timeoutMs дуусвал TIMEOUT; signal тасалбал reason", async () => {
  const { eid } = client(() => ({ body: grant("PENDING") }));
  await assert.rejects(
    eid.seal.waitForGrant(GID, { intervalMs: 5, timeoutMs: 30 }),
    (e: unknown) => e instanceof SealGrantRequestError && e.outcome === "TIMEOUT" && e.failure === undefined,
  );
  const ac = new AbortController();
  const p = eid.seal.waitForGrant(GID, { intervalMs: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(new Error("цуцалсан")), 20);
  await assert.rejects(p, /цуцалсан/);
});

test("seal.waitForGrant — 429 Retry-After-ийг дагана, бусад алдаа шууд", async () => {
  const { eid, calls } = client(
    seq([{ status: 429, body: { error: "хэт олон", code: "RATE_LIMITED" }, headers: { "Retry-After": "1" } }, { body: grant("APPROVED", APPROVED) }]),
  );
  const t0 = Date.now();
  const g = await eid.seal.waitForGrant(GID, { intervalMs: 1 });
  assert.ok(Date.now() - t0 >= 950, "Retry-After 1 с хүлээсэн");
  assert.equal(calls.length, 2);
  assert.equal(g.status, "APPROVED");
  await assert.rejects(
    client(() => ({ status: 404, body: { error: "олдсонгүй", code: "SEAL_GRANT_NOT_FOUND" } })).eid.seal.waitForGrant(GID, { intervalMs: 1 }),
    SealGrantNotFoundError,
  );
});

test("organization.sealGrants — GET /organization/seal-grants/etsi/{personEtsi}", async () => {
  const body = {
    personEtsi: "PNOMN-12345678",
    organizations: [
      {
        orgEtsi: ORG, orgName: "Гэрэгэ Системс ХХК", orgStatus: "ACTIVE",
        grants: [
          { grantId: GID, rpName: "Нэхэмжлэлийн систем", rpDomain: "invoice.example.mn", status: "APPROVED", createdAt: "2026-11-20T10:00:00Z",
            decidedAt: "2026-11-20T10:02:00Z", approverName: "Бат Болд", sealCount: 12, sealCount30d: 12, lastSealedAt: "2026-11-20T11:00:00Z" },
          { grantId: "g2", rpName: "Нэхэмжлэлийн систем", status: "PENDING", createdAt: "2026-11-20T12:00:00Z", expiresAt: "2026-11-20T12:07:00Z",
            sealCount: 0, sealCount30d: 0, lastSealedAt: null },
        ],
      },
      { orgEtsi: "NTRMN-1", orgName: "Хоосон ХХК", orgStatus: "SUSPENDED" },
    ],
  };
  const { eid, calls } = client(() => ({ body }));
  const r = await eid.organization.sealGrants("PNOMN-12345678");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/organization/seal-grants/etsi/PNOMN-12345678");
  assert.equal(r.personEtsi, "PNOMN-12345678");
  assert.equal(r.organizations.length, 2);
  const g = r.organizations[0]!.grants;
  assert.equal(g[0]!.status, "APPROVED");
  assert.equal(g[0]!.sealCount30d, 12);
  assert.equal(g[1]!.lastSealedAt, null);
  assert.deepEqual(r.organizations[1]!.grants, []);
  assert.equal(r.organizations[1]!.orgStatus, "SUSPENDED");
  // Иргэн энэ RP-ээр нэвтрээгүй (24 цаг) → 403 ForbiddenError.
  await assert.rejects(client(() => ({ status: 403, body: { error: "нэвтрээгүй", code: "PERSON_NOT_RECENT" } })).eid.organization.sealGrants("PNOMN-1"), ForbiddenError);
  // organizations алга → хоосон жагсаалт.
  assert.deepEqual((await client(() => ({ body: { personEtsi: "PNOMN-1" } })).eid.organization.sealGrants("PNOMN-1")).organizations, []);
});
