// signature.go-ийн порт: үл харагдах approval гарын үсгийн revision (Sig толь + тогтмол placeholder, widget/талбар,
// эхний хуудасны /Annots, шинэ Catalog + AcroForm), EmbedCMS, SignatureContents.

import { sha256 } from "../crypto.js";
import { fromHex, latin1, toHex } from "../bytes.js";
import { Incremental } from "./incremental.js";
import { PdfError, Value } from "./reader.js";
import { escapeName, hexString, serialize } from "./serialize.js";
import { AppearanceError, appearanceObjectCount, appearanceObjects, nthPage, pageGeometry, visibleRect, visibleWidget, type Visible } from "../page/appearance.js";
import { placeOnPage, type PlaceStatus } from "../page/occupancy.js";

/** CMS-ийн дээд хэмжээ (хэмжсэн 14 KiB) × 2 — /Contents-ийн binary багтаамж. */
export const MEASURED_MAX_CMS = 14 << 10;
export const PLACEHOLDER_BYTES = 2 * MEASURED_MAX_CMS;
export const SUB_FILTER = "ETSI.CAdES.detached";
export const REASON_MAX_UNITS = 127;
const BYTE_RANGE_WIDTH = 40;
const MAX_DEPTH = 32;

export class PlaceholderOverflowError extends Error {}

export type ByteRange = [number, number, number, number];

export interface PreparedSig {
  pdf: Uint8Array;
  byteRange: ByteRange;
  digest: Uint8Array;
  fieldName: string;
  /** The visible stamp's final lower-left corner (visible page space, h100) and how it was chosen; absent when invisible. */
  placement?: { x: number; y: number; status: PlaceStatus };
}

/** "(D:YYYYMMDDHHmmSS+08'00')" — цаг үргэлж +08:00 (Go reference signingZone). */
export function pdfDate(t: Date): string {
  const z = new Date(t.getTime() + 8 * 3600_000);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `(D:${p(z.getUTCFullYear(), 4)}${p(z.getUTCMonth() + 1)}${p(z.getUTCDate())}${p(z.getUTCHours())}${p(z.getUTCMinutes())}${p(z.getUTCSeconds())}+08'00')`;
}

/**
 * vis өгсөн бол харагдах widget (APPEARANCE_SPEC.md): /Rect нь vis.page хуудсан дээр, /F 4, /AP /N form XObject (+ 2 фонт),
 * widget тэр хуудасны /Annots-д. vis.name нь /Name-тэй ижил (бичигдэх ёстой — эс бөгөөс AppearanceError).
 */
