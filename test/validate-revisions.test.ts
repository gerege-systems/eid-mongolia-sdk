// Revision classifier-ийн differential тест: Go SDK pades/internal/validate (CA-ийн нийтийн шалгагчийн код)-ийн
// Extract-ийн оролт/гаралтын corpus (EID_VALIDATE_CORPUS=<dir> go test ./pades/internal/validate) дээр TS порт
// (src/pades/validate/revisions.ts) гарын үсэг бүрд ЯГ ижил LaterChanges гаргах ёстой. Env байхгүй бол skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = process.env.EID_VALIDATE_CORPUS;

interface CorpusSig {
  malformed: boolean;
  covers_whole: boolean;
  signed_end?: number;
  later_signatures_only: boolean;
  later_signatures: number;
  later_visible: boolean;
  obj_num: number;
  byte_range: number[] | null;
}
interface CorpusEntry {
  profile: "own" | "broad";
  error?: string;
  docId: string;
  metas?: Record<string, { revIndex: number; role: string; roleOK: boolean }>;
  signatures: CorpusSig[];
}

test("revisions: Go corpus-тэй ижил", { skip: !dir }, async () => {
  // src-ийг (NodeNext .js импорттой) нэг ESM болгон багцлана.
  const out = join(mkdtempSync(join(tmpdir(), "eid-rev-")), "revisions.mjs");
  const r = await build({
    entryPoints: [fileURLToPath(new URL("../src/pades/validate/revisions.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "error",
  });
  writeFileSync(out, r.outputFiles[0]!.contents);
  const { Revisions } = (await import(pathToFileURL(out).href)) as typeof import("../src/pades/validate/revisions.ts");

  let checked = 0;
  const bad: string[] = [];
  for (const f of readdirSync(dir!).filter((x) => x.endsWith(".json")).sort()) {
    const e = JSON.parse(readFileSync(join(dir!, f), "utf8")) as CorpusEntry;
    if (e.error) continue;
    const doc = new Uint8Array(readFileSync(join(dir!, f.replace(/-(own|broad)\.json$/, ".pdf"))));
    const known = new Map<number, number[]>();
    for (const s of e.signatures) if (!s.malformed && s.byte_range) known.set(s.obj_num, s.byte_range);
    const rev = new Revisions(doc, known, e.profile);
    for (const [k, m] of Object.entries(e.metas ?? {})) rev.sigs.set(Number(k), m);
    rev.docID = e.docId;
    for (const s of e.signatures) {
      if (s.malformed || s.covers_whole) continue;
      const got = await rev.later(s.signed_end ?? 0);
      const want = { signaturesOnly: s.later_signatures_only, signatures: s.later_signatures, visible: s.later_visible };
      checked++;
      if (got.signaturesOnly !== want.signaturesOnly || got.signatures !== want.signatures || got.visible !== want.visible) {
        bad.push(`${f} obj ${s.obj_num}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
  }
  console.log(`revisions corpus: ${checked - bad.length}/${checked} таарсан`);
  assert.deepEqual(bad, []);
  assert.ok(checked > 0);
});

// extract() бүхэлдээ (RawSignature-ийн талбар бүр — байтыг base64-аар) Go Extract-тэй ижил эсэх.
test("extract: Go corpus-тэй ижил", { skip: !dir }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "eid-ext-")), "extract.mjs");
  const r = await build({
    entryPoints: [fileURLToPath(new URL("../src/pades/validate/extract.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "error",
  });
  writeFileSync(out, r.outputFiles[0]!.contents);
  const { extract, ExtractError } = (await import(pathToFileURL(out).href)) as typeof import("../src/pades/validate/extract.ts");
  const b64 = (b?: Uint8Array) => (b ? Buffer.from(b).toString("base64") : undefined);
  const t = (x?: { sec?: number; nanos: number }) => {
    if (!x) return undefined;
    if (x.sec === undefined) return "0001-01-01T00:00:00Z";
    const s = new Date(x.sec * 1000).toISOString().replace(".000Z", "");
    return s + (x.nanos ? "." + String(x.nanos).padStart(9, "0").replace(/0+$/, "") : "") + "Z";
  };
  let checked = 0;
  const bad: string[] = [];
  for (const f of readdirSync(dir!).filter((x) => x.endsWith(".json")).sort()) {
    const e = JSON.parse(readFileSync(join(dir!, f), "utf8")) as CorpusEntry & { signatures: Record<string, unknown>[] };
    const doc = new Uint8Array(readFileSync(join(dir!, f.replace(/-(own|broad)\.json$/, ".pdf"))));
    checked++;
    let got: unknown;
    try {
      const ex = await extract(doc, e.profile);
      got = ex.sigs.map((s) => {
        const o: Record<string, unknown> = {
          signer_name: s.signerName,
          reason: s.reason,
          location: s.location,
          claimed_time: t(s.claimedTime),
          malformed: s.malformed,
          integrity: s.integrity,
          weak_digest: s.weakDigest,
          covers_whole: s.coversWhole,
          later_signatures_only: s.laterSignaturesOnly,
          later_signatures: s.laterSignatures,
          later_visible: s.laterVisible,
          visible: s.visible,
          signed_end: s.signedEnd || undefined,
          leaf: b64(s.leaf),
          certs: s.certs.length ? s.certs.map(b64) : undefined,
          timestamp: s.timestamp && {
            time: t(s.timestamp.time),
            serial: s.timestamp.serial,
            matches: s.timestamp.matches,
            weak_digest: s.timestamp.weakDigest,
            tsa_cert: b64(s.timestamp.tsaCert),
            certs: s.timestamp.certs.length ? s.timestamp.certs.map(b64) : undefined,
          },
          sub_filter: s.subFilter || undefined,
          signing_cert_v2: s.signingCertV2 || undefined,
          signing_time_attr: s.signingTimeAttr || undefined,
          claimed_roles: s.claimedRoles.length ? s.claimedRoles : undefined,
          cms_sha256: s.cmsSha256 || undefined,
          message_digest: s.messageDigest || undefined,
          dss: s.dss && {
            certs: s.dss.certs.length ? s.dss.certs.map(b64) : undefined,
            ocsps: s.dss.ocsps.length ? s.dss.ocsps.map(b64) : undefined,
            crls: s.dss.crls.length ? s.dss.crls.map(b64) : undefined,
          },
          obj_num: s.objNum,
          byte_range: s.byteRange ?? null,
        };
        return JSON.parse(JSON.stringify(o));
      });
    } catch (err) {
      if (!(err instanceof ExtractError)) throw err;
      got = err.code;
    }
    const want = e.error ? e.error : e.signatures;
    try {
      assert.deepEqual(got, JSON.parse(JSON.stringify(want)));
    } catch (err) {
      bad.push(`${f}: ${(err as Error).message.slice(0, 600)}`);
    }
  }
  console.log(`extract corpus: ${checked - bad.length}/${checked} таарсан`);
  assert.deepEqual(bad, []);
});
