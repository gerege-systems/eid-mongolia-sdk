// Харагдах гарын үсэг — APPEARANCE_SPEC.md (pades-client/1), Go reference pades/internal/core/appearance.go-ийн 1:1 порт.
// Widget нь сонгосон хуудсан дээр /Rect-тэй, /AP /N нь шахалтгүй form XObject (verify хуудасны фонт asset, өөрийн QR).
// Бүх урт/координат 1/100 pt-ийн БҮХЭЛ тоо (h100): бичихдээ num100.

import { latin1 } from "../bytes.js";
import { Incremental } from "../pdf/incremental.js";
import { InflateError, zlibInflateStrict } from "../pdf/inflate.js";
import { PdfError, type Value } from "../pdf/reader.js";
import { C_MUTED, C_OK, C_TEXT, PageWriter, asciiURL, fontBodies, loadFonts, streamObj } from "./page.js";
import { qrEncode } from "./qr.js";

/** Харагдах гарын үсгийн байршил/хэмжээ/хуудас буруу эсвэл бичвэр багтахгүй (REQUEST_INVALID). */
export class AppearanceError extends PdfError {}

/** prepareSignature-ийн харагдах оролт: байршил (харагдах хуудасны орон зайд, h100) ба бичвэр. */
export interface Visible {
  /** 1-ээс эхэлсэн, шийдэгдсэн (0 биш). */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  role: string;
  lang: string;
  /** «YYYY-MM-DD HH:MM (+08)» */
  date: string;
  /** https://ca.eidmongolia.mn/verify/<docID>/<revIndex> */
  url: string;
  /**
   * Handwritten-signature and organization-stamp images (APPEARANCE_SPEC.md §6); absent = none. `stamp` needs `role`
   * (onBehalfOf); w, h is then the whole widget rect (box + the stamp's overflow above it).
   */
  sig?: PdfImageData;
  stamp?: PdfImageData;
  /** Scan the page and move the stamp off existing content (PLACEMENT_SPEC.md); false/absent = exactly (x, y). */
  avoid?: boolean;
  /**
   * With `avoid`: never move; the page is still scanned so the status says "overlap" when content is under the rect
   * (PLACEMENT_SPEC.md §6a).
   */
  exact?: boolean;
}

export interface AppearanceParams {
  /** Харагдах (эргүүлэлтийн дараах) өргөн, өндөр, h100. */
  w: number;
  h: number;
  rotate: number;
  name: string;
  role: string;
  lang: string;
  date: string;
  url: string;
  /** APPEARANCE_SPEC.md §6 (absent = none; both absent = the §3 layout, byte-identical to golden v9). */
  sig?: PdfImageData;
  stamp?: PdfImageData;
}

/**
 * A "PDF image" (APPEARANCE_SPEC.md §6.1, Go core.PDFImage): one ink colour + an 8-bit alpha channel. `alpha` is a zlib
 * stream (RFC 1950) that inflates to exactly w·h bytes (rows top-down, no PNG filter bytes); it is written into the PDF
 * verbatim as the /SMask stream (/FlateDecode) — the SDK never compresses at runtime.
 */
export interface PdfImageData {
  w: number;
  h: number;
  /** 0–255 each. */
  color: [number, number, number];
  alpha: Uint8Array;
}

/** PDF image limits (APPEARANCE_SPEC.md §6.1). */
export const MAX_IMAGE_SIDE = 1600;
export const MAX_IMAGE_ALPHA_BYTES = 300 << 10;

const isIntIn = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * Go core.CheckPDFImage — APPEARANCE_SPEC.md §6.1: 1 ≤ w, h ≤ 1600; colour 0–255; 1 ≤ alpha ≤ 300 KiB; alpha is one zlib
 * stream (Go compress/zlib: no preset dictionary other than DICTID 1, valid Adler-32, no trailing bytes) inflating to
 * exactly w·h bytes. AppearanceError otherwise.
 */
