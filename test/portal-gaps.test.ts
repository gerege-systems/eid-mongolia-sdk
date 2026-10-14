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
  DEFAULT_PDF_TIMEOUT_MS,
  EidClient,
  ForbiddenError,
  NetworkError,
  RETRYABLE_ERROR_CODES,
  ResponseTooLargeError,
  ResponseValidator,
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
const SIGN = leaf("sign", "keyUsage=digitalSignature,nonRepudiation\nextendedKeyUsage=emailProtection");

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

const trusted = (extra: Record<string, unknown> = {}) => new ResponseValidator({ trustAnchorsPem: [ROOT_PEM], ...extra });

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

// ── 2. Retry-After, headers, retryable, PDF timeout ──

test("parseRetryAfter — секунд / HTTP-огноо / буруу", () => {
  const now = Date.UTC(2026, 9, 14, 12);
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter(" 60 ", now), 60_000);
  for (const bad of ["", "-1", "0", "abc", "999999999", null, undefined]) assert.equal(parseRetryAfter(bad, now), undefined);
  assert.equal(parseRetryAfter(new Date(now + 30_000).toUTCString(), now), 30_000);
  assert.equal(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), undefined);
});

test("ApiError — PDF 429/503 кодууд retryable + retryAfterMs + headers", async () => {
  const pdfIn = { pdf: new Uint8Array([1]), fileName: "a.pdf", signer: { etsi: "PNOMN-1" } };
  for (const [status, retry, code, doc] of [
    [429, "5", "PDF_PREPARE_BUSY", false],
    [503, "60", "LTV_UNAVAILABLE", false],
    [503, "5", "DOCUMENT_PENDING", true],
    [503, "30", "TSA_UNAVAILABLE", true],
    [503, "60", "LTV_UNAVAILABLE", true],
  ] as const) {
    const { eid } = client({ status, body: { error: "түр", code }, headers: { "Retry-After": retry, "X-Request-Id": "req-1" } });
    await assert.rejects(
      () => (doc ? eid.pdf.document("s1") : eid.pdf.prepare(pdfIn)),
      (e: unknown) =>
        e instanceof ApiError && e.status === status && e.code === code && e.retryable && e.retryAfterMs === Number(retry) * 1000 &&
        e.headers?.get("X-Request-Id") === "req-1",
    );
  }
  assert.equal(RETRYABLE_ERROR_CODES.length, 7);
  const conflict = client({ status: 409, body: { error: "x", code: "DOC_ID_MISMATCH" } });
  await assert.rejects(() => conflict.eid.pdf.prepare(pdfIn), (e: unknown) => e instanceof ApiError && !e.retryable);
  const proxy = client({ status: 503, body: "<html>bad gateway</html>", headers: { "Retry-After": "10" } });
  await assert.rejects(() => proxy.eid.pdf.prepare(pdfIn), (e: unknown) => e instanceof ApiError && e.retryable && e.code === undefined);
  const forbidden = client({ status: 403, body: { error: "x", code: "REPRESENTATION_DENIED" }, headers: { "Retry-After": "7", "X-Request-Id": "req-1" } });
  await assert.rejects(
    () => forbidden.eid.pdf.prepare(pdfIn),
    (e: unknown) => e instanceof ForbiddenError && e.retryAfterMs === 7000 && e.headers?.get("X-Request-Id") === "req-1",
  );
});

