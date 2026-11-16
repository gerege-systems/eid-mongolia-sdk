// complete-ийн DSS цуглуулалтын OCSP цонх (src/pades/ltv.ts collectLTV): гинжийн OCSP-ууд зэрэг; хүчинтэй CRL-тэй CA
// гэрчилгээний (гинжийн эхнийхээс бусад) OCSP цуглуулалт эхэлснээс хойш OCSP_GRACE_MS л, навчных — бүрэн timeout. Golden
// тестийн PKI/HTTP fixture дээр, src-ийг esbuild-ээр багцалж хуурамч цаг (GraceClock)-аар — бодит секундын хүлээлтгүй.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import * as pades from "../dist/pades.js";

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => void unhandled.push(e));

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const V = new URL("./fixtures/pades/validate/", import.meta.url);
const read = (u: URL) => new Uint8Array(readFileSync(u));
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const sha16 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const M = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as {
  signingTime: string;
  now: string;
  http: Record<string, string>;
  cases: { name: string; input: string; prepare: Record<string, unknown>; expect: Record<string, unknown> }[];
};

// Иргэн (04-өөс) — OCSP ocsp.pki.test/04 + CRL 04.crl; 04 (03-аас) — OCSP ocsp.pki.test/03 + CRL 03.crl; 03, 02 — CRL л.
const LEAF_OCSP = "POST http://ocsp.pki.test/04";
const CA04_OCSP = "POST http://ocsp.pki.test/03";
const LEAF_CRL = "GET http://crl.pki.test/04.crl";
const fixture = (k: string): Uint8Array => {
  const hit = Object.entries(M.http).filter(([key]) => key.startsWith(k + " "));
  assert.ok(hit.length > 0, `golden-д ${k} алга`);
  return read(new URL(hit[0]![1], G));
};
const LEAF_OCSP_DER = read(new URL(M.http[`${LEAF_OCSP} 3d432940c5514c0a`]!, G));
const CA04_OCSP_DER = fixture(CA04_OCSP);
const CRLS = ["04", "03", "02", "root"].map((n) => fixture(`GET http://crl.pki.test/${n}.crl`));

// src/pades-ийн дотоод модулийг нэг ESM болгон (NodeNext .js импорттой) багцлана.
interface Bundle {
  collectLTV: (...a: unknown[]) => Promise<{ certs: Uint8Array[]; ocsps: Uint8Array[]; crls: Uint8Array[] }>;
  OCSP_GRACE_MS: number;
  Fetcher: new (fn: unknown, upgrade: boolean, signal?: AbortSignal) => unknown;
  parseCertificate: (der: Uint8Array) => { raw: Uint8Array; serial: Uint8Array };
  parseOCSP: (der: Uint8Array, serial: bigint, issuer: undefined) => Promise<{ thisUpdate: { date: Date; nanos: number } }>;
  intValue: (v: Uint8Array) => bigint;
  CertificateRevokedError: new () => Error;
  LTVError: new () => Error;
}
let bundle: Promise<Bundle> | undefined;
function load(): Promise<Bundle> {
  bundle ??= (async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = await build({
      stdin: {
        contents: [
          `export { collectLTV, parseOCSP, OCSP_GRACE_MS, LTVError } from "./src/pades/ltv.ts";`,
          `export { Fetcher } from "./src/pades/fetch.ts";`,
          `export { parseCertificate } from "./src/pades/x509.ts";`,
          `export { CertificateRevokedError } from "./src/pades/revocation.ts";`,
          `export { intValue } from "./src/pades/asn1.ts";`,
        ].join("\n"),
        resolveDir: root,
        loader: "ts",
        sourcefile: "ltv-entry.ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
      logLevel: "error",
    });
    const out = join(mkdtempSync(join(tmpdir(), "eid-ltv-")), "ltv.mjs");
    writeFileSync(out, r.outputFiles[0]!.contents);
    return (await import(pathToFileURL(out).href)) as Bundle;
  })();
  return bundle;
}

