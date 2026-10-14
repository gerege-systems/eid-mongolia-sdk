// createEidLogin — handler-уудын тест. eID RP-API-г fetchImpl-ээр дуурайна; гарын үсэг/гинжийн шалгалт нь
// ResponseValidator-ийн өөрийн тестэд (sdk.test.ts) — энд validateAuth-ийг орлуулж ямар урсгал/verifier-ээр
// дуудагдсаныг тулгана.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createEidLogin, EidClient, ValidationError, withReturnHint, type EidLoginIdentity, type EidLoginRequest } from "../dist/index.js";

const SID = "0b5e6a4c-1d2e-4f3a-8b9c-0d1e2f3a4b5c";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1";

interface Fake {
  session: Record<string, unknown>;
  calls: { method: string; url: string; body?: unknown }[];
}

function setup(opts: Partial<Parameters<typeof createEidLogin>[0]> = {}) {
  const fake: Fake = { session: { state: "RUNNING" }, calls: [] };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fake.calls.push({ method: init?.method ?? "GET", url: u.pathname + u.search, body });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/authentication/device-link/anonymous") {
      return ok({ sessionID: SID, sessionToken: "tok_ABC-123", sessionSecret: SECRET, deviceLinkBase: "https://ca.eidmongolia.mn/dl", vc: "12345" });
    }
    if (u.pathname.startsWith("/authentication/notification/etsi/")) return ok({ sessionID: SID, vc: { type: "alphaNumeric4", value: "54321" } });
    if (u.pathname === `/session/${SID}`) return ok(fake.session);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new EidClient({ credentials: { rpUUID: "rp-1", rpName: "Демо банк", apiSecret: "rp_sk_test" }, fetchImpl });
  const validated: { flow?: string; verifier?: string }[] = [];
  let fail = false;
  (client.validator as { validateAuth: unknown }).validateAuth = (_r: unknown, _a: unknown, o: { expectedFlowType?: string; userChallengeVerifier?: string }) => {
    validated.push({ flow: o.expectedFlowType, verifier: o.userChallengeVerifier });
    if (fail) throw new ValidationError("гарын үсэг таарсангүй");
    return {
      documentNumber: "doc-1",
      certificateLevel: "QUALIFIED",
      subject: "",
      certificate: null,
      parsedSubject: { givenName: "BAT", surname: "DORJ", serialNumber: "PNOMN-111949212017", country: "MN", name: "BAT DORJ", attributes: {} },
    };
  };
  const identities: EidLoginIdentity[] = [];
  const login = createEidLogin({
    client,
    callbackUrl: "https://bank.example.mn/auth/eid/callback",
    successRedirect: "/home",
    failureRedirect: "/login",
    onSuccess: (id) => {
      identities.push(id);
      return { redirect: "/dashboard", data: { user: id.etsi }, headers: { "Set-Cookie": "app_session=s1; Path=/; HttpOnly" } };
    },
    onError: () => {},
    ...opts,
  });
  return { login, fake, validated, identities, setFail: (v: boolean) => (fail = v) };
}

const req = (method: string, url: string, init: Partial<EidLoginRequest> = {}): EidLoginRequest => ({
  method,
  url,
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  ...(init.body !== undefined ? { body: init.body } : {}),
});

function cookieOf(h: Record<string, string | string[]>): string {
  const sc = [h["Set-Cookie"] ?? []].flat().find((c) => c.startsWith("eid_login="));
  assert.ok(sc, "eid_login cookie");
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Secure/);
  return sc.split(";")[0]!;
}

const COMPLETE_OK = (flowType: string) => ({
  state: "COMPLETE",
  result: { endResult: "OK", documentNumber: "doc-1" },
  cert: { value: "AAAA", certificateLevel: "QUALIFIED" },
  signature: { value: "sig", flowType },
});

