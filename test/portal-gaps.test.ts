// Порталыг (eid-mongolia-mn) SDK руу шилжүүлэхэд илэрсэн дутагдлууд (0.10.0) — Go SDK 0.1.2-той ижил.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, sign as cryptoSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApiError,
  AuthenticationError,
  CITIZEN_ISSUING_CA_SKI,
  EidClient,
  ForbiddenError,
  NetworkError,
  RETRYABLE_ERROR_CODES,
  ResponseTooLargeError,
  ResponseValidator,
  TOKEN_CONFLICT_CODES,
  ValidationError,
  buildAcspV2Payload,
  parseRetryAfter,
  parseSessionResult,
  personMatchesCertificate,
  randomChallenge,
  sha256Base64,
  tokenAuthDigest,
  tokenLimitOf,
  userChallengeOf,
  verifyTokenCertificates,
} from "../dist/index.js";

const CREDS = { rpUUID: "rp-uuid", rpName: "Гэрээний систем", apiSecret: "rp_sk_secret" };

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
/** fetchImpl — хүсэлт бүрийг бичиж, reply-г буцаана. */
function client(reply: Reply | ((url: string) => Reply), extra: Record<string, unknown> = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    trust: { allowUntrusted: true },
    ...extra,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method), body: typeof init?.body === "string" ? init.body : undefined });
      const r = typeof reply === "function" ? reply(String(url)) : reply;
      const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
      return new Response(body, { status: r.status ?? 200, headers: r.headers });
    },
  });
  return { eid, calls };
}

/**
 * fetch-ийн оронд: signal abort хүртэл хүлээнэ. AbortSignal.timeout-ийн timer unref тул (Node 22) event loop-ийг
 * ref-тэй timer-ээр амьд байлгана.
 */
function hangUntilAbort(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("abort ирсэнгүй")), 5_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(init.signal!.reason);
    });
  });
}

// ── тестийн PKI (openssl — репод түлхүүр хадгалахгүй) ──
const DIR = mkdtempSync(join(tmpdir(), "eid-gaps-"));
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }));
const f = (n: string) => join(DIR, n);
const ossl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
// Өөрийн config — системийн openssl.cnf-ийн анхдагч extension-ууд (хувилбар бүрт өөр) холилдохгүй.
writeFileSync(f("root.cnf"), [
  "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no", "[dn]", "CN=Test Root",
  "[v3]", "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash", "",
].join("\n"));
ossl("req", "-x509", "-config", f("root.cnf"), "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", f("root.key"), "-out", f("root.pem"));
const ROOT_PEM = readFileSync(f("root.pem"), "utf8");
let serial = 100;

/** root-оос олгосон leaf (keyUsage / extKeyUsage-тэй). key: "rsa:2048" | "ec". */
function leaf(name: string, ext: string, key = "rsa:2048", subj = "/C=MN/SN=Бат/GN=Болд/serialNumber=PNOMN-12345678/CN=БОЛД Бат") {
  const keyArgs = key === "ec" ? ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256"] : ["-newkey", key];
  ossl("req", "-new", ...keyArgs, "-nodes", "-utf8", "-subj", subj, "-keyout", f(`${name}.key`), "-out", f(`${name}.csr`));
  ossl("req", "-in", f(`${name}.csr`), "-outform", "DER", "-out", f(`${name}.csr.der`));
  writeFileSync(f(`${name}.ext`), `${ext}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n`);
  ossl("x509", "-req", "-in", f(`${name}.csr`), "-CA", f("root.pem"), "-CAkey", f("root.key"), "-days", "1",
    "-set_serial", String(serial++), "-extfile", f(`${name}.ext`), "-out", f(`${name}.pem`));
  return {
    key: readFileSync(f(`${name}.key`), "utf8"),
    cert: new X509Certificate(readFileSync(f(`${name}.pem`))),
    csr: new Uint8Array(readFileSync(f(`${name}.csr.der`))),
  };
}
const AUTH = leaf("auth", "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth,emailProtection");
// qcStatements QcCompliance — 0.19.0-аас түвшин гэрчилгээнээс (SIGN-д qc-гүй бол ADVANCED).
const SIGN = leaf("sign", "keyUsage=digitalSignature,nonRepudiation\nextendedKeyUsage=emailProtection\n1.3.6.1.5.5.7.1.3=DER:30:0a:30:08:06:06:04:00:8e:46:01:01");

const VERIFIER = "dGVzdC12ZXJpZmllci0zMi1ieXRlcy14eHh4eHh4eHg";
const INTERACTIONS = Buffer.from(JSON.stringify([{ type: "displayTextAndPIN", displayText60: "x" }])).toString("base64");

