// Validator-ийн гинжийн шалгалт (0.11.0) — Go SDK 0.1.3-ийн x509.Verify-тэй ижил дүрэм.
//
// CA-ийн бодит гинжийн профайл (ca-eidmongolia-mn pki/chain/01–04, crypto/ca_profile.go, 2026-10-14):
//   01 Root:   KU critical DS|keyCertSign|cRLSign, BC critical CA:TRUE (pathLen алга), EKU алга
//   02 MDDC:   KU critical DS|keyCertSign|cRLSign, BC critical CA:TRUE, policy 2.16.496.1.101.1.2.8, CDP
//   03 Gerege: KU critical keyCertSign|cRLSign, BC critical CA:TRUE, policy, CDP, AIA
//   04 eID:    KU critical keyCertSign|cRLSign, BC critical CA:TRUE pathlen:0, policy, CDP, AIA
//   AUTH leaf: KU critical DS|keyEncipherment, EKU clientAuth+emailProtection, policy, SDA, AIA, CDP (non-critical)
//   SIGN leaf: KU critical DS|nonRepudiation, EKU emailProtection, qcStatements (non-critical)
// Name constraints, policyConstraints, inhibitAnyPolicy, CA-ийн EKU — гинжинд алга.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, sign as cryptoSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CITIZEN_INTERMEDIATES_PEM, CITIZEN_ISSUING_CA_SKI, NATIONAL_ROOT_CA_PEM, ResponseValidator, ValidationError, buildAcspV2Payload, certificateLevelOf, parseSessionResult, randomChallenge, userChallengeOf } from "../dist/index.js";

const DIR = mkdtempSync(join(tmpdir(), "eid-chain-"));
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }));
const f = (n: string) => join(DIR, n);
const ossl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });

const POLICY = "certificatePolicies=2.16.496.1.101.1.2.8";
const CDP = "crlDistributionPoints=URI:http://crl.example.test/ca";
let serial = 1000;

interface Cert {
  name: string;
  key: string;
  pem: string;
  cert: X509Certificate;
}