test("pdfTimeoutMs — анхдагч 80с, тохируулж болно", async () => {
  assert.equal(DEFAULT_PDF_TIMEOUT_MS, 80_000);
  const eid = new EidClient({
    credentials: CREDS,
    pdfTimeoutMs: 50,
    fetchImpl: hangUntilAbort,
  });
  await assert.rejects(() => eid.pdf.document("s1"), (e: unknown) => e instanceof NetworkError && e.timeout === true);
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
  const v = client({ body: ok });
  const res = await v.eid.token.authVerify("c1", TOK_A.cert.raw, new Uint8Array(64));
  assert.equal(res.identity.surname, "Болд");
  assert.equal(res.organization?.etsi, "NTRMN-1");
  assert.deepEqual(Object.keys(JSON.parse(v.calls[0]!.body!)).sort(), ["certificate", "challengeId", "signature"]);
  for (const body of [{ ...ok, identity: { ...ok.identity, etsi: "PNOMN-99999999" } }, { ...ok, result: { endResult: "DENIED" } }]) {
    const bad = client({ body });
    await assert.rejects(
      () => bad.eid.token.authVerify("c1", TOK_A.cert.raw, new Uint8Array(64)),
      (e: unknown) => e instanceof ValidationError && /token auth/.test(e.message) && !/PNOMN-/.test(e.message),
    );
  }
  await assert.rejects(() => v.eid.token.authVerify("c1", new Uint8Array([1, 2]), new Uint8Array(64)));
  const expired = client({ status: 410, body: { error: "x", code: "CHALLENGE_EXPIRED" } });
  await assert.rejects(() => expired.eid.token.authVerify("c1", TOK_A.cert.raw, new Uint8Array(64)), (e: unknown) => e instanceof ApiError && e.code === "CHALLENGE_EXPIRED");
});

// ── 5. validator ──

test("validator — allowedIssuerSkis", () => {
  const { result, acsp } = signedAuth(AUTH.key, AUTH.cert);
  const rootSki = execFileSync("openssl", ["x509", "-in", f("root.pem"), "-noout", "-ext", "subjectKeyIdentifier"]).toString().split("\n")[1]!.trim();
  trusted({ allowedIssuerSkis: [rootSki] }).validateAuth(result, acsp); // ":"-тэй, том үсэг
  assert.throws(() => trusted({ allowedIssuerSkis: [CITIZEN_ISSUING_CA_SKI] }).validateAuth(result, acsp), (e: unknown) => e instanceof ValidationError && /allowedIssuerSkis/.test(e.message));
  assert.throws(() => trusted({ allowedIssuerSkis: ["zz"] }));
  // CITIZEN_ISSUING_CA_SKI — бодит 04 (testdata-гүй репод: Go SDK testdata-тай тулгасан утга)
  assert.equal(CITIZEN_ISSUING_CA_SKI, "b8a37f2c64ad677912db7d9e34f246358a2fb909");
});

