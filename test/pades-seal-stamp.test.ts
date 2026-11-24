// Organisation seal stamp (APPEARANCE_SPEC.md §6, golden v12): the variant rule (§6.1) on hand-made certificate shapes
// and on the golden PKI, the seal content stream (§6.2) and prepare's variant choice. Byte-identity with the Go reference
// is in pades-golden.test.ts (seal-visible, seal-visible-en, seal-visible-third); the validator verdicts (§6.3, both
// mismatch directions) in validate-golden.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { build } from "esbuild";

import { isSealCertificate } from "../dist/index.js";
import * as pades from "../dist/pades.js";

const T = new URL("./fixtures/pades/", import.meta.url);
const G = new URL("golden/", T);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pemAt = (u: URL) => new Uint8Array(new X509Certificate(readFileSync(u)).raw);
const pem = (n: string) => pemAt(new URL(`pki/${n}.pem`, G));

interface FakeCert {
  isCA: boolean;
  keyUsage: number;
  extensions: { oid: string; critical: boolean; value: Uint8Array }[];
}
interface Internals {
  sealCertificate(c: FakeCert): boolean;
  sealCertificateDER(der: Uint8Array | undefined): boolean;
  appearanceContent(p: Record<string, unknown>): string;
  AppearanceError: new (...a: unknown[]) => Error;
}

/** src (NodeNext .js imports) bundled into one ESM — the rule and the content stream are internal. */
async function internals(): Promise<Internals> {
  const r = await build({
    stdin: {
      contents: [
        `export { sealCertificate, sealCertificateDER } from "./src/pades/x509.ts";`,
        `export { appearanceContent, AppearanceError } from "./src/pades/page/appearance.ts";`,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "error",
  });
  const out = join(mkdtempSync(join(tmpdir(), "eid-seal-stamp-")), "seal-stamp.mjs");
  writeFileSync(out, r.outputFiles[0]!.contents);
  return (await import(pathToFileURL(out).href)) as Internals;
}

const I = await internals();

const EKU = "2.5.29.37";
const KU = "2.5.29.15";
const DIGITAL_SIGNATURE = 1;
const NON_REPUDIATION = 2;
const KEY_ENCIPHERMENT = 4;

test("§6.1: e-Seal = not a CA, keyUsage nonRepudiation set and digitalSignature clear, no EKU extension", () => {
  const ku = { oid: KU, critical: true, value: new Uint8Array() };
  const eku = { oid: EKU, critical: false, value: new Uint8Array([0x30, 0x00]) };
  const c = (isCA: boolean, keyUsage: number, ...extensions: FakeCert["extensions"]): FakeCert => ({ isCA, keyUsage, extensions });
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION, ku)), true);
  // Other bits are ignored.
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION | KEY_ENCIPHERMENT, ku)), true);
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION | DIGITAL_SIGNATURE, ku)), false, "citizen SIGN: digitalSignature set");
  assert.equal(I.sealCertificate(c(false, DIGITAL_SIGNATURE, ku)), false);
  assert.equal(I.sealCertificate(c(false, 0)), false, "no keyUsage extension");
  assert.equal(I.sealCertificate(c(true, NON_REPUDIATION, ku)), false, "CA");
  // Any extendedKeyUsage extension — even an empty SEQUENCE — is not an e-Seal certificate (§6.1 item 3).
  assert.equal(I.sealCertificate(c(false, NON_REPUDIATION, ku, eku)), false, "EKU present");
});

test("§6.1 on the golden PKI; unparsable DER is not an e-Seal certificate; same answer as isSealCertificate", () => {
  const cases: [string, Uint8Array, boolean][] = [
    ["golden seal", pem("seal"), true],
    ["golden citizen", pem("citizen"), false],
    ["golden 04 (CA)", pem("04"), false],
    ["golden root", pem("root"), false],
    ["golden tsa (EKU)", pem("tsa"), false],
    ["seal fixture (ECDSA)", pemAt(new URL("seal/seal.pem", T)), true],
  ];
  for (const [name, der, want] of cases) {
    assert.equal(I.sealCertificateDER(der), want, name);
    assert.equal(isSealCertificate(der), want, `${name}: isSealCertificate`);
  }
  assert.equal(I.sealCertificateDER(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])), false);
  assert.equal(I.sealCertificateDER(undefined), false);
});

const P = { w: 22000, h: 6400, rotate: 0, name: "TEST ONLY Golden Org LLC", role: "Захирал", lang: "mn", date: "2026-10-14 12:00 (+08)", url: "" };