function signedAuth(key: string, cert: X509Certificate, schemeName?: string) {
  const acsp = {
    rpChallenge: randomChallenge(), relyingPartyName: "DEMO", brokeredRpName: "", interactions: INTERACTIONS,
    initialCallbackUrl: "", flowTypes: ["QR"], signatureAlgorithm: "rsassa-pss", hashAlgorithm: "SHA-256",
  } as const;
  const userChallenge = userChallengeOf(VERIFIER);
  const serverRandom = "MTlop6EXCrQ6FOErcKjxUhbV";
  const payload = buildAcspV2Payload({
    ...(schemeName ? { schemeName } : {}), serverRandom, rpChallenge: acsp.rpChallenge, userChallenge, relyingPartyName: "DEMO",
    brokeredRpName: "", interactions: INTERACTIONS, interactionTypeUsed: "displayTextAndPIN", initialCallbackUrl: "", flowType: "QR",
  });
  const sig = cryptoSign("sha256", payload, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const result = parseSessionResult({
    state: "COMPLETE", result: { endResult: "OK", documentNumber: "d1" }, signatureProtocol: "ACSP_V2", interactionTypeUsed: "displayTextAndPIN",
    signature: { value: sig.toString("base64"), serverRandom, userChallenge, flowType: "QR", initialCallbackUrl: "",
      signatureAlgorithm: "rsassa-pss", signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" } },
    cert: { value: cert.raw.toString("base64"), certificateLevel: "QUALIFIED" },
  });
  return { result, acsp: acsp as unknown as Parameters<ResponseValidator["validateAuth"]>[1] };
}

function signedDigest(key: string, cert: X509Certificate) {
  const digest = createHash("sha256").update("баримт").digest();
  const sig = cryptoSign("sha256", Buffer.from("баримт"), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const result = parseSessionResult({
    state: "COMPLETE", result: { endResult: "OK", documentNumber: "d1" }, signatureProtocol: "RAW_DIGEST_SIGNATURE",
    signature: { value: sig.toString("base64"), signatureAlgorithm: "rsassa-pss", signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" } },
    cert: { value: cert.raw.toString("base64"), certificateLevel: "QUALIFIED" },
  });
  return { result, digest: digest.toString("base64") };
}

// Тестийн root нь иргэний 04 биш — анхдагч issuer allowlist-ийг (0.19.0) энд унтраана.
const trusted = (extra: Record<string, unknown> = {}) => new ResponseValidator({ trustAnchorsPem: [ROOT_PEM], allowAnyIssuer: true, ...extra });

// ── 1. person блок, raw, tokenCertificate ──

test("parseSessionResult — person блок, tokenCertificate, raw; personMatchesCertificate", () => {
  const raw = {
    state: "COMPLETE", result: { endResult: "OK", documentNumber: "d1" },
    person: { firstName: "Бат", lastName: "Дорж", familyName: "Боржигон", firstNameEn: "BAT", lastNameEn: "DORJ",
      civilId: "12345678", regNo: "УБ99112233", birthDate: "1999-11-22", gender: "M", geID: 42 },
    tokenCertificate: { status: "ISSUED", authSerialHex: "3F9A", signSerialHex: "7C01" },
    futureField: 1,
  };
  const r = parseSessionResult(raw);
  assert.deepEqual(r.person, raw.person);
  assert.deepEqual(r.tokenCertificate, raw.tokenCertificate);
  assert.equal((r.raw as Record<string, unknown>).futureField, 1);
  assert.equal(personMatchesCertificate(r.person, { serialNumber: "PNOMN-12345678" }), true);
  assert.equal(personMatchesCertificate(r.person, "PNOMN-12345678"), true);
  assert.equal(personMatchesCertificate(r.person, "PNOMN-87654321"), false);
  assert.equal(personMatchesCertificate({}, "PNOMN-"), false);
  assert.equal(personMatchesCertificate(null, undefined), false);
  const empty = parseSessionResult({ state: "RUNNING", person: {}, tokenCertificate: {} });
  assert.equal(empty.person, null);
  assert.equal(empty.tokenCertificate, null);
});

test("session.poll — person + raw", async () => {
  const { eid } = client({ body: { state: "COMPLETE", result: { endResult: "OK" }, person: { civilId: "1", geID: 42 } } });
  const r = await eid.session.poll("s1", 1000);
  assert.equal(r.person?.geID, 42);
  assert.ok(r.raw);
});

// ── 2. Retry-After, headers, retryable ──

test("parseRetryAfter — секунд / HTTP-огноо / буруу", () => {
  const now = Date.UTC(2026, 9, 14, 12);
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter(" 60 ", now), 60_000);
  for (const bad of ["", "-1", "0", "abc", "999999999", null, undefined]) assert.equal(parseRetryAfter(bad, now), undefined);
  assert.equal(parseRetryAfter(new Date(now + 30_000).toUTCString(), now), 30_000);
  assert.equal(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), undefined);
});

test("ApiError — 429/503 кодууд retryable + retryAfterMs + headers", async () => {
  const call = (eid: EidClient) => eid.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), []);
  for (const [status, retry, code] of [
    [429, "5", "RATE_LIMITED"],
    [503, "5", "ISSUANCE_PENDING"],
    [503, "5", "STATE_UNAVAILABLE"],
  ] as const) {
    const { eid } = client({ status, body: { error: "түр", code }, headers: { "Retry-After": retry, "X-Request-Id": "req-1" } });
    await assert.rejects(
      () => call(eid),
      (e: unknown) =>
        e instanceof ApiError && e.status === status && e.code === code && e.retryable && e.retryAfterMs === Number(retry) * 1000 &&
        e.headers?.get("X-Request-Id") === "req-1",
    );
  }
  assert.equal(RETRYABLE_ERROR_CODES.length, 3);
  const conflict = client({ status: 409, body: { error: "x", code: "DOC_ID_MISMATCH" } });
  await assert.rejects(() => call(conflict.eid), (e: unknown) => e instanceof ApiError && !e.retryable);
  const proxy = client({ status: 503, body: "<html>bad gateway</html>", headers: { "Retry-After": "10" } });
  await assert.rejects(() => call(proxy.eid), (e: unknown) => e instanceof ApiError && e.retryable && e.code === undefined);
  const forbidden = client({ status: 403, body: { error: "x", code: "REPRESENTATION_DENIED" }, headers: { "Retry-After": "7", "X-Request-Id": "req-1" } });
  await assert.rejects(
    () => call(forbidden.eid),
    (e: unknown) => e instanceof ForbiddenError && e.retryAfterMs === 7000 && e.headers?.get("X-Request-Id") === "req-1",
  );
});

