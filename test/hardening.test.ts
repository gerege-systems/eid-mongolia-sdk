// rp-conformance/2 хатуужуулалт — корпуст орох боломжгүй хэсгүүд (тохиргооны алдаа, хүсэлт илгээгдээгүй эсэх, ECDSA r/s
// хүрээ, handle(Request)-ийн getClientIp эх үүсвэр). Үлдсэнийг test/conformance.test.ts (rp-conformance/2) шалгана.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createEidLogin, EidClient, NATIONAL_ROOT_CA_PEM, ResponseValidator, verifyPrehashedSignature } from "../dist/index.js";

const PKI = join(dirname(fileURLToPath(import.meta.url)), "fixtures/conformance/pki");
const pem = (n: string) => readFileSync(join(PKI, n), "utf8");

test("hardening: trust pool-ийн сул RSA түлхүүр ба үл мэдэх requiredLevel — тохиргооны алдаа", () => {
  assert.throws(() => new ResponseValidator({ trustAnchorsPem: [NATIONAL_ROOT_CA_PEM], intermediatesPem: [pem("ocsp-responder-rsa-1024.pem")] }), /RSA түлхүүр сул/);
  assert.throws(() => new ResponseValidator({ trustAnchorsPem: [pem("leaf-auth-rsa-1024.pem")], intermediatesPem: [] }), /RSA түлхүүр сул/);
  assert.throws(() => new ResponseValidator({ trustAnchorsPem: [NATIONAL_ROOT_CA_PEM], requiredLevel: "QUALIFED" as never }), /requiredLevel/);
  for (const requiredLevel of [undefined, "ADVANCED", "QUALIFIED", "QSCD"] as const) {
    // Бодит 01–04 гинж ≥ 2048 байх ёстой.
    new ResponseValidator({ trustAnchorsPem: [NATIONAL_ROOT_CA_PEM], ...(requiredLevel ? { requiredLevel } : {}) });
  }
});

test("hardening: хоосон / . / .. замын параметр — хүсэлт илгээхгүй", async () => {
  let sent = 0;
  const client = new EidClient({
    baseUrl: "https://rp.example.test/v3",
    credentials: { rpUUID: "00000000-0000-4000-8000-000000000001", rpName: "Тест", apiSecret: "rp_sk_test" },
    fetchImpl: (async () => {
      sent++;
      throw new Error("хүсэлт илгээгдэх ёсгүй");
    }) as typeof fetch,
  });
  for (const id of ["", ".", ".."]) {
    await assert.rejects(async () => client.session.poll(id, 0), /замын параметр/);
    await assert.rejects(async () => client.auth.notificationByEtsi(id, [{ type: "displayTextAndPIN", displayText60: "x" }]), /замын параметр/);
    await assert.rejects(async () => client.person.certificates(id), /замын параметр/);
  }
  assert.equal(sent, 0);
});

test("hardening: ECDSA r/s хүрээнээс гадуур хэзээ ч тэнцэхгүй", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const digest = createHash("sha256").update("range").digest();
  const good = createSign("sha256").update("range").sign(privateKey);
  assert.ok(verifyPrehashedSignature(digest, good.toString("base64"), publicKey, "ecdsa-with-SHA256", "SHA-256"));
  const n = Buffer.from("00ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", "hex");
  const int = (b: Buffer) => Buffer.concat([Buffer.from([0x02, b.length]), b]);
  const s = good.subarray(4 + good[3]!); // r-ийн араас: INTEGER s
  const sv = s.subarray(2, 2 + s[1]!);
  const seq = (body: Buffer) => Buffer.concat([Buffer.from([0x30, body.length]), body]);
  for (const bad of [seq(Buffer.concat([int(n), int(sv)])), seq(Buffer.concat([int(Buffer.from([0x01])), int(n)])), seq(Buffer.concat([int(Buffer.from([0x00])), int(sv)]))]) {
    assert.equal(verifyPrehashedSignature(digest, bad.toString("base64"), publicKey, "ecdsa-with-SHA256", "SHA-256"), false);
  }
});

test("hardening: handle(Request) — getClientIp хоосон бол start:unknown; push түлхүүрт дугаар орохгүй", async () => {
  const keys: string[] = [];
  const client = new EidClient({
    baseUrl: "https://rp.example.test/v3",
    credentials: { rpUUID: "00000000-0000-4000-8000-000000000001", rpName: "Тест", apiSecret: "rp_sk_test" },
    fetchImpl: (async () => new Response('{"error":"down"}', { status: 500, headers: { "Content-Type": "application/json" } })) as typeof fetch,
  });
  const login = createEidLogin({
    client,
    onSuccess: () => ({}),
    getClientIp: () => "",
    rateLimit: (k: string) => (keys.push(k), true),
    pushFloorMs: 0,
    onError: () => {},
  });
  const res = await login.handle(new Request("https://rp.example.test/auth/eid/start", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "push", idCode: "УБ12345678" }),
  }));
  assert.equal(res.status, 502);
  assert.equal(keys[0], "start:unknown");
  assert.match(keys[1]!, /^push:[0-9a-f]{32}$/);
  assert.ok(!keys.join(" ").includes("12345678"));
  const set = res.headers.get("set-cookie");
  assert.equal(set, null);
});