export function checkPdfImage(im: PdfImageData): void {
  const bad = (msg: string): AppearanceError => new AppearanceError(`зураг: ${msg}`);
  if (!isIntIn(im.w, 1, MAX_IMAGE_SIDE) || !isIntIn(im.h, 1, MAX_IMAGE_SIDE)) throw bad("хэмжээ 1…1600 px");
  if (!Array.isArray(im.color) || im.color.length !== 3) throw bad("өнгө 0…255");
  for (const c of im.color) if (!isIntIn(c, 0, 255)) throw bad("өнгө 0…255");
  if (!(im.alpha instanceof Uint8Array) || im.alpha.length === 0 || im.alpha.length > MAX_IMAGE_ALPHA_BYTES) throw bad("alpha 1 B…300 KiB");
  let n: number;
  try {
    n = zlibInflateStrict(im.alpha, im.w * im.h, true).length;
  } catch (e) {
    if (!(e instanceof InflateError)) throw e;
    n = -1;
  }
  if (n !== im.w * im.h) throw bad("alpha нь яг өргөн×өндөр байт биш (эсвэл эвдэрсэн)");
}

/** APPEARANCE_SPEC.md §6.3 geometry (h100, visible space): image placement [dx, dy, dw, dh] (dw 0 = no image). */
interface ApImageLayout {
  boxH: number;
  rowH: number;
  sig: [number, number, number, number];
  stamp: [number, number, number, number];
}

const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** Fit-contain (iw × ih px) into bw × bh (h100): full width when the image is relatively wider, else full height. */
function apFit(iw: number, ih: number, bw: number, bh: number): [number, number] {
  if (iw * bh >= ih * bw) return [bw, Math.max(1, idiv(bw * ih, iw))];
  return [Math.max(1, idiv(bh * iw, ih)), bh];
}

function apLayoutImages(p: AppearanceParams): ApImageLayout {
  const l: ApImageLayout = { boxH: p.h, rowH: p.h, sig: [0, 0, 0, 0], stamp: [0, 0, 0, 0] };
  if (!p.sig && !p.stamp) return l;
  const small = (): AppearanceError => new AppearanceError("хэт жижиг (зурагтай дүрслэл)");
  if (p.stamp) l.boxH = idiv(p.h * 4, 5);
  const band = idiv(l.boxH * 9, 22);
  l.rowH = l.boxH - band;
  const sh = idiv(band * 14, 15);
  const sy = l.rowH - idiv(band * 2, 15);
  let sw = idiv(p.w * 15, 22);
  let sx = idiv(p.w - sw, 2);
  if (p.stamp) {
    const d = idiv(l.boxH * 2, 3);
    const qx = Math.min(idiv(p.w * 41, 60) - idiv(d, 2), p.w - d);
    if (qx < 0 || d <= 0) throw small();
    const [dw, dh] = apFit(p.stamp.w, p.stamp.h, d, d);
    l.stamp = [qx + idiv(d - dw, 2), p.h - d + idiv(d - dh, 2), dw, dh];
    sx = idiv(p.w, 30);
    sw = qx + idiv(d, 2) - sx;
  }
  if (p.sig) {
    if (sw <= 0 || sh <= 0) throw small();
    const [dw, dh] = apFit(p.sig.w, p.sig.h, sw, sh);
    const dx = p.stamp ? sx : sx + idiv(sw - dw, 2);
    l.sig = [dx, sy + idiv(sh - dh, 2), dw, dh];
  }
  return l;
}

/** `q dw 0 0 dh dx dy cm /<name> Do Q` (APPEARANCE_SPEC.md §6.4). */
function apDrawImage(w: PageWriter, name: string, r: [number, number, number, number]): void {
  w.op(`q ${num100(r[2])} 0 0 ${num100(r[3])} ${num100(r[0])} ${num100(r[1])} cm /${name} Do Q`);
}

const AP_PAD = 400;
const AP_GAP = 400;
const AP_MIN_MODULE = 100;
const AP_MAX_SIZE = 11;
const AP_MIN_SIZE = 7;
const AP_BODY_DELTA = 2;
const AP_LEADING = 125;
const AP_DESCENT = 25;
const AP_MAX_LINES = 2;
const MAX_DEPTH = 32;
/** Өргөн/өндрийн дээд хэмжээ (14400 pt), h100. */
export const MAX_APPEARANCE_SIDE = 1440000;

