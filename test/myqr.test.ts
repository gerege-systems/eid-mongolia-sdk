// «Миний QR» (CA гэрээ myqr-2026-10-26 §6, §7): гэрээний vector хэлбэрээр локал тест PKI-аар үүсгэсэн тохиолдлууд,
// CA-ийн албан ёсны test/fixtures/myqr_vectors.json (байвал — SHA-256 бэхэлсэн), mock RP-API-ийн start/result/check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, randomBytes, sign as cryptoSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EidClient,
  ForbiddenError,
  NoSigningCertificateError,
  QR_ERROR_CODES,
  QR_LIMITS,
  QR_PREFIX,
  QrError,
  QrTokenInvalidError,
  RequestInvalidError,
  SessionFailedError,
  parseQr,
  parseSessionResult,
  verifyQrPresentation,
  type RevocationChecker,
  type TrustConfig,
} from "../dist/index.js";

/**
 * CA-ийн `server/internal/service/memory/testdata/myqr_vectors.json`-ийн SHA-256 (hex). Файлыг CA-аас байт-ижил
 * хуулсны дараа бэхэлнэ (гэрээний §5.5).
 * TODO: CA-ийн vector commit ирмэгц `shasum -a 256 test/fixtures/myqr_vectors.json`-ийн утгаар солих.
 */
const MYQR_VECTORS_SHA256 = "TODO-pin-sha256-of-ca-myqr_vectors.json";
const VECTORS_FILE = new URL("./fixtures/myqr_vectors.json", import.meta.url);

const CONTRACT = "myqr-2026-10-26";
const ISSUER = "https://ca.eidmongolia.mn";
const REQUIRED_VERIFY = [
  "ok_basic", "ok_photo", "ok_unicode", "ok_aud_uppercase_expect", "ok_skew_edge", "ok_source_unknown",
  "malformed_segments", "header_extra_kid", "header_alg_rs256", "header_alg_none", "header_typ_jwt", "x5c_single",
  "x5c_garbage", "chain_other_root", "chain_issuer_not_allowed", "leaf_auth_profile", "leaf_expired", "leaf_revoked",
  "revocation_unknown", "bad_signature", "signature_pkcs1v15", "payload_not_json", "iss_wrong",
  "sub_mismatch_cert", "statement_wrong_rp", "aud_mismatch", "sid_mismatch", "nonce_mismatch", "exp_minus_iat_301",
  "iat_future", "expired", "data_value_number", "data_value_too_long", "data_key_too_long", "data_too_many_fields",
  "photo_not_jpeg", "photo_too_large", "data_extra_member",
];

// ── vector runner (CA-ийн файл ба локал vector-д ижил) ──

interface VerifyCase {
  name: string;
  jws: string;
  expect: { rpUUID: string; sessionId: string; nonce: string; now: number; issuer?: string };
  revocation?: Record<string, string>;
  error?: string;
  result?: {
    claims: Record<string, unknown>;
    dataKeys: string[];
    data: Record<string, string>;
    source: string;
    photoSha256: string | null;
    signer: { etsi: string; certSha256: string };
    sha256: string;
  };
}
interface Vectors {
  contract: string;
  issuer: string;
  clockSkewSeconds: number;
  maxAgeSeconds: number;
  limits: Record<string, number>;
  trust: { anchorsPem: string[]; intermediatesPem: string[]; allowedIssuerSkis: string[] };
  parse: { in: string; token?: string; error?: string }[];
  verify: VerifyCase[];
}

const hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const serialKey = (s: string) => s.toLowerCase().replace(/^0+(?=.)/, "");

/** Гэрээний §7.2: serial (hex) → good | revoked | unknown; serial алга → unknown. */
function stubRevocation(map: Record<string, string> = {}): RevocationChecker {
  const m = new Map(Object.entries(map).map(([k, v]) => [serialKey(k), v]));
  return async (cert) => (m.get(serialKey(cert.serialNumber)) ?? "unknown") as "good" | "revoked" | "unknown";
}