test("QR: start → PENDING (шинэ QR) → OK (validateAuth QR, onSuccess, cookie цэвэрлэнэ)", async () => {
  const { login, fake, validated, identities } = setup();
  const s = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  assert.equal(s.status, 200);
  const b = JSON.parse(s.body);
  assert.equal(b.mode, "qr");
  assert.equal(b.vc, "12345");
  assert.match(b.qr, /^https:\/\/ca\.eidmongolia\.mn\/dl\?deviceLinkType=QR&elapsedSeconds=\d+&sessionToken=tok_ABC-123&sessionType=auth&version=1\.0&lang=mon&authCode=/);
  assert.ok(!s.body.includes(SECRET), "sessionSecret хөтчид очихгүй");
  const startCall = fake.calls[0]!;
  assert.equal((startCall.body as { initialCallbackUrl?: string }).initialCallbackUrl, undefined, "QR-д callback үгүй");
  const cookie = cookieOf(s.headers);

  const p = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie } }));
  const pb = JSON.parse(p.body);
  assert.equal(pb.state, "PENDING");
  assert.match(pb.qr, /deviceLinkType=QR/);
  assert.ok(pb.expiresIn > 100);

  fake.session = COMPLETE_OK("QR");
  const ok = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie } }));
  const okb = JSON.parse(ok.body);
  assert.deepEqual(okb, { state: "OK", redirect: "/dashboard", data: { user: "PNOMN-111949212017" } });
  assert.deepEqual(validated, [{ flow: "QR", verifier: undefined }]);
  assert.equal(identities[0]!.civilId, "111949212017");
  assert.equal(identities[0]!.flowType, "QR");
  const sc = [ok.headers["Set-Cookie"]].flat();
  assert.ok(sc.some((c) => c.startsWith("eid_login=;") && c.includes("Max-Age=0")));
  assert.ok(sc.includes("app_session=s1; Path=/; HttpOnly"));

  // Нэг удаа л: дахин status → EXPIRED.
  const again = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie } }));
  assert.equal(JSON.parse(again.body).state, "EXPIRED");
  assert.equal(identities.length, 1);
});

test("status: cookie-гүй / өөр binding → EXPIRED (sessionId мэдсэн ч өөр хөтөч уншихгүй)", async () => {
  const { login } = setup();
  const s = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  const cookie = cookieOf(s.headers);
  for (const c of ["", `eid_login=${SID}.${"A".repeat(43)}`, cookie.replace(/.$/, "x")]) {
    const r = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: c } }));
    assert.equal(JSON.parse(r.body).state, "EXPIRED", c);
  }
});

test("push: регистр шалгана, notification/etsi, Notification урсгалаар шалгана; анхдагч rate limit 3/мин", async () => {
  const { login, fake, validated } = setup();
  const bad = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "push", idCode: "abc" } }));
  assert.equal(bad.status, 400);
  const s = await login.handleRequest(req("POST", "/auth/eid/start", { body: JSON.stringify({ mode: "push", idCode: "уб 12345678" }) }));
  assert.equal(s.status, 200);
  assert.equal(JSON.parse(s.body).vc, "54321");
  assert.equal(JSON.parse(s.body).qr, undefined);
  assert.equal(fake.calls.at(-1)!.url, `/authentication/notification/etsi/${encodeURIComponent("УБ12345678")}`);
  fake.session = COMPLETE_OK("Notification");
  const ok = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  assert.equal(JSON.parse(ok.body).state, "OK");
  assert.deepEqual(validated, [{ flow: "Notification", verifier: undefined }]);
  await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "push", idCode: "УБ12345678" } }));
  await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "push", idCode: "УБ12345678" } }));
  const limited = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "push", idCode: "УБ12345678" } }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["Retry-After"], "60");
});

test("rateLimit hook: start:<ip> ба push:<id> түлхүүр", async () => {
  const keys: string[] = [];
  const { login } = setup({ rateLimit: (k) => (keys.push(k), !k.startsWith("start:")) });
  const r = await login.handleRequest({ ...req("POST", "/auth/eid/start", { body: { mode: "qr" } }), ip: "203.0.113.5" });
  assert.equal(r.status, 429);
  assert.deepEqual(keys, ["start:203.0.113.5"]);
});

test("CSRF: cross-site, JSON бус POST, GET qr татгалзана", async () => {
  const { login } = setup();
  const cross = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" }, headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(cross.status, 403);
  const form = await login.handleRequest({ method: "POST", url: "/auth/eid/start", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "mode=qr" });
  assert.equal(form.status, 415);
  const get = await login.handleRequest(req("GET", "/auth/eid/start?mode=qr"));
  assert.equal(get.status, 405);
});

test("FAILED: иргэн татгалзсан / баталгаажуулалт унасан", async () => {
  const a = setup();
  let s = await a.login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  a.fake.session = { state: "COMPLETE", result: { endResult: "USER_REFUSED" } };
  let r = await a.login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  assert.deepEqual(JSON.parse(r.body), { state: "FAILED", error: "USER_REFUSED" });

  const b = setup();
  b.setFail(true);
  s = await b.login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  b.fake.session = COMPLETE_OK("QR");
  r = await b.login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  assert.deepEqual(JSON.parse(r.body), { state: "FAILED", error: "VALIDATION" });
  assert.equal(b.identities.length, 0);
});

