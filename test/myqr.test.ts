// «Миний QR»: cross-SDK vector (test/fixtures/qr_vectors.json — Go / .NET SDK-д ижил файл) ба stub CA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

import {
  EidClient,
  QrError,
  QrTokenInvalidError,
  SessionFailedError,
  QR_ATTRIBUTES,
  DEFAULT_QR_ISSUER,
  DEFAULT_QR_MAX_AGE_MS,
  parseQr,
  verifyQrPresentation,
  type QrSession,
} from "../dist/index.js";

const V = JSON.parse(readFileSync(new URL("./fixtures/qr_vectors.json", import.meta.url), "utf8"));

test("vectors: каталог ба maxAge", () => {
  assert.deepEqual([...QR_ATTRIBUTES], V.attributes);
  assert.equal(DEFAULT_QR_MAX_AGE_MS, V.maxAgeSeconds * 1000);
});

test("vectors: parse", () => {
  for (const c of V.parse) {
    if (c.error) {
      assert.throws(() => parseQr(c.in), (e: unknown) => e instanceof QrError && e.code === c.error, JSON.stringify(c.in));
    } else {
      assert.equal(parseQr(c.in), c.token);
    }
  }
});

test("vectors: verify", () => {
  for (const c of V.verify) {
    const e = c.expect;
    const exp = { issuer: e.issuer, audience: e.audience, sessionId: e.sessionID, nonce: e.nonce, attributes: e.attributes, now: e.now * 1000 };
    if (c.error) {
      assert.throws(() => verifyQrPresentation(c.jws, V.jwks, exp), (x: unknown) => x instanceof QrError && x.code === c.error, c.name);
      continue;
    }
    const p = verifyQrPresentation(c.jws, V.jwks, exp);
    assert.equal(p.sub, c.result.sub, c.name);
    assert.deepEqual(p.attrs, c.result.attrs, c.name);
    assert.deepEqual(p.unavailable, c.result.unavailable, c.name);
    assert.equal(p.sessionId, e.sessionID);
    assert.equal(p.issuedAt, 1792800000 * 1000);
    assert.equal(p.jws, c.jws);
  }
});

const CREDS = { rpUUID: "rp-uuid", rpName: "Дэлгүүр", apiSecret: "rp_sk_secret" };
const TOK = "q9Xk3vQh2m9cTqL8rW1xYb5nPdA0sE6uJgHtKoVfRiM";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function stub() {
  const st = {
    key: generateKeyPairSync("ec", { namedCurve: "P-256" }),
    kid: "k1",
    jwksHits: 0,
    startBody: null as Record<string, unknown> | null,
    state: "COMPLETE",
    end: "OK",
    nonce: "",
    mutate: null as null | ((p: Record<string, unknown>) => void),
  };
  const jws = (p: unknown) => {
    const input = `${b64u(JSON.stringify({ alg: "ES256", kid: st.kid }))}.${b64u(JSON.stringify(p))}`;
    const sig = cryptoSign("sha256", Buffer.from(input), { key: st.key.privateKey as KeyObject, dsaEncoding: "ieee-p1363" });
    return `${input}.${b64u(sig)}`;
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (u.pathname === "/.well-known/eid-jwks.json") {
      assert.equal(headers.Authorization, undefined, "JWKS-д RP secret илгээгдэв");
      st.jwksHits++;
      const jwk = st.key.publicKey.export({ format: "jwk" });
      return reply(200, { keys: [{ ...jwk, kid: st.kid, alg: "ES256", use: "sig" }] });
    }
    if (u.pathname === "/authentication/qr") {
      assert.equal(headers.Authorization, "Bearer rp_sk_secret");
      st.startBody = JSON.parse(String(init?.body));
      if (String(st.startBody!.qr).endsWith("A".repeat(43))) return reply(404, { error: "x", code: "QR_TOKEN_INVALID" });
      st.nonce = (st.startBody!.nonce as string) ?? (st.startBody!.signatureProtocolParameters as { rpChallenge: string }).rpChallenge;
      return reply(200, { sessionID: "sess-1", vc: { type: "numeric4", value: "4821" } });
    }
    if (u.pathname === "/session/sess-1") {
      const body: Record<string, unknown> = { state: st.state, result: { endResult: st.end } };
      if (st.state === "COMPLETE" && st.end === "OK") {
        const p: Record<string, unknown> = {
          iss: DEFAULT_QR_ISSUER, aud: CREDS.rpUUID, sid: "sess-1", sub: "pairwise-1", iat: Math.floor(Date.now() / 1000),
          nonce: st.nonce, attrs: { age_over_18: true }, unavailable: ["phone"],
        };
        st.mutate?.(p);
        body.presentation = { jws: jws(p), claims: p };
      }
      return reply(200, body);
    }
    return reply(404, {});
  }) as typeof fetch;
  const eid = new EidClient({
    baseUrl: "https://rp.test",
    credentials: CREDS,
    trust: { allowUntrusted: true },
    fetchImpl,
    qr: { jwksUrl: "https://ca.test/.well-known/eid-jwks.json" },
  });
  return { st, eid };
}

