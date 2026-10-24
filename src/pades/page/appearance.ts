// Харагдах гарын үсэг — APPEARANCE_SPEC.md (pades-client/1), Go reference pades/internal/core/appearance.go-ийн 1:1 порт.
// Widget нь сонгосон хуудсан дээр /Rect-тэй, /AP /N нь шахалтгүй form XObject (verify хуудасны фонт asset, өөрийн QR).
// Бүх урт/координат 1/100 pt-ийн БҮХЭЛ тоо (h100): бичихдээ num100.

import { latin1 } from "../bytes.js";
import { Incremental } from "../pdf/incremental.js";
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
  let m: boolean[][];
  try {
    m = qrEncode(latin1(p.url));
  } catch (e) {
    throw new AppearanceError(String(e));
  }
  const n = m.length;
  const mod = Math.trunc((p.h - 2 * AP_PAD) / n);
  if (mod < AP_MIN_MODULE) throw new AppearanceError(`хэт жижиг (өндөр ≥ ${num100(2 * AP_PAD + n * AP_MIN_MODULE)} pt)`);
  const tx = AP_PAD + mod * n + AP_GAP;
  const tw = p.w - tx - AP_PAD;
  const [reg, bld] = loadFonts();
  const w = new PageWriter(reg, bld);
  let lines: ApLine[] | undefined;
  for (let f = AP_MAX_SIZE; f >= AP_MIN_SIZE && lines === undefined && tw > 0; f--) lines = apLayout(w, p, label, f, tw);
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
  w.op(`0.5 0.5 ${num100(p.w - 100)} ${num100(p.h - 100)} re S`);
  w.op(`q ${num100(mod)} 0 0 ${num100(mod)} ${num100(AP_PAD)} ${num100(Math.trunc((p.h - mod * n) / 2))} cm`);
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
  let cursor = p.h - AP_PAD - Math.trunc((p.h - 2 * AP_PAD - total) / 2);
  for (const l of lines) {
    cursor -= l.size * AP_LEADING;
    w.op(`${l.color} rg`);
    w.op(`BT /F${l.font} ${l.size} Tf ${num100(tx)} ${num100(cursor + l.size * AP_DESCENT)} Td ${w.glyphHex(l.font, l.text)} Tj ET`);
  }
  if (cm !== "") w.op("Q");
  w.op("EMC");
  return w.ops;
}

function apLayout(w: PageWriter, p: AppearanceParams, label: string, f: number, tw: number): ApLine[] | undefined {
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
  if (total > p.h - 2 * AP_PAD) return undefined;
  return lines;
}

/** /AP /N form XObject ба түүний 2 фонт (11 объект): ids = [form, F1 ×5, F2 ×5]. Буцаах нь объектын бие. */
export function appearanceObjects(p: AppearanceParams, ids: number[]): (string | Uint8Array)[] {
  const [reg, bld] = loadFonts();
  const { bw, bh } = apRotation(p.rotate, p.w, p.h);
  const content = appearanceContent(p);
  return [
    streamObj(
      ` /Type /XObject /Subtype /Form /BBox [0 0 ${num100(bw)} ${num100(bh)}] /Resources << /Font << /F1 ${ids[1]} 0 R /F2 ${ids[6]} 0 R >> >>`,
      latin1(content),
    ),
    ...fontBodies(ids.slice(1, 6), reg),
    ...fontBodies(ids.slice(6, 11), bld),
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