/** Хуурамч цаг: `now` нь t; `after` бүртгэнэ; `advanceTo` хугацаа нь болсныг дуудна. */
function fakeClock() {
  const c = {
    t: 0,
    afterCalls: 0,
    timers: [] as { at: number; fn: () => void }[],
    now: () => c.t,
    after: (ms: number, fn: () => void) => {
      c.afterCalls++;
      const x = { at: c.t + ms, fn };
      c.timers.push(x);
      return () => {
        const i = c.timers.indexOf(x);
        if (i >= 0) c.timers.splice(i, 1);
      };
    },
    advanceTo: (at: number) => {
      c.t = at;
      for (const x of c.timers.filter((y) => y.at <= at)) {
        c.timers.splice(c.timers.indexOf(x), 1);
        x.fn();
      }
    },
  };
  return c;
}

type Resp = { status: number; arrayBuffer(): Promise<ArrayBuffer> };
type Init = { method: string; body?: Uint8Array; signal?: AbortSignal };
/** "hang" — signal хүртэл хариугүй (TCP хүлээж аваад хариулдаггүй responder); тоо — HTTP статус; байт; функц. */
type Behaviour = "hang" | number | Uint8Array | ((init: Init) => Promise<Resp>);

const ok = (b: Uint8Array): Resp => ({ status: 200, arrayBuffer: async () => b.slice().buffer as ArrayBuffer });
function hang(init: Init): Promise<Resp> {
  return new Promise((_, reject) => {
    const s = init.signal;
    if (!s) return;
    if (s.aborted) reject(s.reason);
    s.addEventListener("abort", () => reject(s.reason ?? new Error("aborted")), { once: true });
  });
}

