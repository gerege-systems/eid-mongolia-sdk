// RP SDK conformance корпус (rp-conformance/2) — Go reference-ийн testdata/conformance-ийн хуулбар
// (scripts/sync-rp-conformance.mjs). Формат: test/fixtures/conformance/README.md. Мессежийн текст корпуст орохгүй —
// алдааг REASONS хүснэгтээр тогтвортой reason key болгож харьцуулна.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acspV2Digest,
  ApiError,
  AuthenticationError,
  buildAcspV2Payload,
  createEidLogin,
  EidClient,
  ForbiddenError,
  interactionsToBase64,
  ocspRevocationChecker,
  ResponseValidator,
  SessionFailedError,
  ValidationError,
  parseSessionResult,
  type EidLoginEvent,
  type EidLoginRequest,
} from "../dist/index.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/conformance");
const read = (rel: string) => readFileSync(join(DIR, rel));
const load = (rel: string) => JSON.parse(read(rel).toString("utf8"));
type Obj = Record<string, any>;

test("conformance: manifest — файл бүрийн sha256, devicelink/myqr pin", () => {
  const m = load("manifest.json");
  assert.equal(m.version, "rp-conformance/2");
  for (const [rel, sum] of Object.entries(m.files as Record<string, string>)) {
    assert.equal(createHash("sha256").update(read(rel)).digest("hex"), sum, rel);
  }
  const pin = (p: string) => createHash("sha256").update(readFileSync(join(DIR, "..", p))).digest("hex");
  assert.equal(pin("devicelink_golden.json"), m.devicelinkGolden.sha256);
  assert.equal(pin("myqr_vectors.json"), m.myqrVectors.sha256);
});

// TS ValidationError мессеж → reason key (README §rp-validate). Дараалал чухал.
const REASONS: [RegExp, string][] = [
  [/session дуусаагүй/iu, "session.not_complete"],
  [/signatureProtocol \S+ ≠/iu, "protocol.mismatch"],
  [/хариунд гэрчилгээ алга/iu, "response.no_certificate"],
  [/хариунд гарын үсэг алга/iu, "response.no_signature"],
  [/documentNumber алга/iu, "response.no_document_number"],
  [/гэрчилгээ (задарсангүй|base64 буруу)/iu, "cert.malformed"],
  [/RSA түлхүүр сул/iu, "cert.weak_key"],
  [/SERIALNUMBER эсвэл CN давхардсан/iu, "subject.duplicate_identity"],
  [/гинжийн гэрчилгээний хугацаа/iu, "chain.expired"],
  [/хүчинтэй болоогүй/iu, "cert.not_yet_valid"],
  [/гэрчилгээний хугацаа дууссан/iu, "cert.expired"],
  [/KeyUsage digitalSignature алга/iu, "purpose.auth_digital_signature"],
  [/ExtKeyUsage clientAuth алга/iu, "purpose.auth_client_auth"],
  [/KeyUsage nonRepudiation/iu, "purpose.sign_non_repudiation"],
  [/trust anchor тохируулаагүй/iu, "trust.no_anchor"],
  [/name constraints/iu, "chain.name_constraints"],
  [/critical extension/iu, "chain.critical_extension"],
  [/pathLenConstraint/iu, "chain.path_len"],
  [/ExtKeyUsage энэ үйлдэлд|CA-ийн ExtKeyUsage/iu, "chain.eku"],
  [/CA биш эсвэл keyCertSign|keyCertSign алга/iu, "chain.not_ca"],
  [/trust anchor \(Root CA\) хүрсэнгүй/iu, "chain.untrusted"],
  [/гинж хүчингүй/iu, "chain.invalid"],
  [/allowedIssuerSkis/iu, "issuer.not_allowed"],
  [/certificateLevel \S+ гэрчилгээнээс/iu, "level.claimed_higher"],
  [/түвшин хүрэлцэхгүй/iu, "level.insufficient"],
  [/qcStatements буруу/iu, "level.qc_malformed"],
  [/serverRandom/iu, "auth.server_random"],
  [/userChallenge буруу хэлбэр/iu, "auth.user_challenge"],
  [/санал болгосон урсгалд байхгүй/iu, "auth.flow_not_offered"],
  [/≠ эхлүүлсэн урсгал/iu, "flow.mismatch"],
  [/userChallengeVerifier заавал/iu, "auth.verifier_required"],
  [/userChallengeVerifier нь/iu, "auth.verifier_mismatch"],
  [/interactionTypeUsed алга/iu, "auth.interaction_type_missing"],
  [/initialCallbackUrl/iu, "auth.callback_url"],
  [/ACSP_V2 payload-той таарсангүй/iu, "auth.signature"],
  [/дэмжигдээгүй (signatureAlgorithm|hashAlgorithm)/iu, "alg.unsupported"],
  [/ECDSA credential зөвхөн SHA-256/iu, "alg.ecdsa_hash"],
  [/бус гэрчилгээтэй|түлхүүртэй таарахгүй/iu, "alg.key_mismatch"],
  [/MGF1/iu, "alg.mgf1"],
  [/saltLength/iu, "alg.salt_length"],
  [/signatureAlgorithm \S+ ≠ хүссэн/iu, "alg.mismatch"],
  [/hashAlgorithm \S+ ≠ хүссэн/iu, "alg.hash_mismatch"],
  [/certificate-choice-оор сонгосонтой/iu, "sign.certificate_mismatch"],
  [/digest урт/iu, "sign.digest_length"],
  [/digest base64/iu, "sign.digest_base64"],
  [/өгсөн digest-тэй таарсангүй/iu, "sign.signature"],
];

