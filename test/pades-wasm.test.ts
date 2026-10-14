// /pades (Go core → WASM): WASM-ын гаралтыг НАТИВ Go core-ийн golden vector-той (test/fixtures/pades/vectors.json,
// scripts/pades-vectors/main.go) байт-байтаар тулгана. dist/eid-pades.wasm алга бол (npm run build:wasm хийгээгүй)
// WASM шаардсан тестүүд skip — CI wasm-ыг build хийдэг тул тэнд заавал ажиллана.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

import * as pades from "../dist/pades.js";

const FIX = new URL("./fixtures/pades/", import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, FIX)));
const der = (name: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(name, FIX))).raw);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Vectors {
  prepare: { name: string; input: string; options: Record<string, unknown>; dtbs?: string; digest?: string; docId?: string; error?: string }[];
  verify: { name: string; input: string; time: string; report: unknown }[];
}
const V = JSON.parse(readFileSync(new URL("vectors.json", FIX), "utf8")) as Vectors;
const hasWasm = existsSync(new URL("../dist/eid-pades.wasm", import.meta.url));
const wasmTest = hasWasm ? test : test.skip;
if (!hasWasm) process.stderr.write("WARN: dist/eid-pades.wasm алга — WASM golden тест skip (npm run build:wasm)\n");

const LEAF = der("leaf.pem");
const ROOT = der("root.pem");

wasmTest("pades.prepare — НАТИВ Go-той байт-ижил (dtbs, digest, docId) ба алдааны код", async () => {
  assert.equal(await pades.profileVersion(), "pades-client/1");
  for (const v of V.prepare) {
    const o = v.options as Record<string, string | boolean | undefined>;
    const opts: pades.PadesPrepareOptions = {
      signerCert: LEAF,
      chain: [ROOT],
      signerName: o.signerName as string | undefined,
      reason: o.reason as string | undefined,
      claimedRole: o.claimedRole as string | undefined,
      signingTime: o.signingTime ? new Date(o.signingTime as string) : undefined,
      docId: o.docId as string | undefined,
      verifyPage: o.verifyPage as boolean | undefined,
      fileName: o.fileName as string | undefined,
      lang: o.lang as "mn" | "en" | undefined,
    };
    if (v.error) {
      await assert.rejects(() => pades.prepare(read(v.input), opts), (e: unknown) => e instanceof pades.PadesError && e.code === v.error, v.name);
      continue;
    }
    const p = await pades.prepare(read(v.input), opts);
    assert.equal(hex(p.dtbs), v.dtbs, `${v.name}: dtbs`);
    assert.equal(hex(p.digest), v.digest, `${v.name}: digest`);
    assert.equal(p.docId, v.docId, `${v.name}: docId`);
    assert.ok(p.state.length > 0);
  }
});

// Go core-ийн албан golden (eid-mongolia-sdk-go pades/testdata/golden/manifest.json) — prepare хэсэг. complete-ийн
// хэсэг (TSA/OCSP/CRL-ийн тогтмол хариу inject) Go-ийн өөрийн тестэд; WASM-д HTTP client inject хийх боломжгүй.
interface Golden {
  signingTime: string;
  cases: { name: string; input: string; prepare: Record<string, unknown>; expect: Record<string, unknown> }[];
}
const GD = "golden/";
const G = JSON.parse(readFileSync(new URL(GD + "manifest.json", FIX), "utf8")) as Golden;

wasmTest("pades.prepare — Go core-ийн албан golden manifest (dtbs, digest, docId, алдааны код)", async () => {
  const chain = ["04.pem", "03.pem", "02.pem"].map((n) => der(GD + "pki/" + n));
  let n = 0;
  for (const c of G.cases) {
    if (c.input.startsWith("case:")) continue; // өмнөх case-ийн complete гаралт дээр — WASM-д complete inject-гүй
    const o = c.prepare as Record<string, string | boolean | undefined>;
    const opts: pades.PadesPrepareOptions = {
      signerCert: der(GD + "pki/citizen.pem"),
      chain,
      roots: [der(GD + "pki/root.pem")],
      signingTime: new Date(G.signingTime),
      reason: o.reason as string | undefined,
      claimedRole: o.claimedRole as string | undefined,
      docId: o.docId as string | undefined,
      verifyPage: o.verifyPage as boolean | undefined,
      fileName: o.fileName as string | undefined,
      lang: o.lang as "mn" | "en" | undefined,
    };
    const input = read(GD + c.input);
    if (c.expect.error) {
      await assert.rejects(() => pades.prepare(input, opts), (e: unknown) => e instanceof pades.PadesError && e.code === c.expect.error, c.name);
    } else {
      const p = await pades.prepare(input, opts);
      assert.equal(hex(p.dtbs), c.expect.dtbs, `${c.name}: dtbs`);
      assert.equal(hex(p.digest), c.expect.digest, `${c.name}: digest`);
      assert.equal(p.docId, c.expect.docId, `${c.name}: docId`);
    }
    n++;
  }
  assert.ok(n >= 5, "golden case цөөн");
});

wasmTest("pades.verify — НАТИВ Go-ийн тайлантай ижил", async () => {
  for (const v of V.verify) {
    const r = await pades.verify(read(v.input), { roots: [ROOT], issuers: [ROOT], time: new Date(v.time) });
    assert.deepEqual(r, v.report, v.name);
  }
  const empty = await pades.verify(read("base-quartz.pdf"));
  assert.equal(empty.indication, "valid");
});

wasmTest("pades.complete — буруу гарын үсэг SIGNATURE_INVALID (сүлжээгүй), эвдэрсэн state STATE_INVALID", async () => {
  const p = await pades.prepare(read("base-quartz.pdf"), { signerCert: LEAF, chain: [ROOT] });
  await assert.rejects(
    () => pades.complete(p.state, new Uint8Array(64).fill(1)),
    (e: unknown) => e instanceof pades.PadesError && e.code === "SIGNATURE_INVALID" && !e.retryable,
  );
  await assert.rejects(
    () => pades.complete(new Uint8Array([1, 2, 3]), "AQID"),
    (e: unknown) => e instanceof pades.PadesError && e.code === "STATE_INVALID",
  );
});

wasmTest("pades — options-ийн үл мэдэгдэх утга → REQUEST_INVALID; signerCert буруу → SIGNER_INVALID", async () => {
  await assert.rejects(() => pades.prepare(read("base-quartz.pdf"), { signerCert: new Uint8Array([1]) }),
    (e: unknown) => e instanceof pades.PadesError && e.code === "SIGNER_INVALID");
  await assert.rejects(() => pades.prepare(read("base-quartz.pdf"), { signerCert: LEAF, chain: [ROOT], lang: "de" as "en" }),
    (e: unknown) => e instanceof pades.PadesError && e.code === "REQUEST_INVALID");
});

test("PadesError — код, retryable; үндсэн entry WASM-гүй", async () => {
  const e = new pades.PadesError("TSA_UNAVAILABLE", "x");
  assert.equal(e.retryable, true);
  assert.equal(e.message, "TSA_UNAVAILABLE: x");
  assert.equal(new pades.PadesError("SIGNATURE_INVALID", "x").retryable, false);
  assert.ok(pades.PADES_ERROR_CODES.includes("PDF_LOCKED"));
  const main = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.ok(!main.includes("eidPades") && !main.includes("eid-pades.wasm"), "үндсэн entry WASM татаж байна");
});
