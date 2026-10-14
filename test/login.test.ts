// createEidLogin — handler-уудын тест. eID RP-API-г fetchImpl-ээр дуурайна; гарын үсэг/гинжийн шалгалт нь
// ResponseValidator-ийн өөрийн тестэд (sdk.test.ts) — энд validateAuth-ийг орлуулж ямар урсгал/verifier-ээр
// дуудагдсаныг тулгана.
import { mock, test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  createEidLogin,
  defaultRateLimit,
  EidClient,
  forwardedClientIp,
  ocspRevocationChecker,
  ValidationError,
  withReturnHint,
  type EidLoginEvent,
  type EidLoginIdentity,
  type EidLoginRequest,
} from "../dist/index.js";

const SID = "0b5e6a4c-1d2e-4f3a-8b9c-0d1e2f3a4b5c";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1";

interface Fake {
  session: Record<string, unknown>;
  calls: { method: string; url: string; body?: unknown }[];
  /** notification start-ын хариу: undefined = бодит session; "json400" — eID-ийн татгалзал; "proxy400" — JSON бус 4xx; "500"; "401". */
  refuse?: "json400" | "proxy400" | "500" | "401";
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
    if (u.pathname.startsWith("/authentication/notification/etsi/")) {
      if (fake.refuse === "json400") return new Response('{"error":"хэрэглэгч олдсонгүй"}', { status: 400, headers: { "Content-Type": "application/json" } });
      if (fake.refuse === "proxy400") return new Response("<html>400 The SSL certificate error</html>", { status: 400, headers: { "Content-Type": "text/html" } });
      if (fake.refuse === "401") return new Response('{"error":"unauthorized"}', { status: 401, headers: { "Content-Type": "application/json" } });
      if (fake.refuse === "500") return new Response('{"error":"дотоод алдаа"}', { status: 500, headers: { "Content-Type": "application/json" } });
      return ok({ sessionID: SID, vc: { type: "alphaNumeric4", value: "54321" } });
    }
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
  const events: EidLoginEvent[] = [];
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
    onEvent: (e) => void events.push(e),
    pushFloorMs: 0, // хугацааны доод хязгаарыг тусдаа тестэд хуурмаг цагаар шалгана
    ...opts,
  });
  return { login, fake, validated, identities, events, setFail: (v: boolean) => (fail = v) };
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
  // RP үргэлжлүүлэхэд (гарын үсэг, гэрчилгээ холбох): sessionId, documentNumber, гэрчилгээ.
  assert.equal(identities[0]!.sessionId, SID);
  assert.equal(identities[0]!.documentNumber, "doc-1");
  assert.equal(identities[0]!.certificateDerB64, "AAAA");
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

const push = (id = "УБ12345678") => req("POST", "/auth/eid/start", { body: { mode: "push", idCode: id } });
async function pushStatuses(login: ReturnType<typeof createEidLogin>, n: number, ip?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await login.handleRequest({ ...push(), ...(ip ? { ip } : {}) })).status);
  return out;
}

test("rateLimit объект: зөвхөн start өгөхөд анхдагч push 3/мин идэвхтэй хэвээр", async () => {
  const keys: string[] = [];
  const { login } = setup({ rateLimit: { start: (k) => (keys.push(k), true) } });
  assert.deepEqual(await pushStatuses(login, 4, "203.0.113.5"), [200, 200, 200, 429]);
  assert.deepEqual(keys, Array(4).fill("start:203.0.113.5"));
});

test("rateLimit функц: анхдагч push хязгаар дээр нэмэгдэнэ (идэвхгүй болгохгүй)", async () => {
  const keys: string[] = [];
  const { login } = setup({ rateLimit: (k) => (keys.push(k), true) });
  assert.deepEqual(await pushStatuses(login, 4), [200, 200, 200, 429]);
  assert.deepEqual(keys, Array(3).fill("push:УБ12345678"), "анхдагч татгалзсан үед хэрэглэгчийн функц дуудагдахгүй");
});

