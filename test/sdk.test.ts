// SDK цөмийн тест. node --test (TS strip). Крипто round-trip, payload байт, mapping, error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

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
} from "../dist/index.js";

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
