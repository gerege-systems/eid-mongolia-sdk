// Гэрээний тест — сүлжээ шаарддаг тул `npm test`-д орохгүй: `npm run test:contract`.
// SDK-ийн дууддаг RP-API зам бүр (src/contract.ts) live /.well-known/eid-ийн endpoints-д байх ёстой; discovery-д
// байгаа ч SDK хамраагүй замууд WARN (fail биш).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BASE_URL } from "../dist/index.js";
import { PDF_SIGNATURE_REGISTER_FIELDS, RP_ROUTES, RP_ROUTES_UNDISCOVERED } from "../src/contract.ts";

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

test("PAdES клиент тал: pdfSigning.clientSide.register ба /pdf/signatures-ийн талбарууд CA-тай ижил", async () => {
  const d = await getJson(EID_DISCOVERY);
  const base = String(d.rp_api_base);
  const ps = (d.pdfSigning ?? {}) as { clientSide?: Record<string, unknown> };
  assert.ok(ps.clientSide, "pdfSigning.clientSide алга");
  assert.equal(ps.clientSide.register, base + RP_ROUTES.pdfSignatures.path, "pdfSigning.clientSide.register");
  const desc = String(((d.endpoints ?? {}) as { pdf?: Record<string, unknown> }).pdf?.signatures ?? "");
  assert.ok(desc.startsWith(`POST ${base}/pdf/signatures`), `endpoints.pdf.signatures: ${desc}`);
  const m = /\{([^}]*)\}/.exec(desc);
  assert.ok(m, "endpoints.pdf.signatures-д {талбарууд} алга");
  const live = m[1]!.split(",").map((x) => x.trim().replace(/\?$/, "")).filter(Boolean).sort();
  assert.deepEqual(live, [...PDF_SIGNATURE_REGISTER_FIELDS].sort(), "SDK-ийн бие ↔ CA dto.PDFSignatureRegisterRequest");
});