test("rateLimit объект: push-ийг дарна ({limit,windowMs}, функц, false); start-ийн window", async () => {
  assert.deepEqual(await pushStatuses(setup({ rateLimit: { push: { limit: 1, windowMs: 60_000 } } }).login, 2), [200, 429]);
  assert.deepEqual(await pushStatuses(setup({ rateLimit: { push: false } }).login, 5), [200, 200, 200, 200, 200]);
  assert.deepEqual(await pushStatuses(setup({ rateLimit: { push: () => true } }).login, 5), [200, 200, 200, 200, 200]);
  const { login } = setup({ rateLimit: { ...defaultRateLimit, start: { limit: 2, windowMs: 60_000 } } });
  const qr = { ...req("POST", "/auth/eid/start", { body: { mode: "qr" } }), ip: "198.51.100.9" };
  const st: number[] = [];
  for (let i = 0; i < 3; i++) st.push((await login.handleRequest(qr)).status);
  assert.deepEqual(st, [200, 200, 429]);
});

test("defaultRateLimit: push 3/60с, frozen; буруу түлхүүр/утга → throw", () => {
  assert.deepEqual(defaultRateLimit, { push: { limit: 3, windowMs: 60_000 } });
  assert.ok(Object.isFrozen(defaultRateLimit));
  assert.throws(() => setup({ rateLimit: { pin: false } as never }), /rateLimit\.pin/);
  assert.throws(() => setup({ rateLimit: { push: { limit: 0, windowMs: 1 } } }), /rateLimit\.push/);
});

test("onSuccess: tx-ийг дуусгасны дараа дуудагдана — onSuccess дотор store-оос уншвал алга (нэг удаа)", async () => {
  const store = new Map<string, unknown>();
  let seenInStore: boolean | undefined;
  const { login, fake } = setup({
    store: {
      get: (k) => store.get(k) as never,
      set: (k, tx) => void store.set(k, tx),
      delete: (k) => store.delete(k),
    },
    onSuccess: (id) => {
      seenInStore = store.has(id.sessionId);
      return {};
    },
  });
  const s = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  fake.session = COMPLETE_OK("QR");
  const ok = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  assert.equal(JSON.parse(ok.body).state, "OK");
  assert.equal(seenInStore, false);
  assert.equal(store.size, 0);
});

test("forwardedClientIp: true = XFF зүүн; n = баруунаас n; hop дутвал undefined; XFF-гүй бол X-Real-IP", () => {
  const h = { "x-forwarded-for": "198.51.100.7, 10.0.0.2, 10.0.0.1", "x-real-ip": "10.0.0.9" };
  assert.equal(forwardedClientIp(h, true), "198.51.100.7");
  assert.equal(forwardedClientIp(h, 1), "10.0.0.1");
  assert.equal(forwardedClientIp(h, 3), "198.51.100.7");
  assert.equal(forwardedClientIp(h, 4), undefined);
  assert.equal(forwardedClientIp(h, false), undefined);
  assert.equal(forwardedClientIp({ "x-real-ip": " 203.0.113.9 " }, 1), "203.0.113.9");
  assert.equal(forwardedClientIp({}, true), undefined);
});

test("handle(Request): trustProxy / getClientIp → start:<ip>; аль нь ч үгүй бол нэг удаа анхааруулна", async () => {
  const mk = (ip?: string) =>
    new Request("https://bank.example.mn/auth/eid/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
      body: JSON.stringify({ mode: "qr" }),
    });
  const keys: string[] = [];
  const rateLimit = (k: string) => (keys.push(k), true);
  const proxied = setup({ rateLimit, trustProxy: 1 }).login;
  assert.equal((await proxied.handle(mk("1.2.3.4, 198.51.100.7"))).status, 200);
  assert.deepEqual(keys, ["start:198.51.100.7"]);

  keys.length = 0;
  const cb = setup({ rateLimit, getClientIp: () => "203.0.113.1" }).login;
  await cb.handle(mk("9.9.9.9"));
  assert.deepEqual(keys, ["start:203.0.113.1"], "getClientIp давуу, XFF-д итгэхгүй");

  keys.length = 0;
  const warnings: string[] = [];
  const bare = setup({ rateLimit, onError: (e) => warnings.push(String(e)) }).login;
  await bare.handle(mk("9.9.9.9"));
  await bare.handle(mk("9.9.9.9"));
  assert.deepEqual(keys, [], "trustProxy-гүй үед XFF-д итгэхгүй");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /getClientIp/);
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

