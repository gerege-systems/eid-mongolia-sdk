// OIDC client тест. Тест өөрөө ES256 түлхүүр үүсгэж discovery/JWKS/token endpoint-ийг fetchImpl-ээр дуурайна.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

import { EidOidcClient, EidOidcError, EID_OIDC_ISSUER, NetworkError, pkceChallenge } from "../dist/index.js";

const ISS = EID_OIDC_ISSUER;
const CLIENT_ID = "6f1c2a3b-0000-4000-8000-000000000001";
const SECRET = "rp_sk_a+b/c:d é";
const REDIRECT = "https://rp.example.mn/eid/callback";

function newKey(kid: string): { kid: string; priv: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { kid, priv: privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" } };
}

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function jwt(key: { kid: string; priv: KeyObject }, claims: Record<string, unknown>, kid = key.kid): string {
  const input = b64u({ alg: "ES256", typ: "JWT", kid }) + "." + b64u(claims);
  const sig = cryptoSign("sha256", Buffer.from(input), { key: key.priv, dsaEncoding: "ieee-p1363" });
  return input + "." + sig.toString("base64url");
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISS,
    aud: CLIENT_ID,
    sub: "pairwise-sub-1",
    exp: now + 300,
    iat: now,
    nonce: "n-123",
    auth_time: now - 5,
    acr: "urn:eidmongolia:loa:qualified",
    given_name: "BAT",
    family_name: "DORJ",
    given_name_mn: "Бат",
    family_name_mn: "Дорж",
    ...over,
  };
}

function mock(opts: { keys: () => unknown[]; token?: (init: RequestInit) => Response; issuer?: string }) {
  const calls = { jwks: 0, discovery: 0, token: [] as RequestInit[] };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === ISS + "/.well-known/openid-configuration") {
      calls.discovery++;
      return Response.json({
        issuer: opts.issuer ?? ISS,
        authorization_endpoint: ISS + "/oauth2/authorize",
        token_endpoint: ISS + "/oauth2/token",
        jwks_uri: ISS + "/oauth2/jwks",
      });
    }
    if (u === ISS + "/oauth2/jwks") {
      calls.jwks++;
      return Response.json({ keys: opts.keys() });
    }
    if (u === ISS + "/oauth2/token") {
      calls.token.push(init!);
      return opts.token ? opts.token(init!) : new Response("{}", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new EidOidcClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUri: REDIRECT, fetchImpl, ...over });
}

async function rejectsCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof EidOidcError && e.code === code);
}

test("pkceChallenge — RFC 7636 Appendix B вектор", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("createAuthorization — URL параметрүүд, S256 challenge, санамсаргүй утгууд", async () => {
  const { fetchImpl, calls } = mock({ keys: () => [] });
  const c = client(fetchImpl, { scope: "openid pnomn" });
  const a = await c.createAuthorization({ display: "page" });
  const u = new URL(a.url);
  assert.equal(u.origin + u.pathname, ISS + "/oauth2/authorize");
  const q = u.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), CLIENT_ID);
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.equal(q.get("scope"), "openid pnomn");
  assert.equal(q.get("display"), "page");
  assert.equal(q.get("state"), a.state);
  assert.equal(q.get("nonce"), a.nonce);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("code_challenge"), await pkceChallenge(a.codeVerifier));
  assert.match(a.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
  const b = await c.createAuthorization();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(new URL(b.url).searchParams.get("display"), null);
  assert.equal(calls.discovery, 1); // cache
});

test("discover — issuer таарахгүй бол discovery_failed", async () => {
  const { fetchImpl } = mock({ keys: () => [], issuer: "https://evil.example" });
  await rejectsCode(client(fetchImpl).discover(), "discovery_failed");
});