function fakeFetch(over: Record<string, Behaviour>) {
  const log: { key: string; signal?: AbortSignal }[] = [];
  const fn = (url: string, init: Init): Promise<Resp> => {
    const key = `${init.method} ${url}`;
    log.push({ key, signal: init.signal });
    const b = over[key];
    if (b === "hang") return hang(init);
    if (typeof b === "function") return b(init);
    if (typeof b === "number") return Promise.resolve({ status: b, arrayBuffer: async () => new ArrayBuffer(0) });
    if (b instanceof Uint8Array) return Promise.resolve(ok(b));
    const file = M.http[`${key} ${sha16(init.body ?? new Uint8Array())}`];
    if (!file) return Promise.resolve({ status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    return Promise.resolve(ok(read(new URL(file, G))));
  };
  const signalsOf = (key: string) => log.filter((x) => x.key === key).map((x) => x.signal!);
  return { fn, log, signalsOf };
}

/** Тестийн хүлээсэн OCSP: `resolve(bytes)` хүртэл хариугүй, signal-аар тасарна. */
function deferred() {
  let res!: (b: Uint8Array) => void;
  const p = new Promise<Uint8Array>((r) => (res = r));
  const behaviour = (init: Init): Promise<Resp> => Promise.race([p.then(ok), hang(init)]);
  return { behaviour, resolve: (b: Uint8Array) => res(b) };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`хүлээлт дууссангүй: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function setup(freshShiftMs = -1000) {
  const L = await load();
  const cert = (n: string) => L.parseCertificate(pem(n));
  const chain = ["citizen", "04", "03", "02"].map(cert);
  const roots = [L.parseCertificate(pem("root"))];
  // timestamp = иргэний OCSP-ийн thisUpdate − 1 с (healthy) — навчны «timestamp-аас хожуу» дүрэм биелнэ.
  const tu = (await L.parseOCSP(LEAF_OCSP_DER, L.intValue(chain[0]!.serial), undefined)).thisUpdate;
  const fresh = { date: new Date(tu.date.getTime() + freshShiftMs), nanos: tu.nanos };
  const run = (fetchFn: unknown, clock: ReturnType<typeof fakeClock>, signal?: AbortSignal, order?: string[]) =>
    L.collectLTV(new L.Fetcher(fetchFn, false, signal), new Date(M.now), fresh, roots, [order ? order.map(cert) : chain], clock);
  return { L, chain, run };
}

test("LTV: эрүүл гинж — DSS-ийн агуулга/дараалал дараалсан хувилбартай ижил (OCSP ба CRL хоёулаа)", async () => {
  const { chain, run } = await setup();
  const clock = fakeClock();
  const d = await run(fakeFetch({}).fn, clock);
  assert.deepEqual(d.ocsps, [LEAF_OCSP_DER, CA04_OCSP_DER]);
  assert.deepEqual(d.crls, CRLS);
  const chainRaw = chain.map((c) => c.raw);
  assert.deepEqual(
    d.certs.filter((c) => chainRaw.some((x) => Buffer.compare(x, c) === 0)),
    chainRaw,
  );
  assert.deepEqual(d.certs.slice(0, 1), [chainRaw[0]]);
  assert.equal(clock.t, 0);
  assert.equal(clock.timers.length, 0);
});

test("LTV: хариугүй CA (04) OCSP + хүчинтэй CRL → цонх (OCSP_GRACE_MS) дуусахад цуцлаад CRL-ээр", async () => {
  const { L, run } = await setup();
  const clock = fakeClock();
  const f = fakeFetch({ [CA04_OCSP]: "hang" });
  const p = run(f.fn, clock);
  await until(() => clock.timers.length === 1, "цонхны таймер");
  assert.equal(L.OCSP_GRACE_MS, 3000);
  assert.equal(clock.timers[0]!.at, L.OCSP_GRACE_MS);
  clock.advanceTo(L.OCSP_GRACE_MS);
  const d = await p;
  assert.deepEqual(d.ocsps, [LEAF_OCSP_DER]);
  assert.deepEqual(d.crls, CRLS);
  assert.ok(f.signalsOf(CA04_OCSP).every((s) => s.aborted));
  assert.ok(f.signalsOf(LEAF_OCSP).every((s) => !s.aborted));
  assert.equal(clock.t, L.OCSP_GRACE_MS);
});

// Цонх гинжийн байрлалаар (эхнийхээс бусад). Fixture PKI-д OCSP-тэй CA ганц (04) тул гинжийг root талаас нь өгч OCSP-тэй
// хоёр гэрчилгээг (04, иргэн) эхний байрлалаас хойш байрлуулна.
test("LTV: хоёр хариугүй CA OCSP + хүчинтэй CRL → нийт НЭГ цонх (цуглуулалт эхэлснээс)", async () => {
  const { L, run } = await setup();
  const clock = fakeClock();
  const f = fakeFetch({ [LEAF_OCSP]: "hang", [CA04_OCSP]: "hang" });
  const p = run(f.fn, clock, undefined, ["02", "03", "04", "citizen"]);
  await until(() => clock.timers.length === 1, "цонхны таймер");
  assert.equal(clock.timers[0]!.at, L.OCSP_GRACE_MS);
  // Хоёр OCSP зэрэг явж байна (дараалсан хувилбарт иргэнийх 04-ийнхийг хүлээнэ).
  await until(() => f.signalsOf(LEAF_OCSP).length === 1, "иргэний OCSP зэрэг");
  assert.equal(clock.t, 0);
  clock.advanceTo(L.OCSP_GRACE_MS);
  const d = await p;
  assert.deepEqual(d.ocsps, []);
  assert.deepEqual(d.crls, [...CRLS].reverse());
  assert.equal(clock.afterCalls, 1, "хоёр дахь OCSP-д дахин цонх өгсөн");
  assert.equal(clock.t, L.OCSP_GRACE_MS);
  assert.ok([...f.signalsOf(LEAF_OCSP), ...f.signalsOf(CA04_OCSP)].every((s) => s.aborted));
});

test("LTV: цонх дотор ирсэн удаан CA OCSP — OCSP ба CRL хоёулаа DSS-д", async () => {
  const { run } = await setup();
  const clock = fakeClock();
  const slow = deferred();
  const f = fakeFetch({ [CA04_OCSP]: slow.behaviour });
  const p = run(f.fn, clock);
  await until(() => clock.timers.length === 1, "цонхны таймер");
  clock.advanceTo(2999);
  slow.resolve(CA04_OCSP_DER);
  const d = await p;
  assert.deepEqual(d.ocsps, [LEAF_OCSP_DER, CA04_OCSP_DER]);
  assert.deepEqual(d.crls, CRLS);
});

test("LTV: навчны удаан OCSP (> цонх), хүчинтэй CRL-тэй → цонхгүй, хүлээгээд OCSP ба CRL хоёулаа DSS-д", async () => {
  const { run } = await setup();
  const clock = fakeClock();
  const slow = deferred();
  const f = fakeFetch({ [LEAF_OCSP]: slow.behaviour });
  const p = run(f.fn, clock);
  await until(() => f.log.some((x) => x.key === LEAF_CRL), "04 CRL");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clock.afterCalls, 0, "навчны OCSP-д цонх өгсөн");
  clock.advanceTo(60_000);
  slow.resolve(LEAF_OCSP_DER);
  const d = await p;
  assert.deepEqual(d.ocsps, [LEAF_OCSP_DER, CA04_OCSP_DER]);
  assert.deepEqual(d.crls, CRLS);
  assert.ok(f.signalsOf(LEAF_OCSP).every((s) => !s.aborted));
});

test("LTV: удаан боловч эрүүл OCSP, хүчинтэй CRL-гүй → цонхгүй, бүрэн хүлээнэ", async () => {
  const { run } = await setup();
  const clock = fakeClock();
  const slow = deferred();
  const f = fakeFetch({ [LEAF_OCSP]: slow.behaviour, [LEAF_CRL]: 404 });
  const p = run(f.fn, clock);
  await until(() => f.log.some((x) => x.key === LEAF_CRL), "04 CRL");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clock.afterCalls, 0);
  clock.advanceTo(60_000);
  slow.resolve(LEAF_OCSP_DER);
  const d = await p;
  assert.deepEqual(d.ocsps, [LEAF_OCSP_DER, CA04_OCSP_DER]);
  assert.deepEqual(d.crls, CRLS.slice(1));
  assert.ok(f.signalsOf(LEAF_OCSP).every((s) => !s.aborted));
});

test("LTV: навчны «revoked» OCSP цонхноос хойш ирсэн ч — хатуу алдаа (CRL хүчинтэй байсан ч)", async () => {
  const { L, run } = await setup();
  const clock = fakeClock();
  const slow = deferred();
  const f = fakeFetch({ [LEAF_OCSP]: slow.behaviour, [CA04_OCSP]: "hang" });
  const p = run(f.fn, clock);
  await until(() => f.log.some((x) => x.key === LEAF_CRL), "04 CRL");
  await new Promise((r) => setTimeout(r, 20));
  clock.advanceTo(60_000);
  slow.resolve(read(new URL("http/online-revoked-0.der", V)));
  await assert.rejects(p, (e: unknown) => e instanceof L.CertificateRevokedError);
  assert.ok(f.signalsOf(CA04_OCSP).every((s) => s.aborted), "үлдсэн OCSP цуцлагдаагүй");
});

test("LTV: CA байрлалын цонх дотор ирсэн «revoked» OCSP — хатуу алдаа (CRL хүчинтэй байсан ч)", async () => {
  const { L, run } = await setup();
  const clock = fakeClock();
  const slow = deferred();
  const f = fakeFetch({ [LEAF_OCSP]: slow.behaviour });
  const p = run(f.fn, clock, undefined, ["02", "03", "04", "citizen"]);
  await until(() => f.log.some((x) => x.key === LEAF_CRL) && clock.timers.length > 0, "цонхны таймер");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clock.t, 0);
  slow.resolve(read(new URL("http/online-revoked-0.der", V)));
  await assert.rejects(p, (e: unknown) => e instanceof L.CertificateRevokedError);
});

for (const [name, b] of [
  ["хог байт", new Uint8Array([1, 2, 3, 4])],
  ["unauthorized (OCSPResponseStatus 6)", new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x06])],
  ["HTTP 401", 401],
  ["өөр гэрчилгээний хариу", CA04_OCSP_DER],
] as const) {
  test(`LTV: иргэний OCSP ${name} → CRL-ээр (fallback), цонх хэрэглэхгүй`, async () => {
    const { run } = await setup();
    const clock = fakeClock();
    const d = await run(fakeFetch({ [LEAF_OCSP]: b }).fn, clock);
    assert.deepEqual(d.ocsps, [CA04_OCSP_DER]);
    assert.deepEqual(d.crls, CRLS);
    assert.equal(clock.t, 0);
  });
}

test("LTV: fail-closed — OCSP ба CRL хоёулаа алга → өмнөх LTVError", async () => {
  const { L, run } = await setup();
  await assert.rejects(run(fakeFetch({ [LEAF_OCSP]: 500, [LEAF_CRL]: 404 }).fn, fakeClock()), (e: unknown) => {
    assert.ok(e instanceof L.LTVError, String(e));
    assert.equal((e as Error).message, "гинжийн гэрчилгээнд хүчинтэй OCSP/CRL алга");
    return true;
  });
});

for (const crl of [true, false]) {
  test(`LTV: навчны OCSP timestamp-аас хожуу биш → NotFresh (CRL ${crl ? "хүчинтэй" : "алга"}) — дүрэм хэвээр`, async () => {
    const { run } = await setup(+1000);
    const over: Record<string, Behaviour> = crl ? {} : { [LEAF_CRL]: 404 };
    await assert.rejects(run(fakeFetch(over).fn, fakeClock()), /OCSP thisUpdate нь timestamp-аас хожуу биш/);
  });
}

test("LTV: CRL «revoked» — тэр дор нь, хүлээж буй OCSP-ууд цуцлагдана", async () => {
  const { L, run } = await setup();
  const clock = fakeClock();
  const f = fakeFetch({ [LEAF_OCSP]: "hang", [CA04_OCSP]: "hang", [LEAF_CRL]: read(new URL("http/online-crl-revoked-0.der", V)) });
  await assert.rejects(run(f.fn, clock), (e: unknown) => e instanceof L.CertificateRevokedError);
  assert.equal(clock.t, 0);
  assert.ok([...f.signalsOf(LEAF_OCSP), ...f.signalsOf(CA04_OCSP)].every((s) => s.aborted));
});

test("LTV: дуудагчийн цуцлалт — хариугүй OCSP/CRL таталт тасарна", async () => {
  const { run } = await setup();
  const clock = fakeClock();
  const outer = new AbortController();
  const f = fakeFetch({ [LEAF_OCSP]: "hang", [LEAF_CRL]: "hang" });
  const p = run(f.fn, clock, outer.signal);
  await until(() => f.log.some((x) => x.key === LEAF_CRL) && f.log.some((x) => x.key === LEAF_OCSP), "OCSP/CRL хүсэлт");
  outer.abort(new Error("stop"));
  await assert.rejects(p);
  assert.ok([...f.signalsOf(LEAF_OCSP), ...f.signalsOf(LEAF_CRL)].every((s) => s.aborted));
  assert.equal(clock.t, 0);
});

test("complete: signal цуцлагдвал хариугүй OCSP/CRL-ийн үед signal.reason шиднэ", async () => {
  const c = M.cases.find((x) => !x.expect.error && !x.input.startsWith("case:"))!;
  const p = await pades.prepare(read(new URL(c.input, G)), {
    ...(c.prepare as Partial<pades.PadesPrepareOptions>),
    signerCert: pem("citizen"),
    chain: ["04", "03", "02"].map(pem),
    signingTime: new Date(M.signingTime),
  });
  const f = fakeFetch({ [LEAF_OCSP]: "hang", [LEAF_CRL]: "hang" });
  const ctl = new AbortController();
  const reason = new Error("хэрэглэгч цуцалсан");
  const done = pades.complete(p.state, Buffer.from(String(c.expect.signature), "hex"), {
    tsaUrl: "http://tsa.pki.test/",
    roots: [pem("root")],
    fetch: f.fn as pades.PadesCompleteOptions["fetch"],
    httpsUpgrade: false,
    now: () => new Date(M.now),
    sleep: async () => {},
    nonce: () => new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(`golden-nonce:${c.name}`), Buffer.of(0)])).digest().subarray(0, 8)),
    signal: ctl.signal,
  });
  await until(() => f.log.some((x) => x.key === LEAF_CRL), "04 CRL хүсэлт");
  ctl.abort(reason);
  await assert.rejects(done, (e: unknown) => e === reason);
  assert.ok(f.signalsOf(LEAF_OCSP).every((s) => s.aborted));
});

test("LTV: unhandled promise rejection үгүй", async () => {
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(unhandled, []);
});
