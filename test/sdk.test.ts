// SDK цөмийн тест. node --test (TS strip). Крипто round-trip, payload байт, mapping, error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build хийсэн бодит артефактыг тестэлнэ (production truth). `npm test` нь эхлээд build хийнэ.
import {
  buildAcspV2Payload,
  acspV2Digest,
  verifyPayloadSignature,
  verifyPrehashedSignature,
  sha256Base64,
  randomChallenge,
  parseSessionResult,
  Http,
  AuthenticationError,
  ForbiddenError,
  ApiError,
  EidClient,
  DEFAULT_BASE_URL,
  resolveBaseUrl,
  deviceLink,
  openOrShowQR,
  isMobileUserAgent,
  DeviceLinkError,
  ResponseValidator,
  ValidationError,
  userChallengeOf,
  buildDeviceLink,
  qrDeviceLinkTicker,
} from "../dist/index.js";
import * as browser from "../dist/browser.js";

// Smart-ID RP-API v3 docs (signature_protocols.html)-ийн албан ёсны вектор — сервер, iOS,
// Android, TS дөрвүүлээ ЭНЭ digest-ийг гаргах ёстой.
const SMART_ID_VECTOR = {
  serverRandom: "MTlop6EXCrQ6FOErcKjxUhbV",
  rpChallenge: "GYS+yoah6emAcVDNIajwSs6UB/M95XrDxMzXBUkwQJ9YFDipXXzGpPc7raWcuc2+TEoRc7WvIZ/7dU/iRXenYg==",
  userChallenge: "GnsWXXEjTCKR89fj9uo5u5ReBZ9JR7_pezLAI5jMS00",
  relyingPartyName: "DEMO",
  brokeredRpName: "Example RP",
  interactions:
    "W3sidHlwZSI6ImNvbmZpcm1hdGlvbk1lc3NhZ2UiLCJkaXNwbGF5VGV4dDIwMCI6IkxvbmdlciBkZXNjcmlwdGlvbiBvZiB0aGUgdHJhbnNhY3Rpb24gY29udGV4dCJ9LHsidHlwZSI6ImRpc3BsYXlUZXh0QW5kUElOIiwiZGlzcGxheVRleHQ2MCI6IlNob3J0IGRlc2NyaXB0aW9uIG9mIHRoZSB0cmFuc2FjdGlvbiBjb250ZXh0In1d",
  interactionTypeUsed: "confirmationMessage",
  initialCallbackUrl: "https://rp.example.com/callback-url?value=RrKjjT4aggzu27YBddX1bQ",
  flowType: "Web2App",
};

test("ACSP_V2 payload — Smart-ID v3 docs вектор (SHA-512)", () => {
  assert.equal(
    acspV2Digest(SMART_ID_VECTOR, "SHA-512").toString("base64"),
    "pKOjbNl/5Fy8NfrFqsj6pSn8W8O+Ik8rM33QSsbyD3J9qDJvEm90SboUciuY4wHGWa0Pnq8BgT3NJKmJiUDfKg==",
  );
  // Хоосон талбар ч '|' тусгаарлагчаа хадгална (QR: callback байхгүй, broker байхгүй → '||').
  const p = buildAcspV2Payload({ ...SMART_ID_VECTOR, brokeredRpName: "", initialCallbackUrl: "" }).toString("utf8");
  assert.ok(p.startsWith("smart-id|ACSP_V2|MTlop6EXCrQ6FOErcKjxUhbV|"));
  assert.ok(p.includes("|REVNTw==||"));
  assert.ok(p.endsWith("|confirmationMessage||Web2App"));
});

test("rsassa-pss — payload (auth) ба prehashed digest (sign) verify", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const payload = buildAcspV2Payload(SMART_ID_VECTOR);
  for (const hash of ["SHA-256", "SHA-512"]) {
    const h = hash.toLowerCase().replace("-", "");
    const sLen = createHash(h).digest().length;
    const sig = cryptoSign(h, payload, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: sLen }).toString("base64");
    assert.equal(verifyPayloadSignature(payload, sig, publicKey, "rsassa-pss", hash), true);
    assert.equal(verifyPayloadSignature(Buffer.from("x"), sig, publicKey, "rsassa-pss", hash), false);
    // sign flow: RP-д зөвхөн digest байгаа → raw RSA + EMSA-PSS-VERIFY
    const digest = createHash(h).update(payload).digest();
    assert.equal(verifyPrehashedSignature(digest, sig, publicKey, "rsassa-pss", hash), true);
    assert.equal(verifyPrehashedSignature(createHash(h).update("y").digest(), sig, publicKey, "rsassa-pss", hash), false);
  }
});