async function runVectors(V: Vectors): Promise<void> {
  assert.equal(V.contract, CONTRACT);
  assert.equal(V.issuer, ISSUER);
  assert.equal(V.clockSkewSeconds, 60);
  assert.equal(V.maxAgeSeconds, 300);
  for (const [k, v] of Object.entries(QR_LIMITS)) assert.equal(V.limits[k], v, `limits.${k}`);
  const names = new Set(V.verify.map((c) => c.name));
  for (const n of REQUIRED_VERIFY) assert.ok(names.has(n), `verify case алга: ${n}`);

  for (const c of V.parse) {
    if (c.error) {
      assert.throws(() => parseQr(c.in), (e: unknown) => e instanceof QrError && e.code === c.error, JSON.stringify(c.in));
    } else {
      const p = parseQr(c.in);
      assert.equal(p.token, c.token, JSON.stringify(c.in));
      assert.equal(p.qr, QR_PREFIX + c.token);
    }
  }

  for (const c of V.verify) {
    const trust: TrustConfig = {
      trustAnchorsPem: V.trust.anchorsPem,
      intermediatesPem: V.trust.intermediatesPem,
      allowedIssuerSkis: V.trust.allowedIssuerSkis,
      revocation: stubRevocation(c.revocation),
    };
    const expect = {
      rpUUID: c.expect.rpUUID,
      sessionId: c.expect.sessionId,
      nonce: c.expect.nonce,
      now: new Date(c.expect.now * 1000),
      ...(c.expect.issuer ? { issuer: c.expect.issuer } : {}),
    };
    if (c.error) {
      assert.ok((QR_ERROR_CODES as readonly string[]).includes(c.error), `${c.name}: үл мэдэгдэх код ${c.error}`);
      await assert.rejects(verifyQrPresentation(c.jws, expect, trust), (e: unknown) => {
        assert.ok(e instanceof QrError, `${c.name}: ${String(e)}`);
        assert.equal(e.code, c.error, `${c.name}: ${e.message}`);
        return true;
      });
      continue;
    }
    const r = await verifyQrPresentation(c.jws, expect, trust);
    const want = c.result!;
    assert.deepEqual(r.claims, want.claims, c.name);
    assert.deepEqual(Object.keys(r.data), want.dataKeys, c.name);
    assert.deepEqual(r.data, want.data, c.name);
    assert.equal(r.source, want.source, c.name);
    assert.equal(r.photo ? hex(r.photo) : null, want.photoSha256, c.name);
    assert.equal(r.signer.etsi, want.signer.etsi, c.name);
    assert.equal(hex(r.signer.certificate.raw), want.signer.certSha256, c.name);
    assert.equal(r.sha256, want.sha256, c.name);
    assert.equal(r.jws, c.jws);
    assert.equal(r.signedAt.getTime(), (want.claims.iat as number) * 1000);
  }
}

test("CA vectors (test/fixtures/myqr_vectors.json)", { skip: !existsSync(VECTORS_FILE) && "CA-ийн vector файл хараахан хуулагдаагүй" }, async () => {
  const buf = readFileSync(VECTORS_FILE);
  assert.equal(hex(buf), MYQR_VECTORS_SHA256, "vector файл CA-ийнхтай байт-ижил биш эсвэл SHA-256 бэхлээгүй");
  await runVectors(JSON.parse(buf.toString("utf8")));
});

// ── локал тест PKI (openssl; CA-ийн профайл: test/chain.test.ts-ийн толгойн тайлбар) ──

const DIR = mkdtempSync(join(tmpdir(), "eid-myqr-"));
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }));
const f = (n: string) => join(DIR, n);
const ossl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
let serial = 4096;

interface Cert {
  name: string;
  key: string;
  pem: string;
  cert: X509Certificate;
}