test("validator — checkKeyUsage: auth → clientAuth, sign → nonRepudiation", () => {
  const strict = trusted({ checkKeyUsage: true });
  const a = signedAuth(AUTH.key, AUTH.cert);
  strict.validateAuth(a.result, a.acsp);
  const wrong = signedAuth(SIGN.key, SIGN.cert);
  assert.throws(() => strict.validateAuth(wrong.result, wrong.acsp), (e: unknown) => e instanceof ValidationError && /clientAuth/.test(e.message));
  // checkKeyUsage=false ч EKU-г гинжийн шалгалт (auth → clientAuth) үргэлж шалгана (0.11.0-аас).
  assert.throws(() => trusted().validateAuth(wrong.result, wrong.acsp), (e: unknown) => e instanceof ValidationError && /ExtKeyUsage/.test(e.message));
  const s = signedDigest(SIGN.key, SIGN.cert);
  strict.validateSign(s.result, s.digest);
  const sAuth = signedDigest(AUTH.key, AUTH.cert);
  assert.throws(() => strict.validateSign(sAuth.result, sAuth.digest), (e: unknown) => e instanceof ValidationError && /nonRepudiation/.test(e.message));
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

// ── 0.11.0: хариуны хэмжээ, representations raw, токены PAdES (Go SDK 0.1.3-тэй ижил) ──

test("хариуны хэмжээ — JSON > 4 MiB, pdfMaxBytes → ResponseTooLargeError (таслахгүй)", async () => {
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

  const pdf = "x".repeat(2048);
  await assert.rejects(() => client({ body: pdf }, { pdfMaxBytes: 1024 }).eid.pdf.document("s"),
    (e: unknown) => e instanceof ResponseTooLargeError && e.limit === 1024);
  await assert.rejects(() => client({ body: pdf }, { pdfMaxBytes: 1024 }).eid.pdf.tokenDocument("s"), ResponseTooLargeError);
  assert.equal((await client({ body: pdf }, { pdfMaxBytes: 2048 }).eid.pdf.document("s")).length, 2048);
  assert.equal((await client({ body: pdf }).eid.pdf.document("s")).length, 2048); // анхдагч 64 MiB
});

test("getRepresentations — raw", async () => {
  const { eid } = client({ body: { personEtsi: "PNOMN-1", representations: [{ orgEtsi: "NTRMN-1" }], future: { x: 1 } } });
  const r = await eid.organization.getRepresentations("PNOMN-1");
  assert.equal(r.representations.length, 1);
  assert.deepEqual((r.raw as Record<string, unknown>).future, { x: 1 });
});

test("pdf.tokenPrepare / tokenFinalize / tokenDocument (USB токены PAdES)", async () => {
  const hashToSign = createHash("sha256").update("dtbs").digest();
  let form: FormData | undefined;
  const calls: { url: string; method: string; body?: string }[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    trust: { allowUntrusted: true },
    fetchImpl: async (url, init) => {
      const u = String(url);
      calls.push({ url: u, method: String(init?.method), body: typeof init?.body === "string" ? init.body : undefined });
      if (u.endsWith("/pdf/token/prepare")) {
        form = init?.body as FormData;
        return Response.json({ signingID: "11111111-1111-4111-8111-111111111111", docID: "d", hashToSign: hashToSign.toString("base64"),
          hashAlgorithm: "SHA-256", signatureAlgorithm: "ecdsa-with-SHA256", signatureFormat: "RAW_RS", expiresAt: "2026-10-14T12:10:00+08:00" });
      }
      if (u.endsWith("/finalize")) return Response.json({ docID: "d", documentStatus: "READY", outSha256: "00".repeat(32), size: 3 });
      if (u.endsWith("/document")) return new Response("PDF");
      return new Response("", { status: 404 });
    },
  });
  const cert = new Uint8Array(AUTH.cert.raw);
  const s = await eid.pdf.tokenPrepare({ pdf: new TextEncoder().encode("%PDF-1.7"), fileName: "гэрээ.pdf", signerEtsi: "PNOMN-12345678",
    certificate: cert, onBehalfOf: "NTRMN-1" });
  assert.equal(s.signingId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(Buffer.from(s.hashToSign), hashToSign);
  assert.equal(s.signatureFormat, "RAW_RS");
  const req = JSON.parse(await (form!.get("request") as Blob).text()) as Record<string, unknown>;
  assert.deepEqual(req, { relyingPartyUUID: CREDS.rpUUID, relyingPartyName: CREDS.rpName, signer: { etsi: "PNOMN-12345678" },
    certificate: Buffer.from(cert).toString("base64"), fileName: "гэрээ.pdf", onBehalfOf: "NTRMN-1" });
  assert.equal(await (form!.get("pdf") as Blob).text(), "%PDF-1.7");

  const sig = new Uint8Array(64).fill(7);
  const blk = await eid.pdf.tokenFinalize(s.signingId, sig);
  assert.equal(blk.documentStatus, "READY");
  const fin = calls.at(-1)!;
  assert.match(fin.url, /\/pdf\/token\/11111111-1111-4111-8111-111111111111\/finalize$/);
  assert.deepEqual(JSON.parse(fin.body!), { signature: Buffer.from(sig).toString("base64") });
  await assert.rejects(() => eid.pdf.tokenFinalize(s.signingId, sig.subarray(0, 63)), /64 байт/);
  assert.equal(new TextDecoder().decode(await eid.pdf.tokenDocument(s.signingId)), "PDF");
  await assert.rejects(() => eid.pdf.tokenPrepare({ pdf: new Uint8Array([1]), fileName: "", signerEtsi: "", certificate: new Uint8Array() }));
  const bad = client({ body: { signingID: "x", hashToSign: "AAAA" } });
  await assert.rejects(() => bad.eid.pdf.tokenPrepare({ pdf: new Uint8Array([1]), fileName: "a.pdf", signerEtsi: "PNOMN-1", certificate: new Uint8Array([1]) }),
    (e: unknown) => e instanceof ValidationError && /hashToSign/.test(e.message));
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
