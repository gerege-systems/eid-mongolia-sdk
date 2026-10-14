// Клиент талын PAdES-ийн backend тал: signPdfDigest (DTBS-д sign session) ба registerSignature (POST /pdf/signatures).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { EidClient, ValidationError, ApiError, buildDeviceLink } from "../dist/index.js";

const CREDS = { rpUUID: "rp-uuid", rpName: "Гэрээний систем", apiSecret: "rp_sk_x" };
const DTBS = createHash("sha256").update("signedAttrs").digest();

function client(respond: (url: string) => { status?: number; body: unknown }) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method), body: JSON.parse(String(init?.body ?? "{}")) });
      const r = respond(String(url));
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    },
  });
  return { eid, calls };
}

test("signPdfDigest — push: RAW_DIGEST_SIGNATURE, sha256WithRSAEncryption, displayText = fileName, onBehalfOf", async () => {
  const { eid, calls } = client(() => ({ body: { sessionID: "s1", vc: { type: "alphaNumeric5", value: "48210" } } }));
  const s = await eid.signPdfDigest({
    dtbs: DTBS, fileName: " Гэрээ №12.pdf ", signer: { etsi: "PNOMN-12345678" }, onBehalfOf: " NTRMN-6235972 ",
  });
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/signature/notification/etsi/PNOMN-12345678");
  const ix = Buffer.from(String(calls[0]!.body.interactions), "base64").toString("utf8");
  assert.deepEqual(JSON.parse(ix), [{ type: "displayTextAndPIN", displayText60: "Баримтад гарын үсэг зурах: Гэрээ №12.pdf" }]);
  assert.deepEqual(calls[0]!.body, {
    relyingPartyUUID: "rp-uuid", relyingPartyName: "Гэрээний систем", certificateLevel: "QUALIFIED",
    signatureProtocol: "RAW_DIGEST_SIGNATURE",
    signatureProtocolParameters: {
      digest: DTBS.toString("base64"), signatureAlgorithm: "sha256WithRSAEncryption",
      signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" },
    },
    interactions: calls[0]!.body.interactions,
    fileName: "Гэрээ №12.pdf",
    onBehalfOf: "NTRMN-6235972",
  });
  assert.equal(s.sessionId, "s1");
  assert.equal(s.vc, "48210");
  assert.equal(s.digest, DTBS.toString("base64"));
  assert.equal(s.interactions, calls[0]!.body.interactions);
  assert.equal(s.deviceLink, null);
  assert.ok(s.receivedAt > 0);
});

test("signPdfDigest — device-link documentNumber: нууц буцаана, buildDeviceLink-д ЯГ ХЭВЭЭР", async () => {
  const secret = Buffer.alloc(32, 1).toString("base64");
  const { eid, calls } = client(() => ({
    body: { sessionID: "s2", sessionToken: "tok_1", sessionSecret: secret, deviceLinkBase: "https://ca.eidmongolia.mn/dl", vc: "12345" },
  }));
  const s = await eid.sign.pdfDigest({
    dtbs: DTBS.toString("base64"), fileName: "a".repeat(120), signer: { documentNumber: "PNOMN-1-ABC" }, flow: "device-link",
    initialCallbackUrl: "https://bank.mn/auth/eid/callback",
  });
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/signature/device-link/document/PNOMN-1-ABC");
  assert.equal(calls[0]!.body.initialCallbackUrl, "https://bank.mn/auth/eid/callback");
  const ix = JSON.parse(Buffer.from(String(calls[0]!.body.interactions), "base64").toString("utf8"));
  assert.equal(Array.from(ix[0].displayText60 as string).length, 60);
  assert.equal(s.vc, "12345");
  assert.deepEqual(s.deviceLink, { sessionToken: "tok_1", sessionSecret: secret, deviceLinkBase: "https://ca.eidmongolia.mn/dl" });
  const link = buildDeviceLink({
    deviceLinkBase: s.deviceLink!.deviceLinkBase, deviceLinkType: "QR", sessionToken: s.deviceLink!.sessionToken,
    sessionSecret: s.deviceLink!.sessionSecret, sessionType: "sign", lang: "mon", receivedAt: s.receivedAt, now: s.receivedAt,
    digest: s.digest, relyingPartyName: CREDS.rpName, interactions: s.interactions,
  });
  assert.match(link, /sessionType=sign/);
  const missing = client(() => ({ body: { sessionID: "s3", vc: "1" } }));
  await assert.rejects(() => missing.eid.signPdfDigest({ dtbs: DTBS, fileName: "a.pdf", signer: { etsi: "PNOMN-1" }, flow: "device-link" }), ValidationError);
});