export async function prepareSignature(base: Uint8Array, signingTime: Date, signerName: string, reason: string, vis?: Visible): Promise<PreparedSig> {
  const inc = new Incremental(base);
  const root = inc.root();
  const acro = root.key("AcroForm");
  const fields = acro.key("Fields");
  const names = new Set<string>();
  let sigFields = 0;
  for (let i = 0; i < fields.len(); i++) {
    const f = fields.index(i);
    names.add(f.key("T").text());
    if (f.key("FT").name() === "Sig") sigFields++;
  }
  let k = sigFields + 1;
  while (names.has(`Signature ${k}`)) k++;
  const fieldName = `Signature ${k}`;

  const sigID = inc.reserve();
  const fieldID = inc.reserve();
  const catID = inc.reserve();
  // Харагдах: form, F1 ×5, F2 ×5, зураг бүрд 2 (APPEARANCE_SPEC.md §6.2).
  const apIDs = vis ? Array.from({ length: appearanceObjectCount(vis) }, () => inc.reserve()) : [];

  let sig = `<<\n /Type /Sig\n /Filter /Adobe.PPKLite\n /SubFilter /${SUB_FILTER}\n /ByteRange `;
  const brAt = sig.length;
  sig += " ".repeat(BYTE_RANGE_WIDTH);
  sig += "\n /Contents <";
  const contentsAt = sig.length - 1;
  sig += "0".repeat(2 * PLACEHOLDER_BYTES);
  sig += ">\n /M " + pdfDate(signingTime);
  const n = sigText(signerName, 120);
  if (n) sig += "\n /Name " + n;
  const r = sigText(reason, REASON_MAX_UNITS);
  if (r) sig += "\n /Reason " + r;
  sig += "\n>>";
  // Body нь "<<"-аар эхэлдэг тул trimSpace байрлалыг өөрчлөхгүй.
  const sigStart = inc.writeObject(sigID, sig);

  let page: Value | undefined;
  let placement: PreparedSig["placement"];
  if (!vis) {
    // Үл харагдах (digitorus createVisualSignature, invisible): эхний хуудас.
    let fld = "<<\n  /Type /Annot\n  /Subtype /Widget\n  /Rect [0 0 0 0]\n";
    page = firstPage(root.key("Pages"), 0);
    if (page) fld += `  /P ${page.ptr.id} ${page.ptr.gen} R\n`;
    fld += `  /F 132\n  /FT /Sig\n  /T (${fieldName})\n  /V ${sigID} 0 R\n>>`;
    inc.writeObject(fieldID, fld);
  } else {
    if (n === "" || goTrimSpace(signerName) !== vis.name) throw new AppearanceError("/Name бичигдэхгүй нэр");
    page = nthPage(root.key("Pages"), vis.page);
    if (!page) throw new AppearanceError(`хуудас ${vis.page} алга`);
    const { box, rot } = pageGeometry(page);
    let rect = visibleRect(box, rot, vis.x, vis.y, vis.w, vis.h);
    placement = { x: vis.x, y: vis.y, status: "requested" };
    if (vis.avoid) {
      // PLACEMENT_SPEC.md: move off existing page content (exact: only report it); the requested rect stays when
      // nothing is free.
      placement = placeOnPage(page, box, rot, vis.x, vis.y, vis.w, vis.h, vis.exact === true);
      if (placement.x !== vis.x || placement.y !== vis.y) rect = visibleRect(box, rot, placement.x, placement.y, vis.w, vis.h);
    }
    const bodies = appearanceObjects(
      { w: vis.w, h: vis.h, rotate: rot, name: vis.name, role: vis.role, lang: vis.lang, date: vis.date, url: vis.url, sig: vis.sig, stamp: vis.stamp },
      apIDs,
    );
    inc.writeObject(fieldID, visibleWidget(fieldName, rect, page.ptr.id, page.ptr.gen, sigID, apIDs[0]!));
    bodies.forEach((b, i) => inc.writeObject(apIDs[i]!, b));
  }
  if (page) addWidgetToPage(inc, page, fieldID);

  let cat = "<<\n  /Type /Catalog\n";
  if (root.key("Version").isNull()) {
    const v = parseGoFloat(inc.rdr.pdfVersion);
    if (v !== undefined && v < 1.5) cat += "  /Version /1.5\n";
  }
  cat += inc.catalogCopy("AcroForm");
  cat += "  /AcroForm <<";
  if (acro.kind() === "dict") {
    const ap = acro.ptr;
    for (const key of acro.keys()) {
      if (key === "Fields" || key === "SigFlags") continue;
      cat += " /" + escapeName(key) + " " + serialize(acro.key(key), ap.id, 0);
    }
  }
  cat += " /Fields [";
  const fp = fields.ptr;
  for (let i = 0; i < fields.len(); i++) cat += serialize(fields.index(i), fp.id, 0) + " ";
  cat += `${fieldID} 0 R] /SigFlags 3 >>\n>>`;
  inc.writeObject(catID, cat);

  const doc = inc.finish(catID);
  const a = sigStart + contentsAt;
  const b = a + 2 * PLACEHOLDER_BYTES + 2;
  if (doc[a] !== 0x3c || doc[b - 1] !== 0x3e) throw new PdfError("pades: placeholder-ийн байрлал буруу");
  const br: ByteRange = [0, a, b, doc.length - b];
  const field = `[${br[0]} ${br[1]} ${br[2]} ${br[3]}]`;
  if (field.length > BYTE_RANGE_WIDTH) throw new PdfError("pades: ByteRange талбарт багтсангүй");
  doc.set(latin1(field), sigStart + brAt);
  return { pdf: doc, byteRange: br, digest: await rangeDigest(doc, br), fieldName, placement };
}

/** SHA-256(doc[0:a] ‖ doc[b:b+c]). */
export async function rangeDigest(doc: Uint8Array, br: ByteRange): Promise<Uint8Array> {
  const buf = new Uint8Array(br[1] + br[3]);
  buf.set(doc.subarray(0, br[1]), 0);
  buf.set(doc.subarray(br[2], br[2] + br[3]), br[1]);
  return sha256(buf);
}