test("§6.2 seal content: no BDC / QR / role line, text at x = pad, frame as the citizen stamp", () => {
  const s = I.appearanceContent({ ...P, seal: true });
  assert.ok(!s.includes("EIDVerify") && !s.includes("BDC") && !s.includes("EMC"), "no marked content");
  assert.ok(!s.includes(" cm\n"), "no QR / no rotation cm");
  const lines = s.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["0.086 0.541 0.31 RG", "1 w", "0.5 0.5 219 63 re S"]);
  const td = lines.filter((l) => l.startsWith("BT "));
  assert.equal(td.length, 3, "name, label, date — the claimedRole is not drawn");
  assert.match(td[0]!, /^BT \/F2 11 Tf 4 [0-9.]+ Td <[0-9A-F]+> Tj ET$/);
  assert.match(td[1]!, /^BT \/F1 9 Tf 4 [0-9.]+ Td /);
  assert.match(td[2]!, /^BT \/F1 9 Tf 4 [0-9.]+ Td /);
  assert.deepEqual(lines.filter((l) => l.endsWith(" rg")), ["0.118 0.118 0.118 rg", "0.086 0.541 0.31 rg", "0.431 0.431 0.431 rg"]);
  // mn and en differ only in the label line.
  const en = I.appearanceContent({ ...P, seal: true, lang: "en" }).split("\n");
  assert.equal(en.filter((l, i) => l !== lines[i]).length, 1);
  // Rotation: the same q / cm / Q wrapper as the citizen stamp.
  const r = I.appearanceContent({ ...P, seal: true, rotate: 90 }).split("\n");
  assert.deepEqual(r.slice(0, 2), ["q", "0 1 -1 0 64 0 cm"]);
  assert.equal(r.at(-2), "Q");
});

test("§6.2 fit: no QR minimum — the smallest one-line-name height is 29.25 pt (f = 7); citizen needs ≥ 45 pt", () => {
  assert.match(I.appearanceContent({ ...P, seal: true, h: 2925 }), /BT \/F2 7 Tf/);
  assert.throws(() => I.appearanceContent({ ...P, seal: true, h: 2924 }), I.AppearanceError);
  assert.throws(() => I.appearanceContent({ ...P, seal: true, w: 800 }), I.AppearanceError, "tw = 0");
  assert.throws(() => I.appearanceContent({ ...P, seal: true, lang: "de" }), I.AppearanceError);
  assert.throws(
    () => I.appearanceContent({ ...P, h: 2925, url: "https://ca.eidmongolia.mn/verify/00000000-0000-4000-8000-000000000000/1" }),
    I.AppearanceError,
  );
});

/** The prepared PDF inside a prepare state ("EIDPADES1" ‖ uint32 ‖ JSON ‖ PDF). */
function preparedPdf(state: Uint8Array): string {
  const st = Buffer.from(state);
  return st.subarray(13 + st.readUInt32BE(9)).toString("latin1");
}

test("prepare: the signer certificate alone selects the stamp variant", async () => {
  const input = new Uint8Array(readFileSync(new URL("input/quartz-pdf13.pdf", G)));
  const chain = ["04", "03", "02"].map(pem);
  const appearance: pades.PadesAppearance = { x: 340, y: 36, width: 220, height: 64 };
  const opts = { chain, signingTime: new Date("2026-10-14T12:00:00+08:00"), appearance };
  const seal = await pades.prepare(input, { ...opts, signerCert: pem("seal") });
  const citizen = await pades.prepare(input, { ...opts, signerCert: pem("citizen") });
  assert.ok(!preparedPdf(seal.state).includes("/EIDVerify"), "seal: no /EIDVerify marker");
  assert.ok(preparedPdf(citizen.state).includes("/EIDVerify"), "citizen: /EIDVerify marker");
  assert.deepEqual(seal.placement, citizen.placement, "placement does not depend on the variant");
  // A 30 pt stamp fits the seal (no QR) but not the citizen stamp (QR module ≥ 1 pt → ≥ 45 pt).
  const small = { ...opts, appearance: { ...appearance, height: 30 } };
  await pades.prepare(input, { ...small, signerCert: pem("seal") });
  await assert.rejects(
    () => pades.prepare(input, { ...small, signerCert: pem("citizen") }),
    (e: unknown) => e instanceof pades.PadesError && e.code === "REQUEST_INVALID",
  );
});