/** Түлхүүр + CSR → issuer (эсвэл өөрөө) гаргасан гэрчилгээ. ext — openssl extension мөрүүд. */
function issue(name: string, issuer: Cert | null, ext: string[], opts: { key?: "rsa" | "ec"; subj?: string; dates?: [string, string] } = {}): Cert {
  const keyArgs = opts.key === "ec" ? ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256"] : ["-newkey", "rsa:2048"];
  const subj = opts.subj ?? `/C=MN/CN=${name}`;
  ossl("req", "-new", ...keyArgs, "-nodes", "-utf8", "-subj", subj, "-keyout", f(`${name}.key`), "-out", f(`${name}.csr`));
  writeFileSync(f(`${name}.ext`), [...ext, "subjectKeyIdentifier=hash", issuer ? "authorityKeyIdentifier=keyid" : ""].join("\n") + "\n");
  if (opts.dates) {
    // Өнгөрсөн хугацаа — `openssl ca` (-startdate/-enddate; openssl 3.0-д x509 -not_before алга).
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

const CA_KU = "keyUsage=critical,keyCertSign,cRLSign";
const caExt = (pathLen?: number, ku = CA_KU) =>
  [`basicConstraints=critical,CA:TRUE${pathLen === undefined ? "" : `,pathlen:${pathLen}`}`, ku, POLICY, CDP];
const LEAF_COMMON = [
  "basicConstraints=critical,CA:FALSE", POLICY, "crlDistributionPoints=URI:http://crl.example.test/crl",
  "authorityInfoAccess=OCSP;URI:http://ocsp.example.test/ocsp,caIssuers;URI:http://crl.example.test/ca/issuing.cer",
  "2.5.29.9=DER:30:0c:30:0a:06:08:2b:06:01:05:05:07:09:03", // SDA (бүтэц хамаагүй — non-critical)
];
const AUTH_EXT = [...LEAF_COMMON, "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=clientAuth,emailProtection"];
const SIGN_EXT = [...LEAF_COMMON, "keyUsage=critical,digitalSignature,nonRepudiation", "extendedKeyUsage=emailProtection",
  "1.3.6.1.5.5.7.1.3=DER:30:0a:30:08:06:06:04:00:8e:46:01:01"]; // qcStatements QcCompliance (non-critical)
const CITIZEN = "/C=MN/SN=Бат/GN=Болд/serialNumber=PNOMN-12345678/CN=БОЛД Бат";

const ROOT = issue("root", null, ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,digitalSignature,keyCertSign,cRLSign"]);
const MDDC = issue("mddc", ROOT, caExt(undefined, "keyUsage=critical,digitalSignature,keyCertSign,cRLSign"));
const GEREGE = issue("gerege", MDDC, caExt());
const ISSUING = issue("issuing", GEREGE, caExt(0));
const CHAIN = [MDDC.pem, GEREGE.pem, ISSUING.pem];
// Тестийн 04-ийн SKI нь CITIZEN_ISSUING_CA_SKI биш — анхдагч issuer allowlist-ийг (0.19.0) энд унтраана.
const validator = (anchor = ROOT, inter = CHAIN, extra: Record<string, unknown> = {}) =>
  new ResponseValidator({ trustAnchorsPem: [anchor.pem], intermediatesPem: inter, allowAnyIssuer: true, ...extra });

const INTERACTIONS = Buffer.from(JSON.stringify([{ type: "displayTextAndPIN", displayText60: "x" }])).toString("base64");

function authOf(leaf: Cert, level = "QUALIFIED") {
  const acsp = {
    rpChallenge: randomChallenge(), relyingPartyName: "DEMO", brokeredRpName: "", interactions: INTERACTIONS,
    initialCallbackUrl: "", flowTypes: ["QR"], signatureAlgorithm: "rsassa-pss", hashAlgorithm: "SHA-256",
  } as const;
  const userChallenge = userChallengeOf("dGVzdC12ZXJpZmllci0zMi1ieXRlcy14eHh4eHh4eHg");
  const serverRandom = "MTlop6EXCrQ6FOErcKjxUhbV";
  const payload = buildAcspV2Payload({
    serverRandom, rpChallenge: acsp.rpChallenge, userChallenge, relyingPartyName: "DEMO", brokeredRpName: "",
    interactions: INTERACTIONS, interactionTypeUsed: "displayTextAndPIN", initialCallbackUrl: "", flowType: "QR",
  });
  const ec = leaf.cert.publicKey.asymmetricKeyType === "ec";
  const sig = ec
    ? cryptoSign("sha256", payload, { key: leaf.key, dsaEncoding: "der" })
    : cryptoSign("sha256", payload, { key: leaf.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const result = parseSessionResult({
    state: "COMPLETE", result: { endResult: "OK", documentNumber: "d1" }, signatureProtocol: "ACSP_V2", interactionTypeUsed: "displayTextAndPIN",
    signature: { value: sig.toString("base64"), serverRandom, userChallenge, flowType: "QR", initialCallbackUrl: "",
      signatureAlgorithm: ec ? "ecdsa-with-SHA256" : "rsassa-pss", signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" } },
    cert: { value: leaf.cert.raw.toString("base64"), certificateLevel: level },
  });
  return { result, acsp: acsp as unknown as Parameters<ResponseValidator["validateAuth"]>[1] };
}

function signOf(leaf: Cert, level = "QUALIFIED") {
  const digest = createHash("sha256").update("баримт").digest();
  const sig = cryptoSign("sha256", Buffer.from("баримт"), { key: leaf.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const result = parseSessionResult({
    state: "COMPLETE", result: { endResult: "OK", documentNumber: "d1" }, signatureProtocol: "RAW_DIGEST_SIGNATURE",
    signature: { value: sig.toString("base64"), signatureAlgorithm: "rsassa-pss", signatureAlgorithmParameters: { hashAlgorithm: "SHA-256" } },
    cert: { value: leaf.cert.raw.toString("base64"), certificateLevel: level },
  });
  return { result, digest: digest.toString("base64") };
}

const rejects = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ValidationError && re.test(e.message), String(re));

test("гинж — бодит профайл (01 → 02 → 03 → 04 → иргэн) амжина: auth, sign, токены EC", () => {
  const strict = validator(); // 0.19.0-аас checkKeyUsage анхдагч true
  const auth = issue("auth", ISSUING, AUTH_EXT, { subj: CITIZEN });
  const a = authOf(auth);
  validator().validateAuth(a.result, a.acsp);
  strict.validateAuth(a.result, a.acsp);
  const sign = issue("sign", ISSUING, SIGN_EXT, { subj: CITIZEN });
  const s = signOf(sign);
  validator().validateSign(s.result, s.digest);
  strict.validateSign(s.result, s.digest);
  const tok = issue("tok", ISSUING, AUTH_EXT, { subj: CITIZEN, key: "ec" });
  const t = authOf(tok);
  validator().validateAuth(t.result, t.acsp);
  // Гарын үсгийн гэрчилгээ (emailProtection) нэвтрэлтэд → clientAuth алга.
  const wrong = authOf(sign);
  rejects(() => validator().validateAuth(wrong.result, wrong.acsp), /ExtKeyUsage/);
  // Нэвтрэлтийн (PIN1) гэрчилгээ (clientAuth+emailProtection) sign-д EKU-гаар тэнцэнэ — анхдагчаар KU (nonRepudiation)
  // алга тул унана (0.18.x-д checkKeyUsage=false анхдагч байсан тул тэнцдэг байв). Хариу ADVANCED гэж зарласан ч.
  const sa = signOf(auth, "ADVANCED");
  rejects(() => strict.validateSign(sa.result, sa.digest), /nonRepudiation/);
  rejects(() => validator(ROOT, CHAIN, { requiredLevel: "ADVANCED" }).validateSign(sa.result, sa.digest), /nonRepudiation/);
  validator(ROOT, CHAIN, { checkKeyUsage: false, requiredLevel: "ADVANCED" }).validateSign(sa.result, sa.digest); // хуучин зан (зөвлөхгүй)
});

test("issuer allowlist — анхдагч CITIZEN_ISSUING_CA_SKI (anchor-тай үед); allowAnyIssuer / өөр жагсаалт", () => {
  const auth = issue("authIss", ISSUING, AUTH_EXT, { subj: CITIZEN });
  const a = authOf(auth);
  const def = new ResponseValidator({ trustAnchorsPem: [ROOT.pem], intermediatesPem: CHAIN });
  rejects(() => def.validateAuth(a.result, a.acsp), /allowedIssuerSkis/);
  const ski = execFileSync("openssl", ["x509", "-in", f("issuing.pem"), "-noout", "-ext", "subjectKeyIdentifier"])
    .toString().split("\n")[1]!.trim();
  new ResponseValidator({ trustAnchorsPem: [ROOT.pem], intermediatesPem: CHAIN, allowedIssuerSkis: [ski] }).validateAuth(a.result, a.acsp);
  validator().validateAuth(a.result, a.acsp);
});

test("certificateLevel — гэрчилгээнээс: SIGN qcStatements → QUALIFIED, qc-гүй → ADVANCED; AUTH KE → QUALIFIED, токен → ADVANCED", () => {
  const v = validator();
  const adv = validator(ROOT, CHAIN, { requiredLevel: "ADVANCED" });
  // Утасны SIGN (qcStatements QcCompliance)
  const sign = issue("lvSign", ISSUING, SIGN_EXT, { subj: CITIZEN });
  assert.equal(certificateLevelOf(sign.cert, "RAW_DIGEST_SIGNATURE"), "QUALIFIED");
  assert.equal(v.validateSign(signOf(sign).result, signOf(sign).digest).certificateLevel, "QUALIFIED");
  // Хариу QSCD гэж худал зарлавал (QcSSCD алга) → татгалзана.
  const q = signOf(sign, "QSCD");
  rejects(() => v.validateSign(q.result, q.digest), /гэрчилгээнээс \(QUALIFIED\) өндөр/);
  // Хариу доогуур (ADVANCED) — хариуныхыг авна, QUALIFIED шаардвал унана.
  const lo = signOf(sign, "ADVANCED");
  rejects(() => v.validateSign(lo.result, lo.digest), /хүрэлцэхгүй/);
  assert.equal(adv.validateSign(lo.result, lo.digest).certificateLevel, "ADVANCED");
  // Хариунд түвшин алга → гэрчилгээнийх.
  const none = signOf(sign, "");
  assert.equal(v.validateSign(none.result, none.digest).certificateLevel, "QUALIFIED");
  // Токены SIGN (qcStatements үгүй) → ADVANCED: QUALIFIED гэж зарласан хариу татгалзагдана.
  const tokSign = issue("lvTokSign", ISSUING, SIGN_EXT.filter((e) => !e.startsWith("1.3.6.1.5.5.7.1.3")), { subj: CITIZEN });
  assert.equal(certificateLevelOf(tokSign.cert, "RAW_DIGEST_SIGNATURE"), "ADVANCED");
  const ts = signOf(tokSign);
  rejects(() => v.validateSign(ts.result, ts.digest), /QUALIFIED гэрчилгээнээс \(ADVANCED\) өндөр/);
  // QcSSCD → QSCD
  const qscd = issue("lvQscd", ISSUING, [...SIGN_EXT.filter((e) => !e.startsWith("1.3.6.1.5.5.7.1.3")),
    "1.3.6.1.5.5.7.1.3=DER:30:14:30:08:06:06:04:00:8e:46:01:01:30:08:06:06:04:00:8e:46:01:04"], { subj: CITIZEN });
  assert.equal(certificateLevelOf(qscd.cert, "RAW_DIGEST_SIGNATURE"), "QSCD");
  // Утасны AUTH (KU keyEncipherment, P-CITIZEN-AUTH) → QUALIFIED; токены AUTH (KU DS, P-CITIZEN-AUTH-TOKEN) → ADVANCED.
  const auth = issue("lvAuth", ISSUING, AUTH_EXT, { subj: CITIZEN });
  assert.equal(certificateLevelOf(auth.cert, "ACSP_V2"), "QUALIFIED");
  const tokAuth = issue("lvTokAuth", ISSUING, [...LEAF_COMMON, "keyUsage=critical,digitalSignature", "extendedKeyUsage=clientAuth,emailProtection"],
    { subj: CITIZEN, key: "ec" });
  assert.equal(certificateLevelOf(tokAuth.cert, "ACSP_V2"), "ADVANCED");
  const ta = authOf(tokAuth);
  rejects(() => v.validateAuth(ta.result, ta.acsp), /өндөр/);
  const ta2 = authOf(tokAuth, "ADVANCED");
  assert.equal(adv.validateAuth(ta2.result, ta2.acsp).certificateLevel, "ADVANCED");
});

test("гинж — татгалзах: pathLen, завсрын EKU, CA:false, keyCertSign-гүй, хугацаа дууссан, буруу root, MDDC дутуу", () => {
  // 04 (pathlen:0) доор дахин CA
  const sub = issue("sub", ISSUING, caExt());
  const a1 = authOf(issue("l1", sub, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [...CHAIN, sub.pem]).validateAuth(a1.result, a1.acsp), /pathLen/);

  // Завсрын CA-д serverAuth EKU
  const tls = issue("tls", GEREGE, [...caExt(0), "extendedKeyUsage=serverAuth"]);
  const a2 = authOf(issue("l2", tls, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [MDDC.pem, GEREGE.pem, tls.pem]).validateAuth(a2.result, a2.acsp), /ExtKeyUsage/);
  const s2 = signOf(issue("l2s", tls, SIGN_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [MDDC.pem, GEREGE.pem, tls.pem]).validateSign(s2.result, s2.digest), /ExtKeyUsage/);

  // CA:FALSE завсрын
  const notCA = issue("notca", GEREGE, ["basicConstraints=critical,CA:FALSE", CA_KU]);
  const a3 = authOf(issue("l3", notCA, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [MDDC.pem, GEREGE.pem, notCA.pem]).validateAuth(a3.result, a3.acsp), /CA биш/);

  // keyCertSign-гүй CA
  const crlOnly = issue("crlonly", GEREGE, caExt(0, "keyUsage=critical,cRLSign"));
  const a4 = authOf(issue("l4", crlOnly, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [MDDC.pem, GEREGE.pem, crlOnly.pem]).validateAuth(a4.result, a4.acsp), /keyCertSign/);

  // Хугацаа дууссан завсрын CA (leaf хүчинтэй)
  const expired = issue("expired", GEREGE, caExt(0), { dates: ["20200101000000Z", "20200201000000Z"] });
  const a5 = authOf(issue("l5", expired, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [MDDC.pem, GEREGE.pem, expired.pem]).validateAuth(a5.result, a5.acsp), /хугацаа/);

  // Буруу root (ижил нэр, өөр түлхүүр) ба MDDC дутуу
  const other = issue("otherroot", null, ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign"], { subj: "/C=MN/CN=root" });
  const a6 = authOf(issue("l6", ISSUING, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(other).validateAuth(a6.result, a6.acsp), /trust anchor/);
  rejects(() => validator(ROOT, [GEREGE.pem, ISSUING.pem]).validateAuth(a6.result, a6.acsp), /trust anchor/);
});

test("гинж — name constraints (fail-closed), үл таних critical extension", () => {
  const nc = issue("nc", GEREGE, [...caExt(0), "nameConstraints=critical,permitted;email:example.org"]);
  const a1 = authOf(issue("n1", nc, AUTH_EXT, { subj: CITIZEN }));
  rejects(() => validator(ROOT, [MDDC.pem, GEREGE.pem, nc.pem]).validateAuth(a1.result, a1.acsp), /name constraints/);
  const a2 = authOf(issue("n2", ISSUING, [...AUTH_EXT, "1.3.6.1.4.1.99999.1=critical,DER:05:00"], { subj: CITIZEN }));
  rejects(() => validator().validateAuth(a2.result, a2.acsp), /critical extension/);
});

test("гинж — бодит нийтийн 04 нь 03-аас (pathlen:0, keyCertSign, AKI DirName+serial-тай 03) баталгаажна", () => {
  const ca04 = readFileSync(new URL("./fixtures/eid-mongolia-issuing-ca.pem", import.meta.url), "utf8");
  const ca03 = readFileSync(new URL("./fixtures/gerege-issuing-ca.pem", import.meta.url), "utf8");
  // 02 (MDDC) нийтийн URL-д нийтлэгдээгүй тул 03-ийг anchor болгоно. verifyChain — private; гинжийн логикийг шууд.
  const v = new ResponseValidator({ trustAnchorsPem: [ca03] }) as unknown as { verifyChain(c: X509Certificate, usage: string): void };
  v.verifyChain(new X509Certificate(ca04), "1.3.6.1.5.5.7.3.2");
  const wrongAnchor = new ResponseValidator({ trustAnchorsPem: [ROOT.pem] }) as unknown as { verifyChain(c: X509Certificate, usage: string): void };
  rejects(() => wrongAnchor.verifyChain(new X509Certificate(ca04), "1.3.6.1.5.5.7.3.2"), /trust anchor/);
});

test("NATIONAL_ROOT_CA_PEM + CITIZEN_INTERMEDIATES_PEM — бодит 01 → 02 → 03 → 04; 04-ийн SKI = CITIZEN_ISSUING_CA_SKI", () => {
  const root = new X509Certificate(NATIONAL_ROOT_CA_PEM);
  assert.equal(root.fingerprint256, "CB:E7:F3:FE:1F:04:80:37:C2:15:DA:32:1E:58:CA:A4:F3:63:DE:9E:54:BB:C4:42:A3:BF:D6:2F:AD:83:44:82");
  const [mddc, gerege, issuing] = CITIZEN_INTERMEDIATES_PEM.map((p) => new X509Certificate(p));
  assert.equal(CITIZEN_INTERMEDIATES_PEM.length, 3);
  assert.ok(mddc!.checkIssued(root) && gerege!.checkIssued(mddc!) && issuing!.checkIssued(gerege!));
  assert.ok(mddc!.verify(root.publicKey) && gerege!.verify(mddc!.publicKey) && issuing!.verify(gerege!.publicKey));
  assert.equal(issuing!.subject.includes("eID Mongolia Issuing CA"), true);
  const ski = execFileSync("openssl", ["x509", "-noout", "-ext", "subjectKeyIdentifier"], { input: CITIZEN_INTERMEDIATES_PEM[2] })
    .toString().split("\n")[1]!.trim().replace(/:/g, "").toLowerCase();
  assert.equal(ski, CITIZEN_ISSUING_CA_SKI);
  assert.ok(Object.isFrozen(CITIZEN_INTERMEDIATES_PEM));
});