test("start → result (stub CA): body, nonce=rpChallenge, кэш, kid солигдох", async () => {
  const { st, eid } = stub();
  const s = await eid.qr.start({ qr: `EIDMN-QR1:${TOK}`, attributes: ["age_over_18", "phone"] });
  assert.equal(s.sessionId, "sess-1");
  assert.equal(s.vc, "4821");
  const b = st.startBody!;
  assert.equal(b.qr, `EIDMN-QR1:${TOK}`);
  assert.equal(b.relyingPartyUUID, CREDS.rpUUID);
  assert.equal(b.relyingPartyName, CREDS.rpName);
  assert.equal(b.signatureProtocol, "ACSP_V2");
  assert.equal(b.interactions, undefined);
  assert.equal(b.nonce, undefined);
  const ch = (b.signatureProtocolParameters as { rpChallenge: string }).rpChallenge;
  assert.equal(Buffer.from(ch, "base64").length, 32);
  assert.equal(s.nonce, ch);

  const stored: QrSession = JSON.parse(JSON.stringify(s));
  const p = await eid.qr.result(stored, { maxWaitMs: 5000 });
  assert.equal(p.sub, "pairwise-1");
  assert.deepEqual(p.attrs, { age_over_18: true });
  assert.deepEqual(p.unavailable, ["phone"]);
  await eid.qr.result(stored, { maxWaitMs: 5000 });
  assert.equal(st.jwksHits, 1, "кэш");

  st.key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  st.kid = "k2";
  (eid.qr as unknown as { lastAttempt: number }).lastAttempt = 0;
  await eid.qr.result(stored, { maxWaitMs: 5000 });
  assert.equal(st.jwksHits, 2, "rotation");
});

test("start: nonce, 404 QR_TOKEN_INVALID, клиент талын шалгалт", async () => {
  const { st, eid } = stub();
  const s = await eid.qr.start({ qr: TOK, attributes: ["full_name"], nonce: "order-42" });
  assert.equal(s.nonce, "order-42");
  assert.equal(st.startBody!.nonce, "order-42");
  await assert.rejects(eid.qr.start({ qr: "A".repeat(43), attributes: ["age_over_18"] }), (e: unknown) =>
    e instanceof QrTokenInvalidError && e.status === 404 && e.code === "QR_TOKEN_INVALID");
  st.startBody = null;
  for (const a of [[], ["age_over_99"], ["phone", "phone"]]) {
    await assert.rejects(eid.qr.start({ qr: TOK, attributes: a as never }), (e: unknown) =>
      e instanceof QrError && e.code === "QR_ATTRIBUTES_INVALID");
  }
  await assert.rejects(eid.qr.start({ qr: "hello", attributes: ["phone"] }), (e: unknown) =>
    e instanceof QrError && e.code === "QR_FORMAT_INVALID");
  assert.equal(st.startBody, null, "буруу хүсэлт CA руу явсан");
});

test("result: USER_REFUSED, aud/attr/nonce зөрөх, TIMEOUT", async () => {
  const { st, eid } = stub();
  const s = await eid.qr.start({ qr: TOK, attributes: ["age_over_18", "phone"] });
  const o = { maxWaitMs: 2000, serverPollMs: 1000 };
  st.end = "USER_REFUSED";
  await assert.rejects(eid.qr.result(s, o), (e: unknown) => e instanceof SessionFailedError && e.endResult === "USER_REFUSED");
  st.end = "OK";
  const invalid = (e: unknown) => e instanceof QrError && e.code === "QR_PRESENTATION_INVALID";
  st.mutate = (p) => (p.aud = "other-rp");
  await assert.rejects(eid.qr.result(s, o), invalid);
  st.mutate = (p) => (p.attrs = { age_over_18: true, civil_id: "1" });
  await assert.rejects(eid.qr.result(s, o), invalid);
  st.mutate = null;
  await assert.rejects(eid.qr.result({ ...s, nonce: "replayed" }, o), invalid);
  st.state = "RUNNING";
  await assert.rejects(eid.qr.result(s, { maxWaitMs: 1000, serverPollMs: 1000 }), (e: unknown) =>
    e instanceof SessionFailedError && e.endResult === "TIMEOUT");
});

test("JWKS татагдахгүй / http → QR_JWKS_UNAVAILABLE", async () => {
  for (const jwksUrl of ["https://ca.test/missing", "http://example.com/jwks.json"]) {
    const { eid } = stub();
    const e2 = new EidClient({ baseUrl: "https://rp.test", credentials: CREDS, trust: { allowUntrusted: true },
      fetchImpl: (eid as unknown as { qr: { d: { fetchImpl: typeof fetch } } }).qr.d.fetchImpl, qr: { jwksUrl } });
    await assert.rejects(e2.qr.verify("a.b.c", { sessionId: "s", vc: "", nonce: "n", attributes: ["age_over_18"] }), (e: unknown) =>
      e instanceof QrError && e.code === "QR_JWKS_UNAVAILABLE");
  }
});