// ── G1: регистрийн oracle — decoy + доод хугацаа ──

const keysOf = (o: object) => Object.keys(o).sort();
// mock.timers({apis: [..., "Date"]}) — Node ≥ 20.4 (18-д хуучин API, Date-гүй).
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number) as [number, number];
const MOCK_DATE = NODE_MAJOR > 20 || (NODE_MAJOR === 20 && NODE_MINOR >= 4);
const settle = () => new Promise<void>((r) => setImmediate(r));

test("push decoy: eID татгалзсан дугаар бодит push-тэй ижил хэлбэр; status PENDING (eID-ээс асуухгүй) → EXPIRED", async () => {
  const { login, fake, events } = setup({ pollMs: 5 });
  const real = await login.handleRequest(push("УБ12345678"));
  fake.refuse = "json400";
  const decoy = await login.handleRequest(push("УБ87654321"));
  assert.equal(real.status, 200);
  assert.equal(decoy.status, 200);
  const rb = JSON.parse(real.body);
  const db = JSON.parse(decoy.body);
  assert.deepEqual(keysOf(db), keysOf(rb));
  assert.equal(db.mode, "push");
  assert.equal(db.expiresIn, rb.expiresIn);
  assert.match(db.vc, /^[0-9]{5}$/);
  assert.deepEqual(keysOf(decoy.headers), keysOf(real.headers));
  const dc = cookieOf(decoy.headers);
  assert.match(dc, /^eid_login=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\./);

  const calls = fake.calls.length;
  const rp = JSON.parse((await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(real.headers) } }))).body);
  const dp = JSON.parse((await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: dc } }))).body);
  assert.equal(rp.state, "PENDING");
  assert.equal(dp.state, "PENDING");
  assert.deepEqual(keysOf(dp), keysOf(rp));
  assert.equal(dp.vc, db.vc);
  assert.equal(fake.calls.length, calls + 1, "decoy-ийн status eID руу хүсэлт илгээхгүй");

  // TTL дууссаны дараа EXPIRED — бодиттой ижил зам (store-ийн хугацаа).
  const exp = setup({ ttlMs: 1, pollMs: 1 });
  exp.fake.refuse = "json400";
  const d2 = await exp.login.handleRequest(push());
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(JSON.parse((await exp.login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(d2.headers) } }))).body).state, "EXPIRED");

  // Аудит: хоёулаа push_sent, decoy нь зөвхөн meta-д; регистр meta-д алга.
  assert.deepEqual(events.map((e) => [e.kind, e.meta.decoy]), [["push_sent", false], ["push_sent", true]]);
  assert.match(String(events[0]!.meta.pushKey), /^[0-9a-f]{32}$/);
  assert.notEqual(events[0]!.meta.pushKey, events[1]!.meta.pushKey);
  assert.ok(!JSON.stringify(events).includes("12345678") && !JSON.stringify(events).includes("87654321"));
});

test("push floor: бодит ба decoy хоёулаа ≥ 1 с (хуурмаг цаг); qr-д хамаарахгүй; pushFloorMs: 0 унтраана", { skip: !MOCK_DATE && "mock.timers (Date) — Node ≥ 20.4" }, async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    for (const refuse of [undefined, "json400", "500"] as const) {
      const { login, fake } = setup({ pushFloorMs: undefined });
      fake.refuse = refuse;
      let done = false;
      const p = login.handleRequest(push()).then((r) => ((done = true), r));
      await settle();
      mock.timers.tick(999);
      await settle();
      assert.equal(done, false, `${refuse ?? "real"}: 999 мс-д хариулахгүй`);
      mock.timers.tick(1);
      await settle();
      assert.equal(done, true, `${refuse ?? "real"}: 1000 мс-д хариулна`);
      assert.equal((await p).status, refuse === "500" ? 502 : 200);
    }
    const qr = await setup({ pushFloorMs: undefined }).login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
    assert.equal(qr.status, 200, "qr floor-гүй (timer tick-гүйгээр дууссан)");
    const off = await setup({ pushFloorMs: 0 }).login.handleRequest(push());
    assert.equal(off.status, 200);
  } finally {
    mock.timers.reset();
  }
});