export const APPEARANCE_LABELS: Record<string, string> = {
  mn: "eID Mongolia-аар зурсан",
  en: "Signed with eID Mongolia",
};

/** pt → h100: floor(v × 100 + 0.5). */
export const round100 = (v: number): number => Math.floor(v * 100 + 0.5);

/** h100 → PDF тоо: «N», «N.d», «N.dd» (төгсгөлийн тэггүй), сөрөгт «-». */
export function num100(v: number): string {
  let sign = "";
  if (v < 0) {
    sign = "-";
    v = -v;
  }
  let s = sign + String(Math.trunc(v / 100));
  const f = v % 100;
  if (f !== 0) s += f % 10 === 0 ? "." + String(f / 10) : "." + String(f).padStart(2, "0");
  return s;
}

function apRotation(rot: number, w: number, h: number): { cm: string; bw: number; bh: number } {
  switch (rot) {
    case 0:
      return { cm: "", bw: w, bh: h };
    case 90:
      return { cm: `0 1 -1 0 ${num100(h)} 0 cm`, bw: h, bh: w };
    case 180:
      return { cm: `-1 0 0 -1 ${num100(w)} ${num100(h)} cm`, bw: w, bh: h };
    case 270:
      return { cm: `0 -1 1 0 0 ${num100(w)} cm`, bw: h, bh: w };
  }
  throw new AppearanceError(`/Rotate ${rot}`);
}

interface ApLine {
  font: number;
  size: number;
  color: string;
  text: string;
}

/** Form XObject-ийн content stream (APPEARANCE_SPEC.md §3). */
export function appearanceContent(p: AppearanceParams): string {
  const label = APPEARANCE_LABELS[p.lang];
  if (label === undefined) throw new AppearanceError(`хэл ${p.lang}`);
  if (!asciiURL(p.url)) throw new AppearanceError("URL ASCII биш");
  if (p.w <= 0 || p.h <= 0 || p.w > MAX_APPEARANCE_SIDE || p.h > MAX_APPEARANCE_SIDE) throw new AppearanceError("хэмжээ");
  if (p.stamp && p.role === "") throw new AppearanceError("тамгын зураг зөвхөн байгууллагын нэрийн өмнөөс (claimedRole)");
  for (const im of [p.sig, p.stamp]) if (im) checkPdfImage(im);
  const il = apLayoutImages(p);
  const rowH = il.rowH;
  let m: boolean[][];
  try {
    m = qrEncode(latin1(p.url));
  } catch (e) {
    throw new AppearanceError(String(e));
  }
  const n = m.length;
  const mod = Math.trunc((rowH - 2 * AP_PAD) / n);
  if (mod < AP_MIN_MODULE) throw new AppearanceError(`хэт жижиг (өндөр ≥ ${num100(2 * AP_PAD + n * AP_MIN_MODULE)} pt)`);
  const tx = AP_PAD + mod * n + AP_GAP;
  const tw = p.w - tx - AP_PAD;
  const [reg, bld] = loadFonts();
  const w = new PageWriter(reg, bld);
  let lines: ApLine[] | undefined;
  for (let f = AP_MAX_SIZE; f >= AP_MIN_SIZE && lines === undefined && tw > 0; f--) lines = apLayout(w, p, label, f, tw, rowH);
  if (lines === undefined) throw new AppearanceError("хэт жижиг (бичвэр багтахгүй)");
  let total = 0;
  for (const l of lines) total += l.size * AP_LEADING;
  const { cm } = apRotation(p.rotate, p.w, p.h);
  w.op(`/EIDVerify <</URL (${p.url})>> BDC`);
  if (cm !== "") {
    w.op("q");
    w.op(cm);
  }
  w.op(`${C_OK} RG`);
  w.op("1 w");
  w.op(`0.5 0.5 ${num100(p.w - 100)} ${num100(il.boxH - 100)} re S`);
  if (p.sig || p.stamp) {
    w.op("0.5 w");
    w.op(`0 ${num100(rowH)} m ${num100(p.w)} ${num100(rowH)} l S`);
  }
  if (p.sig) apDrawImage(w, "Sig", il.sig);
  w.op(`q ${num100(mod)} 0 0 ${num100(mod)} ${num100(AP_PAD)} ${num100(Math.trunc((rowH - mod * n) / 2))} cm`);
  w.op("0 0 0 rg");
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; ) {
      if (!m[r]![c]) {
        c++;
        continue;
      }
      const s = c;
      while (c < n && m[r]![c]) c++;
      w.op(`${s} ${n - 1 - r} ${c - s} 1 re`);
    }
  }
  w.op("f");
  w.op("Q");
  let cursor = rowH - AP_PAD - Math.trunc((rowH - 2 * AP_PAD - total) / 2);
  for (const l of lines) {
    cursor -= l.size * AP_LEADING;
    w.op(`${l.color} rg`);
    w.op(`BT /F${l.font} ${l.size} Tf ${num100(tx)} ${num100(cursor + l.size * AP_DESCENT)} Td ${w.glyphHex(l.font, l.text)} Tj ET`);
  }
  if (p.stamp) apDrawImage(w, "Stamp", il.stamp);
  if (cm !== "") w.op("Q");
  w.op("EMC");
  return w.ops;
}

