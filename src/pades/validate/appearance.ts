// Харагдах гарын үсгийн own-signer хэлбэр (APPEARANCE_SPEC.md §5 Validator) — Go SDK pades/internal/validate/appearance.go-ийн
// порт. PAdES бичигчийн харагдах widget, /AP /N form XObject ба түүний 2 фонтыг (11 объект + зураг бүрд 2 — §6.5) гарын үсгийн өөрийн өгөгдлөөс
// (/Name, /M, claimedRole, revIndex, docID) SDK-ийн бичигчийн кодоор (../page/appearance.ts — Go core-той байт-ижил)
// ДАХИН ҮҮСГЭЖ, задалсан объект бүрийг бүтцээр (pdfEqual: толь + stream-ийн түүхий байт) тулгана.

import { latin1 } from "../bytes.js";
import { MAX_IMAGE_SIDE, appearanceObjects, round100, visibleWidget, type PdfImageData } from "../page/appearance.js";
import { PReal, PRef, PdfObjError, PStr, PStream, PdfParser, dget, isArr, isDict, isInt, pdfEqual, type PDict, type PVal } from "./pdfobj.js";
import { errNotSignatureOnly, ownDate, pdfTextString, type Classifier } from "./revisions.js";

export const AP_VERIFY_PREFIX = "https://ca.eidmongolia.mn/verify/";
const AP_URL_RE = /^\/EIDVerify <<\/URL \(https:\/\/ca\.eidmongolia\.mn\/verify\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([1-9][0-9]?)\)>> BDC\n/;

function onlyKeys(d: PDict, ...keys: string[]): boolean {
  for (const k of d.keys()) if (!keys.includes(k)) return false;
  return true;
}

/** own горимын харагдах widget d (объект widget): widget ба /AP-ийн 11 объект яг PAdES бичигчийнх. */
export function ownVisible(c: Classifier, d: PDict, widget: number): void {
  const fail = errNotSignatureOnly;
  if (!onlyKeys(d, "Type", "Subtype", "Rect", "P", "F", "FT", "T", "V", "AP")) throw fail();
  const pr = dget(d, "P");
  const sr = dget(d, "V");
  const ap = dget(d, "AP");
  const t = dget(d, "T");
  if (!(pr instanceof PRef) || !(sr instanceof PRef) || !isDict(ap) || !(t instanceof PStr) || !onlyKeys(ap, "N") || !c.pages.has(pr.num)) throw fail();
  const nr = dget(ap, "N");
  if (!(nr instanceof PRef)) throw fail();
  const { box, rot } = pageGeometry(c, pr.num);
  const ra = dget(d, "Rect");
  if (!isArr(ra) || ra.length !== 4) throw fail();
  const rect: number[] = [];
  for (const x of ra) {
    const v = pdfNumber(x);
    if (v === undefined) throw fail();
    rect.push(round100(v));
  }
  if (rect[0]! >= rect[2]! || rect[1]! >= rect[3]! || rect[0]! < box[0]! || rect[1]! < box[1]! || rect[2]! > box[2]! || rect[3]! > box[3]!) throw fail();
  let w = rect[2]! - rect[0]!;
  let h = rect[3]! - rect[1]!;
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  sameObject(c, widget, latin1(visibleWidget(t.v, rect, pr.num, pr.gen, sr.num, nr.num)));
  const sd = c.fin.deref(sr);
  const meta = c.sigs.get(sr.num);
  if (!isDict(sd) || !meta || !meta.roleOK) throw fail();
  const ns = dget(sd, "Name");
  const ms = dget(sd, "M");
  if (!(ns instanceof PStr) || !(ms instanceof PStr)) throw fail();
  const m = ms.v;
  if (!ownDate(m) || m.slice(16) !== "+08'00'") throw fail();
  const date = `${m.slice(2, 6)}-${m.slice(6, 8)}-${m.slice(8, 10)} ${m.slice(10, 12)}:${m.slice(12, 14)} (+08)`;
  const { ids, sig, stamp } = apIDs(c, nr);
  const form = c.fin.get(ids[0]!);
  if (!(form instanceof PStream)) throw fail();
  let head = "";
  for (let i = 0; i < Math.min(form.data.length, 200); i++) head += String.fromCharCode(form.data[i]!);
  const sm = AP_URL_RE.exec(head);
  if (!sm || sm[2] !== String(meta.revIndex) || (c.docID !== "" && sm[1] !== c.docID)) throw fail();
  const url = AP_VERIFY_PREFIX + sm[1] + "/" + sm[2];
  const name = pdfTextString(ns);
  for (const lang of ["mn", "en"]) {
    let bodies: (string | Uint8Array)[];
    try {
      // Зураг (APPEARANCE_SPEC.md §6.5): PDF-ээс уншсан өнгө/хэмжээ/alpha-аар дахин үүсгэнэ — appearanceObjects нь
      // alpha-г checkPdfImage-ээр шалгана; объект бүр (толь, content stream-ийн байрлал) байт-ижил байх ёстой.
      bodies = appearanceObjects({ w, h, rotate: rot, name, role: meta.role, lang, date, url, sig, stamp }, ids);
    } catch {
      throw fail();
    }
    let match = true;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      try {
        sameObject(c, ids[i]!, typeof b === "string" ? latin1(b) : b);
      } catch (e) {
        if (!(e instanceof PdfObjError)) throw e;
        match = false;
        break;
      }
    }
    if (match) return;
  }
  throw fail();
}