test("push: eID тасалдал (5xx, proxy-ийн JSON бус 4xx, 401) → 502, decoy биш (порталтай ижил); decoy: false → 502", async () => {
  for (const refuse of ["500", "proxy400", "401"] as const) {
    const { login, fake, events } = setup();
    fake.refuse = refuse;
    const r = await login.handleRequest(push());
    assert.equal(r.status, 502, refuse);
    assert.equal(JSON.parse(r.body).error, "eid_unavailable");
    assert.equal(events.length, 0);
  }
  const off = setup({ decoy: false });
  off.fake.refuse = "json400";
  assert.equal((await off.login.handleRequest(push())).status, 502);
});

test("push decoy: хязгаар decoy-д ч үйлчилнэ; push_limited event", async () => {
  const { login, fake, events } = setup();
  fake.refuse = "json400";
  assert.deepEqual(await pushStatuses(login, 4), [200, 200, 200, 429]);
  assert.deepEqual(events.map((e) => e.kind), ["push_sent", "push_sent", "push_sent", "push_limited"]);
  assert.equal(events[3]!.sessionId, null);
});

// ── G2: гэрчилгээний цуцлалт ──

const FIX = JSON.parse(readFileSync(new URL("./fixtures/ocsp.json", import.meta.url), "utf8")) as Record<string, string>;
const der = (b64: string) => Buffer.from(b64, "base64");

async function revocationRun(opts: Parameters<typeof setup>[0]) {
  const t = setup(opts);
  const s = await t.login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  t.fake.session = COMPLETE_OK("QR");
  const r = await t.login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  return { ...t, r, body: JSON.parse(r.body) };
}

test("revocation: revoked / шалгагчийн алдаа / hard-fail unknown → FAILED VALIDATION (500 биш), onSuccess-гүй", async () => {
  const cases = [
    { revocation: async () => "revoked" as const, reason: "revoked" },
    { revocation: async (): Promise<"good"> => { throw new Error("boom"); }, reason: "revocation_unavailable" },
    { revocation: async () => "unknown" as const, revocationMode: "hard-fail" as const, reason: "revocation_unavailable" },
  ];
  for (const { reason, ...opts } of cases) {
    const { r, body, identities, events } = await revocationRun(opts);
    assert.equal(r.status, 200);
    assert.deepEqual(body, { state: "FAILED", error: "VALIDATION" });
    assert.equal(identities.length, 0);
    assert.deepEqual(events.at(-1), { kind: "unverified", sessionId: SID, meta: { mode: "qr", reason } });
  }
});

test("revocation: анхдагч OCSP (хариугүй → soft-fail unchecked), good, false → skipped", async () => {
  for (const [opts, want] of [
    [{}, "unchecked"],
    [{ revocation: async () => "good" as const }, "good"],
    [{ revocation: async () => "unknown" as const }, "unchecked"],
    [{ revocation: false as const }, "skipped"],
  ] as const) {
    const { body, identities, events } = await revocationRun(opts);
    assert.equal(body.state, "OK", JSON.stringify(opts));
    assert.equal(identities[0]!.revocation, want);
    assert.deepEqual(events.at(-1), { kind: "success", sessionId: SID, meta: { mode: "qr", flow: "QR", revocation: want } });
  }
});