test("handleCallback — бүтэн урсгал: Basic header urlencode, form body, claims", async () => {
  const k = newKey("k1");
  const { fetchImpl, calls } = mock({
    keys: () => [k.jwk],
    token: () => Response.json({ id_token: jwt(k, claims()), token_type: "Bearer", expires_in: 300 }),
  });
  const r = await client(fetchImpl).handleCallback(`${REDIRECT}?code=abc&state=s-1`, {
    state: "s-1",
    nonce: "n-123",
    codeVerifier: "v".repeat(43),
  });
  assert.equal(r.claims.sub, "pairwise-sub-1");
  assert.equal(r.claims.given_name_mn, "Бат");
  assert.equal(r.claims.pnomn, undefined);
  assert.equal(typeof r.idToken, "string");

  const init = calls.token[0]!;
  const h = init.headers as Record<string, string>;
  const basic = Buffer.from(h.Authorization!.replace(/^Basic /, ""), "base64").toString("utf8");
  // RFC 6749 §2.3.1 — form-urlencode хийгээд base64 (':' / '+' / '/' / зай / UTF-8 кодлогдоно)
  assert.equal(basic, `${CLIENT_ID}:rp_sk_a%2Bb%2Fc%3Ad+%C3%A9`);
  assert.equal(h["Content-Type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(String(init.body));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "abc");
  assert.equal(body.get("redirect_uri"), REDIRECT);
  assert.equal(body.get("code_verifier"), "v".repeat(43));
});

test("handleCallback — state буруу → state_mismatch, token дуудахгүй", async () => {
  const { fetchImpl, calls } = mock({ keys: () => [] });
  const c = client(fetchImpl);
  const checks = { state: "s-1", nonce: "n", codeVerifier: "v" };
  await rejectsCode(c.handleCallback("?code=abc&state=s-2", checks), "state_mismatch");
  await rejectsCode(c.handleCallback("?code=abc", checks), "state_mismatch");
  // харьцангуй зам (Express req.originalUrl) — query-г уншина
  await rejectsCode(c.handleCallback("/eid/callback?code=abc&state=s-2", checks), "state_mismatch");
  await rejectsCode(c.handleCallback("/eid/callback?error=access_denied&state=s-1", checks), "access_denied");
  // error-той ч гэсэн state буруу бол state_mismatch
  await rejectsCode(c.handleCallback(new URLSearchParams("error=access_denied&state=x"), checks), "state_mismatch");
  await rejectsCode(c.handleCallback("?code=abc&state=", { ...checks, state: "" }), "state_mismatch");
  assert.equal(calls.token.length, 0);
});

test("handleCallback — error=access_denied → төрөлжсөн EidOidcError; танихгүй код → server_error", async () => {
  const { fetchImpl, calls } = mock({ keys: () => [] });
  const c = client(fetchImpl);
  const checks = { state: "s-1", nonce: "n", codeVerifier: "v" };
  await assert.rejects(
    c.handleCallback(new URL(`${REDIRECT}?error=access_denied&error_description=expired&state=s-1`), checks),
    (e: unknown) => e instanceof EidOidcError && e.code === "access_denied" && e.description === "expired",
  );
  await rejectsCode(c.handleCallback("error=login_required&state=s-1", checks), "login_required");
  await rejectsCode(c.handleCallback("error=weird&state=s-1", checks), "server_error");
  await rejectsCode(c.handleCallback("state=s-1", checks), "invalid_callback");
  await rejectsCode(c.handleCallback(`code=a&state=s-1&iss=${encodeURIComponent("https://evil.example")}`, checks), "invalid_callback");
  assert.equal(calls.token.length, 0);
});

test("handleCallback — token endpoint алдаа (invalid_grant) төрөлжинө", async () => {
  const { fetchImpl } = mock({
    keys: () => [],
    token: () => Response.json({ error: "invalid_grant", error_description: "code used" }, { status: 400 }),
  });
  await rejectsCode(
    client(fetchImpl).handleCallback("code=a&state=s", { state: "s", nonce: "n", codeVerifier: "v" }),
    "invalid_grant",
  );
});

test("handleCallback — сүлжээний алдаа NetworkError", async () => {
  const c = client((async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  await assert.rejects(c.discover(), NetworkError);
});

test("verifyIdToken — зөв токен", async () => {
  const k = newKey("k1");
  const { fetchImpl } = mock({ keys: () => [k.jwk] });
  const c = await client(fetchImpl).verifyIdToken(jwt(k, claims()), { nonce: "n-123" });
  assert.equal(c.acr, "urn:eidmongolia:loa:qualified");
});

test("verifyIdToken — буруу aud / azp, хугацаа дууссан, iat ирээдүйд, буруу nonce, буруу iss", async () => {
  const k = newKey("k1");
  const { fetchImpl } = mock({ keys: () => [k.jwk] });
  const c = client(fetchImpl);
  const now = Math.floor(Date.now() / 1000);
  const bad = (over: Record<string, unknown>, nonce = "n-123") =>
    rejectsCode(c.verifyIdToken(jwt(k, claims(over)), { nonce }), "invalid_id_token");
  await bad({ aud: "other-client" });
  await bad({ aud: [CLIENT_ID, "other"] }); // олон aud, azp алга
  await bad({ aud: [CLIENT_ID, "other"], azp: "other" });
  await bad({ exp: now - 61 });
  await bad({ iat: now + 120 });
  await bad({}, "n-other");
  await bad({ iss: ISS + "/" });
  await bad({ sub: "" });
  // clock skew дотор — зөвшөөрнө
  await c.verifyIdToken(jwt(k, claims({ exp: now - 30 })), { nonce: "n-123" });
  await c.verifyIdToken(jwt(k, claims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID })), { nonce: "n-123" });
});

test("verifyIdToken — танихгүй kid → JWKS-ийг нэг удаа дахин татна", async () => {
  const k1 = newKey("k1");
  const k2 = newKey("k2");
  let keys = [k1.jwk];
  const { fetchImpl, calls } = mock({ keys: () => keys });
  const c = client(fetchImpl);
  await c.verifyIdToken(jwt(k1, claims()), { nonce: "n-123" });
  assert.equal(calls.jwks, 1);
  keys = [k1.jwk, k2.jwk]; // түлхүүр солигдов
  await c.verifyIdToken(jwt(k2, claims()), { nonce: "n-123" });
  assert.equal(calls.jwks, 2);
  await c.verifyIdToken(jwt(k2, claims()), { nonce: "n-123" });
  assert.equal(calls.jwks, 2); // cache
  // огт байхгүй kid → нэг refetch, дараа нь алдаа
  await rejectsCode(c.verifyIdToken(jwt(k1, claims(), "k-none"), { nonce: "n-123" }), "invalid_id_token");
  assert.equal(calls.jwks, 3);
});

test("verifyIdToken — буруу гарын үсэг, солигдсон payload, alg none/HS256", async () => {
  const k = newKey("k1");
  const other = newKey("k1"); // ижил kid, өөр түлхүүр
  const { fetchImpl } = mock({ keys: () => [k.jwk] });
  const c = client(fetchImpl);
  await rejectsCode(c.verifyIdToken(jwt(other, claims()), { nonce: "n-123" }), "invalid_id_token");
  const [h, , s] = jwt(k, claims()).split(".");
  await rejectsCode(c.verifyIdToken(`${h}.${b64u(claims({ sub: "attacker" }))}.${s}`, { nonce: "n-123" }), "invalid_id_token");
  await rejectsCode(c.verifyIdToken(`${b64u({ alg: "none", kid: "k1" })}.${b64u(claims())}.`, { nonce: "n-123" }), "invalid_id_token");
  await rejectsCode(c.verifyIdToken(`${b64u({ alg: "HS256", kid: "k1" })}.${b64u(claims())}.${s}`, { nonce: "n-123" }), "invalid_id_token");
  await rejectsCode(c.verifyIdToken("not-a-jwt", { nonce: "n-123" }), "invalid_id_token");
});

test("EidOidcClient — тохиргооны шалгалт", () => {
  assert.throws(() => new EidOidcClient({ clientId: "", clientSecret: "s", redirectUri: REDIRECT }));
  assert.throws(() => new EidOidcClient({ clientId: "c", clientSecret: "s", redirectUri: "http://x/cb" }));
});