function issue(name: string, issuer: Cert | null, ext: string[], opts: { subj?: string; dates?: [string, string] } = {}): Cert {
  const subj = opts.subj ?? `/C=MN/CN=${name}`;
  ossl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-utf8", "-subj", subj, "-keyout", f(`${name}.key`), "-out", f(`${name}.csr`));
  writeFileSync(f(`${name}.ext`), [...ext, "subjectKeyIdentifier=hash", issuer ? "authorityKeyIdentifier=keyid" : ""].join("\n") + "\n");
  if (opts.dates) {
    writeFileSync(f("ca.cnf"), [
      "[ca]", "default_ca=d", "[d]", `database=${f("index.txt")}`, `new_certs_dir=${DIR}`, `serial=${f("serial")}`,
      "default_md=sha256", "policy=p", "unique_subject=no", "email_in_dn=no", "[p]", "commonName=supplied", "",
    ].join("\n"));
    writeFileSync(f("index.txt"), "");
    writeFileSync(f("serial"), `${(serial++).toString(16).padStart(4, "0")}\n`);
    ossl("ca", "-batch", "-config", f("ca.cnf"), "-cert", f(`${issuer!.name}.pem`), "-keyfile", f(`${issuer!.name}.key`),
      "-in", f(`${name}.csr`), "-out", f(`${name}.pem`), "-notext", "-startdate", opts.dates[0], "-enddate", opts.dates[1],
      "-extfile", f(`${name}.ext`));
  } else if (issuer) {
    ossl("x509", "-req", "-in", f(`${name}.csr`), "-CA", f(`${issuer.name}.pem`), "-CAkey", f(`${issuer.name}.key`), "-days", "2",
      "-set_serial", String(serial++), "-extfile", f(`${name}.ext`), "-out", f(`${name}.pem`));
  } else {
    ossl("x509", "-req", "-in", f(`${name}.csr`), "-signkey", f(`${name}.key`), "-days", "2", "-set_serial", String(serial++),
      "-extfile", f(`${name}.ext`), "-out", f(`${name}.pem`));
  }
  const pem = readFileSync(f(`${name}.pem`), "utf8");
  return { name, key: readFileSync(f(`${name}.key`), "utf8"), pem, cert: new X509Certificate(pem) };
}

const ROOT_EXT = ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,digitalSignature,keyCertSign,cRLSign"];
const CA_EXT = ["basicConstraints=critical,CA:TRUE,pathlen:0", "keyUsage=critical,keyCertSign,cRLSign"];
const LEAF_COMMON = ["basicConstraints=critical,CA:FALSE", "authorityInfoAccess=OCSP;URI:http://ocsp.example.test/ocsp"];
const SIGN_EXT = [...LEAF_COMMON, "keyUsage=critical,digitalSignature,nonRepudiation", "extendedKeyUsage=emailProtection",
  "1.3.6.1.5.5.7.1.3=DER:30:0a:30:08:06:06:04:00:8e:46:01:01"]; // qcStatements QcCompliance
const AUTH_EXT = [...LEAF_COMMON, "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=clientAuth,emailProtection"];
const CITIZEN = "/C=MN/SN=DORJ/GN=BAT/serialNumber=PNOMN-000000000001/CN=DORJ BAT";

const ROOT = issue("root", null, ROOT_EXT);
const CA = issue("ca", ROOT, CA_EXT);
const LEAF = issue("leaf_sign", CA, SIGN_EXT, { subj: CITIZEN });
const LEAF_AUTH = issue("leaf_auth", CA, AUTH_EXT, { subj: CITIZEN });
const LEAF_REVOKED = issue("leaf_revoked", CA, SIGN_EXT, { subj: CITIZEN });
const LEAF_EXPIRED = issue("leaf_expired", CA, SIGN_EXT, { subj: CITIZEN, dates: ["20200101000000Z", "20200201000000Z"] });
const LEAF_BY_ROOT = issue("leaf_by_root", ROOT, SIGN_EXT, { subj: CITIZEN });
const OTHER_ROOT = issue("other_root", null, ROOT_EXT);
const OTHER_LEAF = issue("other_leaf", OTHER_ROOT, SIGN_EXT, { subj: CITIZEN });
const CA_SKI = execFileSync("openssl", ["x509", "-noout", "-ext", "subjectKeyIdentifier"], { input: CA.pem })
  .toString().split("\n")[1]!.trim().replace(/:/g, "").toLowerCase();

// ── CA-ийн composer-ийн дүр (гэрээний §1.4, `v`-гүй: Go encoding/json — талбарын дараалал, fields byte-эрэмбэ, HTML escape) ──

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const der64 = (c: Cert) => c.cert.raw.toString("base64");
const goJson = (v: unknown) =>
  JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const sortedFields = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
const statement = (rp: string) => `Та ${rp}-д «Миний мэдээлэл» хэсгийн бүх мэдээллийг хуваалцах гэж байна`;

