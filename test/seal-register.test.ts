// seal.registerSealedPdf (POST /seal/{orgEtsi}/registrations, CA V158 — ca-eidmongolia-mn main 70c0e09c, PR #78) ба
// seal.sealForDocument (POST /seal/{orgEtsi} + {docId, revIndex}). Go sealregister_test.go-ийн TS хувилбар.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ApiError,
  EidClient,
  ForbiddenError,
  SEAL_REGISTER_ERROR_CODES,
  SEAL_REGISTER_FIELDS,
  SEAL_REQUEST_FIELDS,
  SEAL_RESERVATION_FIELDS,
  ValidationError,
  buildSealRegisterBody,
  type SealRegisterInput,
} from "../dist/index.js";

const S = new URL("./fixtures/pades/seal/", import.meta.url);
const M = JSON.parse(readFileSync(new URL("manifest.json", S), "utf8")) as { dtbs: string; signature: string };
const SEAL = new Uint8Array(new X509Certificate(readFileSync(new URL("seal.pem", S))).raw);
const DTBS = new Uint8Array(Buffer.from(M.dtbs, "hex"));
const CREDS = { rpUUID: "rp-uuid", rpName: "Нэхэмжлэлийн систем", apiSecret: "rp_sk_x" };
const ORG = "NTRMN-6235972";
const DOC = "3f0c2a8e-6b1d-4c55-9a77-000000000002";
const h64 = (c: string) => c.repeat(64);

/** CA dto.SealRegisterRequest — JSON tag (DisallowUnknownFields). */
const CA_FIELDS = ["docID", "revIndex", "cms", "fileName", "inSha256", "sigRevSha256", "outSha256", "priorCmsSha256", "priorRevisionSha256"];
/** CA dto.SealRequest (V158). */
const CA_SEAL_FIELDS = ["relyingPartyUUID", "relyingPartyName", "digest", "hashType", "docId", "revIndex"];

const REGISTERED = { docID: DOC, revIndex: 1, registeredAt: "2026-11-25T12:00:00+08:00", verifyUrl: `https://ca.eidmongolia.mn/verify/${DOC}` };

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
function client(respond: (body: Record<string, unknown>, url: string) => Reply) {
  const calls: { url: string; method: string; auth: string; body: Record<string, unknown> }[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    fetchImpl: async (url, init) => {
      const h = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: String(init?.method), auth: String(h.get("authorization")), body });
      const r = respond(body, String(url));
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
    },
  });
  return { eid, calls };
}

const reg = (): SealRegisterInput => ({
  docID: DOC,
  revIndex: 1,
  cms: new Uint8Array([0x30, 1]),
  fileName: "Нэхэмжлэх.pdf",
  inSha256: h64("a"),
  sigRevSha256: h64("b"),
  outSha256: h64("c"),
});

test("registerSealedPdf — POST /seal/{orgEtsi}/registrations, CA dto.SealRegisterRequest; 201 created, 200 давталт", async () => {
  let status = 201;
  const { eid, calls } = client((body) => {
    for (const k of Object.keys(body)) if (!CA_FIELDS.includes(k)) return { status: 400, body: { error: k, code: "REQUEST_INVALID" } };
    return { status, body: REGISTERED };
  });
  const out = await eid.seal.registerSealedPdf(` ${ORG} `, reg());
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `https://rp.eidmongolia.mn/seal/${ORG}/registrations`);
  assert.equal(calls[0]!.auth, "Bearer rp_sk_x");
  assert.deepEqual(calls[0]!.body, { docID: DOC, revIndex: 1, cms: "MAE=", fileName: "Нэхэмжлэх.pdf", inSha256: h64("a"), sigRevSha256: h64("b"), outSha256: h64("c") });
  assert.deepEqual({ ...out, raw: undefined }, { ...REGISTERED, created: true, raw: undefined });
  status = 200;
  const again = await eid.seal.registerSealedPdf(ORG, { ...reg(), fileName: undefined, cms: "MAE=" });
  assert.equal(again.created, false);
  assert.equal("fileName" in calls[1]!.body, false, "fileName заавал биш");
  assert.deepEqual([...SEAL_REGISTER_FIELDS].sort(), [...CA_FIELDS].sort());
});