/** CMS-ийг placeholder-т hex-ээр бичнэ; багтахгүй бол PlaceholderOverflowError (тайрахгүй). */
export function embedCMS(prepared: Uint8Array, br: ByteRange, cms: Uint8Array): Uint8Array {
  if (cms.length === 0) throw new PdfError("pades: CMS хоосон");
  if (cms.length > PLACEHOLDER_BYTES) throw new PlaceholderOverflowError(`${cms.length} > ${PLACEHOLDER_BYTES} байт`);
  const [z, a, b, c] = br;
  if (z !== 0 || a <= 0 || b !== a + 2 * PLACEHOLDER_BYTES + 2 || b + c !== prepared.length || prepared[a] !== 0x3c || prepared[b - 1] !== 0x3e) {
    throw new PdfError("pades: ByteRange нь prepared баримттай таарахгүй");
  }
  for (let i = a + 1; i < b - 1; i++) if (prepared[i] !== 0x30) throw new PdfError("pades: placeholder аль хэдийн бөглөгдсөн");
  const out = prepared.slice();
  out.set(latin1(toHex(cms)), a + 1);
  return out;
}

/** ByteRange-ийн заасан /Contents (hex тайлсан, тэг дүүргэлттэй). */
export function signatureContents(signed: Uint8Array, br: ByteRange): Uint8Array {
  const [z, a, b] = br;
  if (z !== 0 || a <= 0 || b <= a + 2 || b > signed.length || signed[a] !== 0x3c || signed[b - 1] !== 0x3e) {
    throw new PdfError("pades: ByteRange нь /Contents-ийг заахгүй");
  }
  let s = "";
  for (let i = a + 1; i < b - 1; i++) s += String.fromCharCode(signed[i]!);
  if (s.length % 2 !== 0) throw new PdfError("pades: /Contents hex: odd length");
  return fromHex(s);
}

function addWidgetToPage(inc: Incremental, page: Value, widget: number): void {
  const pgp = page.ptr;
  const annots = page.key("Annots");
  if (!annots.isNull() && annots.kind() !== "array") throw new PdfError("хуудасны /Annots массив биш");
  const ap = annots.ptr;
  let arr = "[";
  for (let i = 0; i < annots.len(); i++) arr += serialize(annots.index(i), ap.id, 0) + " ";
  arr += `${widget} 0 R]`;
  if (!annots.isNull() && (ap.id !== pgp.id || ap.gen !== pgp.gen)) {
    inc.writeObject(ap.id, arr, ap.gen);
    return;
  }
  let b = "<<";
  for (const key of page.keys()) {
    if (key === "Annots") continue;
    b += " /" + escapeName(key) + " " + serialize(page.key(key), pgp.id, 0);
  }
  b += " /Annots " + arr + " >>";
  inc.writeObject(pgp.id, b, pgp.gen);
}

function firstPage(v: Value, depth: number): Value | undefined {
  if (depth > MAX_DEPTH) return undefined;
  switch (v.key("Type").name()) {
    case "Page":
      return v;
    case "Pages": {
      const kids = v.key("Kids");
      for (let i = 0; i < kids.len(); i++) {
        const p = firstPage(kids.index(i), depth + 1);
        if (p) return p;
      }
    }
  }
  return undefined;
}

/** Go strconv.ParseFloat (header-ийн "1.x"). */
function parseGoFloat(s: string): number | undefined {
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : undefined;
}

const BAD_WORDS = [" obj", "endobj", "stream", "xref", "trailer", "%%EOF"];

/** Go unicode.IsSpace-ийн TrimSpace (strings.TrimSpace). */
function goTrimSpace(s: string): string {
  const sp = (c: number): boolean =>
    (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  let lo = 0;
  let hi = s.length;
  while (lo < hi && sp(s.charCodeAt(lo))) lo++;
  while (hi > lo && sp(s.charCodeAt(hi - 1))) hi--;
  return s.slice(lo, hi);
}

/**
 * /Name, /Reason-ийн PDF text string (hex): ASCII бол шууд, эс бөгөөс BOM-той UTF-16BE. Хоосон, хэт урт (UTF-16 нэгж),
 * удирдах тэмдэгт, PDF түлхүүр үгтэй бол "" (бичихгүй).
 */
export function sigText(input: string, maxUnits: number): string {
  const s = goTrimSpace(input);
  if (s === "" || s.length > maxUnits || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) return "";
  let ascii = true;
  for (const ch of s) {
    const r = ch.codePointAt(0)!;
    if (r < 0x20 || r === 0x7f || (r >= 0x80 && r <= 0x9f)) return "";
    if (r > 0x7e) ascii = false;
  }
  if (BAD_WORDS.some((w) => s.includes(w))) return "";
  if (ascii) return hexString(latin1(s));
  const raw = new Uint8Array(2 + s.length * 2);
  raw[0] = 0xfe;
  raw[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    raw[2 + i * 2] = u >> 8;
    raw[3 + i * 2] = u & 0xff;
  }
  return hexString(raw);
}