// ── 3. fileName ──

test("sign — fileName хүсэлтэд орно (хоосон бол үгүй)", async () => {
  const { eid, calls } = client({ body: { sessionID: "s1", vc: { type: "alphaNumeric5", value: "12345" } } });
  await eid.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), [], { fileName: " Гэрээ.pdf " });
  await eid.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), []);
  assert.equal(JSON.parse(calls[0]!.body!).fileName, "Гэрээ.pdf");
  assert.equal("fileName" in JSON.parse(calls[1]!.body!), false);
});

// ── 4. PKI_READ, токен ──

test("person — PKI_READ замууд, activity query, raw", async () => {
  const { eid, calls } = client((url) => {
    if (url.includes("/certificates/")) return { body: { personEtsi: "PNOMN-1", counts: { valid: 1, total: 1 }, certificates: [{ type: "AUTH", keyMedium: "TOKEN", organization: { etsi: "NTRMN-6235972", name: "Гэрэгэ" } }] } };
    if (url.includes("/devices/")) return { body: { personEtsi: "PNOMN-1", devices: [{ documentNumber: "d", platform: "APNS", active: true }], activeCount: 1, total: 1 } };
    if (url.includes("/rp/activity/")) return { body: { personEtsi: "PNOMN-1", counts: { authentication: 2, signature: 1 }, sessions: [{ kind: "AUTH", outcome: "OK" }], total: 3, limit: 5, offset: 10 } };
    if (url.includes("/person/summary/")) return { body: { personEtsi: "PNOMN-1", lastName: "Дорж", activity: { authentication: 42 }, representationCount: 1 } };
    return { body: { children: [{ etsi: "PNOMN-2", name: "Дорж Сүх", registered: false }] } };
  });
  const certs = await eid.person.certificates("PNOMN-1");
  assert.equal(certs.certificates[0]!.organization?.etsi, "NTRMN-6235972");
  assert.ok(certs.raw);
  assert.equal((await eid.person.devices("PNOMN-1")).activeCount, 1);
  const act = await eid.person.activity("PNOMN-1", { flow: "AUTHENTICATION", limit: 5, offset: 10 });
  assert.equal(act.counts.authentication, 2);
  await eid.person.activity("PNOMN-1");
  assert.equal((await eid.person.summary("PNOMN-1")).lastName, "Дорж");
  assert.equal((await eid.person.children("PNOMN-1")).children[0]!.name, "Дорж Сүх");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url.replace("https://rp.eidmongolia.mn", "")}`),
    [
      "GET /certificates/etsi/PNOMN-1",
      "GET /devices/etsi/PNOMN-1",
      "GET /rp/activity/etsi/PNOMN-1?flow=AUTHENTICATION&limit=5&offset=10",
      "GET /rp/activity/etsi/PNOMN-1",
      "GET /person/summary/etsi/PNOMN-1",
      "GET /person/children/etsi/PNOMN-1",
    ],
  );
  const denied = client({ status: 403, body: { error: "RP-д PKI_READ эрх алга" } });
  await assert.rejects(() => denied.eid.person.summary("PNOMN-1"), ForbiddenError);
});

const TOK_A = leaf("tokA", "keyUsage=digitalSignature\nextendedKeyUsage=clientAuth,emailProtection", "ec", "/C=MN/serialNumber=PNOMN-55667788/CN=BOLD Bat");
const TOK_S = leaf("tokS", "keyUsage=digitalSignature,nonRepudiation", "ec", "/C=MN/serialNumber=PNOMN-55667788/CN=BOLD Bat");
const hx = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").toUpperCase();

test("token.issueCertificate — яг CA-ийн талбарууд, CSR hash тулгалт", async () => {
  const { eid, calls } = client({
    body: { sessionID: "ts1", vc: { type: "alphaNumeric5", value: "04817" }, csrAuthSha256: hx(TOK_A.csr), csrSignSha256: hx(TOK_S.csr), expiresAt: "2026-10-12T16:41:34+08:00" },
  });
  const s = await eid.token.issueCertificate({ signerEtsi: "PNOMN-55667788", csrAuth: TOK_A.csr, csrSign: TOK_S.csr, tokenSerial: "EP2003-0042A1" });
  assert.equal(s.sessionId, "ts1");
  assert.equal(s.vc, "04817");
  assert.equal(s.csrAuthSha256, hx(TOK_A.csr).toLowerCase());
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/token/certificate");
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    relyingPartyUUID: "rp-uuid", relyingPartyName: "Гэрээний систем", signer: { etsi: "PNOMN-55667788" },
    csrAuth: Buffer.from(TOK_A.csr).toString("base64"), csrSign: Buffer.from(TOK_S.csr).toString("base64"),
    tokenSerial: "EP2003-0042A1", onBehalfOf: "", flow: "notification",
  });
  const swapped = client({ body: { sessionID: "ts1", csrAuthSha256: hx(TOK_S.csr), csrSignSha256: hx(TOK_S.csr) } });
  await assert.rejects(
    () => swapped.eid.token.issueCertificate({ signerEtsi: "PNOMN-1", csrAuth: TOK_A.csr, csrSign: TOK_S.csr, tokenSerial: "x", tokenLabel: "L", onBehalfOf: "NTRMN-1" }),
    (e: unknown) => e instanceof ValidationError && /csrAuthSha256/.test(e.message),
  );
  await assert.rejects(() => swapped.eid.token.issueCertificate({ signerEtsi: "", csrAuth: TOK_A.csr, csrSign: TOK_S.csr, tokenSerial: "x" }));
});

test("token.certificateResult + verifyTokenCertificates + tokenLimitOf", async () => {
  const { eid, calls } = client({
    body: { status: "ISSUED", auth: { certificate: TOK_A.cert.raw.toString("base64"), serialHex: "A" },
      sign: { certificate: TOK_S.cert.raw.toString("base64"), serialHex: "S" }, chain: ["x"], organization: null, keyMedium: "TOKEN", certificateLevel: "ADVANCED" },
  });
  const r = await eid.token.certificateResult("ts1");
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/token/certificate/ts1");
  assert.equal(r.status, "ISSUED");
  assert.equal(r.organization, null);
  verifyTokenCertificates(r, TOK_A.csr, TOK_S.csr);
  assert.throws(() => verifyTokenCertificates(r, TOK_S.csr, TOK_A.csr), (e: unknown) => e instanceof ValidationError && /түлхүүр/.test(e.message));
  assert.throws(() => verifyTokenCertificates({ ...r, auth: null }, TOK_A.csr, TOK_S.csr), ValidationError);

  const limited = client({ status: 409, body: { error: "хязгаар", code: "TOKEN_LIMIT_REACHED", kind: "ORGANIZATION", limit: 1, organization: "NTRMN-6235972" } });
  const err = await limited.eid.token.issueCertificate({ signerEtsi: "PNOMN-1", csrAuth: TOK_A.csr, csrSign: TOK_S.csr, tokenSerial: "x" }).catch((e) => e);
  assert.deepEqual(tokenLimitOf(err), { kind: "ORGANIZATION", limit: 1, organization: "NTRMN-6235972" });
  for (const body of [
    { code: "TOKEN_LIMIT_REACHED", kind: "PERSONAL" },
    { code: "TOKEN_LIMIT_REACHED", kind: "ORGANIZATION", limit: 1 },
    { code: "TOKEN_LIMIT_REACHED", kind: "X", limit: 1 },
  ]) {
    assert.equal(tokenLimitOf(new ApiError(409, JSON.stringify(body), body.code)), undefined);
  }
  assert.equal(tokenLimitOf(new ApiError(409, JSON.stringify({ kind: "PERSONAL", limit: 1 }), "TOKEN_IN_USE")), undefined);
  assert.deepEqual(tokenLimitOf(new ApiError(409, JSON.stringify({ kind: "PERSONAL", limit: 0 }), "TOKEN_LIMIT_REACHED")), { kind: "PERSONAL", limit: 0 });
  assert.equal(tokenLimitOf(new Error("x")), undefined);

  const scope = client({ status: 409, body: { error: "Токены төрлийг солихын тулд …", code: "TOKEN_SCOPE_CHANGE" } });
  const se = await scope.eid.token.issueCertificate({ signerEtsi: "PNOMN-1", csrAuth: TOK_A.csr, csrSign: TOK_S.csr, tokenSerial: "x", onBehalfOf: "NTRMN-1" }).catch((e) => e);
  assert.ok(se instanceof ApiError && se.status === 409 && se.code === "TOKEN_SCOPE_CHANGE");
  assert.ok((TOKEN_CONFLICT_CODES as readonly string[]).includes(se.code!));
  assert.equal(se.retryable, false);
  assert.equal(tokenLimitOf(se), undefined);
});

test("token.certificateInfo: discovery-ийн tokenCertificate блок (scopeLockedOnRenewal)", async () => {
  const block = {
    certificateLevel: "ADVANCED", enabled: true, issue: "https://rp.eidmongolia.mn/token/certificate",
    keyAlgorithm: "EC P-256 (ecdsa-with-SHA256)", onBehalfOf: "optional", permission: "TOKEN_ISSUE",
    result: "https://rp.eidmongolia.mn/token/certificate/{sessionID}", scopeLockedOnRenewal: true,
  };
  const { eid, calls } = client({ status: 200, body: { version: "v3", tokenCertificate: block } });
  const i = await eid.token.certificateInfo();
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/.well-known/eid");
  assert.equal(i.scopeLockedOnRenewal, true);
  assert.equal(i.enabled, true);
  assert.equal(i.permission, "TOKEN_ISSUE");
  assert.equal(i.onBehalfOf, "optional");
  const old = await client({ status: 200, body: { version: "v3" } }).eid.token.certificateInfo();
  assert.equal(old.enabled, false);
  assert.equal(old.scopeLockedOnRenewal, false);
});

test("token auth — tokenAuthDigest вектор, challenge, verify (identity = SERIALNUMBER)", async () => {
  assert.equal(
    tokenAuthDigest("2d87bd3a-1303-41bf-81bd-37d6b92fb7bc", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").toString("hex"),
    "a88f9803b82f9e0701752360184f18f2035bc2447372283e3fa009fe2cfeeef5",
  );
  assert.throws(() => tokenAuthDigest("2D87BD3A-1303-41BF-81BD-37D6B92FB7BC", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="));
  assert.throws(() => tokenAuthDigest("2d87bd3a-1303-41bf-81bd-37d6b92fb7bc", "AAEC"));

  const ch = client({ body: { challengeId: "c1", challenge: "q3J0", rpUUID: "2d87bd3a-1303-41bf-81bd-37d6b92fb7bc", expiresAt: "2026-10-12T08:42:10Z" } });
  assert.equal((await ch.eid.token.authChallenge()).challengeId, "c1");
  assert.equal(ch.calls[0]!.url, "https://rp.eidmongolia.mn/token/auth/challenge");
  assert.deepEqual(JSON.parse(ch.calls[0]!.body!), { relyingPartyUUID: "rp-uuid", relyingPartyName: "Гэрээний систем" });

  const ok = {
    result: { endResult: "OK" }, identity: { etsi: "PNOMN-55667788", givenName: "Бат", surname: "Болд" },
    cert: { serialHex: "4f1c", notAfter: "2027-10-12T08:40:00Z" }, organization: { etsi: "NTRMN-1", name: "X" },
  };
  // 0.19.0: SDK CA руу илгээхээс өмнө гарын үсэг (r||s, tokenAuthDigest), rpUUID, гэрчилгээг (гинж/зориулалт) өөрөө шалгана.
  const RP = "2d87bd3a-1303-41bf-81bd-37d6b92fb7bc";
  const chal = { challengeId: "c1", challenge: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", rpUUID: RP, expiresAt: "" };
  const preimage = Buffer.concat([Buffer.from("eID-TOKEN-AUTH" + RP), Buffer.from(chal.challenge, "base64")]);
  const sig = new Uint8Array(cryptoSign("sha256", preimage, { key: TOK_A.key, dsaEncoding: "ieee-p1363" }));
  const tclient = (reply: Reply, trust: Record<string, unknown> = { trustAnchorsPem: [ROOT_PEM], allowAnyIssuer: true }) =>
    client(reply, { credentials: { ...CREDS, rpUUID: RP }, trust });
  const v = tclient({ body: ok });
  const res = await v.eid.token.authVerify(chal, TOK_A.cert.raw, sig);
  assert.equal(res.identity.surname, "Болд");
  assert.equal(res.organization?.etsi, "NTRMN-1");
  assert.deepEqual(Object.keys(JSON.parse(v.calls[0]!.body!)).sort(), ["certificate", "challengeId", "signature"]);
  for (const body of [{ ...ok, identity: { ...ok.identity, etsi: "PNOMN-99999999" } }, { ...ok, result: { endResult: "DENIED" } }]) {
    const bad = tclient({ body });
    await assert.rejects(
      () => bad.eid.token.authVerify(chal, TOK_A.cert.raw, sig),
      (e: unknown) => e instanceof ValidationError && /token auth/.test(e.message) && !/PNOMN-/.test(e.message),
    );
  }
  // CA OK гэсэн ч SDK-ийн шалгалт унавал CA руу ЯВАХГҮЙ: буруу гарын үсэг, өөр challenge, өөр RP, гинжгүй/өөр issuer, KU.
  const localFail = async (name: string, fn: (c: ReturnType<typeof tclient>) => Promise<unknown>, re: RegExp, trust?: Record<string, unknown>) => {
    const c = tclient({ body: ok }, trust);
    await assert.rejects(() => fn(c), (e: unknown) => e instanceof ValidationError && re.test(e.message), name);
    assert.equal(c.calls.length, 0, name);
  };
  await localFail("zero sig", (c) => c.eid.token.authVerify(chal, TOK_A.cert.raw, new Uint8Array(64)), /гарын үсэг/);
  await localFail("other challenge", (c) => c.eid.token.authVerify({ ...chal, challenge: "AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" }, TOK_A.cert.raw, sig), /гарын үсэг/);
  await localFail("other rp", (c) => c.eid.token.authVerify({ ...chal, rpUUID: "00000000-0000-4000-8000-000000000000" }, TOK_A.cert.raw, sig), /rpUUID/);
  await localFail("default issuer", (c) => c.eid.token.authVerify(chal, TOK_A.cert.raw, sig), /allowedIssuerSkis/, { trustAnchorsPem: [ROOT_PEM] });
  await localFail("no anchor", (c) => c.eid.token.authVerify(chal, TOK_A.cert.raw, sig), /Trust anchor/, {});
  const tsSig = new Uint8Array(cryptoSign("sha256", preimage, { key: TOK_S.key, dsaEncoding: "ieee-p1363" }));
  await localFail("sign cert", (c) => c.eid.token.authVerify(chal, TOK_S.cert.raw, tsSig), /KeyUsage|ExtKeyUsage|clientAuth/);
  await assert.rejects(() => v.eid.token.authVerify(chal, new Uint8Array([1, 2]), sig));
  await assert.rejects(() => v.eid.token.authVerify("c1" as unknown as typeof chal, TOK_A.cert.raw, sig), /challengeId мөр биш/);
  const expired = tclient({ status: 410, body: { error: "x", code: "CHALLENGE_EXPIRED" } });
  await assert.rejects(() => expired.eid.token.authVerify(chal, TOK_A.cert.raw, sig), (e: unknown) => e instanceof ApiError && e.code === "CHALLENGE_EXPIRED");
});

// ── 5. validator ──

test("validator — allowedIssuerSkis", () => {
  const { result, acsp } = signedAuth(AUTH.key, AUTH.cert);
  const rootSki = execFileSync("openssl", ["x509", "-in", f("root.pem"), "-noout", "-ext", "subjectKeyIdentifier"]).toString().split("\n")[1]!.trim();
  trusted({ allowedIssuerSkis: [rootSki] }).validateAuth(result, acsp); // ":"-тэй, том үсэг
  // Анхдагч (allowAnyIssuer-гүй, жагсаалтгүй) = [CITIZEN_ISSUING_CA_SKI] → тестийн root-ийн leaf татгалзагдана.
  assert.throws(() => new ResponseValidator({ trustAnchorsPem: [ROOT_PEM] }).validateAuth(result, acsp), (e: unknown) => e instanceof ValidationError && /allowedIssuerSkis/.test(e.message));
  // allowUntrusted (anchor-гүй) — анхдагч allowlist үйлчлэхгүй (гинж алга).
  new ResponseValidator({ allowUntrusted: true }).validateAuth(result, acsp);
  assert.throws(() => trusted({ allowedIssuerSkis: [CITIZEN_ISSUING_CA_SKI] }).validateAuth(result, acsp), (e: unknown) => e instanceof ValidationError && /allowedIssuerSkis/.test(e.message));
  assert.throws(() => trusted({ allowedIssuerSkis: ["zz"] }));
  // CITIZEN_ISSUING_CA_SKI — бодит 04 (testdata-гүй репод: Go SDK testdata-тай тулгасан утга)
  assert.equal(CITIZEN_ISSUING_CA_SKI, "b8a37f2c64ad677912db7d9e34f246358a2fb909");
});

test("validator — checkKeyUsage (0.19.0-аас анхдагч true): auth → clientAuth, sign → nonRepudiation", () => {
  const strict = trusted();
  const a = signedAuth(AUTH.key, AUTH.cert);
  strict.validateAuth(a.result, a.acsp);
  const wrong = signedAuth(SIGN.key, SIGN.cert);
  assert.throws(() => strict.validateAuth(wrong.result, wrong.acsp), (e: unknown) => e instanceof ValidationError && /clientAuth/.test(e.message));
  // checkKeyUsage=false ч EKU-г гинжийн шалгалт (auth → clientAuth) үргэлж шалгана (0.11.0-аас).
  assert.throws(() => trusted({ checkKeyUsage: false }).validateAuth(wrong.result, wrong.acsp), (e: unknown) => e instanceof ValidationError && /ExtKeyUsage/.test(e.message));
  const s = signedDigest(SIGN.key, SIGN.cert);
  strict.validateSign(s.result, s.digest);
  // PIN1 (AUTH) түлхүүрийн гарын үсэг validateSign-д — анхдагчаар унана.
  const sAuth = signedDigest(AUTH.key, AUTH.cert);
  assert.throws(() => strict.validateSign(sAuth.result, sAuth.digest), (e: unknown) => e instanceof ValidationError && /nonRepudiation/.test(e.message));
  assert.throws(() => new EidClient({ credentials: CREDS, trust: { trustAnchorsPem: [ROOT_PEM], allowAnyIssuer: true, requiredLevel: "ADVANCED" } })
    .validator.validateSign(sAuth.result, sAuth.digest), (e: unknown) => e instanceof ValidationError && /nonRepudiation/.test(e.message));
});

test("validator — schemeName", () => {
  const { result, acsp } = signedAuth(AUTH.key, AUTH.cert); // smart-id
  assert.throws(() => trusted({ schemeName: "eid-mongolia" }).validateAuth(result, acsp), (e: unknown) => e instanceof ValidationError && /ACSP_V2/.test(e.message));
  trusted({ schemeName: "smart-id" }).validateAuth(result, acsp);
  const custom = signedAuth(AUTH.key, AUTH.cert, "eid-mongolia");
  trusted({ schemeName: "eid-mongolia" }).validateAuth(custom.result, custom.acsp);
});

test("validator — checkRevocationStatus: good / unchecked / skipped; revoked, unknown hard-fail → ValidationError", async () => {
  const mk = (st: "good" | "revoked" | "unknown", mode?: "hard-fail" | "soft-fail") =>
    trusted({ revocation: async () => st, ...(mode ? { revocationMode: mode } : {}) });
  assert.equal(await trusted().checkRevocationStatus(AUTH.cert), "skipped");
  assert.equal(await mk("good").checkRevocationStatus(AUTH.cert), "good");
  assert.equal(await mk("unknown", "soft-fail").checkRevocationStatus(AUTH.cert), "unchecked");
  await assert.rejects(() => mk("revoked", "soft-fail").checkRevocationStatus(AUTH.cert), ValidationError);
  await assert.rejects(() => mk("unknown").checkRevocationStatus(AUTH.cert), ValidationError);
  await mk("good").checkRevocation(AUTH.cert);
  const boom = trusted({ revocation: async () => { throw new Error("ocsp down"); } });
  await assert.rejects(() => boom.checkRevocationStatus(AUTH.cert), /ocsp down/);
});

// ── 6. PII ──

function noPII(e: unknown): boolean {
  const msg = (e as Error).message + " " + String((e as NetworkError).op ?? "");
  return !["PNOMN-", "12345678", "Бат", "Болд", "БОЛД"].some((p) => msg.includes(p));
}

test("PII — NetworkError замд PNOMN/РД/documentNumber орохгүй (op masked)", async () => {
  const eid = new EidClient({
    credentials: CREDS,
    fetchImpl: async (url) => {
      throw new TypeError(`fetch failed: ${String(url)}`);
    },
  });
  await assert.rejects(
    () => eid.auth.notificationByEtsi("PNOMN-12345678", []),
    (e: unknown) => e instanceof NetworkError && e.op === "POST /authentication/notification/etsi/…" && noPII(e),
  );
  await assert.rejects(() => eid.person.activity("PNOMN-12345678", { limit: 5 }), (e: unknown) => e instanceof NetworkError && noPII(e));
  await assert.rejects(
    () => eid.sign.digestByDocument("doc-12345678", sha256Base64("x"), []),
    (e: unknown) => e instanceof NetworkError && e.op === "POST /signature/notification/document/…" && noPII(e),
  );
  await assert.rejects(
    () => eid.sign.digestForSigner({ documentNumber: "PNOMN-12345678-ABCD-Q", certChoiceSessionId: "cc-1" }, sha256Base64("x"), []),
    (e: unknown) => e instanceof NetworkError && e.op === "POST /signature/notification/linked/…" && noPII(e),
  );
  const slow = new EidClient({
    credentials: CREDS, timeoutMs: 20,
    fetchImpl: hangUntilAbort,
  });
  await assert.rejects(() => slow.organization.getRepresentations("PNOMN-12345678"), (e: unknown) => e instanceof NetworkError && e.timeout === true && noPII(e));
});

test("PII — ValidationError-д гэрчилгээний нэр/PNOMN орохгүй", () => {
  const { result, acsp } = signedAuth(AUTH.key, AUTH.cert);
  for (const v of [
    new ResponseValidator({ trustAnchorsPem: [readFileSync(f("tokA.pem"), "utf8")] }), // өөр anchor → гинж
    trusted({ requiredLevel: "QSCD" }),
    trusted({ allowedIssuerSkis: [CITIZEN_ISSUING_CA_SKI] }),
  ]) {
    assert.throws(() => v.validateAuth(result, acsp), (e: unknown) => e instanceof ValidationError && noPII(e));
  }
});

// ── 7. AuthenticationError ──

test("AuthenticationError — CA-ийн code/body vs proxy 401", async () => {
  // CA-ийн rpAuth: {"error":"RP API secret буруу"} (code-гүй)
  const ca = client({ status: 401, body: { error: "RP API secret буруу" } });
  await assert.rejects(
    () => ca.eid.session.poll("x", 1000),
    (e: unknown) => e instanceof AuthenticationError && e.serverMessage === "RP API secret буруу" && e.code === undefined,
  );
  const coded = client({ status: 401, body: { error: "x", code: "RP_AUTH_FAILED" } });
  await assert.rejects(
    () => coded.eid.session.poll("x", 1000),
    (e: unknown) => e instanceof AuthenticationError && e.code === "RP_AUTH_FAILED" && /RP_AUTH_FAILED/.test(e.body ?? "") && /RP_AUTH_FAILED/.test(e.message),
  );
  const proxy = client({ status: 401, body: "<html>401 Authorization Required</html>" });
  await assert.rejects(
    () => proxy.eid.session.poll("x", 1000),
    (e: unknown) => e instanceof AuthenticationError && e.code === undefined && e.serverMessage === undefined && /html/.test(e.body ?? ""),
  );
});

// ── 0.11.0: хариуны хэмжээ, representations raw (Go SDK 0.1.3-тэй ижил) ──

test("хариуны хэмжээ — JSON > 4 MiB → ResponseTooLargeError (таслахгүй)", async () => {
  const MAX = 4 << 20;
  const big = `{"personEtsi":"PNOMN-1","pad":"${"a".repeat(MAX)}"}`;
  const { eid } = client({ body: big });
  await assert.rejects(() => eid.organization.getRepresentations("PNOMN-1"),
    (e: unknown) => e instanceof ResponseTooLargeError && e.limit === MAX && !e.message.includes("PNOMN-1"));
  const head = `{"personEtsi":"PNOMN-1","pad":""}`;
  const exact = `{"personEtsi":"PNOMN-1","pad":"${"a".repeat(MAX - head.length)}"}`;
  await client({ body: exact }).eid.organization.getRepresentations("PNOMN-1");
  // Content-Length-аар эрт татгалзана.
  const declared = client(() => ({ body: "x", headers: { "content-length": String(MAX + 1) } }));
  await assert.rejects(() => declared.eid.organization.getRepresentations("PNOMN-1"), ResponseTooLargeError);

});

test("getRepresentations — raw", async () => {
  const { eid } = client({ body: { personEtsi: "PNOMN-1", representations: [{ orgEtsi: "NTRMN-1" }], future: { x: 1 } } });
  const r = await eid.organization.getRepresentations("PNOMN-1");
  assert.equal(r.representations.length, 1);
  assert.deepEqual((r.raw as Record<string, unknown>).future, { x: 1 });
});

// ── 0.12.0: roleLabel (CA !339) + language → Accept-Language ──

test("roleLabel — representations ба session onBehalfOf; хуучин CA-д байхгүй", async () => {
  const { eid } = client({ body: { personEtsi: "PNOMN-1", representations: [
    { orgEtsi: "NTRMN-1", role: "ceo", roleLabel: "Гүйцэтгэх захирал", rightType: "ADMIN", source: "REGISTRY", validFrom: "2026-10-01T00:00:00Z" },
    { orgEtsi: "NTRMN-2", role: "Нягтлан", rightType: "MANAGER", source: "MANUAL", validFrom: "2026-10-01T00:00:00Z" },
  ] } });
  const r = await eid.organization.getRepresentations("PNOMN-1");
  assert.equal(r.representations[0].roleLabel, "Гүйцэтгэх захирал");
  assert.equal(r.representations[1].roleLabel, undefined);

  const base = { state: "COMPLETE", result: { endResult: "OK" } };
  const s = parseSessionResult({ ...base, onBehalfOf: { orgEtsi: "NTRMN-1", orgName: "Х ХХК", role: "ceo", roleLabel: "Chief Executive Officer", rightType: "ADMIN" } });
  assert.equal(s.onBehalfOf?.roleLabel, "Chief Executive Officer");
  assert.equal(s.onBehalfOf?.role, "ceo");
  const old = parseSessionResult({ ...base, onBehalfOf: { orgEtsi: "NTRMN-1", role: "ceo", rightType: "ADMIN" } });
  assert.equal(old.onBehalfOf?.roleLabel, undefined);
  assert.ok(!("roleLabel" in (old.onBehalfOf ?? {})));
});

test("language → Accept-Language; анхдагч илгээхгүй", async () => {
  const seen: (string | null)[] = [];
  const mk = (extra: Record<string, unknown>) => new EidClient({
    credentials: CREDS, trust: { allowUntrusted: true }, ...extra,
    fetchImpl: async (_url, init) => {
      seen.push(new Headers(init?.headers).get("accept-language"));
      return new Response(JSON.stringify({ personEtsi: "PNOMN-1", representations: [] }), { status: 200 });
    },
  });
  await mk({}).organization.getRepresentations("PNOMN-1");
  await mk({ language: "en" }).organization.getRepresentations("PNOMN-1");
  await mk({ language: " " }).organization.getRepresentations("PNOMN-1");
  assert.deepEqual(seen, [null, "en", null]);
});

// ── 0.12.1: rightTypeLabel / sourceLabel (CA !344) ──

test("rightTypeLabel / sourceLabel — representations ба session onBehalfOf; хуучин CA-д байхгүй", async () => {
  const { eid } = client({ body: { personEtsi: "PNOMN-1", representations: [
    { orgEtsi: "NTRMN-1", role: "ceo", roleLabel: "Гүйцэтгэх захирал", rightType: "ADMIN", rightTypeLabel: "Админ",
      source: "REGISTRY", sourceLabel: "Улсын бүртгэл", validFrom: "2026-10-01T00:00:00Z" },
    { orgEtsi: "NTRMN-2", role: "Нягтлан", rightType: "MANAGER", source: "MANUAL", validFrom: "2026-10-01T00:00:00Z" },
  ] } });
  const r = await eid.organization.getRepresentations("PNOMN-1");
  assert.equal(r.representations[0].rightTypeLabel, "Админ");
  assert.equal(r.representations[0].sourceLabel, "Улсын бүртгэл");
  assert.equal(r.representations[1].rightTypeLabel, undefined);
  assert.equal(r.representations[1].sourceLabel, undefined);

  const base = { state: "COMPLETE", result: { endResult: "OK" } };
  const s = parseSessionResult({ ...base, onBehalfOf: { orgEtsi: "NTRMN-1", orgName: "Х ХХК", role: "ceo", rightType: "MANAGER", rightTypeLabel: "Signatory" } });
  assert.equal(s.onBehalfOf?.rightTypeLabel, "Signatory");
  assert.equal(s.onBehalfOf?.rightType, "MANAGER");
  const old = parseSessionResult({ ...base, onBehalfOf: { orgEtsi: "NTRMN-1", role: "ceo", rightType: "ADMIN" } });
  assert.ok(!("rightTypeLabel" in (old.onBehalfOf ?? {})));
});
