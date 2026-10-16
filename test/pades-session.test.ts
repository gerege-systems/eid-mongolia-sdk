// Клиент талын PAdES-ийн backend тал: signPdfDigest (DTBS-д sign session) ба registerSignature (POST /pdf/signatures).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  EidClient,
  ValidationError,
  ApiError,
  PDF_REGISTER_ERROR_CODES,
  type PdfRegisterErrorCode,
  buildDeviceLink,
  buildRegisterBody,
  registrationFromCompleted,
  PDF_SIGNATURE_REGISTER_FIELDS,
} from "../dist/index.js";

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

// CA dto.PDFSignatureRegisterRequest (server/internal/dto/pdf.go, main d948fdd4) — JSON tag ба omitempty. CA нь
// DisallowUnknownFields: SDK-ийн бие эдгээрээс өөр түлхүүргүй, omitempty-гүй талбар бүр заавал байна.
const CA_DTO_TAGS = {
  docID: "required", revIndex: "required", medium: "required", sessionID: "omitempty", cms: "required", fileName: "required",
  inSha256: "required", pageSha256: "omitempty", sigRevSha256: "required", outSha256: "required",
  priorCmsSha256: "omitempty", priorRevisionSha256: "omitempty", onBehalfOf: "omitempty", signerEtsi: "omitempty",
} as const;

test("registerSignature — бие нь CA DTO-ийн JSON tag-тай яг таарна (hasPage үгүй)", () => {
  assert.deepEqual([...PDF_SIGNATURE_REGISTER_FIELDS].sort(), Object.keys(CA_DTO_TAGS).sort());
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const full = buildRegisterBody({
    docID: "11111111-1111-4111-8111-111111111111", revIndex: 3, medium: "phone", sessionID: "s", cms: new Uint8Array([0x30, 0]),
    fileName: "a.pdf", inSha256: sha("i"), pageSha256: sha("p"), sigRevSha256: sha("r"), outSha256: sha("o"),
    priorCmsSha256: [sha("c")], priorRevisionSha256: [sha("v")], onBehalfOf: "NTRMN-1", signerEtsi: "PNOMN-1",
  });
  assert.deepEqual(Object.keys(full), Object.keys(CA_DTO_TAGS), "талбар бүр, DTO-ийн дарааллаар");
  const min = buildRegisterBody({ docID: "11111111-1111-4111-8111-111111111111", revIndex: 1, cms: "MAA=", fileName: "a.pdf",
    inSha256: sha("i"), pageSha256: sha("p"), sigRevSha256: sha("r"), outSha256: sha("o") });
  for (const [k, v] of Object.entries(CA_DTO_TAGS)) {
    if (v === "required") assert.ok(k in min, `${k} заавал`);
  }
  assert.ok(!("hasPage" in min) && !("hasPage" in full));
});

test("registrationFromCompleted — complete()-ийн үр дүнгээс", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const done = { docId: "11111111-1111-4111-8111-111111111111", revIndex: 1, cms: new Uint8Array([0x30, 0]), inSha256: sha("i"),
    hasPage: true, pageSha256: sha("p"), sigRevSha256: sha("r"), outSha256: sha("o"), priorCmsSha256: [] as string[] };
  const inp = registrationFromCompleted(done, { fileName: "a.pdf", sessionID: "s1", onBehalfOf: "NTRMN-1" });
  assert.deepEqual(buildRegisterBody(inp), {
    docID: done.docId, revIndex: 1, medium: "phone", sessionID: "s1", cms: "MAA=", fileName: "a.pdf", inSha256: sha("i"),
    pageSha256: sha("p"), sigRevSha256: sha("r"), outSha256: sha("o"), onBehalfOf: "NTRMN-1",
  });
  const second = registrationFromCompleted({ ...done, revIndex: 2, hasPage: false, pageSha256: "", priorCmsSha256: [sha("c")] },
    { fileName: "a.pdf", signerEtsi: "PNOMN-1" });
  const b = buildRegisterBody(second);
  assert.equal(b.medium, "token");
  assert.equal("pageSha256" in b, false);
  assert.deepEqual(b.priorCmsSha256, [sha("c")]);
  assert.equal(b.signerEtsi, "PNOMN-1");
});

