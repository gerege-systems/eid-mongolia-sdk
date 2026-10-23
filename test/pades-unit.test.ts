// /pades — алдааны кодууд, хөтчийн https upgrade / CRL толин хуулбар, үндсэн entry-д pades код орохгүй.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as pades from "../dist/pades.js";

const G = new URL("./fixtures/pades/golden/", import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, G)));
const pem = (n: string) => new Uint8Array(new X509Certificate(readFileSync(new URL(`pki/${n}.pem`, G))).raw);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const M = JSON.parse(readFileSync(new URL("manifest.json", G), "utf8")) as {
  signingTime: string;
  now: string;
  http: Record<string, string>;
  cases: { name: string; input: string; prepare: Record<string, string | boolean>; expect: Record<string, string> }[];
};
const CASE = M.cases.find((c) => c.name === "quartz-pdf13")!;
const base: pades.PadesPrepareOptions = {
  signerCert: pem("citizen"),
  chain: ["04", "03", "02"].map(pem),
  signingTime: new Date(M.signingTime),
  docId: CASE.prepare.docId as string,
  verifyPage: true,
  fileName: "a.pdf",
};
const code = (c: pades.PadesErrorCode) => (e: unknown) => e instanceof pades.PadesError && e.code === c;

function replay(drop: (key: string) => boolean = () => false): pades.PadesCompleteOptions["fetch"] {
  return async (url, init) => {
    const key = `${init.method} ${url} ${sha(init.body ?? new Uint8Array()).slice(0, 16)}`;
    const f = M.http[key];
    if (!f || drop(key)) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = read(f);
    return { status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  };
}

const nonce = (name: string) => () =>
  new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(`golden-nonce:${name}`), Buffer.of(0)])).digest().subarray(0, 8));

const completeOpts = (drop?: (k: string) => boolean): pades.PadesCompleteOptions => ({
  tsaUrl: "http://tsa.pki.test/",
  roots: [pem("root")],
  fetch: replay(drop),
  httpsUpgrade: false,
  now: () => new Date(M.now),
  sleep: async () => {},
  nonce: nonce(CASE.name),
});

test("PadesError — код, retryable", () => {
  const e = new pades.PadesError("TSA_UNAVAILABLE", "x");
  assert.equal(e.retryable, true);
  assert.equal(e.message, "TSA_UNAVAILABLE: x");
  assert.equal(new pades.PadesError("SIGNATURE_INVALID", "x").retryable, false);
  assert.ok(pades.PADES_ERROR_CODES.includes("PDF_LOCKED"));
  assert.equal(pades.profileVersion(), "pades-client/1");
});