test("sha256WithRSAEncryption (PKCS#1 v1.5) — payload ба prehashed verify", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const payload = buildAcspV2Payload(SMART_ID_VECTOR);
  const sig = cryptoSign("sha256", payload, { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64");
  assert.equal(verifyPayloadSignature(payload, sig, publicKey, "sha256WithRSAEncryption", "SHA-256"), true);
  const digest = createHash("sha256").update(payload).digest();
  assert.equal(verifyPrehashedSignature(digest, sig, publicKey, "sha256WithRSAEncryption", "SHA-256"), true);
  assert.equal(verifyPrehashedSignature(digest, sig, publicKey, "rsassa-pss", "SHA-256"), false);
});

test("sha256Base64 — мэдэгдэх вектор (abc)", () => {
  // SHA-256("abc") = ungtS/...; base64 нь тогтмол
  assert.equal(sha256Base64("abc"), "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
});

test("randomChallenge — default 64 байт base64", () => {
  const c = randomChallenge();
  assert.equal(Buffer.from(c, "base64").length, 64);
});

test("ecdsa-with-SHA256 (хуучин cert) — payload ба prehashed verify", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const payload = buildAcspV2Payload(SMART_ID_VECTOR);
  const sig = cryptoSign("sha256", payload, { key: privateKey, dsaEncoding: "der" }).toString("base64");
  assert.equal(verifyPayloadSignature(payload, sig, publicKey, "ecdsa-with-SHA256", "SHA-256"), true);
  assert.equal(cryptoVerify("sha256", Buffer.from("bad"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(sig, "base64")), false);
  const digest = createHash("sha256").update(payload).digest();
  assert.equal(verifyPrehashedSignature(digest, sig, publicKey, "ecdsa-with-SHA256", "SHA-256"), true);
});

test("parseSessionResult — nested result/signature/cert mapping", () => {
  const r = parseSessionResult({
    state: "COMPLETE",
    result: { endResult: "OK", documentNumber: "AB1234567" },
    signatureProtocol: "ACSP_V2",
    signature: {
      value: "c2ln",
      serverRandom: "+wVP2U/SMKVkVrggDjNTXFV/",
      userChallenge: "TLSjYRH2oYw8tW2bq0it0IUb7WIFkCLgF8NTc7-4Zq4",
      flowType: "Notification",
      signatureAlgorithm: "rsassa-pss",
      signatureAlgorithmParameters: {
        hashAlgorithm: "SHA-512",
        maskGenAlgorithm: { algorithm: "id-mgf1", parameters: { hashAlgorithm: "SHA-512" } },
        saltLength: 64,
        trailerField: "0xbc",
      },
    },
    cert: { value: "Y2VydA==", certificateLevel: "QUALIFIED" },
  });
  assert.equal(r.state, "COMPLETE");
  assert.equal(r.signatureProtocol, "ACSP_V2");
  assert.equal(r.serverRandom, "+wVP2U/SMKVkVrggDjNTXFV/");
  assert.equal(r.userChallenge, "TLSjYRH2oYw8tW2bq0it0IUb7WIFkCLgF8NTc7-4Zq4");
  assert.equal(r.flowType, "Notification");
  assert.equal(r.signatureAlgorithm, "rsassa-pss");
  assert.equal(r.signatureAlgorithmParameters?.hashAlgorithm, "SHA-512");
  assert.equal(r.signatureAlgorithmParameters?.saltLength, 64);
  assert.equal(r.endResult, "OK");
  assert.equal(r.documentNumber, "AB1234567");
  assert.equal(r.signatureValueB64, "c2ln");
  assert.equal(r.certificateDerB64, "Y2VydA==");
  assert.equal(r.certificateLevel, "QUALIFIED");
  assert.equal(r.onBehalfOf, null); // ердийн хувь хүний session
});

test("parseSessionResult — байгууллагаар нэвтрэх (onBehalfOf блок)", () => {
  const r = parseSessionResult({
    state: "COMPLETE",
    result: { endResult: "OK", documentNumber: "AB1234567" },
    onBehalfOf: {
      orgEtsi: "NTRMN-6235972",
      orgName: "Герэге Системс ХХК",
      role: "Захирал",
      rightType: "ADMIN",
    },
  });
  assert.equal(r.onBehalfOf?.orgEtsi, "NTRMN-6235972");
  assert.equal(r.onBehalfOf?.rightType, "ADMIN");
  assert.equal(r.onBehalfOf?.role, "Захирал");
  // Эрх хураагдсан бол role/rightType хоосон ирнэ — байгууллагын мөр хэвээр.
  const revoked = parseSessionResult({
    state: "COMPLETE",
    onBehalfOf: { orgEtsi: "NTRMN-6235972", orgName: "Герэге Системс ХХК" },
  });
  assert.equal(revoked.onBehalfOf?.orgEtsi, "NTRMN-6235972");
  assert.equal(revoked.onBehalfOf?.rightType, null);
});

test("Http — 401→AuthenticationError, 403→ForbiddenError, 500→ApiError", async () => {
  const mk = (status: number) =>
    new Http({
      baseUrl: "https://x/v3",
      apiSecret: "rp_sk_test",
      fetchImpl: async () => new Response("boom", { status }),
    });
  await assert.rejects(() => mk(401).get("/session/x"), AuthenticationError);
  await assert.rejects(() => mk(403).get("/session/x"), ForbiddenError);
  await assert.rejects(() => mk(500).get("/session/x"), ApiError);
});

test("Http — Bearer header илгээдэг", async () => {
  let seenAuth = "";
  const http = new Http({
    baseUrl: "https://x/v3",
    apiSecret: "rp_sk_secret123",
    fetchImpl: async (_url, init) => {
      seenAuth = String((init?.headers as Record<string, string>)["Authorization"]);
      return new Response("{}", { status: 200 });
    },
  });
  await http.get("/session/x");
  assert.equal(seenAuth, "Bearer rp_sk_secret123");
});

test("resolveBaseUrl — анхдагч rp., /v3 залгахгүй, хуучин ca. хост тодорхой алдаа", () => {
  assert.equal(resolveBaseUrl(undefined), "https://rp.eidmongolia.mn");
  assert.equal(DEFAULT_BASE_URL, "https://rp.eidmongolia.mn");
  assert.equal(resolveBaseUrl("https://rp.eidmongolia.mn/"), "https://rp.eidmongolia.mn");
  assert.equal(resolveBaseUrl("https://rp.eidmongolia.mn/v3"), "https://rp.eidmongolia.mn/v3");
  assert.equal(resolveBaseUrl("http://localhost:8080/v3"), "http://localhost:8080/v3");
  assert.throws(() => resolveBaseUrl("https://ca.eidmongolia.mn"), /rp\.eidmongolia\.mn/);
  assert.throws(() => resolveBaseUrl("not a url"), /буруу URL/);
});

test("EidClient — rp. хост руу /v3-гүй зам дууддаг", async () => {
  let seen = "";
  const eid = new EidClient({
    credentials: { rpUUID: "u", rpName: "n", apiSecret: "rp_sk_x" },
    fetchImpl: async (url) => {
      seen = String(url);
      return new Response(JSON.stringify({ state: "RUNNING" }), { status: 200 });
    },
  });
  await eid.session.poll("abc", 1000).catch(() => undefined);
  assert.ok(seen.startsWith("https://rp.eidmongolia.mn/session/abc"), seen);
});

const DL = {
  sessionId: "3f2b8c1e-9a4d-4e21-b7c3-0d5e6f7a8b9c",
  vc: "04821",
  deviceLinkBase: "https://ca.eidmongolia.mn/dl",
};

test("deviceLink — CA гэрээ: {base}?sessionId=&vc=", () => {
  assert.equal(deviceLink(DL), `https://ca.eidmongolia.mn/dl?sessionId=${DL.sessionId}&vc=04821`);
  // суурийн бусад query хадгалагдана, sessionId/vc давхардахгүй
  assert.equal(
    deviceLink({ ...DL, deviceLinkBase: "https://x.test/dl?b=1&vc=99999" }),
    `https://x.test/dl?b=1&vc=04821&sessionId=${DL.sessionId}`,
  );
  assert.equal(browser.deviceLink(DL), deviceLink(DL));
});

test("deviceLink — буруу оролт DeviceLinkError", () => {
  assert.throws(() => deviceLink({ ...DL, deviceLinkBase: null }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, deviceLinkBase: "  " }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, deviceLinkBase: "eidmongolia://approve" }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, deviceLinkBase: "geregesmartid://x" }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, deviceLinkBase: "/dl" }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, sessionId: "abc" }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, sessionId: DL.sessionId.toUpperCase() }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, vc: null }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, vc: "1234" }), DeviceLinkError);
  assert.throws(() => deviceLink({ ...DL, vc: "12345&x=1" }), DeviceLinkError);
  assert.ok(new DeviceLinkError("x") instanceof browser.EidError);
});