test("registerSignature — POST /pdf/signatures бие ба хариу; алдааны код", async () => {
  const docID = "11111111-1111-4111-8111-111111111111";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const { eid, calls } = client(() => ({
    status: 201,
    body: { docID, revIndex: 1, registeredAt: "2026-10-14T12:00:00+08:00", verifyUrl: `https://ca.eidmongolia.mn/verify/${docID}` },
  }));
  const cms = new Uint8Array([0x30, 0x82, 0x01]);
  const r = await eid.registerSignature({
    docID, sessionID: "s1", cms, outSha256: sha("out").toUpperCase(), inSha256: sha("in"), fileName: " Гэрээ.pdf ",
    pageSha256: sha("page"), onBehalfOf: "NTRMN-6235972", revIndex: 1, sigRevSha256: sha("rev"),
  });
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/pdf/signatures");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, {
    docID, revIndex: 1, medium: "phone", sessionID: "s1", cms: Buffer.from(cms).toString("base64"), fileName: "Гэрээ.pdf",
    inSha256: sha("in"), pageSha256: sha("page"), sigRevSha256: sha("rev"), outSha256: sha("out"), onBehalfOf: "NTRMN-6235972",
  });
  assert.equal(r.revIndex, 1);
  assert.equal(r.registeredAt, "2026-10-14T12:00:00+08:00");
  assert.equal(r.verifyUrl, `https://ca.eidmongolia.mn/verify/${docID}`);
  assert.equal(r.created, true);

  // токен (sessionID-гүй) 2 дахь гарын үсэг
  await eid.registerSignature({ docID, cms, outSha256: sha("o2"), sigRevSha256: sha("r2"), inSha256: sha("i2"), fileName: "a.pdf",
    revIndex: 2, priorCmsSha256: [sha("c1")] });
  assert.equal(calls[1]!.body.medium, "token");
  assert.deepEqual(calls[1]!.body.priorCmsSha256, [sha("c1")]);
  assert.equal("sessionID" in calls[1]!.body, false);

  const base = { docID, cms, outSha256: sha("out"), sigRevSha256: sha("rev"), inSha256: sha("in"), pageSha256: sha("p"),
    fileName: "a.pdf", revIndex: 1 };
  for (const bad of [{ ...base, docID: "x" }, { ...base, cms: new Uint8Array() }, { ...base, cms: new Uint8Array(28_673) },
    { ...base, outSha256: "00" }, { ...base, inSha256: "" }, { ...base, pageSha256: undefined }, { ...base, fileName: "" },
    { ...base, revIndex: 0 }, { ...base, revIndex: 2 }, { ...base, sigRevSha256: "" }, { ...base, medium: "phone" as const },
    { ...base, cms: "not base64!" }]) {
    await assert.rejects(() => eid.registerSignature(bad), ValidationError);
  }
  const conflict = client(() => ({ status: 409, body: { error: "x", code: "CLAIMED_ROLE_MISMATCH" } }));
  await assert.rejects(() => conflict.eid.registerSignature(base), (e: unknown) => e instanceof ApiError && e.code === "CLAIMED_ROLE_MISMATCH");
});

test("PDF_REGISTER_ERROR_CODES — CA pades_register.go-ийн кодууд, давхардалгүй; ApiError.code-оор салаална", async () => {
  // CA main (2026-10-16) POST /pdf/signatures-ийн бүх тогтвортой code. Go SDK: eid.PDFRegisterErrorCodes (ижил дараалал).
  const want: PdfRegisterErrorCode[] = ["REQUEST_INVALID", "REQUEST_TOO_LARGE", "CMS_INVALID", "SIGNATURE_INVALID",
    "TIMESTAMP_INVALID", "SIGNER_MISMATCH", "SIGNER_CERT_INVALID", "TOKEN_CERT_INVALID", "TOKEN_ORG_MISMATCH",
    "SESSION_MISMATCH", "SESSION_NOT_COMPLETE", "SESSION_FAILED", "CLAIMED_ROLE_MISMATCH", "REPRESENTATION_REVOKED",
    "DOC_ID_CONFLICT", "REGISTRY_CONFLICT", "DOC_NOT_FOUND", "PRIOR_MISMATCH", "RATE_LIMITED", "STATE_UNAVAILABLE"];
  assert.deepEqual([...PDF_REGISTER_ERROR_CODES], want);
  assert.equal(new Set(PDF_REGISTER_ERROR_CODES).size, PDF_REGISTER_ERROR_CODES.length);
  const docID = "11111111-1111-4111-8111-111111111111";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const { eid } = client(() => ({ status: 404, body: { error: "x", code: "DOC_NOT_FOUND" } }));
  await assert.rejects(
    () => eid.registerSignature({ docID, sessionID: "s1", cms: new Uint8Array([0x30, 1]), outSha256: sha("o"), sigRevSha256: sha("r"),
      inSha256: sha("i"), pageSha256: sha("p"), fileName: "a.pdf", revIndex: 1 }),
    (e: unknown) => e instanceof ApiError && (PDF_REGISTER_ERROR_CODES as readonly string[]).includes(e.code!) && e.code === "DOC_NOT_FOUND",
  );
});

test("registerSignature — 200 давталт: created false", async () => {
  const docID = "11111111-1111-4111-8111-111111111111";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const { eid } = client(() => ({ status: 200, body: { docID, revIndex: 1, registeredAt: "x", verifyUrl: "v" } }));
  const r = await eid.registerSignature({ docID, sessionID: "s1", cms: new Uint8Array([0x30, 1]), outSha256: sha("o"),
    inSha256: sha("i"), fileName: "a.pdf", pageSha256: sha("p"), revIndex: 1, sigRevSha256: sha("r") });
  assert.equal(r.created, false);
});

