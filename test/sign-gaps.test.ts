// Sign session-ий дутуу хэсгүүд (client-side PAdES) — Go SDK feat/sign-session-gaps-тэй ижил.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, sign as cryptoSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SIGN_SESSION_TTL_MS,
  DeviceLinkError,
  EidClient,
  ResponseValidator,
  SessionFailedError,
  ValidationError,
  buildDeviceLink,
  deviceLinkInput,
  parseSessionResult,
  sessionExpiry,
  sha256Base64,
} from "../dist/index.js";

const CREDS = { rpUUID: "rp-uuid", rpName: "Гэрээний систем", apiSecret: "rp_sk_secret" };
const DL_REPLY = {
  sessionID: "0b8f3f0e-1111-4222-8333-444455556666",
  sessionToken: "tok_abc-123",
  sessionSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTMyYg==",
  deviceLinkBase: "https://ca.eidmongolia.mn/dl",
  vc: "12345",
};
const NOTIF_REPLY = { sessionID: "s-1", vc: { type: "alphaNumeric5", value: "54321" } };

function client(extra: Record<string, unknown> = {}) {
  const calls: { url: string; body: Record<string, any> }[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    trust: { allowUntrusted: true },
    ...extra,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      const body = String(url).includes("device-link") ? DL_REPLY : NOTIF_REPLY;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  return { eid, calls, last: () => calls[calls.length - 1]! };
}
const path = (u: string) => new URL(u).pathname;

/** openssl-ээр түр self-signed cert (keyUsage тодорхой). */
function mkCert(keyArgs: string[], ku: string) {
  const dir = mkdtempSync(join(tmpdir(), "eid-sg-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", ...keyArgs, "-nodes", "-days", "2", "-utf8", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      "-subj", "/C=MN/SN=Бат/GN=Болд/serialNumber=PNOMN-12345678/CN=БОЛД Бат", "-addext", `keyUsage=${ku}`,
      "-addext", "1.3.6.1.5.5.7.1.3=DER:30:0a:30:08:06:06:04:00:8e:46:01:01", // qcStatements QcCompliance → QUALIFIED
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: new X509Certificate(readFileSync(join(dir, "c.pem"))) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const RSA = mkCert(["-newkey", "rsa:2048"], "nonRepudiation");
const EC = mkCert(["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256"], "nonRepudiation");
const AUTH_ONLY = mkCert(["-newkey", "rsa:2048"], "digitalSignature");

const V = new ResponseValidator({ allowUntrusted: true });

test("sign device-link — etsi/document зам, body, sign контекст, expiresAt, deviceLinkInput", async () => {
  const { eid, last } = client();
  const digest = sha256Base64("гэрээ");
  const ix = [{ type: "displayTextAndPIN" as const, displayText60: "Гэрээнд гарын үсэг зурах" }];
  const before = Date.now();
  const s = await eid.sign.deviceLinkByEtsi("PNOMN-12345678", digest, ix, {
    callbackUrl: " https://rp.example.mn/cb ", fileName: "Гэрээ.pdf", onBehalfOf: "NTRMN-6235972", signatureAlgorithm: "sha256WithRSAEncryption",
  });
  const c = last();
  assert.equal(path(c.url), "/signature/device-link/etsi/PNOMN-12345678");
  assert.equal(c.body.initialCallbackUrl, "https://rp.example.mn/cb");
  assert.equal(c.body.fileName, "Гэрээ.pdf");
  assert.equal(c.body.onBehalfOf, "NTRMN-6235972");
  assert.equal(c.body.signatureProtocol, "RAW_DIGEST_SIGNATURE");
  assert.deepEqual(c.body.signatureProtocolParameters, {
    digest, signatureAlgorithm: "sha256WithRSAEncryption", signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" },
  });
  assert.equal(s.sessionType, "sign");
  assert.equal(s.vc, "12345");
  assert.equal(s.sign?.digest, digest);
  assert.equal(s.sign?.interactions, c.body.interactions);
  assert.equal(s.sign?.relyingPartyName, CREDS.rpName);
  assert.ok(s.expiresAt! >= before + DEFAULT_SIGN_SESSION_TTL_MS && s.expiresAt! <= Date.now() + DEFAULT_SIGN_SESSION_TTL_MS);
  for (const t of ["QR", "Web2App", "App2App"] as const) {
    const l = buildDeviceLink(deviceLinkInput(s, t, "mon"));
    assert.match(l, /sessionType=sign/);
    assert.match(l, new RegExp(`deviceLinkType=${t}`));
  }
  // гараар угсарсантай байт-ижил
  const manual = buildDeviceLink({
    deviceLinkBase: DL_REPLY.deviceLinkBase, deviceLinkType: "Web2App", sessionToken: DL_REPLY.sessionToken,
    sessionSecret: DL_REPLY.sessionSecret, sessionType: "sign", lang: "mon", digest, relyingPartyName: CREDS.rpName,
    interactions: s.sign!.interactions, initialCallbackUrl: "https://rp.example.mn/cb",
  });
  assert.equal(buildDeviceLink(deviceLinkInput(s, "Web2App", "mon")), manual);

  await eid.sign.deviceLinkByDocument("PNOMN-12345678-MOCK-Q", digest, ix);
  assert.equal(path(last().url), "/signature/device-link/document/PNOMN-12345678-MOCK-Q");
  assert.equal(last().body.initialCallbackUrl, undefined);
  assert.equal(last().body.signatureProtocolParameters.signatureAlgorithm, "rsassa-pss", "хуучин анхдагч хэвээр");
});

test("expiresAt — push sign, signSessionTtlMs, sessionExpiry", async () => {
  const { eid } = client({ signSessionTtlMs: 90_000 });
  const before = Date.now();
  const s = await eid.sign.digestByEtsi("PNOMN-1", sha256Base64("x"), []);
  assert.ok(s.expiresAt! >= before + 90_000 && s.expiresAt! <= Date.now() + 90_000);
  assert.equal(s.sign?.signatureAlgorithm, "rsassa-pss");
  assert.equal(sessionExpiry(0), 600_000);
  assert.equal(sessionExpiry(1000, 5000), 6000);
});

test("certificate-choice — etsi push / device-link (зөвхөн QR), body талбарууд", async () => {
  const { eid, last } = client();
  const s = await eid.sign.certificateChoiceByEtsi("PNOMN-12345678");
  assert.equal(path(last().url), "/signature/certificate-choice/notification/etsi/PNOMN-12345678");
  assert.deepEqual(Object.keys(last().body).sort(), ["certificateLevel", "relyingPartyName", "relyingPartyUUID"]);
  assert.equal(s.sessionId, "s-1");
  assert.equal(s.vc, "54321");
  assert.equal(s.sign, undefined);
  assert.ok(s.expiresAt);
  const d = await eid.sign.certificateChoiceDeviceLink({ certificateLevel: "QSCD" });
  assert.equal(path(last().url), "/signature/certificate-choice/device-link/anonymous");
  assert.equal(last().body.certificateLevel, "QSCD");
  assert.equal(d.sessionType, "cert");
  assert.match(buildDeviceLink(deviceLinkInput(d, "QR", "eng")), /sessionType=cert/);
  assert.throws(() => buildDeviceLink(deviceLinkInput(d, "Web2App", "eng")), DeviceLinkError);
});

const ccResult = (cert: X509Certificate, extra: Record<string, unknown> = {}) =>
  parseSessionResult({
    state: "COMPLETE", result: { endResult: "OK", documentNumber: "PNOMN-12345678-ABCD-Q" },
    cert: { value: cert.raw.toString("base64"), certificateLevel: "QUALIFIED" }, ...extra,
  });

test("validateCertificateChoice — Signer; амжилтгүй/дутуу/итгэлгүй/зориулалт буруу", () => {
  const sg = V.validateCertificateChoice(ccResult(RSA.cert), "cc-1");
  assert.equal(sg.documentNumber, "PNOMN-12345678-ABCD-Q");
  assert.equal(sg.certChoiceSessionId, "cc-1");
  assert.equal(sg.parsedSubject.serialNumber, "PNOMN-12345678");
  assert.equal(sg.certificateDerB64, RSA.cert.raw.toString("base64"));
  assert.throws(
    () => V.validateCertificateChoice(ccResult(RSA.cert, { result: { endResult: "USER_REFUSED_CERT_CHOICE" } })),
    (e: unknown) => e instanceof SessionFailedError,
  );
  assert.throws(() => V.validateCertificateChoice(ccResult(RSA.cert, { result: { endResult: "OK" } })), /documentNumber алга/);
  assert.throws(() => new ResponseValidator({}).validateCertificateChoice(ccResult(RSA.cert)), /Trust anchor/);
  const ku = new ResponseValidator({ allowUntrusted: true, checkKeyUsage: true });
  assert.equal(ku.validateCertificateChoice(ccResult(RSA.cert)).documentNumber, "PNOMN-12345678-ABCD-Q");
  assert.throws(() => ku.validateCertificateChoice(ccResult(AUTH_ONLY.cert)), /contentCommitment/);
});

test("digestForSigner / deviceLinkForSigner — documentNumber-аар, linked, sha256WithRSAEncryption, буруу оролт", async () => {
  const { eid, calls, last } = client();
  const dtbs = createHash("sha256").update("signedAttrs").digest("base64");
  const signer = { documentNumber: "PNOMN-12345678-ABCD-Q", certChoiceSessionId: "cc-1" };
  const s = await eid.sign.digestForSigner(signer, dtbs, [], { fileName: "a.pdf" });
  assert.equal(path(last().url), "/signature/notification/linked/PNOMN-12345678-ABCD-Q");
  assert.equal(last().body.linkedSessionID, "cc-1");
  assert.equal(last().body.signatureProtocolParameters.signatureAlgorithm, "sha256WithRSAEncryption");
  assert.equal(s.sign?.signatureAlgorithm, "sha256WithRSAEncryption");
  assert.equal(s.sign?.hashAlgorithm, "SHA-256");

  await eid.sign.digestForSigner({ documentNumber: "DOC-1" }, dtbs, []);
  assert.equal(path(last().url), "/signature/notification/document/DOC-1");
  assert.equal(last().body.linkedSessionID, undefined);

  const dl = await eid.sign.deviceLinkForSigner(signer, dtbs, [], { callbackUrl: "https://rp.example.mn/cb" });
  assert.equal(path(last().url), "/signature/device-link/document/PNOMN-12345678-ABCD-Q");
  assert.equal(last().body.linkedSessionID, undefined);
  assert.equal(dl.sessionType, "sign");

  const n = calls.length;
  for (const [sg, d, o] of [
    [{ documentNumber: "" }, dtbs, undefined],
    [signer, Buffer.alloc(48).toString("base64"), undefined],
    [signer, dtbs, { hashAlgorithm: "SHA-512" }],
    [signer, "not base64!", undefined],
  ] as const) {
    await assert.rejects(eid.sign.digestForSigner(sg, d, [], o as never));
  }
  assert.equal(calls.length, n, "буруу оролтод хүсэлт явав");
});

test("validateSign — expectedAlgorithm (PSS-ийг хүсээгүй бол татгалзана) ба expectedCertificate", () => {
  const data = Buffer.from("signedAttrs");
  const digest = createHash("sha256").update(data).digest("base64");
  const signed = (k: { key: string; cert: X509Certificate }, alg: string) => {
    const sig =
      alg === "rsassa-pss"
        ? cryptoSign("sha256", data, { key: k.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
        : alg === "ecdsa-with-SHA256"
          ? cryptoSign("sha256", data, { key: k.key, dsaEncoding: "der" })
          : cryptoSign("sha256", data, { key: k.key, padding: constants.RSA_PKCS1_PADDING });
    return ccResult(k.cert, {
      signatureProtocol: "RAW_DIGEST_SIGNATURE",
      signature: { value: sig.toString("base64"), signatureAlgorithm: alg, signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" } },
    });
  };
  const pkcs1 = { expectedAlgorithm: "sha256WithRSAEncryption" } as const;
  assert.equal(V.validateSign(signed(RSA, "sha256WithRSAEncryption"), digest, pkcs1).signatureAlgorithm, "sha256WithRSAEncryption");
  assert.throws(() => V.validateSign(signed(RSA, "rsassa-pss"), digest, pkcs1), (e: unknown) => e instanceof ValidationError && /≠ хүссэн sha256WithRSAEncryption/.test(e.message));
  assert.ok(V.validateSign(signed(RSA, "rsassa-pss"), digest, { expectedAlgorithm: "rsassa-pss" }));
  assert.throws(() => V.validateSign(signed(RSA, "sha256WithRSAEncryption"), digest, { expectedAlgorithm: "rsassa-pss" }), /≠ хүссэн rsassa-pss/);
  // хуучин threshold-ECDSA credential — EC гэрчилгээтэй үед л
  assert.ok(V.validateSign(signed(EC, "ecdsa-with-SHA256"), digest, pkcs1));
  // хуучин зан
  assert.ok(V.validateSign(signed(RSA, "rsassa-pss"), digest));
  // өөр гэрчилгээ (өөр утас)
  assert.throws(
    () => V.validateSign(signed(EC, "ecdsa-with-SHA256"), digest, { ...pkcs1, expectedCertificate: RSA.cert }),
    (e: unknown) => e instanceof ValidationError && /certificate-choice/.test(e.message),
  );
  assert.ok(V.validateSign(signed(RSA, "sha256WithRSAEncryption"), digest, { ...pkcs1, expectedCertificate: RSA.cert }));
});
