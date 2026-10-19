// POST /share (CA docs/SHARE_EMAIL.md, main 0329ef95) ба /certificates-ийн issuedAt/revokedAt/revocationReason.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  AuthenticationError,
  EidClient,
  ForbiddenError,
  SHARE_ERROR_CODES,
  ShareError,
} from "../dist/index.js";

const CREDS = { rpUUID: "rp-uuid", rpName: "Гэрээний систем", apiSecret: "rp_sk_secret" };
const PDF = new TextEncoder().encode("%PDF-1.7\n…");

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Call = { url: string; method: string; headers: Record<string, string>; form?: FormData };

function client(reply: Reply) {
  const calls: Call[] = [];
  const eid = new EidClient({
    credentials: CREDS,
    trust: { allowUntrusted: true },
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: String(init?.method),
        headers: (init?.headers ?? {}) as Record<string, string>,
        form: init?.body instanceof FormData ? init.body : undefined,
      });
      const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
      return new Response(body, { status: reply.status ?? 200, headers: reply.headers });
    },
  });
  return { eid, calls };
}

test("share: multipart талбарууд, to давтагдана, Content-Type-ийг fetch тавина", async () => {
  const { eid, calls } = client({ body: { sent: 2, sha256: "ab", signatures: 1, docID: "d-1" } });
  const r = await eid.share({
    file: PDF,
    filename: "гэрээ.pdf",
    to: ["a@x.mn", "b@x.mn"],
    subject: "Гэрээ",
    message: "Гарын үсэг зурна уу",
    lang: "en",
  });
  assert.deepEqual({ sent: r.sent, sha256: r.sha256, signatures: r.signatures, docID: r.docID }, {
    sent: 2, sha256: "ab", signatures: 1, docID: "d-1",
  });
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "https://rp.eidmongolia.mn/share");
  assert.equal(c.headers.Authorization, "Bearer rp_sk_secret");
  assert.equal(c.headers["Content-Type"], undefined, "boundary-г fetch тавина");
  const f = c.form!;
  assert.deepEqual(f.getAll("to"), ["a@x.mn", "b@x.mn"]);
  assert.equal(f.get("subject"), "Гэрээ");
  assert.equal(f.get("message"), "Гарын үсэг зурна уу");
  assert.equal(f.get("lang"), "en");
  assert.equal(f.get("filename"), "гэрээ.pdf");
  const file = f.get("file") as Blob & { name: string };
  assert.equal(file.name, "гэрээ.pdf");
  assert.equal(file.type, "application/pdf");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PDF);
  assert.deepEqual([...f.keys()].sort(), ["file", "filename", "lang", "message", "subject", "to", "to"]);
});

test("share: File (нэртэй Blob)-ийн нэр анхдагч, заавал биш талбар илгээгдэхгүй, docID байхгүй", async () => {
  const { eid, calls } = client({ body: { sent: 1, sha256: "cd", signatures: 2 } });
  const r = await eid.share({ file: Object.assign(new Blob([PDF], { type: "application/pdf" }), { name: "signed.pdf" }), to: "a@x.mn" });
  assert.equal(r.docID, undefined);
  const f = calls[0]!.form!;
  assert.deepEqual([...f.keys()].sort(), ["file", "to"]);
  assert.equal((f.get("file") as Blob & { name: string }).name, "signed.pdf");

  const c2 = client({ body: { sent: 1, sha256: "cd", signatures: 1 } });
  await c2.eid.share({ file: new Blob([PDF]), to: "a@x.mn" });
  const file = c2.calls[0]!.form!.get("file") as Blob & { name: string };
  assert.equal(file.name, "document.pdf");
  assert.equal(file.type, "application/pdf");
});

test("share: 422 FILE_NOT_SIGNED → ShareError.reason", async () => {
  const { eid } = client({ status: 422, body: { error: "…", code: "FILE_NOT_SIGNED", reason: "untrusted" } });
  const e = await eid.share({ file: PDF, to: "a@x.mn" }).catch((x: unknown) => x);
  assert.ok(e instanceof ShareError && e instanceof ApiError);
  assert.equal(e.status, 422);
  assert.equal(e.code, "FILE_NOT_SIGNED");
  assert.equal(e.reason, "untrusted");
});

test("share: 502 MAIL_FAILED → sent/failed/recipients", async () => {
  const { eid } = client({
    status: 502,
    body: { error: "…", code: "MAIL_FAILED", sent: 1, failed: 1, recipients: ["sent", "failed"] },
  });
  const e = (await eid.share({ file: PDF, to: ["a@x.mn", "b@x.mn"] }).catch((x: unknown) => x)) as ShareError;
  assert.ok(e instanceof ShareError);
  assert.equal(e.code, "MAIL_FAILED");
  assert.equal(e.sent, 1);
  assert.equal(e.failed, 1);
  assert.deepEqual(e.recipients, ["sent", "failed"]);
  assert.equal(e.retryable, false);
});