// CA TestRegisterSealWindowReservationDuplicate-ийн «Хэлбэр → 400 REQUEST_INVALID» векторууд + orgEtsi (orgEtsiRe).
test("registerSealedPdf — хэлбэрийн алдаа ValidationError, сүлжээнд гарахгүй (CA normalizeSealRegister)", async () => {
  const { eid, calls } = client(() => ({ status: 201, body: REGISTERED }));
  const bad: Record<string, Partial<SealRegisterInput>> = {
    docID: { docID: DOC.toUpperCase() },
    "revIndex 0": { revIndex: 0 },
    "revIndex 17": { revIndex: 17 },
    "prior тоо": { priorCmsSha256: [h64("d")] },
    "prior дутуу": { revIndex: 2 },
    "prior hex": { revIndex: 2, priorRevisionSha256: ["x"] },
    out: { outSha256: "x" },
    "in том үсэг": { inSha256: h64("A") },
    sigRev: { sigRevSha256: "" },
    fileName: { fileName: "а".repeat(121) },
    "cms хоосон": { cms: new Uint8Array() },
    "cms base64 биш": { cms: "!!" },
    "cms хэт том": { cms: new Uint8Array(28_673) },
  };
  for (const [name, mod] of Object.entries(bad)) {
    await assert.rejects(eid.seal.registerSealedPdf(ORG, { ...reg(), ...mod }), ValidationError, name);
  }
  for (const org of ["", "PNOMN-1", "NTRMN-", "NTRMN-ab_c"]) await assert.rejects(eid.seal.registerSealedPdf(org, reg()), ValidationError, org);
  assert.equal(calls.length, 0);
  // Хил: 120 тэмдэгт, 28 672 байт, prior CMS + revision холимог.
  const ok = buildSealRegisterBody({ ...reg(), fileName: "а".repeat(120), cms: new Uint8Array(28_672), revIndex: 3, priorCmsSha256: [h64("d")], priorRevisionSha256: [h64("e")] });
  assert.deepEqual(Object.keys(ok), ["docID", "revIndex", "cms", "fileName", "inSha256", "sigRevSha256", "outSha256", "priorCmsSha256", "priorRevisionSha256"]);
});

test("registerSealedPdf — SEAL_REGISTER_ERROR_CODES-ийн код бүр CA-ийн статусаар ApiError; 403 ForbiddenError; 501", async () => {
  const status: Record<string, number> = {
    REQUEST_TOO_LARGE: 413, REQUEST_INVALID: 400, RATE_LIMITED: 429, STATE_UNAVAILABLE: 503, CMS_INVALID: 400, SIGNER_MISMATCH: 409,
    SIGNER_CERT_INVALID: 409, SIGNATURE_INVALID: 400, SEAL_NOT_FOUND: 409, SEAL_DOC_MISMATCH: 409, TIMESTAMP_INVALID: 400,
    DOC_ID_RESERVED: 409, DOC_ID_CONFLICT: 409, PRIOR_MISMATCH: 409, REGISTRY_CONFLICT: 409,
  };
  assert.equal(Object.keys(status).length, SEAL_REGISTER_ERROR_CODES.length);
  for (const code of SEAL_REGISTER_ERROR_CODES) {
    const st = status[code]!;
    const retry = st === 429 || st === 503;
    const { eid } = client(() => ({ status: st, body: { error: "x", code }, headers: retry ? { "Retry-After": "600" } : undefined }));
    await assert.rejects(eid.seal.registerSealedPdf(ORG, reg()), (e: unknown) => {
      assert.ok(e instanceof ApiError, code);
      assert.equal(e.code, code);
      assert.equal(e.status, st);
      assert.equal(e.retryable, retry, `${code} retryable`);
      if (retry) assert.equal(e.retryAfterMs, 600_000);
      return true;
    });
  }
  const f = client(() => ({ status: 403, body: { error: "SEAL эрхгүй" } }));
  await assert.rejects(f.eid.seal.registerSealedPdf(ORG, reg()), ForbiddenError);
  const n = client(() => ({ status: 501, body: { error: "тамганы бүртгэл тохируулаагүй" } }));
  await assert.rejects(n.eid.seal.registerSealedPdf(ORG, reg()), (e: unknown) => e instanceof ApiError && e.status === 501);
});

test("SEAL_REGISTER_ERROR_CODES — CA memory.SealRegisterErrorCodes-тэй ижил дараалал (Go eid.SealRegisterErrorCodes)", () => {
  assert.deepEqual(
    [...SEAL_REGISTER_ERROR_CODES],
    ["REQUEST_TOO_LARGE", "REQUEST_INVALID", "RATE_LIMITED", "STATE_UNAVAILABLE", "CMS_INVALID", "SIGNER_MISMATCH", "SIGNER_CERT_INVALID",
      "SIGNATURE_INVALID", "SEAL_NOT_FOUND", "SEAL_DOC_MISMATCH", "TIMESTAMP_INVALID", "DOC_ID_RESERVED", "DOC_ID_CONFLICT", "PRIOR_MISMATCH",
      "REGISTRY_CONFLICT"],
  );
});