test("registerSignature — горим A-ийн өмнөх мөр: PRIOR_MISMATCH → revision-оор тааруулна (priorSignatures)", async () => {
  const docID = "11111111-1111-4111-8111-111111111111";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const done = { docId: docID, revIndex: 3, cms: new Uint8Array([0x30, 1]), inSha256: sha("i"), hasPage: false, pageSha256: "",
    sigRevSha256: sha("r"), outSha256: sha("o"), priorCmsSha256: [sha("c1"), sha("c2")], priorRevisionSha256: [sha("v1"), sha("v2")] };
  const reg = registrationFromCompleted(done, { fileName: "a.pdf", sessionID: "s1" });
  assert.deepEqual(reg.priorSignatures, [{ cmsSha256: sha("c1"), revisionSha256: sha("v1") }, { cmsSha256: sha("c2"), revisionSha256: sha("v2") }]);
  assert.equal("priorSignatures" in buildRegisterBody(reg), false, "CA руу илгээхгүй");

  // CA: эхний мөр горим A (revision v1), хоёр дахь нь клиент (CMS c2).
  const want = JSON.stringify({ cms: [sha("c2")], rev: [sha("v1")] });
  const { eid, calls } = client(() => {
    const b = calls[calls.length - 1]!.body;
    const got = JSON.stringify({ cms: b.priorCmsSha256 ?? [], rev: b.priorRevisionSha256 ?? [] });
    return got === want
      ? { status: 201, body: { docID, revIndex: 3, registeredAt: "x", verifyUrl: "v" } }
      : { status: 409, body: { error: "x", code: "PRIOR_MISMATCH" } };
  });
  const r = await eid.registerSignature(reg);
  assert.equal(r.created, true);
  assert.equal(calls.length, 2, "бүгд CMS → эхний 1 revision");
  assert.deepEqual(calls[0]!.body.priorCmsSha256, [sha("c1"), sha("c2")]);

  // Хоёр дахь нь горим A (эхний k-д үгүй) — n ≤ 4 тул бүх хослол.
  calls.length = 0;
  const want2 = JSON.stringify({ cms: [sha("c1")], rev: [sha("v2")] });
  const c2 = client(() => {
    const b = c2.calls[c2.calls.length - 1]!.body;
    const got = JSON.stringify({ cms: b.priorCmsSha256 ?? [], rev: b.priorRevisionSha256 ?? [] });
    return got === want2
      ? { status: 200, body: { docID, revIndex: 3, registeredAt: "x", verifyUrl: "v" } }
      : { status: 409, body: { error: "x", code: "PRIOR_MISMATCH" } };
  });
  assert.equal((await c2.eid.registerSignature(reg)).created, false);
  assert.equal(c2.calls.length, 4, "бүгд CMS, эхний 1, эхний 2, дараа нь {2}");

  // Хэзээ ч таарахгүй → анхны PRIOR_MISMATCH; өөр алдаа → шууд.
  const never = client(() => ({ status: 409, body: { error: "x", code: "PRIOR_MISMATCH" } }));
  await assert.rejects(() => never.eid.registerSignature(reg), (e: unknown) => e instanceof ApiError && e.code === "PRIOR_MISMATCH");
  assert.equal(never.calls.length, 4);
  const other = client(() => ({ status: 409, body: { error: "x", code: "REGISTRY_CONFLICT" } }));
  await assert.rejects(() => other.eid.registerSignature(reg), (e: unknown) => e instanceof ApiError && e.code === "REGISTRY_CONFLICT");
  assert.equal(other.calls.length, 1);

  // Дуудагч гараар ангилсан (priorRevisionSha256) → оролдохгүй.
  const manual = registrationFromCompleted({ ...done, revIndex: 2, priorCmsSha256: [], priorRevisionSha256: [sha("v1")] },
    { fileName: "a.pdf", sessionID: "s1", priorRevisionSha256: [sha("v1")] });
  assert.equal(manual.priorSignatures, undefined);
  const once = client(() => ({ status: 409, body: { error: "x", code: "PRIOR_MISMATCH" } }));
  await assert.rejects(() => once.eid.registerSignature(manual), ApiError);
  assert.equal(once.calls.length, 1);
});

test("getRepresentations — claimedRole дамжина", async () => {
  const { eid } = client(() => ({ body: { personEtsi: "PNOMN-1", representations: [
    { orgEtsi: "NTRMN-6235972", claimedRole: "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)" }] } }));
  const r = await eid.organization.getRepresentations("PNOMN-1");
  assert.equal(r.representations[0]!.claimedRole, "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)");
});