function classify(e: unknown): Obj {
  if (e instanceof SessionFailedError) return { class: "SessionFailedError", endResult: (e as unknown as Obj).endResult };
  if (e instanceof ValidationError) {
    const hit = REASONS.find(([re]) => re.test(e.message));
    return { class: "ValidationError", reason: hit ? hit[1] : `?${e.message}` };
  }
  return { class: `?${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}` };
}

/** Date.now-ийг тогтмол болгож fn-ийг ажиллуулна (validator нь Date.now()-оор цаг авдаг). */
function at<T>(iso: string, fn: () => T): T {
  const real = Date.now;
  const t = Date.parse(iso);
  Date.now = () => t;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("conformance: rp-validate/1", () => {
  const f = load("rp-validate/cases.json");
  const pem = (rel: string) => read(rel).toString("utf8");
  assert.ok(f.cases.length >= 60);
  const failures: string[] = [];
  for (const c of f.cases as Obj[]) {
    const tr = f.trust[c.trust];
    const v = new ResponseValidator({
      trustAnchorsPem: tr.anchors.map(pem),
      intermediatesPem: tr.intermediates.map(pem),
      allowedIssuerSkis: tr.allowedIssuerSkis,
      ...(tr.requiredLevel ? { requiredLevel: tr.requiredLevel } : {}),
      clockSkewMs: (tr.clockSkewSeconds ?? 0) * 1000,
    });
    const r = parseSessionResult(c.session);
    const o: Obj = c.options ?? {};
    let out: Obj | undefined;
    let err: unknown;
    try {
      out = at(c.now, () => {
        if (c.kind === "auth") {
          return v.validateAuth(r, c.acsp, {
            ...(o.expectedFlowType ? { expectedFlowType: o.expectedFlowType } : {}),
            ...(o.userChallengeVerifier !== undefined ? { userChallengeVerifier: o.userChallengeVerifier } : {}),
          });
        }
        if (c.kind === "sign") {
          return v.validateSign(r, c.digest, {
            hashAlgorithm: c.hashAlgorithm,
            ...(o.expectedFlowType ? { expectedFlowType: o.expectedFlowType } : {}),
            ...(o.expectedAlgorithm ? { expectedAlgorithm: o.expectedAlgorithm } : {}),
            ...(o.expectedCertificate ? { expectedCertificate: new X509Certificate(Buffer.from(o.expectedCertificate, "base64")) } : {}),
          });
        }
        return v.validateCertificateChoice(r, c.certChoiceSessionId);
      }) as Obj;
    } catch (e) {
      err = e;
    }
    try {
      if (c.expect.error) {
        assert.ok(err, "алдаа хүлээсэн, амжилттай");
        assert.deepEqual(classify(err), c.expect.error);
        continue;
      }
      if (err) throw err;
      const e = c.expect.ok;
      const s = out!.parsedSubject;
      assert.deepEqual(
        {
          documentNumber: out!.documentNumber,
          certificateLevel: out!.certificateLevel,
          certificateSha256: createHash("sha256").update(out!.certificate.raw).digest("hex"),
          subject: {
            serialNumber: s.serialNumber ?? "",
            givenName: s.givenName ?? "",
            surname: s.surname ?? "",
            country: s.country ?? "",
            commonName: s.commonName ?? "",
          },
          ...(c.kind === "sign" ? { signatureAlgorithm: out!.signatureAlgorithm } : {}),
        },
        e,
      );
      if (c.kind === "certificateChoice") {
        assert.equal(out!.certChoiceSessionId, c.certChoiceSessionId);
        assert.equal(out!.certificateDerB64, out!.certificate.raw.toString("base64"));
      }
    } catch (e) {
      failures.push(`${c.name}: ${e instanceof Error ? e.message.split("\n").slice(0, 8).join(" ") : e}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("conformance: interactions_golden", () => {
  for (const c of load("interactions_golden.json").cases as Obj[]) {
    // Талбарын дараалал: type, displayText60, displayText200 (README §interactions).
    const list = c.interactions.map((i: Obj) => ({
      type: i.type,
      ...(i.displayText60 !== undefined ? { displayText60: i.displayText60 } : {}),
      ...(i.displayText200 !== undefined ? { displayText200: i.displayText200 } : {}),
    }));
    assert.equal(interactionsToBase64(list), c.base64, c.name);
    assert.equal(Buffer.from(c.base64, "base64").toString("utf8"), c.json, c.name);
  }
});

test("conformance: acsp_v2", () => {
  for (const c of load("acsp_v2.json").cases as Obj[]) {
    const p = { ...c.params, ...(c.params.schemeName ? {} : { schemeName: undefined }) };
    assert.equal(buildAcspV2Payload(p).toString("utf8"), c.payload, c.name);
    assert.equal(acspV2Digest(p, c.hashAlgorithm).toString("base64"), c.digestB64, c.name);
  }
});

test("conformance: ocsp", async () => {
  const f = load("ocsp/cases.json");
  const failures: string[] = [];
  for (const c of f.cases as Obj[]) {
    const cert = new X509Certificate(read(c.certificate));
    const issuer = new X509Certificate(read(c.issuer));
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const rep = c.http[`${init?.method ?? "GET"} ${String(url)}`] ?? { status: 404, bodyB64: "" };
      const body = Buffer.from(rep.bodyB64, "base64");
      return new Response(body.length ? body : null, { status: rep.status, headers: rep.contentType ? { "Content-Type": rep.contentType } : {} });
    }) as typeof fetch;
    const check = ocspRevocationChecker({ fetchImpl, now: () => Date.parse(c.now) });
    let got: string;
    try {
      got = await check(cert, issuer);
    } catch (e) {
      got = `throw ${e instanceof Error ? e.message : e}`;
    }
    if (got !== c.expect.status) failures.push(`${c.name}: ${got} ≠ ${c.expect.status}`);
  }
  assert.deepEqual(failures, []);
});

// ── wire ──

const isoSec = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));
const ns = (v: unknown) => (v === undefined || v === null || v === "" ? null : v);

function sessionJson(r: Obj): Obj {
  const out: Obj = { state: r.state };
  for (const k of ["endResult", "documentNumber", "certificateDerB64", "certificateLevel", "signatureValueB64", "signatureAlgorithm",
    "signatureProtocol", "serverRandom", "userChallenge", "flowType", "interactionTypeUsed"]) out[k] = ns(r[k]);
  out.initialCallbackUrl = typeof r.initialCallbackUrl === "string" ? r.initialCallbackUrl : null;
  const p = r.signatureAlgorithmParameters;
  out.signatureAlgorithmParameters = p ? { hashAlgorithm: p.hashAlgorithm, ...(p.saltLength != null ? { saltLength: p.saltLength } : {}) } : null;
  const o = r.onBehalfOf;
  out.onBehalfOf = o
    ? { orgEtsi: o.orgEtsi, orgName: ns(o.orgName), role: ns(o.role), rightType: ns(o.rightType),
      ...(o.roleLabel ? { roleLabel: o.roleLabel } : {}), ...(o.rightTypeLabel ? { rightTypeLabel: o.rightTypeLabel } : {}) }
    : null;
  out.person = r.person ?? null;
  out.tokenCertificate = r.tokenCertificate ?? null;
  return out;
}

function wireResult(res: Obj, hasExp: boolean): Obj {
  if ("state" in res) return { type: "session", session: sessionJson(res) };
  const m: Obj = { sessionId: res.sessionId, vc: res.vc, rpChallenge: res.rpChallenge, acsp: res.acsp ?? null, sign: res.sign ?? null };
  if (hasExp) m.expiresAt = isoSec(res.expiresAt);
  if ("sessionToken" in res) {
    Object.assign(m, { type: "deviceLink", sessionToken: res.sessionToken, sessionSecret: res.sessionSecret,
      deviceLinkBase: res.deviceLinkBase, sessionType: res.sessionType });
    if (res.sessionType === "cert") Object.assign(m, { relyingPartyName: res.relyingPartyName, callbackUrl: res.initialCallbackUrl ?? "" });
  } else {
    m.type = "notification";
  }
  return m;
}

function errJson(e: unknown): Obj {
  if (e instanceof ApiError) {
    return { class: "ApiError", status: e.status, code: e.code ?? "", ...(e.retryAfterMs ? { retryAfterSeconds: Math.round(e.retryAfterMs / 1000) } : {}) };
  }
  if (e instanceof ForbiddenError) return { class: "ForbiddenError", status: 403, code: e.code ?? "" };
  if (e instanceof AuthenticationError) return { class: "AuthenticationError", status: 401, code: e.code ?? "" };
  throw e;
}

const ptrGet = (v: unknown, ptr: string) => ptr.slice(1).split("/").reduce<any>((a, k) => (a && typeof a === "object" ? a[k] : undefined), v);
function ptrSet(v: Obj, ptr: string, val: unknown) {
  const parts = ptr.slice(1).split("/");
  const last = parts.pop()!;
  parts.reduce<any>((a, k) => a[k], v)[last] = val;
}
function resolveReq(v: unknown, body: unknown): unknown {
  if (typeof v === "string" && v.startsWith("$request:")) return ptrGet(body, v.slice("$request:".length));
  if (Array.isArray(v)) return v.map((x) => resolveReq(x, body));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveReq(x, body)]));
  return v;
}

async function invoke(client: EidClient, call: Obj): Promise<unknown> {
  const a = call.args;
  const inter = (a.interactions ?? []).map((i: Obj) => ({
    type: i.type,
    ...(i.displayText60 !== undefined ? { displayText60: i.displayText60 } : {}),
    ...(i.displayText200 !== undefined ? { displayText200: i.displayText200 } : {}),
  }));
  const o = a.options;
  switch (call.method) {
    case "auth.notificationByEtsi": return client.auth.notificationByEtsi(a.id, inter, o);
    case "auth.notificationByDocument": return client.auth.notificationByDocument(a.documentNumber, inter, o);
    case "auth.deviceLinkAnonymous": return client.auth.deviceLinkAnonymous(inter, o);
    case "auth.deviceLinkByEtsi": return client.auth.deviceLinkByEtsi(a.id, inter, o);
    case "sign.digestByEtsi": return client.sign.digestByEtsi(a.id, a.digest, inter, o);
    case "sign.digestByDocument": return client.sign.digestByDocument(a.documentNumber, a.digest, inter, o);
    case "sign.textByEtsi": return client.sign.textByEtsi(a.id, a.text, inter, o);
    case "sign.deviceLinkByEtsi": return client.sign.deviceLinkByEtsi(a.id, a.digest, inter, o);
    case "sign.deviceLinkByDocument": return client.sign.deviceLinkByDocument(a.documentNumber, a.digest, inter, o);
    case "sign.digestForSigner": return client.sign.digestForSigner(a.signer, a.digest, inter, o);
    case "sign.deviceLinkForSigner": return client.sign.deviceLinkForSigner(a.signer, a.digest, inter, o);
    case "sign.certificateChoiceByEtsi": return client.sign.certificateChoiceByEtsi(a.id, o);
    case "sign.certificateChoiceDeviceLink": return client.sign.certificateChoiceDeviceLink(o);
    case "session.poll": return client.session.poll(a.sessionId, a.serverPollMs);
  }
  throw new Error(`wire: үл мэдэх method ${call.method}`);
}

test("conformance: wire", async () => {
  const f = load("wire/cases.json");
  const failures: string[] = [];
  for (const c of f.cases as Obj[]) {
    let sent: { method: string; path: string; headers: Headers; body: unknown } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      sent = { method: init?.method ?? "GET", path: u.pathname + u.search, headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined };
      return new Response(JSON.stringify(c.response.body), { status: c.response.status,
        headers: { "Content-Type": "application/json", ...(c.response.headers ?? {}) } });
    }) as typeof fetch;
    const client = new EidClient({ baseUrl: f.client.baseUrl, fetchImpl,
      credentials: { rpUUID: f.client.rpUUID, rpName: f.client.rpName, apiSecret: f.client.apiSecret } });
    try {
      let got: Obj;
      try {
        got = wireResult((await invoke(client, c.call)) as Obj, "expiresAt" in (c.response.body ?? {}));
      } catch (e) {
        got = { error: errJson(e) };
      }
      assert.ok(sent, "хүсэлт илгээгдсэнгүй");
      assert.equal(sent.method, c.request.method);
      assert.equal(sent.path, c.request.path);
      for (const [k, v] of Object.entries(c.request.headers as Record<string, string>)) {
        const h = sent.headers.get(k) ?? "";
        assert.equal(k === "Content-Type" ? h.split(";")[0]!.trim() : h, v, `header ${k}`);
      }
      const body = sent.body === undefined ? undefined : structuredClone(sent.body) as Obj;
      for (const [ptr, format] of Object.entries((c.request.volatile ?? {}) as Record<string, string>)) {
        const val = ptrGet(body, ptr);
        assert.equal(format, "base64:64");
        assert.ok(typeof val === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(val) && Buffer.from(val, "base64").length === 64, `volatile ${ptr}`);
        ptrSet(body!, ptr, "$volatile");
      }
      assert.deepEqual(body, c.request.body, "хүсэлтийн бие");
      assert.deepEqual(JSON.parse(JSON.stringify(got)), resolveReq(c.expect, sent.body), "үр дүн");
    } catch (e) {
      failures.push(`${c.name}: ${e instanceof Error ? e.message.split("\n").slice(0, 12).join(" ") : e}`);
    }
  }
  assert.deepEqual(failures, []);
});

// ── eidlogin ──

type Rule = Obj;
interface Res { status: number; json?: Obj; headers: Record<string, string[]>; cookie?: Record<string, string> }

function strOf(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function match(want: unknown, got: unknown, all: Res[], path = "$"): void {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    const w = want as Obj;
    if ("$re" in w) return void assert.match(strOf(got), new RegExp(w.$re), path);
    if ("$range" in w) return void assert.ok(typeof got === "number" && got >= w.$range[0] && got <= w.$range[1], `${path}: ${got} ∉ ${w.$range}`);
    if ("$sameAs" in w) {
      const [i, , key] = String(w.$sameAs).split(".");
      return void assert.equal(strOf(got), strOf(all[Number(i)]!.json?.[key!]), `${path} $sameAs ${w.$sameAs}`);
    }
    assert.ok(got && typeof got === "object", `${path}: объект хүлээсэн`);
    for (const [k, x] of Object.entries(w)) match(x, (got as Obj)[k], all, `${path}.${k}`);
    return;
  }
  if (want === null) return void assert.equal(got ?? null, null, path);
  assert.equal(strOf(got), strOf(want), path);
  assert.equal(typeof want === "boolean", typeof got === "boolean", `${path} төрөл`);
}

function parseCookie(sc: string): Record<string, string> {
  const out: Record<string, string> = {};
  sc.split(";").forEach((part, i) => {
    const p = part.trim();
    const eq = p.indexOf("=");
    if (i === 0) out[""] = p.slice(eq + 1);
    else out[(eq < 0 ? p : p.slice(0, eq)).toLowerCase()] = eq < 0 ? "true" : p.slice(eq + 1);
  });
  return out;
}

function checkStep(e: Obj, r: Res, all: Res[]) {
  if (e.status !== undefined) assert.equal(r.status, e.status, "status");
  const keys = Object.keys(r.json ?? {}).sort();
  if (e.jsonKeys) assert.deepEqual(keys, [...e.jsonKeys].sort(), "jsonKeys");
  if (e.sameKeysAs !== undefined) assert.deepEqual(keys, Object.keys(all[e.sameKeysAs]!.json ?? {}).sort(), "sameKeysAs");
  if (e.json) match(e.json, r.json, all, "json");
  if (e.location !== undefined) match(e.location, r.headers["location"]?.[0], all, "location");
  for (const [k, v] of Object.entries((e.headers ?? {}) as Record<string, string>)) assert.equal(r.headers[k.toLowerCase()]?.[0], v, `header ${k}`);
  if (e.noSetCookie) assert.equal(r.cookie, undefined, "Set-Cookie байх ёсгүй");
  if (e.setCookie) {
    const c = r.cookie;
    assert.ok(c, "Set-Cookie алга");
    if (e.setCookie.cleared) assert.ok(c[""] === "" && c["max-age"] === "0", `cookie цэвэрлэгдээгүй ${JSON.stringify(c)}`);
    if (e.setCookie.value !== undefined) match(e.setCookie.value, c[""], all, "cookie value");
    for (const k of (e.setCookie.absentAttributes ?? []) as string[]) assert.ok(!(k.toLowerCase() in c), `cookie ${k} байх ёсгүй`);
    for (const [k, v] of Object.entries((e.setCookie.attributes ?? {}) as Obj)) {
      if (v === true) assert.ok(k.toLowerCase() in c, `cookie ${k}`);
      else match(v, c[k.toLowerCase()], all, `cookie ${k}`);
    }
  }
}

test("conformance: eidlogin scenarios", async () => {
  const f = load("eidlogin/scenarios.json");
  const failures: string[] = [];
  for (const sc of f.scenarios as Obj[]) {
    const cfg: Obj = { ...f.config, ...(sc.config ?? {}) };
    let rules: Rule[] = [...(sc.upstream ?? []), ...f.upstream];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      const ru = rules.find((x) => x.method === method && (x.path ? x.path === u.pathname : u.pathname.startsWith(x.pathPrefix)));
      if (!ru) return new Response('{"error":"not found"}', { status: 404, headers: { "Content-Type": "application/json" } });
      let body = ru.bodyText;
      if (body === undefined) {
        const b = { ...(ru.body ?? {}) };
        if (ru.expiresAtInSeconds) b.expiresAt = new Date(Date.now() + ru.expiresAtInSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
        body = JSON.stringify(b);
      }
      return new Response(body, { status: ru.status, headers: { "Content-Type": ru.contentType ?? "application/json" } });
    }) as typeof fetch;
    const client = new EidClient({ baseUrl: "https://rp.conformance.test", fetchImpl,
      credentials: { rpUUID: cfg.rpUUID, rpName: cfg.rpName, apiSecret: cfg.apiSecret } });
    const events: EidLoginEvent[] = [];
    const keys: string[] = [];
    // wireCookieName — хөтчийн харах нэр (cookieName "" = SDK-ийн анхдагч, README §eidlogin).
    const wire: string = cfg.wireCookieName || cfg.cookieName;
    const rateLimits = cfg.rateLimits
      ? Object.fromEntries(Object.entries(cfg.rateLimits as Record<string, Obj>).map(([k, r]) =>
        [k, { limit: r.max, windowMs: r.windowSeconds * 1000, ...(r.maxKeys ? { maxKeys: r.maxKeys } : {}) }]))
      : undefined;
    const ipSource = cfg.clientIp !== "none"; // эх үүсвэр: trustProxy (X-Real-IP)
    const login = createEidLogin({
      client,
      onSuccess: () => ({ redirect: "/dashboard" }),
      ...(cfg.callbackUrl ? { callbackUrl: cfg.callbackUrl } : {}),
      successRedirect: cfg.successRedirect,
      failureRedirect: cfg.failureRedirect,
      ttlMs: cfg.ttlSeconds * 1000,
      pollMs: cfg.pollMs,
      pushFloorMs: cfg.pushFloorMs,
      cookie: {
        ...(cfg.cookieName ? { name: cfg.cookieName } : {}),
        ...(cfg.cookieDomain ? { domain: cfg.cookieDomain } : {}),
        ...(cfg.cookiePath ? { path: cfg.cookiePath } : {}),
      },
      ...(cfg.revocation === "disabled" ? { revocation: false } : {}),
      decoy: cfg.decoy !== false,
      onError: () => {},
      onEvent: (e) => void events.push(e),
      ...(ipSource ? { trustProxy: 1 } : {}),
      ...(cfg.auditKeyHex ? { auditKey: Buffer.from(cfg.auditKeyHex, "hex") } : {}),
      ...(rateLimits ? { rateLimit: rateLimits } : {}),
      ...(cfg.recordRateLimitKeys ? { rateLimit: async (k: string) => (keys.push(k), true) } : {}),
    });
    const results: Res[] = [];
    try {
      for (const [i, st] of (sc.steps as Obj[]).entries()) {
        if (st.upstream) rules = [...st.upstream, ...rules];
        for (let n = 0; n < (st.repeat ?? 1); n++) {
          const q = st.request;
          const headers: Record<string, string> = {};
          if (q.json !== undefined) headers["content-type"] = "application/json";
          for (const [k, v] of Object.entries((q.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
          if (q.cookieFrom !== undefined && results[q.cookieFrom]?.cookie) {
            const pair = `${wire}=${results[q.cookieFrom]!.cookie![""]}`;
            headers.cookie = q.cookieHeader ? String(q.cookieHeader).split("$cookieFrom").join(pair) : pair;
          }
          if (q.ip && ipSource) headers["x-real-ip"] = q.ip;
          const req: EidLoginRequest = { method: q.method, url: q.path, headers,
            ...(q.json !== undefined ? { body: q.json } : q.text !== undefined ? { body: q.text } : {}) };
          const res = await login.handleRequest(req);
          const h: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = [v].flat();
          const r: Res = { status: res.status, headers: h };
          if ((h["content-type"]?.[0] ?? "").startsWith("application/json")) r.json = JSON.parse(res.body);
          const sc0 = (h["set-cookie"] ?? []).find((x) => x.startsWith(`${wire}=`));
          if (sc0) r.cookie = parseCookie(sc0);
          results[i] = r;
          try {
            checkStep(st.expect ?? {}, r, results);
          } catch (e) {
            throw new Error(`алхам ${i}: ${e instanceof Error ? e.message : e} (status ${r.status}, ${JSON.stringify(r.json)}, ${JSON.stringify(h["set-cookie"])})`);
          }
        }
      }
      if (sc.events) {
        assert.equal(events.length, sc.events.length, `events ${JSON.stringify(events)}`);
        sc.events.forEach((w: Obj, i: number) => {
          const g = events[i]!;
          assert.equal(g.kind, w.kind, `event ${i}`);
          if ("sessionId" in w) match(w.sessionId, g.sessionId === "" ? null : g.sessionId, results, `event ${i} sessionId`);
          if (w.meta) match(w.meta, JSON.parse(JSON.stringify(g.meta)), results, `event ${i} meta`);
        });
      }
      if (sc.rateLimitKeys) assert.deepEqual(keys, sc.rateLimitKeys, "rateLimitKeys");
    } catch (e) {
      failures.push(`${sc.name}: ${e instanceof Error ? e.message.split("\n").slice(0, 6).join(" ") : e}`);
    }
  }
  assert.deepEqual(failures, []);
});