function apLayout(w: PageWriter, p: AppearanceParams, label: string, f: number, tw: number, rowH: number): ApLine[] | undefined {
  const b = f - AP_BODY_DELTA;
  const limit = tw * 10;
  const lines: ApLine[] = [];
  for (const t of w.wrapLimit(2, f, p.name, limit, AP_MAX_LINES)) lines.push({ font: 2, size: f, color: C_TEXT, text: t });
  if (p.role !== "") {
    for (const t of w.wrapLimit(1, b, p.role, limit, AP_MAX_LINES)) lines.push({ font: 1, size: b, color: C_TEXT, text: t });
  }
  lines.push({ font: 1, size: b, color: C_OK, text: label }, { font: 1, size: b, color: C_MUTED, text: p.date });
  let total = 0;
  for (const l of lines) {
    if (l.text === "" || w.width1000(l.font, l.size, l.text) > limit) return undefined;
    total += l.size * AP_LEADING;
  }
  if (total > rowH - 2 * AP_PAD) return undefined;
  return lines;
}

/** The number of objects appearanceObjects writes: 11 (form, F1 ×5, F2 ×5) + 2 per image. */
export function appearanceObjectCount(p: Pick<AppearanceParams, "sig" | "stamp">): number {
  return 11 + (p.sig ? 2 : 0) + (p.stamp ? 2 : 0);
}

/**
 * /AP /N form XObject ба түүний 2 фонт (11 объект) + зураг бүрд 2 (APPEARANCE_SPEC.md §6.2): ids = [form, F1 ×5, F2 ×5,
 * (Sig base, Sig mask), (Stamp base, Stamp mask)], ids.length = appearanceObjectCount(p). Буцаах нь объектын бие.
 */