test("share: 429 RATE_LIMITED / 503 VALIDATOR_BUSY → retryable + retryAfterMs", async () => {
  for (const [status, code] of [[429, "RATE_LIMITED"], [503, "VALIDATOR_BUSY"]] as const) {
    const { eid } = client({ status, body: { error: "…", code }, headers: { "Retry-After": "30" } });
    const e = (await eid.share({ file: PDF, to: "a@x.mn" }).catch((x: unknown) => x)) as ShareError;
    assert.ok(e instanceof ShareError);
    assert.equal(e.code, code);
    assert.equal(e.retryAfterMs, 30_000);
    assert.equal(e.retryable, true);
  }
});

test("share: 400/413/415/503 кодууд ShareError; REQUEST_INVALID ч ShareError", async () => {
  for (const [status, code] of [
    [400, "RECIPIENT_DUPLICATE"],
    [400, "REQUEST_INVALID"],
    [413, "FILE_TOO_LARGE"],
    [415, "FILE_TYPE_NOT_SUPPORTED"],
    [503, "SHARE_DISABLED"],
  ] as const) {
    const { eid } = client({ status, body: { error: "…", code } });
    const e = (await eid.share({ file: PDF, to: "a@x.mn" }).catch((x: unknown) => x)) as ShareError;
    assert.ok(e instanceof ShareError, code);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    assert.ok((SHARE_ERROR_CODES as readonly string[]).includes(code));
  }
});

test("share: 401/403 нь ерөнхий төрлөөрөө", async () => {
  const a = await client({ status: 401, body: { error: "…" } }).eid.share({ file: PDF, to: "a@x.mn" }).catch((x: unknown) => x);
  assert.ok(a instanceof AuthenticationError);
  const f = await client({ status: 403, body: { error: "SIGN эрхгүй", code: "PERMISSION_DENIED" } })
    .eid.share({ file: PDF, to: "a@x.mn" }).catch((x: unknown) => x);
  assert.ok(f instanceof ForbiddenError);
});

test("shareInfo: discovery-ийн share блок", async () => {
  const share = {
    enabled: false,
    endpoint: "https://rp.eidmongolia.mn/share",
    formats: [{ extension: ".pdf", mime: "application/pdf", name: "pdf" }],
    languages: ["mn", "en"],
    maxFileBytes: 3080192,
    maxFilenameChars: 120,
    maxMessageChars: 1000,
    maxRecipients: 5,
    maxSubjectChars: 150,
    permission: "SIGN",
    quota: { perRPDay: 200, perRPHour: 30, perRecipientDay: 10 },
    requiresValidSignature: true,
  };
  const { eid, calls } = client({ body: { share } });
  const s = await eid.shareInfo();
  assert.equal(calls[0]!.url, "https://rp.eidmongolia.mn/.well-known/eid");
  assert.equal(s.enabled, false);
  assert.equal(s.maxFileBytes, 3080192);
  assert.equal(s.maxRecipients, 5);
  assert.deepEqual(s.quota, { perRPHour: 30, perRPDay: 200, perRecipientDay: 10 });
  assert.equal(s.formats[0]!.extension, ".pdf");

  const old = await client({ body: {} }).eid.shareInfo();
  assert.equal(old.enabled, false, "share блокгүй (хуучин CA) → enabled false");
});

test("person.certificates: issuedAt, revokedAt, revocationReason", async () => {
  const { eid } = client({
    body: {
      personEtsi: "PNOMN-1",
      counts: { valid: 0, revoked: 1, suspended: 1, expired: 0, total: 2 },
      certificates: [
        { type: "SIGN", status: "REVOKED", issuedAt: "2026-01-02T03:04:05+08:00", revokedAt: "2026-02-01T00:00:00+08:00", revocationReason: "keyCompromise" },
        { type: "SIGN", status: "SUSPENDED", issuedAt: "2025-01-02T03:04:05+08:00", revocationReason: "superseded" },
      ],
    },
  });
  const c = await eid.person.certificates("PNOMN-1");
  assert.equal(c.certificates[0]!.issuedAt, "2026-01-02T03:04:05+08:00");
  assert.equal(c.certificates[0]!.revokedAt, "2026-02-01T00:00:00+08:00");
  assert.equal(c.certificates[0]!.revocationReason, "keyCompromise");
  assert.equal(c.certificates[1]!.revokedAt, undefined);
  assert.equal(c.certificates[1]!.revocationReason, "superseded");
});

test("person.certificates: TOKEN мөрөнд tokenSerial, MOBILE-д алга", async () => {
  const { eid } = client({
    body: {
      personEtsi: "PNOMN-1",
      counts: { valid: 2, revoked: 0, suspended: 0, expired: 0, total: 2 },
      certificates: [
        { type: "AUTH", keyMedium: "TOKEN", status: "VALID", tokenSerial: "EP2003-0042A1", organization: { etsi: "NTRMN-1", name: "Тест ХХК" } },
        { type: "SIGN", keyMedium: "MOBILE", status: "VALID" },
      ],
    },
  });
  const c = await eid.person.certificates("PNOMN-1");
  assert.equal(c.certificates[0]!.tokenSerial, "EP2003-0042A1");
  assert.equal(c.certificates[1]!.tokenSerial, undefined);
});