test("ocspRevocationChecker: good / revoked / unknown→revoked, хуучин хариу, 5xx, issuer алга, good кэш", async () => {
  const { X509Certificate } = await import("node:crypto");
  const leaf = new X509Certificate(der(FIX.leaf!));
  const ca = new X509Certificate(der(FIX.ca!));
  let answer: string | number = "good";
  let calls = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls++;
    assert.equal(url, "http://ocsp.test/ocsp");
    assert.equal(init?.redirect, "manual");
    if (typeof answer === "number") return new Response("", { status: answer });
    return new Response(der(FIX[answer]!), { status: 200 });
  }) as typeof fetch;
  const at = Date.parse(FIX.at!) + 60_000;
  const mk = (now = at) => ocspRevocationChecker({ fetchImpl, now: () => now });
  answer = "revoked";
  assert.equal(await mk()(leaf, ca), "revoked");
  answer = "unknown";
  assert.equal(await mk()(leaf, ca), "revoked", "олгогч мэдэхгүй serial → revoked");
  answer = "good";
  assert.equal(await mk(at + 72 * 3600_000)(leaf, ca), "unknown", "хуучин thisUpdate");
  assert.equal(await mk(at - 3600_000)(leaf, ca), "unknown", "ирээдүйн thisUpdate");
  answer = 500;
  assert.equal(await mk()(leaf, ca), "unknown");
  assert.equal(await mk()(leaf, undefined), "unknown");
  answer = "good";
  const c = mk();
  assert.equal(await c(leaf, ca), "good");
  answer = 500;
  const before = calls;
  assert.equal(await c(leaf, ca), "good", "good 5 мин кэшлэгдэнэ");
  assert.equal(calls, before);
  assert.equal(await mk()(leaf, leaf), "unknown", "буруу issuer-ийн гарын үсэг");
});

// ── G3: аудит ──

test("onEvent: refused / failed / expired / unverified / flow_refused", async () => {
  const { login, fake, events, setFail } = setup();
  for (const endResult of ["USER_REFUSED_DISPLAYTEXTANDPIN", "WRONG_VC", "TIMEOUT"]) {
    fake.session = { state: "RUNNING" };
    const s = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
    fake.session = { state: "COMPLETE", result: { endResult } };
    await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  }
  assert.deepEqual(events.map((e) => [e.kind, e.meta.endResult]), [["refused", "USER_REFUSED_DISPLAYTEXTANDPIN"], ["failed", "WRONG_VC"], ["expired", "TIMEOUT"]]);

  events.length = 0;
  setFail(true);
  const s = await login.handleRequest(req("POST", "/auth/eid/start", { body: { mode: "qr" } }));
  fake.session = COMPLETE_OK("QR");
  await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  assert.deepEqual(events, [{ kind: "unverified", sessionId: SID, meta: { mode: "qr", reason: "validation" } }]);

  events.length = 0;
  const w = await login.handleRequest(req("GET", "/auth/eid/start?mode=web2app"));
  await login.handleRequest(req("GET", "/auth/eid/callback?sessionId=other&userChallengeVerifier=x", { headers: { cookie: cookieOf(w.headers) } }));
  assert.deepEqual(events, [{ kind: "flow_refused", sessionId: SID, meta: { mode: "web2app", reason: "unbound" } }]);
});

test("onEvent алдаа урсгалыг зогсоохгүй (onError руу)", async () => {
  const errs: unknown[] = [];
  const { login } = setup({ onEvent: () => { throw new Error("audit down"); }, onError: (e) => errs.push(e) });
  assert.equal((await login.handleRequest(push())).status, 200);
  assert.match(String(errs[0]), /audit down/);
});

test("push: CA TIMEOUT → EXPIRED (decoy-той ижил төгсгөл, FAILED/TIMEOUT биш)", async () => {
  const { login, fake, events } = setup();
  const s = await login.handleRequest(push());
  fake.session = { state: "COMPLETE", result: { endResult: "TIMEOUT" } };
  const r = await login.handleRequest(req("GET", "/auth/eid/status", { headers: { cookie: cookieOf(s.headers) } }));
  assert.deepEqual(JSON.parse(r.body), { state: "EXPIRED" });
  assert.deepEqual(events.map((e) => e.kind), ["push_sent", "expired"]);
});