// CA-ийн гинжийн дүрэм (persistence.CheckChain) тамганд ч ижил: горим A-ийн өмнөх мөр → PRIOR_MISMATCH → хослолууд.
test("registerSealedPdf — 409 PRIOR_MISMATCH: priorSignatures-ээр registerSignature-тэй ижил хослолууд", async () => {
  const input: SealRegisterInput = {
    ...reg(),
    revIndex: 3,
    priorCmsSha256: [h64("1"), h64("2")],
    priorSignatures: [{ cmsSha256: h64("1"), revisionSha256: h64("3") }, { cmsSha256: h64("2"), revisionSha256: h64("4") }],
  };
  const tryWith = async (i: SealRegisterInput, wantCms: string, wantRev: string, code: string) => {
    const { eid, calls } = client((body) => {
      for (const k of Object.keys(body)) if (!CA_FIELDS.includes(k)) return { status: 400, body: { code: "REQUEST_INVALID" } };
      const cms = ((body.priorCmsSha256 as string[] | undefined) ?? []).join(",");
      const rev = ((body.priorRevisionSha256 as string[] | undefined) ?? []).join(",");
      return cms === wantCms && rev === wantRev ? { status: 201, body: REGISTERED } : { status: 409, body: { error: "x", code } };
    });
    try {
      return { out: await eid.seal.registerSealedPdf(ORG, i), n: calls.length, err: undefined as unknown };
    } catch (err) {
      return { out: undefined, n: calls.length, err };
    }
  };
  let r = await tryWith(input, h64("2"), h64("3"), "PRIOR_MISMATCH");
  assert.equal(r.out?.created, true);
  assert.equal(r.n, 2);
  r = await tryWith(input, "-", "-", "PRIOR_MISMATCH");
  assert.ok(r.err instanceof ApiError && r.err.code === "PRIOR_MISMATCH");
  assert.equal(r.n, 4);
  r = await tryWith(input, "-", "-", "SEAL_NOT_FOUND");
  assert.ok(r.err instanceof ApiError && r.err.code === "SEAL_NOT_FOUND");
  assert.equal(r.n, 1);
  r = await tryWith({ ...input, priorCmsSha256: [h64("2")], priorRevisionSha256: [h64("3")] }, "-", "-", "PRIOR_MISMATCH");
  assert.equal(r.n, 1, "гараар ангилсан бол оролдохгүй");
});

// CA TestSealReservationValidation-ийн векторууд: нөөц хоёулаа эсвэл аль нь ч үгүй, UUID жижиг, rev 1–16, зөвхөн SHA-256.
test("sealForDocument — POST /seal/{orgEtsi} {digest, hashType SHA256, docId, revIndex}; seal() нөөцгүй хэвээр", async () => {
  const sealResponse = { orgEtsi: ORG, signature: { value: M.signature, signatureAlgorithm: "ecdsa-with-SHA256" }, cert: { value: Buffer.from(SEAL).toString("base64"), certificateLevel: "QUALIFIED" }, sealedAt: "2026-11-25T04:05:06Z" };
  const { eid, calls } = client((body) => {
    for (const k of Object.keys(body)) if (!CA_SEAL_FIELDS.includes(k)) return { status: 400, body: { code: "REQUEST_INVALID" } };
    return { body: sealResponse };
  });
  const r = await eid.seal.sealForDocument(ORG, DTBS, DOC, 2);
  assert.equal(r.orgEtsi, ORG);
  assert.equal(calls[0]!.url, `https://rp.eidmongolia.mn/seal/${ORG}`);
  assert.deepEqual(calls[0]!.body, { digest: Buffer.from(DTBS).toString("base64"), hashType: "SHA256", docId: DOC, revIndex: 2 });
  assert.deepEqual(Object.keys(calls[0]!.body).sort(), [...SEAL_REQUEST_FIELDS, ...SEAL_RESERVATION_FIELDS].sort());
  await eid.seal.seal(ORG, DTBS);
  assert.deepEqual(Object.keys(calls[1]!.body).sort(), [...SEAL_REQUEST_FIELDS].sort(), "seal() нөөц илгээхгүй");
  const bad: [string, () => Promise<unknown>][] = [
    ["docId том үсэг", () => eid.seal.sealForDocument(ORG, DTBS, DOC.toUpperCase(), 1)],
    ["revIndex 0", () => eid.seal.sealForDocument(ORG, DTBS, DOC, 0)],
    ["revIndex 17", () => eid.seal.sealForDocument(ORG, DTBS, DOC, 17)],
    ["docId-гүй", () => eid.seal.sealForDocument(ORG, DTBS, "", 2)],
    ["SHA-384 урт", () => eid.seal.sealForDocument(ORG, new Uint8Array(48), DOC, 1)],
  ];
  for (const [name, f] of bad) await assert.rejects(f(), ValidationError, name);
  assert.equal(calls.length, 2, "буруу нөөц сүлжээнд гарсангүй");
});