test("signPdfDigest — оролтын шалгалт (dtbs 32 байт, fileName, signer яг нэг)", async () => {
  const { eid, calls } = client(() => ({ body: {} }));
  const ok = { dtbs: DTBS, fileName: "a.pdf", signer: { etsi: "PNOMN-1" } };
  for (const bad of [
    { ...ok, dtbs: DTBS.subarray(0, 31) },
    { ...ok, dtbs: "not base64!" },
    { ...ok, dtbs: Buffer.alloc(48).toString("base64") },
    { ...ok, fileName: "  " },
    { ...ok, fileName: "я".repeat(121) },
    { ...ok, signer: {} },
    { ...ok, signer: { etsi: "PNOMN-1", documentNumber: "d" } },
  ]) {
    await assert.rejects(() => eid.signPdfDigest(bad as never), ValidationError);
  }
  assert.equal(calls.length, 0);
});

test("registerSignature — POST /pdf/signatures бие ба хариу; алдааны код", async () => {
  const docID = "11111111-1111-4111-8111-111111111111";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const { eid, calls } = client(() => ({ status: 201, body: { docID, revIndex: 1, verifyUrl: `https://ca.eidmongolia.mn/verify/${docID}` } }));
  const cms = new Uint8Array([0x30, 0x82, 0x01]);
  const r = await eid.registerSignature({
    docID, sessionId: "s1", cms, outSha256: sha("out").toUpperCase(), inSha256: sha("in"), fileName: " Гэрээ.pdf ",
    hasPage: true, pageSha256: sha("page"), onBehalfOf: "NTRMN-6235972", revIndex: 1, sigRevSha256: sha("rev"),
  });
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/pdf/signatures");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, {
    docID, sessionID: "s1", cms: Buffer.from(cms).toString("base64"), medium: "phone", revIndex: 1, outSha256: sha("out"),
    sigRevSha256: sha("rev"), inSha256: sha("in"), fileName: "Гэрээ.pdf", hasPage: true, pageSha256: sha("page"),
    onBehalfOf: "NTRMN-6235972",
  });
  assert.equal(r.revIndex, 1);
  assert.equal(r.verifyUrl, `https://ca.eidmongolia.mn/verify/${docID}`);

  // токен (sessionId-гүй) 2 дахь гарын үсэг
  await eid.registerSignature({ docID, cms, outSha256: sha("o2"), sigRevSha256: sha("r2"), fileName: "a.pdf", hasPage: false,
    revIndex: 2, priorCmsSha256: [sha("c1")] });
  assert.equal(calls[1]!.body.medium, "token");
  assert.deepEqual(calls[1]!.body.priorCmsSha256, [sha("c1")]);
  assert.equal("sessionID" in calls[1]!.body, false);

  const base = { docID, cms, outSha256: sha("out"), sigRevSha256: sha("rev"), fileName: "a.pdf", hasPage: false, revIndex: 1 };
  for (const bad of [{ ...base, docID: "x" }, { ...base, cms: new Uint8Array() }, { ...base, outSha256: "00" },
    { ...base, hasPage: true }, { ...base, fileName: "" }, { ...base, revIndex: 0 }, { ...base, revIndex: 2 },
    { ...base, sigRevSha256: "" }, { ...base, medium: "phone" as const }]) {
    await assert.rejects(() => eid.registerSignature(bad), ValidationError);
  }
  const conflict = client(() => ({ status: 409, body: { error: "x", code: "CLAIMED_ROLE_MISMATCH" } }));
  await assert.rejects(() => conflict.eid.registerSignature(base), (e: unknown) => e instanceof ApiError && e.code === "CLAIMED_ROLE_MISMATCH");
});

test("getRepresentations — claimedRole дамжина", async () => {
  const { eid } = client(() => ({ body: { personEtsi: "PNOMN-1", representations: [
    { orgEtsi: "NTRMN-6235972", claimedRole: "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)" }] } }));
  const r = await eid.organization.getRepresentations("PNOMN-1");
  assert.equal(r.representations[0]!.claimedRole, "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)");
});
