// Гэрээний тест — сүлжээ шаарддаг тул `npm test`-д орохгүй: `npm run test:contract`.
// SDK-ийн дууддаг RP-API зам бүр (src/contract.ts) live /.well-known/eid-ийн endpoints-д байх ёстой; discovery-д
// байгаа ч SDK хамраагүй замууд WARN (fail биш). OIDC: SDK-ийн хүлээдэг утгууд discovery-тэй таарах ёстой.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BASE_URL, EID_ACR_ADVANCED, EID_ACR_QUALIFIED, EID_OIDC_ISSUER } from "../dist/index.js";
import { ID_TOKEN_CLAIMS, OIDC_EXPECT, RP_ROUTES, RP_ROUTES_UNDISCOVERED } from "../src/contract.ts";

const EID_DISCOVERY = "https://rp.eidmongolia.mn/.well-known/eid";

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  assert.equal(res.status, 200, `GET ${url}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** stderr-д; GitHub Actions дээр нэг нэгдсэн ::warning:: annotation. */
function warn(title: string, lines: string[]): void {
  for (const l of lines) process.stderr.write(`WARN: ${title}: ${l}\n`);
  if (lines.length > 0 && process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::warning title=${title}::${lines.join("%0A")}\n`);
  }
}

const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+)/;

/** endpoints мод доторх "METHOD URL …" мөр бүр (тайлбартай мөр ч орно). */
function collectEndpoints(v: unknown, out: { method: string; url: string }[] = []): { method: string; url: string }[] {
  if (typeof v === "string") {
    const m = ENDPOINT_RE.exec(v);
    if (m) out.push({ method: m[1]!, url: m[2]! });
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectEndpoints(x, out);
  }
  return out;
}

/** "METHOD /path/{}" — query хасаж, {param} нэрийг үл тооно. */
const normRoute = (method: string, path: string) => `${method} ${path.split("?")[0]!.replace(/\{[^}]*\}/g, "{}")}`;

test("RP-API: SDK-ийн зам бүр /.well-known/eid-д бий", async () => {
  const d = await getJson(EID_DISCOVERY);
  assert.equal(d.rp_api_base, DEFAULT_BASE_URL, "rp_api_base ≠ SDK DEFAULT_BASE_URL");
  const base = String(d.rp_api_base) + "/";

  const eps = collectEndpoints(d.endpoints);
  assert.ok(eps.length > 0, "discovery endpoints хоосон / танигдаагүй");
  // rp_api_base доорх замуудыг SDK-ийн замтай тулгана; бусад хост (ca. public г.м.) зөвхөн WARN-д.
  const rpKey = (e: { method: string; url: string }) =>
    e.url.startsWith(base) ? normRoute(e.method, "/" + e.url.slice(base.length)) : undefined;
  const rp = new Set(eps.map(rpKey).filter((k) => k !== undefined));

  const covered = new Set<string>();
  const missing: string[] = [];
  for (const r of Object.values(RP_ROUTES)) {
    const k = normRoute(r.method, r.path);
    covered.add(k);
    if (!rp.has(k)) missing.push(`${r.method} ${r.path}`);
  }

  // CA-ийн гэрээнд (код + docs) байгаа ч discovery-д жагсаагдаагүй замууд — WARN; discovery-д орсон бол шилжүүлэх сануулга.
  const undiscovered: string[] = [];
  const nowDiscovered: string[] = [];
  for (const r of Object.values(RP_ROUTES_UNDISCOVERED)) {
    const k = normRoute(r.method, r.path);
    covered.add(k);
    (rp.has(k) ? nowDiscovered : undiscovered).push(`${r.method} ${r.path}`);
  }
  warn("SDK зам CA-д бий ч discovery-д алга", undiscovered);
  warn("discovery-д орсон — RP_ROUTES_UNDISCOVERED-оос RP_ROUTES руу шилжүүл", nowDiscovered);

  const uncovered = eps
    .filter((e) => {
      const k = rpKey(e);
      return k === undefined || !covered.has(k);
    })
    .map((e) => `${e.method} ${e.url}`)
    .sort();
  warn("discovery-д байгаа ч SDK хамраагүй", uncovered);

  assert.deepEqual(missing, [], "SDK зам discovery-д алга");
});

test("OIDC: SDK-ийн хүлээдэг утгууд openid-configuration-тэй таарна", async () => {
  const d = await getJson(EID_OIDC_ISSUER + "/.well-known/openid-configuration");
  assert.equal(d.issuer, EID_OIDC_ISSUER, "issuer");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    assert.ok(typeof d[k] === "string" && d[k].startsWith("https://"), `${k} = ${String(d[k])}`);
  }
  const has = (field: string, want: string) => {
    const list = d[field];
    assert.ok(Array.isArray(list) && list.includes(want), `${field} ${JSON.stringify(list)}-д SDK-ийн "${want}" алга`);
  };
  has("id_token_signing_alg_values_supported", OIDC_EXPECT.idTokenAlg);
  has("code_challenge_methods_supported", OIDC_EXPECT.pkceMethod);
  has("token_endpoint_auth_methods_supported", OIDC_EXPECT.tokenEndpointAuthMethod);
  has("response_types_supported", "code");
  has("scopes_supported", OIDC_EXPECT.defaultScope);
  has("acr_values_supported", EID_ACR_QUALIFIED);
  has("acr_values_supported", EID_ACR_ADVANCED);

  // EidIdTokenClaims-ийн талбар бүр claims_supported-д: required алга бол fail, optional бол WARN.
  const supported = Array.isArray(d.claims_supported) ? (d.claims_supported as string[]) : [];
  const absent = Object.entries(ID_TOKEN_CLAIMS).filter(([c]) => !supported.includes(c));
  warn(
    "claims_supported-д SDK-ийн optional claim алга",
    absent.filter(([, kind]) => kind === "optional").map(([c]) => c),
  );
  assert.deepEqual(
    absent.filter(([, kind]) => kind === "required").map(([c]) => c),
    [],
    `claims_supported ${JSON.stringify(supported)}-д SDK-ийн required claim алга`,
  );
});
