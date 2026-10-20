// CA !357 (2026-10-14): session start хариуны `expiresAt` (RFC 3339) ба 409 NO_SIGNING_CERTIFICATE / 409
// CERT_CHOICE_INVALID / 400 REQUEST_INVALID typed алдаа.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  CertChoiceInvalidError,
  EidClient,
  NoSigningCertificateError,
  RequestInvalidError,
  parseExpiresAt,
  sha256Base64,
  startExpiry,
} from "../dist/index.js";

const CREDS = { rpUUID: "rp-uuid", rpName: "Банк", apiSecret: "rp_sk_secret" };
const EXP = "2026-10-14T14:10:00Z";

function client(reply: (url: string) => { status: number; body: unknown }) {
  return new EidClient({
    credentials: CREDS,
    trust: { allowUntrusted: true },
    fetchImpl: async (url) => {
      const r = reply(String(url));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
}

const DL = { sessionID: "0b8f3f0e-1111-4222-8333-444455556666", sessionToken: "t", sessionSecret: "c2VjcmV0", deviceLinkBase: "https://ca.eidmongolia.mn/dl", vc: "12345" };
const NOTIF = { sessionID: "s-1", vc: { type: "alphaNumeric5", value: "54321" } };

test("expiresAt: CA-ийн утгыг авна (sign push/device-link, cert-choice, auth)", async () => {
  const want = Date.parse(EXP);
  const eid = client((u) => ({ status: 200, body: { ...(u.includes("device-link") ? DL : NOTIF), expiresAt: EXP } }));
  assert.equal((await eid.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), [])).expiresAt, want);
  assert.equal((await eid.sign.deviceLinkByEtsi("PNOMN-1", sha256Base64("x"), [])).expiresAt, want);
  assert.equal((await eid.sign.certificateChoiceByEtsi("PNOMN-1")).expiresAt, want);
  assert.equal((await eid.auth.notificationByEtsi("PNOMN-1", [{ type: "displayTextAndPIN", displayText60: "x" }])).expiresAt, want);
  assert.equal((await eid.auth.deviceLinkAnonymous([{ type: "displayTextAndPIN", displayText60: "x" }])).expiresAt, want);
});

test("expiresAt: CA талбаргүй / буруу бол sign-д тооцоолол, auth-д undefined", async () => {
  const eid = client((u) => ({ status: 200, body: u.includes("device-link") ? DL : { ...NOTIF, expiresAt: "маргааш" } }));
  const before = Date.now();
  const s = await eid.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), []);
  assert.ok(s.expiresAt! >= before + 600_000 && s.expiresAt! <= Date.now() + 600_000);
  const a = await eid.auth.deviceLinkAnonymous([{ type: "displayTextAndPIN", displayText60: "x" }]);
  assert.equal(a.expiresAt, undefined);
  assert.equal(parseExpiresAt(EXP), Date.parse(EXP));
  assert.equal(parseExpiresAt("1760450000"), undefined);
  assert.equal(parseExpiresAt(undefined), undefined);
  assert.equal(startExpiry({ expiresAt: EXP }, 0), Date.parse(EXP));
  assert.equal(startExpiry({}, 1000, 5000), 6000);
});

test("typed алдаа: NO_SIGNING_CERTIFICATE / CERT_CHOICE_INVALID / REQUEST_INVALID (ApiError-ийн дэд анги)", async () => {
  const cases: Array<[number, string, new (...a: never[]) => ApiError]> = [
    [409, "NO_SIGNING_CERTIFICATE", NoSigningCertificateError],
    [409, "CERT_CHOICE_INVALID", CertChoiceInvalidError],
    [400, "REQUEST_INVALID", RequestInvalidError],
  ];
  for (const [status, code, Cls] of cases) {
    const eid = client(() => ({ status, body: { error: "x", code } }));
    await assert.rejects(eid.sign.digestForSigner({ documentNumber: "PNOMN-1-MOBILE-Q", certChoiceSessionId: "c-1" }, sha256Base64("x"), []), (e: unknown) => {
      assert.ok(e instanceof Cls, code);
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).status, status);
      assert.equal((e as ApiError).code, code);
      return true;
    });
  }
  const other = client(() => ({ status: 409, body: { error: "x", code: "SOMETHING_ELSE" } }));
  await assert.rejects(other.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), []), (e: unknown) => {
    assert.equal((e as Error).constructor, ApiError);
    return true;
  });
});

test("waitForResult: анхдагч хугацаа session-ий TTL-ийг дагана (150 с биш)", async () => {
  // serverPollMs-ийг их тавьж эхний poll-ийн timeoutMs = deadline − одоо болгоно.
  const run = async (disc: { status: number; body: unknown }, opts: { maxWaitMs?: number; expiresAt?: number }) => {
    const urls: string[] = [];
    const eid = client((u) => {
      urls.push(u);
      return u.includes("/.well-known/eid") ? disc : { status: 200, body: { state: "COMPLETE", result: { endResult: "OK" } } };
    });
    const r = await eid.session.waitForResult("s-1", { serverPollMs: 10_000_000, ...opts });
    assert.equal(r.state, "COMPLETE");
    const poll = urls.find((u) => u.includes("/session/"))!;
    return { ms: Number(new URL(poll).searchParams.get("timeoutMs")), discovery: urls.some((u) => u.includes("/.well-known/eid")) };
  };
  const near = (got: number, want: number) => assert.ok(got <= want && got > want - 5_000, `${got} ≉ ${want}`);
  const ttl = { status: 200, body: { sessionTtl: { auth: 300, sign: 600 } } };
  let r = await run(ttl, {});
  assert.ok(r.discovery);
  near(r.ms, 615_000); // max(auth, sign) + WAIT_GRACE_MS
  r = await run(ttl, { expiresAt: Date.now() + 280_000 });
  assert.ok(!r.discovery);
  near(r.ms, 295_000);
  r = await run(ttl, { expiresAt: Date.now() - 3_600_000 }); // өнгөрсөн — нэг poll
  near(r.ms, 1_000);
  r = await run(ttl, { maxWaitMs: 42_000, expiresAt: Date.now() + 280_000 }); // maxWaitMs давуу
  near(r.ms, 42_000);
  near((await run({ status: 200, body: { version: "v3" } }, {})).ms, 600_000); // хуучин CA
  near((await run({ status: 500, body: {} }, {})).ms, 600_000); // discovery унасан
});