test("Web2App: GET start → 302 апп, callback-д retScheme; status WAIT_CALLBACK; callback verifier → 303", async () => {
  const { login, fake, validated, identities } = setup();
  const s = await login.handleRequest(req("GET", "/auth/eid/start?mode=web2app&lang=en", { headers: { "user-agent": IPHONE_CHROME } }));
  assert.equal(s.status, 302);
  assert.match(String(s.headers.Location), /^https:\/\/ca\.eidmongolia\.mn\/dl\?deviceLinkType=Web2App&sessionToken=tok_ABC-123&sessionType=auth&version=1\.0&lang=eng&authCode=/);
  assert.equal(
    (fake.calls[0]!.body as { initialCallbackUrl: string }).initialCallbackUrl,
    "https://bank.example.mn/auth/eid/callback?retScheme=googlechromes",
  );
  const cookie = cookieOf(s.headers);
  fake.session = COMPLETE_OK("Web2App");
  const st = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie } }));
  assert.deepEqual(JSON.parse(st.body), { state: "WAIT_CALLBACK" });
  assert.equal(identities.length, 0, "poll Web2App-ийг дуусгахгүй");

  // Өөр хөтөч (cookie-гүй) — verifier-тэй ч хүлээн авахгүй (login CSRF).
  const cb = `/auth/eid/callback?retScheme=googlechromes&sessionId=${SID}&userChallengeVerifier=v3r1f13r`;
  const unbound = await login.handleRequest(req("GET", cb));
  assert.equal(unbound.status, 303);
  assert.equal(unbound.headers.Location, "/login?eid_error=expired");
  assert.equal(identities.length, 0);

  const done = await login.handleRequest(req("GET", cb, { headers: { cookie } }));
  assert.equal(done.status, 303);
  assert.equal(done.headers.Location, "/dashboard");
  assert.deepEqual(validated, [{ flow: "Web2App", verifier: "v3r1f13r" }]);
  assert.equal(identities[0]!.flowType, "Web2App");
});

test("Web2App: callback verifier-гүй / sessionId зөрсөн → алдааны redirect", async () => {
  const { login, fake, identities } = setup();
  const s = await login.handleRequest(req("GET", "/auth/eid/start?mode=web2app", { headers: { "user-agent": IPHONE_CHROME } }));
  const cookie = cookieOf(s.headers);
  fake.session = COMPLETE_OK("Web2App");
  let r = await login.handleRequest(req("GET", `/auth/eid/callback?sessionId=${SID}`, { headers: { cookie } }));
  assert.equal(r.headers.Location, "/login?eid_error=unbound");
  r = await login.handleRequest(req("GET", `/auth/eid/callback?sessionId=11111111-1111-4111-8111-111111111111&userChallengeVerifier=x`, { headers: { cookie } }));
  assert.equal(r.headers.Location, "/login?eid_error=unbound");
  assert.equal(identities.length, 0);
});

test("callbackUrl тохиргоо: зам /auth/eid/callback, https; web2app тохируулаагүй бол 400", async () => {
  assert.throws(() => setup({ callbackUrl: "https://bank.example.mn/eid/cb" }), /auth\/eid\/callback/);
  assert.throws(() => setup({ callbackUrl: "http://bank.example.mn/auth/eid/callback" }), /https/);
  const { login } = setup({ callbackUrl: undefined });
  const r = await login.handleRequest(req("GET", "/auth/eid/start?mode=web2app"));
  assert.equal(r.status, 400);
});

test("handle(Request): Next.js/Web-standard", async () => {
  const { login } = setup();
  const r = await login.handle(
    new Request("https://bank.example.mn/auth/eid/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "qr" }) }),
  );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie") ?? "", /^eid_login=/);
  assert.equal((await r.json()).mode, "qr");
  const nf = await login.handle(new Request("https://bank.example.mn/auth/eid/other"));
  assert.equal(nf.status, 404);
});

test("withReturnHint: iOS/Android хөтөч, танихгүй бол хэвээр", () => {
  const cb = "https://bank.example.mn/auth/eid/callback";
  assert.equal(withReturnHint(cb, IPHONE_CHROME), cb + "?retScheme=googlechromes");
  assert.equal(
    withReturnHint(cb, "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 SamsungBrowser/24.0"),
    cb + "?retPkg=com.sec.android.app.sbrowser",
  );
  assert.equal(withReturnHint(cb, "Mozilla/5.0 (Macintosh) Safari/605"), cb);
});