/**
 * /AP /N-ээс объектын дугаарууд (appearanceObjects-ийн дарааллаар: form, F1 ×5, F2 ×5, дараа нь /Resources /XObject-ийн
 * /Sig, /Stamp тус бүрд base, /SMask) ба зургууд (PDF-ээс уншсан; undefined = байхгүй); бүгд шинэ, үе 0, давхардалгүй.
 */
function apIDs(c: Classifier, n: PRef): { ids: number[]; sig?: PdfImageData; stamp?: PdfImageData } {
  const fail = errNotSignatureOnly;
  const refs: PRef[] = [n];
  const get = (r: PRef): PDict => {
    const o = c.fin.deref(r);
    if (isDict(o)) return o;
    if (o instanceof PStream) return o.dict;
    throw fail();
  };
  const form = get(n);
  const res = dget(form, "Resources");
  const fonts = dget(isDict(res) ? res : null, "Font");
  for (const key of ["F1", "F2"]) {
    const t0 = dget(isDict(fonts) ? fonts : null, key);
    if (!(t0 instanceof PRef)) throw fail();
    const td = get(t0);
    const desc = dget(td, "DescendantFonts");
    const tu = dget(td, "ToUnicode");
    if ((isArr(desc) ? desc.length : 0) !== 1 || !(tu instanceof PRef)) throw fail();
    const cid = (desc as PVal[])[0]!;
    if (!(cid instanceof PRef)) throw fail();
    const cd = get(cid);
    const fd = dget(cd, "FontDescriptor");
    if (!(fd instanceof PRef)) throw fail();
    const fdd = get(fd);
    const ff = dget(fdd, "FontFile2");
    if (!(ff instanceof PRef)) throw fail();
    refs.push(t0, cid, fd, ff, tu);
  }
  // Зураг: /XObject /Sig, /Stamp → base (1×1, 3 байт өнгө) → /SMask (W×H, alpha-ийн түүхий zlib). Толины бусад
  // түлхүүр/утгыг дахин үүсгэсэн объекттой тулгаж шалгана (sameObject).
  let sig: PdfImageData | undefined;
  let stamp: PdfImageData | undefined;
  if (isDict(res) && res.has("XObject")) {
    const xo = dget(res, "XObject");
    if (!isDict(xo)) throw fail();
    for (const key of ["Sig", "Stamp"]) {
      if (!xo.has(key)) continue;
      const br = dget(xo, key);
      if (!(br instanceof PRef)) throw fail();
      const { im, mr } = apImage(c, br);
      refs.push(br, mr);
      if (key === "Sig") sig = im;
      else stamp = im;
    }
  }
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const r of refs) {
    if (r.gen !== 0 || !c.isNew.has(r.num) || seen.has(r.num)) throw fail();
    seen.add(r.num);
    ids.push(r.num);
  }
  return { ids, sig, stamp };
}

