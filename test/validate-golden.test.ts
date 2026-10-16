// validatePdf conformance: Go SDK pades/testdata/validate (scripts/sync-pades-golden.mjs-ээр бэхэлсэн commit) — Go
// pades.ValidatePDF-ийн гаргасан тайлантай ЯГ ижил JSON (deep-equal). Онлайн OCSP/CRL = тогтмол fixture (сүлжээгүй).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const T = new URL("./fixtures/pades/", import.meta.url);
const V = new URL("validate/", T);

interface Case {
  name: string;
  input: string;
  offline: boolean;
  http?: Record<string, string>;
  nationalRoots?: boolean;
  time?: string;
  expect: Record<string, unknown>;
}
const M = JSON.parse(readFileSync(new URL("manifest.json", V), "utf8")) as { time: string; roots: string[]; issuers: string[]; cases: Case[] };
const der = (p: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(p, T))).raw);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

for (const c of M.cases) {
  test(`validatePdf golden: ${c.name}`, async () => {
    const doc = new Uint8Array(readFileSync(new URL(c.input, T)));
    const files = new Map(Object.entries(c.http ?? {}).map(([k, f]) => [k, new Uint8Array(readFileSync(new URL(f, V)))]));
    const fetch = async (url: string, init: { method: string; body?: Uint8Array }) => {
      const b = files.get(`${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`);
      return { status: b ? 200 : 404, arrayBuffer: async () => (b ?? new Uint8Array()).slice().buffer };
    };
    let got: unknown;
    try {
      got = await validatePdf(doc, {
        roots: c.nationalRoots ? undefined : M.roots.map(der),
        issuers: M.issuers.map(der),
        time: new Date(c.time ?? M.time),
        offline: c.offline,
        fetch,
      });
    } catch (e) {
      if (!(e instanceof ValidatePdfError)) throw e;
      got = { error: e.code };
    }
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.expect);
  });
}