test("isMobileUserAgent — Android/iPhone/iPadOS desktop UA/UA-CH", () => {
  const ipadUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  assert.equal(isMobileUserAgent({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile" }), true);
  assert.equal(isMobileUserAgent({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }), true);
  assert.equal(isMobileUserAgent({ userAgent: ipadUA, maxTouchPoints: 5 }), true);
  assert.equal(isMobileUserAgent({ userAgent: ipadUA, maxTouchPoints: 0 }), false);
  assert.equal(isMobileUserAgent({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", userAgentData: { mobile: true } }), true);
  assert.equal(isMobileUserAgent({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), false);
});

test("openOrShowQR — гар утсанд location.assign, desktop-д showQR", () => {
  const g = globalThis as { location?: unknown };
  const prev = g.location;
  const assigned: string[] = [];
  g.location = { assign: (u: string) => assigned.push(u) };
  try {
    const shown: string[] = [];
    assert.equal(openOrShowQR(DL, { showQR: (l) => shown.push(l), isMobile: true }), "opened");
    assert.deepEqual(assigned, [deviceLink(DL)]);
    assert.deepEqual(shown, []);
    assert.equal(openOrShowQR(DL, { showQR: (l) => shown.push(l), isMobile: () => false }), "qr");
    assert.deepEqual(shown, [deviceLink(DL)]);
    assert.equal(assigned.length, 1);
    assert.throws(() => openOrShowQR({ ...DL, deviceLinkBase: null }, { showQR: () => {}, isMobile: true }), DeviceLinkError);
    assert.equal(assigned.length, 1);
  } finally {
    g.location = prev;
  }
});

test("auth.deviceLinkAnonymous — deviceLinkBase ба vc (мөр) задлагдана", async () => {
  const eid = new EidClient({
    credentials: { rpUUID: "u", rpName: "n", apiSecret: "rp_sk_x" },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ sessionID: DL.sessionId, sessionToken: "t", sessionSecret: "s", deviceLinkBase: DL.deviceLinkBase, vc: "04821" }),
        { status: 200 },
      ),
  });
  const s = await eid.auth.deviceLinkAnonymous([{ type: "displayTextAndPIN", displayText60: "x" }]);
  assert.equal(s.vc, "04821");
  assert.equal(s.deviceLinkBase, DL.deviceLinkBase);
  assert.equal(deviceLink(s), deviceLink(DL));
  assert.ok(Math.abs(s.receivedAt - Date.now()) < 5_000, "receivedAt = хариу хүлээн авсан мөч");
});

// ── Device link v3 (buildDeviceLink) ──
// test/fixtures/devicelink_golden.json — ca-eidmongolia-mn `server/internal/crypto/testdata/devicelink_golden.json`
// (commit 88834efa)-ийн ЗАСВАРГҮЙ хуулбар. Сервер, iOS, Android, TS дөрвүүлээ байт-ижил гаргах ёстой.
// Шинэчлэх: эх файлыг дахин хуулна (векторыг энд засахгүй).
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/devicelink_golden.json", import.meta.url), "utf8"));
const RECEIVED_AT = 1_790_000_000_123;

function goldenInput(v: { input: Record<string, any> }, extraMs = 0) {
  const i = v.input;
  return {
    deviceLinkBase: i.deviceLinkBase,
    deviceLinkType: i.deviceLinkType,
    sessionToken: i.sessionToken,
    sessionSecret: i.sessionSecret,
    sessionType: i.sessionType,
    lang: i.lang,
    receivedAt: RECEIVED_AT,
    // floor шалгах: E секунд + 999 мс → E
    now: RECEIVED_AT + (i.elapsedSeconds ?? 0) * 1000 + extraMs,
    rpChallenge: i.sessionType === "auth" ? i.rpChallengeOrDigest : undefined,
    digest: i.sessionType === "sign" ? i.rpChallengeOrDigest : undefined,
    relyingPartyName: i.relyingPartyName,
    interactions: i.interactions,
    initialCallbackUrl: i.initialCallbackUrl,
    schemeName: i.schemeName,
    brokeredRpName: i.brokeredRpName,
  };
}

test("buildDeviceLink — golden векторууд (SK баримт 9 + eID 6) байт-ижил", () => {
  assert.equal(GOLDEN.vectors.length, 15);
  for (const v of GOLDEN.vectors) {
    assert.equal(buildDeviceLink(goldenInput(v)), v.deviceLink, v.name);
    assert.equal(buildDeviceLink(goldenInput(v, 999)), v.deviceLink, `${v.name} (floor)`);
    assert.ok(v.deviceLink.endsWith(`&authCode=${v.authCode}`), v.name);
  }
});

test("buildDeviceLink — golden invalid холбоосуудын аль нь ч гарахгүй", () => {
  const produced = new Set(GOLDEN.vectors.map((v: any) => buildDeviceLink(goldenInput(v))));
  for (const bad of GOLDEN.invalid) assert.ok(!produced.has(bad.link), bad.name);
});

test("buildDeviceLink — QR-д callback authCode-д орохгүй; Web2App-д орно", () => {
  const qr = GOLDEN.vectors.find((v: any) => v.name === "eid-qr-auth-e0");
  const same = buildDeviceLink({ ...goldenInput(qr), initialCallbackUrl: undefined });
  assert.equal(same, qr.deviceLink);
  const w = GOLDEN.vectors.find((v: any) => v.name === "eid-web2app-auth");
  assert.notEqual(buildDeviceLink({ ...goldenInput(w), initialCallbackUrl: "https://rp.example.mn/other" }), w.deviceLink);
});

test("buildDeviceLink — elapsedSeconds: floor, сөрөг → 0, Date хүлээн авна", () => {
  const qr = GOLDEN.vectors.find((v: any) => v.name === "eid-qr-auth-e7");
  const e = (link: string) => new URLSearchParams(link.split("?")[1]).get("elapsedSeconds");
  assert.equal(e(buildDeviceLink({ ...goldenInput(qr), now: RECEIVED_AT + 7_999 })), "7");
  assert.equal(e(buildDeviceLink({ ...goldenInput(qr), now: RECEIVED_AT - 3_000 })), "0");
  assert.equal(
    buildDeviceLink({ ...goldenInput(qr), receivedAt: new Date(RECEIVED_AT), now: new Date(RECEIVED_AT + 7_000) }),
    qr.deviceLink,
  );
});

test("buildDeviceLink — буруу оролт DeviceLinkError", () => {
  const qr = goldenInput(GOLDEN.vectors.find((v: any) => v.name === "eid-qr-auth-e0"));
  const w = goldenInput(GOLDEN.vectors.find((v: any) => v.name === "eid-web2app-auth"));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["http base", { ...qr, deviceLinkBase: "http://ca.eidmongolia.mn/dl" }],
    ["scheme base", { ...qr, deviceLinkBase: "eidmongolia://approve" }],
    ["base query", { ...qr, deviceLinkBase: "https://ca.eidmongolia.mn/dl?x=1" }],
    ["base empty", { ...qr, deviceLinkBase: "" }],
    ["type", { ...qr, deviceLinkType: "Notification" }],
    ["sessionType", { ...qr, sessionType: "login" }],
    ["token &", { ...qr, sessionToken: "abc&vc=1" }],
    ["token empty", { ...qr, sessionToken: "" }],
    ["lang 2", { ...qr, lang: "mn" }],
    ["lang upper", { ...qr, lang: "MON" }],
    ["secret url", { ...qr, sessionSecret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" }],
    ["secret empty", { ...qr, sessionSecret: "" }],
    ["auth no challenge", { ...qr, rpChallenge: undefined }],
    ["sign no digest", { ...qr, sessionType: "sign", rpChallenge: undefined }],
    ["cert challenge", { ...qr, sessionType: "cert" }],
    ["QR no receivedAt", { ...qr, receivedAt: undefined }],
    ["Web2App no callback", { ...w, initialCallbackUrl: "" }],
    ["App2App no callback", { ...w, deviceLinkType: "App2App", initialCallbackUrl: undefined }],
  ];
  for (const [name, input] of bad) assert.throws(() => buildDeviceLink(input as any), DeviceLinkError, name);
});

test("qrDeviceLinkTicker — шууд нэг, дараа нь interval бүрд шинэ elapsedSeconds; stop зогсооно", async () => {
  const qr = goldenInput(GOLDEN.vectors.find((v: any) => v.name === "eid-qr-auth-e0"));
  const { now: _now, deviceLinkType: _t, ...input } = qr;
  let clock = RECEIVED_AT;
  const links: string[] = [];
  const stop = qrDeviceLinkTicker(input, (l) => links.push(l), { intervalMs: 5, clock: () => (clock += 1000) - 1000 });
  assert.equal(links.length, 1);
  assert.ok(links[0]!.includes("elapsedSeconds=0&"));
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const n = links.length;
  assert.ok(n >= 3, `ticks ${n}`);
  links.forEach((l, i) => assert.ok(l.includes(`elapsedSeconds=${i}&`), l));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(links.length, n, "stop-ийн дараа гарахгүй");
  assert.throws(() => qrDeviceLinkTicker({ ...input, sessionSecret: "" }, () => {}), DeviceLinkError);
});

test("browser entry — sessionSecret шаарддаг buildDeviceLink ОРОХГҮЙ", () => {
  assert.equal((browser as Record<string, unknown>).buildDeviceLink, undefined);
  assert.equal((browser as Record<string, unknown>).qrDeviceLinkTicker, undefined);
});

// ── ResponseValidator.validateAuth — flowType/verifier (device-link relay хаалт) ──
// Тестийн түр self-signed cert-ийг openssl-ээр үүсгэнэ (репод түлхүүр хадгалахгүй).
const FIX = (() => {
  const dir = mkdtempSync(join(tmpdir(), "eid-sdk-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/C=MN/CN=TEST",
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: new X509Certificate(readFileSync(join(dir, "c.pem"))) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const VERIFIER = "dGVzdC12ZXJpZmllci0zMi1ieXRlcy14eHh4eHh4eHg";

/** Бодит ACSP_V2 гарын үсэгтэй COMPLETE/OK хариу + RP-ийн acsp контекст. */
function signedAuth(flowType: string, callback = "https://rp.test/cb") {
  const acsp = {
    rpChallenge: randomChallenge(),
    relyingPartyName: "DEMO",
    brokeredRpName: "",
    interactions: SMART_ID_VECTOR.interactions,
    initialCallbackUrl: callback,
    flowTypes: callback ? ["QR", "App2App", "Web2App"] : ["QR"],
    signatureAlgorithm: "rsassa-pss",
    hashAlgorithm: "SHA-256",
  } as const;
  const userChallenge = userChallengeOf(VERIFIER);
  const serverRandom = SMART_ID_VECTOR.serverRandom;
  const payload = buildAcspV2Payload({
    serverRandom, rpChallenge: acsp.rpChallenge, userChallenge, relyingPartyName: acsp.relyingPartyName,
    brokeredRpName: "", interactions: acsp.interactions, interactionTypeUsed: "displayTextAndPIN",
    initialCallbackUrl: callback, flowType,
  });
  const sig = cryptoSign("sha256", payload, { key: FIX.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const result = parseSessionResult({
    state: "COMPLETE",
    result: { endResult: "OK", documentNumber: "PNOMN-TEST" },
    signatureProtocol: "ACSP_V2",
    interactionTypeUsed: "displayTextAndPIN",
    signature: {
      value: sig.toString("base64"), serverRandom, userChallenge, flowType,
      signatureAlgorithm: "rsassa-pss", signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" },
    },
    cert: { value: FIX.cert.raw.toString("base64"), certificateLevel: "QUALIFIED" },
  });
  return { result, acsp: acsp as unknown as Parameters<ResponseValidator["validateAuth"]>[1] };
}

const V = new ResponseValidator({ allowUntrusted: true });

test("userChallengeOf — BASE64URL(SHA-256(verifier)), 43 тэмдэгт", () => {
  const uc = userChallengeOf(VERIFIER);
  assert.match(uc, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(uc, createHash("sha256").update(VERIFIER).digest("base64url"));
});

test("validateAuth — хүчинтэй хариу (expectedFlowType-гүй — хуучин зан хэвээр)", () => {
  const { result, acsp } = signedAuth("QR");
  assert.equal(V.validateAuth(result, acsp).documentNumber, "PNOMN-TEST");
});

test("validateAuth — OK боловч гарын үсэггүй → татгалзана", () => {
  const { result, acsp } = signedAuth("QR");
  assert.throws(() => V.validateAuth({ ...result, signatureValueB64: null }, acsp), /гарын үсэг алга/);
  assert.throws(() => V.validateAuth({ ...result, signatureValueB64: null }, acsp, { expectedFlowType: "QR" }), /гарын үсэг алга/);
  assert.throws(() => V.validateAuth({ ...result, signatureValueB64: "" }, acsp), ValidationError);
});

test("validateAuth — expectedFlowType QR: QR зөвшөөрнө, Web2App (relay) татгалзана", () => {
  const ok = signedAuth("QR");
  assert.equal(V.validateAuth(ok.result, ok.acsp, { expectedFlowType: "QR" }).documentNumber, "PNOMN-TEST");
  const relay = signedAuth("Web2App");
  assert.throws(() => V.validateAuth(relay.result, relay.acsp, { expectedFlowType: "QR" }), /эхлүүлсэн урсгал QR/);
});

test("validateAuth — expectedFlowType Web2App: зөв verifier-тэй зөвшөөрнө", () => {
  const { result, acsp } = signedAuth("Web2App");
  const who = V.validateAuth(result, acsp, { expectedFlowType: "Web2App", userChallengeVerifier: VERIFIER });
  assert.equal(who.documentNumber, "PNOMN-TEST");
});

test("validateAuth — Web2App/App2App: verifier алга эсвэл буруу бол татгалзана", () => {
  for (const flow of ["Web2App", "App2App"] as const) {
    const { result, acsp } = signedAuth(flow);
    assert.throws(() => V.validateAuth(result, acsp, { expectedFlowType: flow }), /userChallengeVerifier заавал/);
    assert.throws(() => V.validateAuth(result, acsp, { expectedFlowType: flow, userChallengeVerifier: "" }), /заавал/);
    assert.throws(
      () => V.validateAuth(result, acsp, { expectedFlowType: flow, userChallengeVerifier: VERIFIER + "x" }),
      /userChallengeVerifier нь/,
    );
  }
});

test("validateAuth — expectedFlowType Web2App боловч гарын үсэгт QR/App2App → татгалзана", () => {
  for (const flow of ["QR", "App2App"]) {
    const { result, acsp } = signedAuth(flow);
    assert.throws(
      () => V.validateAuth(result, acsp, { expectedFlowType: "Web2App", userChallengeVerifier: VERIFIER }),
      /эхлүүлсэн урсгал Web2App/,
    );
  }
});

test("validateAuth — хариуны flowType-ийг солиход гарын үсэг таарахгүй", () => {
  const { result, acsp } = signedAuth("Web2App");
  assert.throws(() => V.validateAuth({ ...result, flowType: "QR" }, acsp, { expectedFlowType: "QR" }), /ACSP_V2 payload-той таарсангүй/);
});
