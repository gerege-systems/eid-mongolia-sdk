// Go FuzzValidatePDF-тэй дүйцэх детерминист mutation тест: golden PDF + бүтцийн seed-үүдийг seed-тэй PRNG-ээр эвдэж
// (байт солих, таслах, хэсэг давхарлах, `[`/`<<`/`0 R` оруулах) validatePdf / prepare нь ЗӨВХӨН тайлан эсвэл
// ValidatePdfError / PadesError буцаахыг, нэг оролтод хугацаа хэтрэхгүйг шалгана. EID_FUZZ_ITER-ээр давталтыг нэмнэ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as pades from "../dist/pades.js";
import { validatePdf, ValidatePdfError } from "../dist/validate.js";

const F = new URL("./fixtures/pades/", import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, F)));
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`golden/pki/${n}.pem`, F))).raw);

const SEEDS = [
  "golden/output/quartz-pdf13.pdf",
  "golden/output/quartz-objstm.pdf",
  "golden/output/desktop-objstm-nopage.pdf",
  "validate/input/deep-nesting-objstm.pdf",
  "validate/input/encrypted-aes-128.pdf",
  "fuzz/objstm-cycle-c8b2f6dc9d5d37bf.pdf",
].map(read);
const ITER = Number(process.env.EID_FUZZ_ITER ?? 150);
const PER_CASE_MS = 5000;
const INSERTS = ["[", "[[[[[[[[", "<<", ">>", " 0 R", " 1 0 R ", "/Type /ObjStm", "/Size 99999999999", "endobj", "stream\n", "/Extends 3 0 R"].map(
  (s) => Uint8Array.from(Buffer.from(s, "latin1")),
);

/** mulberry32 — тогтмол seed-тэй PRNG (давтагдах). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(src: Uint8Array, rnd: () => number): Uint8Array {
  let b: Uint8Array = src.slice();
  const n = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) {
    const at = Math.floor(rnd() * b.length);
    switch (Math.floor(rnd() * 5)) {
      case 0: // байт солих
        for (let i = 0; i < 1 + rnd() * 8 && at + i < b.length; i++) b[at + i] = Math.floor(rnd() * 256);
        break;
      case 1: // таслах
        b = b.subarray(0, Math.max(8, at));
        break;
      case 2: {
        // хэсэг давхарлах
        const len = Math.floor(rnd() * 512);
        const from = Math.floor(rnd() * b.length);
        b = Uint8Array.from([...b.subarray(0, at), ...b.subarray(from, from + len), ...b.subarray(at)]);
        break;
      }
      default: {
        const ins = INSERTS[Math.floor(rnd() * INSERTS.length)]!;
        const rep = 1 + Math.floor(rnd() * 64);
        const parts: number[] = [];
        for (let i = 0; i < rep; i++) parts.push(...ins);
        b = Uint8Array.from([...b.subarray(0, at), ...parts, ...b.subarray(at)]);
      }
    }
  }
  return b;
}

async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what}: ${PER_CASE_MS} мс хэтэрсэн`)), PER_CASE_MS)));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

test(`validatePdf / prepare fuzz (${ITER} mutation): зөвхөн тайлан эсвэл кодтой алдаа`, async () => {
  const rnd = prng(0x5eed);
  const signer = { signerCert: pem("citizen"), chain: ["04", "03", "02"].map(pem) };
  for (let i = 0; i < ITER; i++) {
    const doc = mutate(SEEDS[i % SEEDS.length]!, rnd);
    const tag = `#${i} (seed ${i % SEEDS.length}, ${doc.length} B)`;
    try {
      const rep = await within(validatePdf(doc, { offline: true }), `validatePdf ${tag}`);
      assert.ok(["valid", "invalid", "indeterminate"].includes(rep.indication), tag);
    } catch (e) {
      assert.ok(e instanceof ValidatePdfError, `validatePdf ${tag}: ${e instanceof Error ? e.stack : String(e)}`);
    }
    try {
      await within(pades.prepare(doc, signer), `prepare ${tag}`);
    } catch (e) {
      assert.ok(e instanceof pades.PadesError, `prepare ${tag}: ${e instanceof Error ? e.stack : String(e)}`);
    }
  }
});