test("prepare — оролт/options-ийн алдаа", async () => {
  const pdf = read(CASE.input);
  await assert.rejects(() => pades.prepare(new TextEncoder().encode("hello"), base), code("PDF_INVALID"));
  await assert.rejects(() => pades.prepare(new Uint8Array((10 << 20) - (256 << 10) + 1), base), code("PDF_TOO_LARGE"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, signerCert: new Uint8Array([1, 2]) }), code("SIGNER_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, lang: "de" as "en" }), code("REQUEST_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, docId: "NOT-A-UUID" }), code("REQUEST_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, fileName: " ​ " }), code("REQUEST_INVALID"));
  await assert.rejects(() => pades.prepare(pdf, { ...base, claimedRole: "x".repeat(901) }), code("REQUEST_INVALID"));
  // Шигтгэсэн (бодит) eID гинжид тестийн иргэний олгогч алга → chain шаардана.
  await assert.rejects(() => pades.prepare(pdf, { ...base, chain: undefined }), code("SIGNER_INVALID"));
  // Санамсаргүй docId (v4 UUID), state хадгалагдана.
  const p = await pades.prepare(pdf, { ...base, docId: undefined, verifyPage: false });
  assert.match(p.docId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(p.dtbs.length, 32);
});

test("complete — SIGNATURE_INVALID / STATE_INVALID / TSA_UNAVAILABLE / LTV_UNAVAILABLE; дараа нь амжилттай", async () => {
  const p = await pades.prepare(read(CASE.input), { ...base, fileName: CASE.prepare.fileName as string, lang: "mn" });
  const sig = Buffer.from(CASE.expect.signature!, "hex");
  await assert.rejects(() => pades.complete(p.state, new Uint8Array(256).fill(1), completeOpts()), (e: unknown) => code("SIGNATURE_INVALID")(e) && !(e as pades.PadesError).retryable);
  await assert.rejects(() => pades.complete(new Uint8Array([1, 2, 3]), sig, completeOpts()), code("STATE_INVALID"));
  const tampered = p.state.slice();
  tampered[tampered.length - 10] ^= 1;
  await assert.rejects(() => pades.complete(tampered, sig, completeOpts()), code("STATE_INVALID"));
  await assert.rejects(() => pades.complete(p.state, sig, completeOpts((k) => k.includes("tsa.pki.test"))), (e: unknown) => code("TSA_UNAVAILABLE")(e) && (e as pades.PadesError).retryable);
  await assert.rejects(() => pades.complete(p.state, sig, completeOpts((k) => k.includes("/04 ") || k.includes("04.crl"))), code("LTV_UNAVAILABLE"));
  // fetch алга (тохиргоо) → REQUEST_INVALID, retryable биш (өмнө TSA_UNAVAILABLE + retryable байв).
  const realFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  try {
    await assert.rejects(() => pades.complete(p.state, sig, { ...completeOpts(), fetch: undefined }), (e: unknown) => code("REQUEST_INVALID")(e) && !(e as pades.PadesError).retryable);
  } finally {
    globalThis.fetch = realFetch;
  }
  // base64 мөрөөр (session signature.value) — ижил state-ээр дахин оролдоно.
  const r = await pades.complete(p.state, sig.toString("base64"), completeOpts());
  assert.equal(r.outSha256, CASE.expect.outSha256);

  // Гарын үсэгтэй баримтад өөр docId → REQUEST_INVALID; docId хуудаснаас.
  await assert.rejects(() => pades.prepare(r.pdf, { ...base, docId: "00000000-0000-4000-8000-000000000000" }), code("REQUEST_INVALID"));
  const p2 = await pades.prepare(r.pdf, { ...base, docId: undefined });
  assert.equal(p2.docId, CASE.prepare.docId);
  // Гарын үсгийн revision-ийг эвдвэл өмнөх гарын үсэг хүчингүй.
  const broken = r.pdf.slice();
  broken[100] ^= 1;
  await assert.rejects(() => pades.prepare(broken, base), code("PDF_PRIOR_SIGNATURE_INVALID"));
});

test("prepare — appearance: байршил/хэмжээ буруу, багтахгүй бол REQUEST_INVALID (APPEARANCE_SPEC.md §1, §3)", async () => {
  const pdf = read(CASE.input); // 612 × 792, 1 хуудас
  const ok: pades.PadesAppearance = { x: 36, y: 36, width: 220, height: 64 };
  const bad: [string, Partial<pades.PadesPrepareOptions>][] = [
    ["хуудас алга", { appearance: { ...ok, page: 2 } }],
    ["сөрөг page", { appearance: { ...ok, page: -1 } }],
    ["бутархай page", { appearance: { ...ok, page: 1.5 } }],
    ["хуудаснаас гарна", { appearance: { ...ok, x: 500 } }],
    ["дээш гарна", { appearance: { ...ok, y: 760 } }],
    ["нам (QR < 1 pt)", { appearance: { ...ok, height: 44 } }],
    ["нарийн (бичвэр)", { appearance: { ...ok, width: 90 } }],
    ["тэг өргөн", { appearance: { ...ok, width: 0 } }],
    ["NaN", { appearance: { ...ok, x: NaN } }],
    ["14400-аас их", { appearance: { ...ok, height: 14401 } }],
    ["хэл", { appearance: { ...ok, lang: "de" as "en" } }],
    ["/Name бичигдэхгүй", { appearance: ok, signerName: "a stream b" }],
    ["role удирдах тэмдэгт", { appearance: ok, claimedRole: "a\u200eb" }],
  ];
  for (const [name, o] of bad) {
    await assert.rejects(() => pades.prepare(pdf, { ...base, ...o }), code("REQUEST_INVALID"), name);
  }
  // Хамгийн бага (45 pt өндөр) хүлээн авна; харагдах нь үл харагдахаас өөр DTBS.
  const p45 = await pades.prepare(pdf, { ...base, appearance: { ...ok, height: 45 } });
  const inv = await pades.prepare(pdf, base);
  assert.notDeepEqual(p45.dtbs, inv.dtbs);

  // Гарын үсэгтэй, хуудасгүй, docId-гүй баримтад харагдах → REQUEST_INVALID (verify URL-д docId заавал).
  const np = M.cases.find((c) => c.name === "quartz-pdf13-nopage")!;
  const prep = await pades.prepare(pdf, { ...base, docId: np.prepare.docId as string, verifyPage: false, fileName: undefined });
  const done = await pades.complete(prep.state, Buffer.from(np.expect.signature!, "hex"), { ...completeOpts(), nonce: nonce(np.name) });
  assert.equal(done.outSha256, np.expect.outSha256);
  await assert.rejects(() => pades.prepare(done.pdf, { ...base, docId: undefined, verifyPage: false, appearance: ok }), code("REQUEST_INVALID"));
  await pades.prepare(done.pdf, { ...base, docId: np.prepare.docId as string, verifyPage: false, appearance: ok });
});

test("appearance images — оролтын шалгалт (REQUEST_INVALID), анхдагч хэмжээ, stampImage claimedRole-гүй (APPEARANCE_SPEC.md §6)", async () => {
  const pdf = read(CASE.input);
  type Ap = pades.PadesAppearance;
  const cases = M.cases as unknown as { name: string; prepare: { appearance?: Ap } }[];
  const sigImg = cases.find((c) => c.name === "img-signature")!.prepare.appearance!.signatureImage!;
  const stampImg = cases.find((c) => c.name === "img-signature-stamp")!.prepare.appearance!.stampImage!;
  const shortAlpha = cases.find((c) => c.name === "img-bad-alpha")!.prepare.appearance!.signatureImage!.alpha;
  const mod = (f: (im: pades.PdfImage) => void): pades.PdfImage => {
    const im = { ...sigImg, color: [...sigImg.color] as [number, number, number] };
    f(im);
    return im;
  };
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  // Go fdictAlpha: FDICT + DICTID 1 (хоосон толь) — §6.1 татгалзана.
  const fdictAlpha = (z: Uint8Array): Uint8Array => {
    let flg = 0xc0 | 0x20;
    flg |= (31 - ((z[0]! * 256 + flg) % 31)) % 31;
    return Buffer.concat([Buffer.of(z[0]!, flg, 0, 0, 0, 1), z.subarray(2)]);
  };
  // Go TestAppearanceImageInput-ийн 13 тохиолдол + TS-ийн оролтын хэлбэр (бутархай, base64).
  const bad: Record<string, pades.PdfImage> = {
    "sha256 том үсэг": mod((im) => (im.sha256 = im.sha256.toUpperCase())),
    "sha256 богино": mod((im) => (im.sha256 = im.sha256.slice(0, 63))),
    "өнгө 256": mod((im) => (im.color[1] = 256)),
    "өнгө сөрөг": mod((im) => (im.color[0] = -1)),
    "өргөн 1601": mod((im) => (im.width = 1601)),
    "өндөр 0": mod((im) => (im.height = 0)),
    "alpha хоосон": mod((im) => (im.alpha = "")),
    "alpha zlib биш": mod((im) => (im.alpha = b64(new TextEncoder().encode("not zlib")))),
    "alpha илүү байт": mod((im) => im.height--),
    "alpha дутуу байт": mod((im) => (im.alpha = shortAlpha)),
    "alpha ард хог": mod((im) => (im.alpha = b64(Buffer.concat([Buffer.from(im.alpha, "base64"), Buffer.of(0)])))),
    "alpha > 300 KiB": mod((im) => (im.alpha = b64(new Uint8Array((300 << 10) + 1)))),
    "alpha FDICT 1": mod((im) => (im.alpha = b64(fdictAlpha(Buffer.from(im.alpha, "base64"))))),
    "өргөн бутархай": mod((im) => (im.width = 480.5)),
    "alpha base64 биш": mod((im) => (im.alpha = im.alpha.slice(0, -1) + "*")),
  };
  for (const [name, im] of Object.entries(bad)) {
    await assert.rejects(() => pades.suggestPlacement(pdf, { x: 36, y: 36, width: 0, height: 0, signatureImage: im }), code("REQUEST_INVALID"), name);
    await assert.rejects(() => pades.prepare(pdf, { ...base, appearance: { x: 36, y: 36, width: 0, height: 0, signatureImage: im } }), code("REQUEST_INVALID"), name);
  }
  // Анхдагч хэмжээ (§6.3): width = height = 0.
  const sizes: [Ap, number, number][] = [
    [{ x: 36, y: 36, width: 0, height: 0 }, 220, 64],
    [{ x: 36, y: 36, width: 0, height: 0, signatureImage: sigImg }, 220, 110],
    [{ x: 36, y: 36, width: 0, height: 0, stampImage: stampImg }, 240, 147.5],
    [{ x: 36, y: 36, width: 0, height: 0, signatureImage: sigImg, stampImage: stampImg }, 240, 147.5],
    [{ x: 36, y: 36, width: 300, height: 180, stampImage: stampImg }, 300, 180],
  ];
  for (const [a, w, h] of sizes) {
    const s = await pades.suggestPlacement(pdf, a);
    assert.deepEqual([s.width, s.height], [w, h]);
  }
  assert.deepEqual(pades.DEFAULT_ORG_STAMP_SIZE, { width: 240, height: 147.5 });
  // stampImage зөвхөн claimedRole-той: suggestPlacement шалгахгүй, prepare REQUEST_INVALID.
  await assert.rejects(() => pades.prepare(pdf, { ...base, appearance: { x: 340, y: 36, width: 0, height: 0, stampImage: stampImg } }), code("REQUEST_INVALID"));
  // Хэт жижиг тамгатай дүрслэл (§6.3) → REQUEST_INVALID; зураггүй ижил хэмжээ хүлээн авна.
  await assert.rejects(
    () => pades.prepare(pdf, { ...base, claimedRole: "Захирал", appearance: { x: 36, y: 36, width: 120, height: 64, stampImage: stampImg } }),
    code("REQUEST_INVALID"),
  );
});

test("complete — хөтөч: http → https зөвхөн allowlist-д, бусдыг татахгүй", async () => {
  const p = await pades.prepare(read(CASE.input), { ...base, fileName: CASE.prepare.fileName as string, lang: "mn" });
  const sig = Buffer.from(CASE.expect.signature!, "hex");
  const urls: string[] = [];
  const spy: pades.PadesCompleteOptions["fetch"] = async (url) => {
    urls.push(url);
    return { status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(() => pades.complete(p.state, sig, { fetch: spy, httpsUpgrade: true, tsaUrl: "http://tsa.timeserver.mn/" }), code("TSA_UNAVAILABLE"));
  assert.deepEqual(urls, ["https://tsa.timeserver.mn/"]);
  urls.length = 0;
  await assert.rejects(() => pades.complete(p.state, sig, { fetch: spy, httpsUpgrade: true, tsaUrl: "http://tsa.pki.test/" }), code("TSA_UNAVAILABLE"));
  assert.deepEqual(urls, [], "allowlist-ээс гадуурх http-г татахгүй");
});

test("үндсэн entry /pades-ийн кодыг агуулахгүй", () => {
  const main = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.ok(!main.includes("EIDPADES1") && !main.includes("NotoSans"), "үндсэн entry pades татаж байна");
});