const RP_UUID = "6f1c2a9e-1b7d-4c2e-9a51-3d8e5b7c9f01";
const SID = "3f0d4a52-8e1b-4f6a-b0c7-2d9e1a5b7c33";
const NONCE = "order-1042-abcdef";
const T = Math.floor(Date.now() / 1000) - 30;
const FIELDS = { reg_no: "УБ90010112", given_name: "Бат", surname: "Дорж", birth_date: "1990-01-01" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2044)]);

interface Spec {
  leaf?: Cert;
  x5c?: unknown;
  header?: Record<string, unknown>;
  payload?: (p: Record<string, unknown>) => void;
  data?: Record<string, unknown>;
  rawPayload?: string;
  sign?: "pss" | "pkcs1" | "corrupt";
  expect?: Partial<VerifyCase["expect"]>;
  revocation?: Record<string, string> | null;
  jws?: string;
}

function makeCase(name: string, s: Spec, error?: string): VerifyCase {
  const leaf = s.leaf ?? LEAF;
  const header = s.header ?? { alg: "PS256", typ: "eidmn-myqr+jwt", x5c: s.x5c ?? [der64(leaf), der64(CA)] };
  const data = s.data ?? { source: "citizenid", fields: FIELDS };
  const p: Record<string, unknown> = {
    iss: ISSUER, sub: "PNOMN-000000000001", aud: RP_UUID, rp_name: "Demo Bank", sid: SID, nonce: NONCE,
    iat: T, exp: T + 300, statement: statement("Demo Bank"),
    data: { ...data, ...(isRecord(data.fields) ? { fields: sortedFields(data.fields) } : {}) },
  };
  s.payload?.(p);
  const input = `${b64u(goJson(header))}.${b64u(s.rawPayload ?? goJson(p))}`;
  const key = leaf.key;
  let sig = s.sign === "pkcs1"
    ? cryptoSign("sha256", Buffer.from(input), key)
    : cryptoSign("sha256", Buffer.from(input), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  if (s.sign === "corrupt") sig = Buffer.from(sig.map((b, i) => (i === 7 ? b ^ 0x01 : b)));
  const jws = s.jws ?? `${input}.${b64u(sig)}`;
  const c: VerifyCase = {
    name,
    jws,
    expect: { rpUUID: RP_UUID, sessionId: SID, nonce: NONCE, now: T + 10, ...s.expect },
    ...(s.revocation === null ? {} : { revocation: s.revocation ?? { [serialKey(leaf.cert.serialNumber)]: "good" } }),
  };
  if (error) return { ...c, error };
  const fields = (p.data as { fields: Record<string, string> }).fields;
  const photo = (p.data as { photo?: string }).photo;
  return {
    ...c,
    result: {
      claims: p,
      dataKeys: Object.keys(fields),
      data: fields,
      source: (p.data as { source: string }).source,
      photoSha256: photo ? hex(Buffer.from(photo, "base64")) : null,
      signer: { etsi: "PNOMN-000000000001", certSha256: hex(leaf.cert.raw) },
      sha256: hex(input),
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const TOKEN = "Qm9yamlnaW4tdGVzdC10b2tlbi0wMDAwMDAwMDAwMDA";
const many = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${String(i).padStart(3, "0")}`, "x"]));

const LOCAL: Vectors = {
  contract: CONTRACT,
  issuer: ISSUER,
  clockSkewSeconds: 60,
  maxAgeSeconds: 300,
  limits: { ...QR_LIMITS },
  trust: { anchorsPem: [ROOT.pem], intermediatesPem: [], allowedIssuerSkis: [CA_SKI] },
  parse: [
    { in: `EIDMN-QR1:${TOKEN}`, token: TOKEN },
    { in: `  EIDMN-QR1:${TOKEN}\n`, token: TOKEN },
    { in: `EIDMN-QR2:${TOKEN}`, error: "QR_FORMAT_INVALID" },
    { in: TOKEN, error: "QR_FORMAT_INVALID" },
    { in: `EIDMN-QR1:${TOKEN}x`, error: "QR_FORMAT_INVALID" },
    { in: `eidmn-qr1:${TOKEN}`, error: "QR_FORMAT_INVALID" },
  ],
  verify: [
    makeCase("ok_basic", {}),
    makeCase("ok_photo", { data: { source: "dan", fields: FIELDS, photo: JPEG.toString("base64") } }),
    makeCase("ok_unicode", { data: { source: "passport", fields: { "нэр <b>": "Бат & Дорж 😀", "Овог": "<script>Дорж</script>", empty: "" } } }),
    makeCase("ok_photo_only", { data: { source: "dan", fields: {}, photo: JPEG.toString("base64") } }),
    makeCase("ok_aud_uppercase_expect", { expect: { rpUUID: RP_UUID.toUpperCase() } }),
    makeCase("ok_skew_edge", { expect: { now: T + 300 + 59 } }),
    makeCase("ok_source_unknown", { data: { source: "unknown", fields: FIELDS } }),
    makeCase("malformed_segments", { jws: "eyJhbGciOiJQUzI1NiJ9.eyJ2IjoyfQ" }, "QR_JWS_MALFORMED"),
    makeCase("malformed_padding", { jws: "eyJh.eyJ2.c2ln=" }, "QR_JWS_MALFORMED"),
    makeCase("header_extra_kid", { header: { alg: "PS256", typ: "eidmn-myqr+jwt", x5c: [der64(LEAF), der64(CA)], kid: "k1" } }, "QR_HEADER_INVALID"),
    makeCase("header_alg_rs256", { header: { alg: "RS256", typ: "eidmn-myqr+jwt", x5c: [der64(LEAF), der64(CA)] } }, "QR_HEADER_INVALID"),
    makeCase("header_alg_none", { header: { alg: "none", typ: "eidmn-myqr+jwt", x5c: [der64(LEAF), der64(CA)] } }, "QR_HEADER_INVALID"),
    makeCase("header_typ_jwt", { header: { alg: "PS256", typ: "JWT", x5c: [der64(LEAF), der64(CA)] } }, "QR_HEADER_INVALID"),
    makeCase("x5c_single", { x5c: [der64(LEAF)] }, "QR_HEADER_INVALID"),
    makeCase("x5c_garbage", { x5c: [der64(LEAF), "bm90LWEtY2VydA=="] }, "QR_HEADER_INVALID"),
    makeCase("x5c_base64url", { x5c: [b64u(LEAF.cert.raw), der64(CA)] }, "QR_HEADER_INVALID"),
    makeCase("chain_other_root", { leaf: OTHER_LEAF, x5c: [der64(OTHER_LEAF), der64(OTHER_ROOT)] }, "QR_CHAIN_INVALID"),
    makeCase("chain_issuer_not_allowed", { leaf: LEAF_BY_ROOT }, "QR_CHAIN_INVALID"),
    makeCase("leaf_auth_profile", { leaf: LEAF_AUTH }, "QR_CHAIN_INVALID"),
    makeCase("leaf_expired", { leaf: LEAF_EXPIRED }, "QR_CHAIN_INVALID"),
    makeCase("leaf_revoked", { leaf: LEAF_REVOKED, revocation: { [serialKey(LEAF_REVOKED.cert.serialNumber)]: "revoked" } }, "QR_CERT_REVOKED"),
    makeCase("revocation_unknown", { revocation: null }, "QR_REVOCATION_UNKNOWN"),
    makeCase("bad_signature", { sign: "corrupt" }, "QR_SIGNATURE_INVALID"),
    makeCase("signature_pkcs1v15", { sign: "pkcs1" }, "QR_SIGNATURE_INVALID"),
    makeCase("payload_not_json", { rawPayload: "not json" }, "QR_JWS_MALFORMED"),
    makeCase("iss_wrong", { payload: (p) => (p.iss = "https://evil.example") }, "QR_CLAIMS_INVALID"),
    makeCase("sub_mismatch_cert", { payload: (p) => (p.sub = "PNOMN-999999999999") }, "QR_CLAIMS_INVALID"),
    makeCase("statement_wrong_rp", { payload: (p) => (p.statement = statement("Other Bank")) }, "QR_CLAIMS_INVALID"),
    makeCase("iat_not_integer", { payload: (p) => (p.iat = T + 0.5) }, "QR_CLAIMS_INVALID"),
    makeCase("aud_mismatch", { expect: { rpUUID: "00000000-0000-0000-0000-000000000000" } }, "QR_AUDIENCE_MISMATCH"),
    makeCase("sid_mismatch", { expect: { sessionId: "other-session" } }, "QR_SESSION_MISMATCH"),
    makeCase("nonce_mismatch", { expect: { nonce: "order-1042-ABCDEF" } }, "QR_NONCE_MISMATCH"),
    makeCase("exp_minus_iat_301", { payload: (p) => (p.exp = T + 301) }, "QR_CLAIMS_INVALID"),
    makeCase("iat_future", { payload: (p) => ((p.iat = T + 200), (p.exp = T + 500)), expect: { now: T + 139 } }, "QR_NOT_YET_VALID"),
    makeCase("expired", { expect: { now: T + 300 + 61 } }, "QR_EXPIRED"),
    makeCase("data_value_number", { data: { source: "dan", fields: { reg_no: 12 } } }, "QR_DATA_INVALID"),
    makeCase("data_value_too_long", { data: { source: "dan", fields: { a: "ө".repeat(1025) } } }, "QR_DATA_INVALID"),
    makeCase("data_key_too_long", { data: { source: "dan", fields: { ["к".repeat(65)]: "x" } } }, "QR_DATA_INVALID"),
    makeCase("data_key_control", { data: { source: "dan", fields: { "a\u0085": "x" } } }, "QR_DATA_INVALID"),
    makeCase("data_too_many_fields", { data: { source: "dan", fields: many } }, "QR_DATA_INVALID"),
    makeCase("data_empty", { data: { source: "dan", fields: {} } }, "QR_DATA_INVALID"),
    makeCase("data_source_bad", { data: { source: "DAN", fields: FIELDS } }, "QR_DATA_INVALID"),
    makeCase("photo_not_jpeg", { data: { source: "dan", fields: FIELDS, photo: Buffer.from("\x89PNG\r\n\x1a\nxxxx").toString("base64") } }, "QR_DATA_INVALID"),
    makeCase("photo_too_large", { data: { source: "dan", fields: FIELDS, photo: Buffer.concat([JPEG, Buffer.alloc(153601 - JPEG.length)]).toString("base64") } }, "QR_DATA_INVALID"),
    makeCase("photo_line_breaks", { data: { source: "dan", fields: FIELDS, photo: JPEG.toString("base64").replace(/(.{76})/g, "$1\n") } }, "QR_DATA_INVALID"),
    makeCase("data_extra_member", { data: { source: "dan", fields: FIELDS, extra: "x" } }, "QR_DATA_INVALID"),
  ],
};

test("локал vector (гэрээний §7.2 хэлбэр, тест PKI)", async () => {
  await runVectors(LOCAL);
});

test("ok_unicode: payload-д <>& escape хийгдсэн, утга verbatim", async () => {
  const c = LOCAL.verify.find((x) => x.name === "ok_unicode")!;
  const payload = Buffer.from(c.jws.split(".")[1]!, "base64url").toString("utf8");
  assert.ok(payload.includes("\\u003cscript\\u003e") && payload.includes("\\u0026") && !payload.includes("<"));
  const trust = { trustAnchorsPem: [ROOT.pem], intermediatesPem: [], allowedIssuerSkis: [CA_SKI], revocation: stubRevocation(c.revocation) };
  const r = await verifyQrPresentation(c.jws, { ...c.expect, now: new Date(c.expect.now * 1000) }, trust);
  assert.equal(r.data["Овог"], "<script>Дорж</script>");
  assert.equal(r.data["нэр <b>"], "Бат & Дорж 😀");
  assert.equal(r.signer.givenName, "BAT");
  assert.equal(r.signer.surname, "DORJ");
});

test("revocation: soft-fail unknown-г зөвшөөрнө, checker-ийн алдаа = unknown", async () => {
  const c = LOCAL.verify.find((x) => x.name === "ok_basic")!;
  const base = { trustAnchorsPem: [ROOT.pem], intermediatesPem: [], allowedIssuerSkis: [CA_SKI] };
  const exp = { ...c.expect, now: new Date(c.expect.now * 1000) };
  const r = await verifyQrPresentation(c.jws, exp, { ...base, revocation: stubRevocation({}), revocationMode: "soft-fail" });
  assert.equal(r.claims.sid, SID);
  const throwing: RevocationChecker = async () => {
    throw new Error("ocsp down");
  };
  await assert.rejects(verifyQrPresentation(c.jws, exp, { ...base, revocation: throwing }), (e: unknown) =>
    e instanceof QrError && e.code === "QR_REVOCATION_UNKNOWN");
  // x5c[1] (олгогч CA) нь anchor биш: өөр root-д итгэвэл гинж хүрэхгүй.
  await assert.rejects(verifyQrPresentation(c.jws, exp, { trustAnchorsPem: [OTHER_ROOT.pem], intermediatesPem: [], allowedIssuerSkis: [CA_SKI], revocation: stubRevocation(c.revocation) }), (e: unknown) =>
    e instanceof QrError && e.code === "QR_CHAIN_INVALID");
});

test("session: presentation = { jws } (илүү талбар хаягдана)", () => {
  const r = parseSessionResult({ state: "COMPLETE", result: { endResult: "OK" }, presentation: { jws: "a.b.c", claims: { x: 1 } } });
  assert.deepEqual(r.presentation, { jws: "a.b.c" });
});

// ── mock RP-API: start / result / check ──

const CREDS = { rpUUID: RP_UUID, rpName: "Demo Bank", apiSecret: "rp_sk_secret" };
const TOK2 = "q9Xk3vQh2m9cTqL8rW1xYb5nPdA0sE6uJgHtKoVfRiM";

function stub() {
  const st = {
    calls: 0,
    startBody: null as Record<string, unknown> | null,
    startReply: null as null | { status: number; body: unknown },
    session: { status: 200, state: "COMPLETE", end: "OK" },
  };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    st.calls++;
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer rp_sk_secret");
    if (u.pathname === "/authentication/qr" && init?.method === "POST") {
      st.startBody = JSON.parse(String(init.body));
      if (st.startReply) return reply(st.startReply.status, st.startReply.body);
      return reply(200, { sessionID: "sess-2" });
    }
    if (u.pathname === "/session/sess-2") {
      if (st.session.status !== 200) return reply(st.session.status, { error: "x", code: "QR_PRESENTATION_GONE" });
      const body: Record<string, unknown> = { state: st.session.state, ...(st.session.state === "COMPLETE" ? { result: { endResult: st.session.end } } : {}) };
      if (st.session.state === "COMPLETE" && st.session.end === "OK") {
        const now = Math.floor(Date.now() / 1000);
        const c = makeCase("live", { payload: (p) => ((p.sid = "sess-2"), (p.nonce = st.startBody!.nonce), (p.iat = now), (p.exp = now + 300)) });
        body.signatureProtocol = "RAW_DIGEST_SIGNATURE";
        body.presentation = { jws: c.jws };
      }
      return reply(200, body);
    }
    return reply(404, {});
  }) as typeof fetch;
  const eid = new EidClient({
    baseUrl: "https://rp.test",
    credentials: CREDS,
    fetchImpl,
    trust: {
      trustAnchorsPem: [ROOT.pem],
      intermediatesPem: [],
      allowedIssuerSkis: [CA_SKI],
      revocation: stubRevocation({ [serialKey(LEAF.cert.serialNumber)]: "good" }),
    },
  });
  return { st, eid };
}

test("qr.start: буруу мөр → QR_FORMAT_INVALID, сүлжээгүй", async () => {
  const { st, eid } = stub();
  for (const qr of [TOK2, `EIDMN-QR2:${TOK2}`, "hello"]) {
    await assert.rejects(eid.qr.start({ qr }), (e: unknown) => e instanceof QrError && e.code === "QR_FORMAT_INVALID");
  }
  assert.equal(st.calls, 0, "CA руу хүсэлт явсан");
  assert.deepEqual(eid.qr.parse(` ${QR_PREFIX}${TOK2} `), { token: TOK2, qr: `${QR_PREFIX}${TOK2}` });
});

test("qr.start: body, auto nonce (22 тэмдэгт base64url), өгсөн nonce verbatim", async () => {
  const { st, eid } = stub();
  const s = await eid.qr.start({ qr: ` ${QR_PREFIX}${TOK2}\n` });
  assert.equal(s.sessionId, "sess-2");
  assert.match(s.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(st.startBody, { qr: `${QR_PREFIX}${TOK2}`, relyingPartyUUID: RP_UUID, relyingPartyName: "Demo Bank", nonce: s.nonce });
  const s2 = await eid.qr.start({ qr: `${QR_PREFIX}${TOK2}`, nonce: "order-0000000042", relyingPartyName: "Касс 3" });
  assert.equal(s2.nonce, "order-0000000042");
  assert.equal(st.startBody!.nonce, "order-0000000042");
  assert.equal(st.startBody!.relyingPartyName, "Касс 3");
  assert.notEqual((await eid.qr.start({ qr: `${QR_PREFIX}${TOK2}` })).nonce, s.nonce);
});

test("qr.start: CA-ийн 409/400/404/403 код дамжина", async () => {
  const { st, eid } = stub();
  const qr = `${QR_PREFIX}${TOK2}`;
  st.startReply = { status: 409, body: { error: "x", code: "NO_SIGNING_CERTIFICATE" } };
  await assert.rejects(eid.qr.start({ qr }), (e: unknown) => e instanceof NoSigningCertificateError && e.status === 409 && e.code === "NO_SIGNING_CERTIFICATE");
  st.startReply = { status: 400, body: { error: "x", code: "REQUEST_INVALID" } };
  await assert.rejects(eid.qr.start({ qr, nonce: "short" }), (e: unknown) => e instanceof RequestInvalidError && e.code === "REQUEST_INVALID");
  st.startReply = { status: 404, body: { error: "x", code: "QR_TOKEN_INVALID" } };
  await assert.rejects(eid.qr.start({ qr }), (e: unknown) => e instanceof QrTokenInvalidError && e.status === 404);
  st.startReply = { status: 403, body: { error: "x", code: "PERMISSION_DENIED" } };
  await assert.rejects(eid.qr.start({ qr }), (e: unknown) => e instanceof ForbiddenError && e.code === "PERMISSION_DENIED");
});

test("qr.result / check: OK → шалгасан өгөгдөл; RUNNING; USER_REFUSED; 410 → QR_PRESENTATION_GONE", async () => {
  const { st, eid } = stub();
  const s = await eid.qr.start({ qr: `${QR_PREFIX}${TOK2}` });
  const stored = JSON.parse(JSON.stringify(s));
  const r = await eid.qr.result(stored, { maxWaitMs: 5000 });
  assert.deepEqual(r.data, FIELDS);
  assert.deepEqual(Object.keys(r.data), ["birth_date", "given_name", "reg_no", "surname"]);
  assert.equal(r.source, "citizenid");
  assert.equal(r.signer.etsi, "PNOMN-000000000001");
  assert.equal(r.claims.sid, "sess-2");
  assert.match(r.sha256, /^[0-9a-f]{64}$/);

  const c = await eid.qr.check(stored);
  assert.equal(c.complete, true);
  await assert.rejects(eid.qr.result({ ...stored, nonce: "replayed-nonce-0000" }, { maxWaitMs: 5000 }), (e: unknown) =>
    e instanceof QrError && e.code === "QR_NONCE_MISMATCH");

  st.session.state = "RUNNING";
  assert.deepEqual(await eid.qr.check(stored), { complete: false });
  await assert.rejects(eid.qr.result(stored, { maxWaitMs: 1000, serverPollMs: 1000 }), (e: unknown) => e instanceof QrError && e.code === "QR_PENDING");

  st.session.state = "COMPLETE";
  st.session.end = "USER_REFUSED";
  await assert.rejects(eid.qr.result(stored, { maxWaitMs: 5000 }), (e: unknown) => e instanceof SessionFailedError && e.endResult === "USER_REFUSED");
  await assert.rejects(eid.qr.check(stored), (e: unknown) => e instanceof SessionFailedError && e.endResult === "USER_REFUSED");

  st.session.status = 410;
  await assert.rejects(eid.qr.result(stored, { maxWaitMs: 5000 }), (e: unknown) => e instanceof QrError && e.code === "QR_PRESENTATION_GONE");
  await assert.rejects(eid.qr.check(stored), (e: unknown) => e instanceof QrError && e.code === "QR_PRESENTATION_GONE");
});