export function appearanceObjects(p: AppearanceParams, ids: number[]): (string | Uint8Array)[] {
  if (ids.length !== appearanceObjectCount(p)) throw new AppearanceError("объектын тоо");
  const [reg, bld] = loadFonts();
  const { bw, bh } = apRotation(p.rotate, p.w, p.h);
  const content = appearanceContent(p);
  let res = `/Font << /F1 ${ids[1]} 0 R /F2 ${ids[6]} 0 R >>`;
  const imgs: Uint8Array[] = [];
  let next = 11;
  if (p.sig || p.stamp) {
    res += " /XObject <<";
    for (const [name, im] of [["Sig", p.sig], ["Stamp", p.stamp]] as const) {
      if (!im) continue;
      const base = ids[next]!;
      const mask = ids[next + 1]!;
      next += 2;
      res += ` /${name} ${base} 0 R`;
      imgs.push(
        streamObj(` /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${mask} 0 R`, Uint8Array.from(im.color)),
        streamObj(` /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, im.alpha),
      );
    }
    res += " >>";
  }
  return [
    streamObj(` /Type /XObject /Subtype /Form /BBox [0 0 ${num100(bw)} ${num100(bh)}] /Resources << ${res} >>`, latin1(content)),
    ...fontBodies(ids.slice(1, 6), reg),
    ...fontBodies(ids.slice(6, 11), bld),
    ...imgs,
  ];
}

/** Харагдах гарын үсгийн талбар/widget-ийн бие (APPEARANCE_SPEC.md §2). rect — хэрэглэгчийн орон зай (h100). */
export function visibleWidget(fieldName: string, rect: number[], pageID: number, pageGen: number, sigID: number, formID: number): string {
  return `<<\n  /Type /Annot\n  /Subtype /Widget\n  /Rect [${rect.map(num100).join(" ")}]\n  /P ${pageID} ${pageGen} R\n  /F 4\n  /FT /Sig\n  /T (${fieldName})\n  /V ${sigID} 0 R\n  /AP << /N ${formID} 0 R >>\n>>`;
}

/** Харагдах (x, y, w, h) → хэрэглэгчийн орон зайн /Rect (APPEARANCE_SPEC.md §1). */
export function visibleRect(box: number[], rot: number, x: number, y: number, w: number, h: number): number[] {
  const [b0, b1, b2, b3] = box as [number, number, number, number];
  const bw = b2 - b0;
  const bh = b3 - b1;
  const [vw, vh] = rot === 90 || rot === 270 ? [bh, bw] : [bw, bh];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > vw || y + h > vh) throw new AppearanceError("тэгш өнцөгт хуудасны (CropBox) гадна");
  const pt = (vx: number, vy: number): [number, number] => {
    switch (rot) {
      case 90:
        return [b2 - vy, b1 + vx];
      case 180:
        return [b2 - vx, b3 - vy];
      case 270:
        return [b0 + vy, b3 - vx];
    }
    return [b0 + vx, b1 + vy];
  };
  const [x1, y1] = pt(x, y);
  const [x2, y2] = pt(x + w, y + h);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/** Хуудасны (удамшсан) CropBox (байхгүй бол MediaBox) h100-аар хэвийн болгосон ба /Rotate (0–270). */
export function pageGeometry(page: Value): { box: number[]; rot: number } {
  const inh = (key: string): Value | undefined => {
    let v = page;
    for (let i = 0; i < MAX_DEPTH; i++) {
      const x = v.key(key);
      if (!x.isNull()) return x;
      v = v.key("Parent");
      if (v.kind() !== "dict") break;
    }
    return undefined;
  };
  const b = inh("CropBox") ?? inh("MediaBox");
  if (b === undefined || b.kind() !== "array" || b.len() !== 4) throw new AppearanceError("хуудасны MediaBox алга");
  const f: number[] = [];
  for (let i = 0; i < 4; i++) {
    const e = b.index(i);
    if (e.kind() !== "int" && e.kind() !== "real") throw new AppearanceError("хуудасны хайрцаг буруу");
    const v = e.float64();
    if (!Number.isFinite(v) || Math.abs(v) > 1e7) throw new AppearanceError("хуудасны хайрцаг буруу");
    f.push(round100(v));
  }
  const box = [Math.min(f[0]!, f[2]!), Math.min(f[1]!, f[3]!), Math.max(f[0]!, f[2]!), Math.max(f[1]!, f[3]!)];
  let rot = 0;
  const r = inh("Rotate");
  if (r !== undefined) {
    if (r.kind() !== "int" || r.int64() % 90 !== 0) throw new AppearanceError("хуудасны /Rotate 90-ийн үржвэр биш");
    rot = ((r.int64() % 360) + 360) % 360;
  }
  return { box, rot };
}

/** /Pages модны n дэх (1-ээс) /Page (модны дарааллаар, гүн ≤ 32). */
export function nthPage(root: Value, n: number): Value | undefined {
  if (n < 1) return undefined;
  const walk = (v: Value, depth: number): Value | undefined => {
    if (depth > MAX_DEPTH) return undefined;
    switch (v.key("Type").name()) {
      case "Page":
        n--;
        return n === 0 ? v : undefined;
      case "Pages": {
        const kids = v.key("Kids");
        for (let i = 0; i < kids.len(); i++) {
          const p = walk(kids.index(i), depth + 1);
          if (p) return p;
          if (n <= 0) break;
        }
      }
    }
    return undefined;
  };
  return walk(root, 0);
}

/** isVerifyPage-ийн уншиx /Annots-ийн дээд тоо (Go maxVerifyAnnots, PLACEMENT_SPEC §3.7-тэй ижил). */
const MAX_VERIFY_ANNOTS = 10000;

/**
 * Go core.DefaultStampPage — `appearance.page` 0 / байхгүй үеийн хуудас (PLACEMENT_SPEC §1a): баримтын (модны
 * дарааллаар) eID verify хуудас БИШ сүүлийн хуудас (1-ээс) ба хуудасны тоо n. Verify хуудас = /Annots-д
 * `/Subtype /Link`, `/A << /S /URI /URI verifyUri >>` (байт-ижил) annotation-тай хуудас. Бүх хуудас verify бол n.
 */
export function defaultStampPage(doc: Uint8Array, verifyUri: string): { page: number; n: number } {
  const pages = pageList(new Incremental(doc).root().key("Pages"));
  return { page: lastNonVerifyPage(pages, verifyUri), n: pages.length };
}

/**
 * The last page (1-based) of `pages` that is not a verify page of `verifyUri`; n when every page is one. verifyUri ""
 * skips nothing (the last page) — SuggestPlacement on an unsigned document (PLACEMENT_SPEC §6b).
 */
export function lastNonVerifyPage(pages: Value[], verifyUri: string): number {
  for (let i = pages.length - 1; verifyUri !== "" && i >= 0; i--) {
    if (!isVerifyPage(pages[i]!, verifyUri)) return i + 1;
  }
  return pages.length;
}

/** Go core.pageList — the /Page objects in /Pages tree order (depth ≤ 32, at most 65 537). */
export function pageList(root: Value): Value[] {
  const pages: Value[] = [];
  const walk = (v: Value, depth: number): void => {
    if (depth > MAX_DEPTH || pages.length > 1 << 16) return;
    switch (v.key("Type").name()) {
      case "Page":
        pages.push(v);
        break;
      case "Pages": {
        const kids = v.key("Kids");
        for (let i = 0; i < kids.len(); i++) walk(kids.index(i), depth + 1);
      }
    }
  };
  walk(root, 0);
  return pages;
}

/** Go isVerifyPage — хуудсын /Annots-д verifyUri руу заасан Link байгаа эсэх; уншиж чадахгүй бол false (агуулга). */
function isVerifyPage(page: Value, verifyUri: string): boolean {
  try {
    const annots = page.key("Annots");
    if (annots.kind() !== "array") return false;
    const want = latin1(verifyUri);
    const m = Math.min(annots.len(), MAX_VERIFY_ANNOTS);
    for (let i = 0; i < m; i++) {
      const a = annots.index(i);
      if (a.kind() !== "dict" || a.key("Subtype").name() !== "Link") continue;
      const act = a.key("A");
      if (act.kind() !== "dict" || act.key("S").name() !== "URI") continue;
      const u = act.key("URI");
      if (u.kind() !== "string") continue;
      const got = u.rawString();
      if (got.length === want.length && got.every((b, j) => b === want[j])) return true;
    }
  } catch {
    /* Go: recover → false */
  }
  return false;
}

/** Баримтын /Pages модны /Page объектын тоо (модыг тоолно, /Count-д итгэхгүй). */
export function pageCount(doc: Uint8Array): number {
  const inc = new Incremental(doc);
  let n = 0;
  const walk = (v: Value, depth: number): void => {
    if (depth > MAX_DEPTH || n > 1 << 16) return;
    switch (v.key("Type").name()) {
      case "Page":
        n++;
        break;
      case "Pages": {
        const kids = v.key("Kids");
        for (let i = 0; i < kids.len(); i++) walk(kids.index(i), depth + 1);
      }
    }
  };
  walk(inc.root().key("Pages"), 0);
  return n;
}