/**
 * Зургийн base XObject (br) ба түүний /SMask-аас PdfImageData: өнгө = base stream-ийн 3 байт, w/h = mask-ийн /Width
 * /Height (бүхэл), alpha = mask stream-ийн түүхий байт. Хэлбэрийн бусад шалгалт — дахин үүсгэж тулгах.
 */
function apImage(c: Classifier, br: PRef): { im: PdfImageData; mr: PRef } {
  const fail = errNotSignatureOnly;
  const base = c.fin.deref(br);
  if (!(base instanceof PStream) || base.data.length !== 3) throw fail();
  const mr = dget(base.dict, "SMask");
  if (!(mr instanceof PRef)) throw fail();
  const mask = c.fin.deref(mr);
  if (!(mask instanceof PStream)) throw fail();
  const w = dget(mask.dict, "Width");
  const h = dget(mask.dict, "Height");
  const side = BigInt(MAX_IMAGE_SIDE);
  if (!isInt(w) || !isInt(h) || w < 1n || h < 1n || w > side || h > side) throw fail();
  return { im: { w: Number(w), h: Number(h), color: [base.data[0]!, base.data[1]!, base.data[2]!], alpha: mask.data }, mr };
}

const isSpaceByte = (x: number): boolean => x === 9 || x === 10 || x === 11 || x === 12 || x === 13 || x === 32;

/** num объект нь body-г (PAdES бичигчийн бие) задалсантай бүтцээрээ тэнцүү. */
function sameObject(c: Classifier, num: number, body: Uint8Array): void {
  let s = 0;
  let e = body.length;
  while (s < e && isSpaceByte(body[s]!)) s++;
  while (e > s && isSpaceByte(body[e - 1]!)) e--;
  const pre = latin1(`${num} 0 obj\n`);
  const post = latin1("\nendobj\n");
  const src = new Uint8Array(pre.length + (e - s) + post.length);
  src.set(pre, 0);
  src.set(body.subarray(s, e), pre.length);
  src.set(post, pre.length + (e - s));
  const p = new PdfParser(src, 0, c.fin.budget);
  const want = p.indirect(undefined);
  const got = c.fin.get(num);
  if (!pdfEqual(got, want.val)) throw errNotSignatureOnly();
}

/** Хуудасны (/Parent-ээр удамшсан) CropBox (байхгүй бол MediaBox), h100-аар хэвийн болгосон, ба /Rotate. */
function pageGeometry(c: Classifier, num: number): { box: number[]; rot: number } {
  const fail = errNotSignatureOnly;
  const inh = (key: string): PVal => {
    let cur: PVal = new PRef(num, 0);
    for (let i = 0; i < 32; i++) {
      if (!(cur instanceof PRef)) return null;
      const o: PVal = c.fin.get(cur.num);
      if (!isDict(o)) throw fail();
      if (o.has(key)) return c.fin.resolve(dget(o, key));
      cur = dget(o, "Parent");
    }
    throw fail();
  };
  let b = inh("CropBox");
  if (b === null) b = inh("MediaBox");
  if (!isArr(b) || b.length !== 4) throw fail();
  const f: number[] = [];
  for (const x of b) {
    const v = pdfNumber(x);
    if (v === undefined) throw fail();
    f.push(round100(v));
  }
  const box = [Math.min(f[0]!, f[2]!), Math.min(f[1]!, f[3]!), Math.max(f[0]!, f[2]!), Math.max(f[1]!, f[3]!)];
  let rot = 0;
  const r = inh("Rotate");
  if (r !== null) {
    if (!isInt(r) || r % 90n !== 0n) throw fail();
    rot = Number(((r % 360n) + 360n) % 360n);
  }
  return { box, rot };
}

/** Бүхэл эсвэл бодит тоо (|v| ≤ 1e7). */
function pdfNumber(x: PVal): number | undefined {
  let v: number;
  if (isInt(x)) v = Number(x);
  else if (x instanceof PReal) v = x.v;
  else return undefined;
  return !Number.isNaN(v) && Math.abs(v) <= 1e7 ? v : undefined;
}
