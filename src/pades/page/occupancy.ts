// Visible stamp placement — PLACEMENT_SPEC.md (pades-client/1), a 1:1 port of the Go reference
// pades/internal/core/occupancy.go (Occupancy) and placement.go (placeCandidates, placeVisible).
//
// The occupancy scanner is a pure function of the page objects: it never renders and never loads a system font. All
// arithmetic is IEEE-754 binary64 with +, −, ×, ÷ in exactly the order written in the spec (§2) — JS never fuses
// a·b + c, so plain expressions match Go's explicit float64(...) roundings. Results are pinned box-for-box by
// test/fixtures/pades/golden/placement/vectors.json.

import { zlibInflateStrict } from "../pdf/inflate.js";
import { PInt, PStream, type Value } from "../pdf/reader.js";
import { visibleRect } from "./appearance.js";

// Limits (PLACEMENT_SPEC.md §5). Hitting any of them makes the page unscannable: the stamp stays where it was requested.
const MAX_BYTES = 4 << 20; // decoded content bytes, page + every form execution
const MAX_OPS = 100_000; // operators executed, page + forms
const MAX_DEPTH = 8; // form XObject nesting (page content = 0)
const MAX_SAVE = 64; // q nesting per content stream
const MAX_OPERANDS = 65_536; // operand objects pending at one operator (nested array elements count)
const MAX_NESTING = 32; // array / dictionary nesting in an operand
const MAX_ANNOTS = 10_000; // /Annots entries
const MAX_W_ENTRIES = 65_536; // CIDFont /W: elements read (outer array, and each inner array)
const MAX_W_ASSIGN = 262_144; // CIDFont /W: CID assignments attempted before reading stops
const MAX_NUM_LEN = 32; // a longer numeric token is not a number
const CLAMP = 1e7; // box coordinates are clamped to ±CLAMP pt before quantising
const MAX_INHERIT = 32; // /Parent chain for inherited page attributes

/** The page cannot be scanned within the rules (limit hit, unsupported filter, broken stream). */
export class UnscannableError extends Error {}

const unscannable = (why: string): UnscannableError => new UnscannableError(`pades: page content not scannable: ${why}`);

/** h100 box [x0, y0, x1, y1] in default user space. */
export type Box = [number, number, number, number];

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m × n (row-vector convention, ISO 32000-1 §8.3.4): each product rounded on its own, summed left to right. */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** (x, y) × m: x' = a·x + c·y + e, y' = b·x + d·y + f. */
function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const finite = (m: Matrix): boolean => m.every((v) => Number.isFinite(v));

/** A float bounding box being accumulated (default user space). */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const pointRect = (x: number, y: number): Rect => ({ x0: x, y0: y, x1: x, y1: y });

function addPoint(r: Rect, x: number, y: number): void {
  r.x0 = Math.min(r.x0, x);
  r.y0 = Math.min(r.y0, y);
  r.x1 = Math.max(r.x1, x);
  r.y1 = Math.max(r.y1, y);
}

/** Outward to h100 after clamping to ±CLAMP pt: floor(min·100), ceil(max·100). `+ 0` folds −0 into 0 (Go int). */
function quantise(r: Rect): Box {
  const c = (v: number): number => {
    if (Number.isNaN(v)) throw unscannable("NaN");
    return Math.min(Math.max(v, -CLAMP), CLAMP);
  };
  const x0 = c(r.x0);
  const y0 = c(r.y0);
  const x1 = c(r.x1);
  const y1 = c(r.y1);
  return [Math.floor(x0 * 100) + 0, Math.floor(y0 * 100) + 0, Math.ceil(x1 * 100) + 0, Math.ceil(y1 * 100) + 0];
}

// ── Fonts (PLACEMENT_SPEC.md §3.4) ──

const enum FontKind {
  Simple, // 1-byte codes, /Widths
  Identity, // Type0 + /Identity-H|V: 2-byte codes, /W + /DW
  Composite, // Type0, any other /Encoding: 1-byte codes, 1000
  Default, // Type3, missing font, no Tf: 1-byte codes, 1000
}

interface Font {
  kind: FontKind;
  first: number;
  /** simple: /Widths (non-number → NaN = not given). */
  widths: number[];
  /** simple: FontDescriptor /MissingWidth if > 0, else 1000. */
  missing: number;
  /** identity: /DW, default 1000. */
  dw: number;
  w: Map<number, number>;
}

const newFont = (kind: FontKind): Font => ({ kind, first: 0, widths: [], missing: 1000, dw: 1000, w: new Map() });

const DEFAULT_FONT: Font = newFont(FontKind.Default);

function number(v: Value): number | undefined {
  const k = v.kind();
  return k === "int" || k === "real" ? v.float64() : undefined;
}

function loadFont(v: Value): Font {
  switch (v.key("Subtype").name()) {
    case "Type3":
      return DEFAULT_FONT;
    case "Type0": {
      const enc = v.key("Encoding");
      if (enc.kind() !== "name" || (enc.name() !== "Identity-H" && enc.name() !== "Identity-V")) return newFont(FontKind.Composite);
      const f = newFont(FontKind.Identity);
      const d = v.key("DescendantFonts").index(0);
      const dw = number(d.key("DW"));
      if (dw !== undefined) f.dw = dw;
      const w = d.key("W");
      const n = Math.min(w.len(), MAX_W_ENTRIES);
      let budget = MAX_W_ASSIGN;
      const set = (cid: number, val: number): boolean => {
        if (--budget < 0) return false;
        if (!f.w.has(cid) && cid >= 0 && cid <= 0xffff) f.w.set(cid, val);
        return true;
      };
      read: for (let i = 0; i < n; ) {
        const c0f = number(w.index(i));
        if (c0f === undefined || i + 1 >= n) break;
        const c0 = Math.trunc(c0f);
        const arr = w.index(i + 1);
        if (arr.kind() === "array") {
          const m = Math.min(arr.len(), MAX_W_ENTRIES);
          for (let j = 0; j < m; j++) {
            const x = number(arr.index(j));
            if (x !== undefined && !set(c0 + j, x)) break read;
          }
          i += 2;
          continue;
        }
        const c1 = number(w.index(i + 1));
        const x = number(w.index(i + 2));
        if (c1 === undefined || x === undefined || i + 2 >= n) break;
        const hi = Math.trunc(c1);
        for (let c = Math.max(c0, 0); c <= hi && c <= 0xffff; c++) {
          if (!set(c, x)) break read;
        }
        i += 3;
      }
      return f;
    }
  }
  const f = newFont(FontKind.Simple);
  const fc = number(v.key("FirstChar"));
  if (fc !== undefined) f.first = Math.trunc(fc);
  const ws = v.key("Widths");
  const m = Math.min(ws.len(), 256);
  for (let i = 0; i < m; i++) f.widths.push(number(ws.index(i)) ?? NaN);
  const mw = number(v.key("FontDescriptor").key("MissingWidth"));
  if (mw !== undefined && mw > 0) f.missing = mw;
  return f;
}

/** A string's codes: width (glyph space, 1/1000 em) and whether the code is the 1-byte code 32. */
function glyphs(f: Font, b: Uint8Array, fn: (w0: number, space: boolean) => void): void {
  if (f.kind === FontKind.Identity) {
    for (let i = 0; i + 1 < b.length; i += 2) {
      const w = f.w.get((b[i]! << 8) | b[i + 1]!);
      fn(w ?? f.dw, false);
    }
    return;
  }
  for (const c of b) {
    let w = 1000;
    if (f.kind === FontKind.Simple) {
      w = f.missing;
      const i = c - f.first;
      if (i >= 0 && i < f.widths.length && !Number.isNaN(f.widths[i]!)) w = f.widths[i]!;
    }
    fn(w, f.kind !== FontKind.Composite && c === 0x20);
  }
}

// ── Content-stream lexer (PLACEMENT_SPEC.md §3.1) ──

const enum T {
  Num,
  Str,
  Name,
  Arr,
  Dict,
  Other, // true/false/null, or any keyword inside an array/dictionary
}

interface Operand {
  kind: T;
  num: number;
  str: Uint8Array;
  name: string;
  arr: Operand[];
}

const EMPTY: Uint8Array = new Uint8Array(0);
const opnd = (kind: T, num = 0, str: Uint8Array = EMPTY, name = ""): Operand => ({ kind, num, str, name, arr: [] });

const enum Lx {
  EOF,
  Obj,
  Keyword,
  ArrEnd,
  DictEnd,
}

const isSpace = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

// ( ) < > [ ] { } / %
const isDelim = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

/** [+-]?(\d+(\.\d*)?|\.\d+), at most MAX_NUM_LEN bytes. */
function isNumber(b: Uint8Array, s: number, e: number): boolean {
  if (e === s || e - s > MAX_NUM_LEN) return false;
  let i = s;
  if (b[i] === 0x2b || b[i] === 0x2d) i++;
  let digits = 0;
  let dot = false;
  for (; i < e; i++) {
    const c = b[i]!;
    if (c >= 0x30 && c <= 0x39) digits++;
    else if (c === 0x2e && !dot) dot = true;
    else return false;
  }
  return digits > 0;
}

const latin1 = (b: Uint8Array, s: number, e: number): string => {
  let out = "";
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]!);
  return out;
};

interface Token {
  k: Lx;
  o: Operand;
  /** Lx.Obj: "[" / "<<" when an array / dictionary was opened; Lx.Keyword: the keyword. */
  kw: string;
}

const EOF_TOKEN: Token = { k: Lx.EOF, o: opnd(T.Other), kw: "" };

class Lexer {
  i = 0;
  constructor(readonly b: Uint8Array) {}

  skipSpace(): void {
    const b = this.b;
    while (this.i < b.length) {
      const c = b[this.i]!;
      if (isSpace(c)) this.i++;
      else if (c === 0x25) {
        while (this.i < b.length && b[this.i] !== 0x0d && b[this.i] !== 0x0a) this.i++;
      } else return;
    }
  }

  /** Regular bytes from the current position; returns the end index (this.i is advanced to it). */
  regular(): number {
    const b = this.b;
    while (this.i < b.length && !isSpace(b[this.i]!) && !isDelim(b[this.i]!)) this.i++;
    return this.i;
  }

  /** After '(' : balanced parentheses, escapes; EOF ends the string. */
  literal(): Uint8Array {
    const b = this.b;
    const out: number[] = [];
    let depth = 1;
    while (this.i < b.length) {
      let c = b[this.i++]!;
      switch (c) {
        case 0x28:
          depth++;
          break;
        case 0x29:
          if (--depth === 0) return Uint8Array.from(out);
          break;
        case 0x5c: {
          if (this.i >= b.length) return Uint8Array.from(out);
          const e = b[this.i++]!;
          switch (e) {
            case 0x6e:
              c = 0x0a;
              break;
            case 0x72:
              c = 0x0d;
              break;
            case 0x74:
              c = 0x09;
              break;
            case 0x62:
              c = 0x08;
              break;
            case 0x66:
              c = 0x0c;
              break;
            case 0x0d:
              if (this.i < b.length && b[this.i] === 0x0a) this.i++;
              continue;
            case 0x0a:
              continue;
            default:
              if (e >= 0x30 && e <= 0x37) {
                let v = e - 0x30;
                for (let k = 0; k < 2 && this.i < b.length && b[this.i]! >= 0x30 && b[this.i]! <= 0x37; k++) v = v * 8 + (b[this.i++]! - 0x30);
                c = v & 0xff;
              } else c = e;
          }
        }
      }
      out.push(c);
    }
    return Uint8Array.from(out);
  }

  /** After '<' : hex digits, other bytes skipped, odd final nibble padded with 0; '>' or EOF ends it. */
  hexString(): Uint8Array {
    const b = this.b;
    const out: number[] = [];
    let hi = 0;
    let half = false;
    while (this.i < b.length) {
      const c = b[this.i++]!;
      if (c === 0x3e) break;
      const v = unhex(c);
      if (v < 0) continue;
      if (half) out.push((hi << 4) | v);
      else hi = v;
      half = !half;
    }
    if (half) out.push(hi << 4);
    return Uint8Array.from(out);
  }

  /** After '/' : regular bytes, #xx decoded (latin1, like the PDF object reader). */
  name(): string {
    const s = this.i;
    const e = this.regular();
    const t = this.b;
    let out = "";
    for (let i = s; i < e; i++) {
      if (t[i] === 0x23 && i + 2 < e) {
        const h = unhex(t[i + 1]!);
        const lo = unhex(t[i + 2]!);
        if (h >= 0 && lo >= 0) {
          out += String.fromCharCode((h << 4) | lo);
          i += 2;
          continue;
        }
      }
      out += String.fromCharCode(t[i]!);
    }
    return out;
  }

  /** One token. Keywords come back as Lx.Keyword; '{' '}', stray ')' and a lone '>' are skipped. */
  next(): Token {
    const b = this.b;
    for (;;) {
      this.skipSpace();
      if (this.i >= b.length) return EOF_TOKEN;
      switch (b[this.i]) {
        case 0x28:
          this.i++;
          return { k: Lx.Obj, o: opnd(T.Str, 0, this.literal()), kw: "" };
        case 0x3c:
          if (this.i + 1 < b.length && b[this.i + 1] === 0x3c) {
            this.i += 2;
            return { k: Lx.Obj, o: opnd(T.Dict), kw: "<<" };
          }
          this.i++;
          return { k: Lx.Obj, o: opnd(T.Str, 0, this.hexString()), kw: "" };
        case 0x3e:
          if (this.i + 1 < b.length && b[this.i + 1] === 0x3e) {
            this.i += 2;
            return { k: Lx.DictEnd, o: EOF_TOKEN.o, kw: "" };
          }
          this.i++;
          continue;
        case 0x5b:
          this.i++;
          return { k: Lx.Obj, o: opnd(T.Arr), kw: "[" };
        case 0x5d:
          this.i++;
          return { k: Lx.ArrEnd, o: EOF_TOKEN.o, kw: "" };
        case 0x2f:
          this.i++;
          return { k: Lx.Obj, o: opnd(T.Name, 0, EMPTY, this.name()), kw: "" };
        case 0x29:
        case 0x7b:
        case 0x7d:
          this.i++;
          continue;
      }
      const s = this.i;
      const e = this.regular();
      if (isNumber(b, s, e)) return { k: Lx.Obj, o: opnd(T.Num, Number(latin1(b, s, e))), kw: "" };
      const t = latin1(b, s, e);
      if (t === "true" || t === "false" || t === "null") return { k: Lx.Obj, o: opnd(T.Other), kw: "" };
      return { k: Lx.Keyword, o: EOF_TOKEN.o, kw: t };
    }
  }

  /**
   * Completes an array or dictionary opened by next (open = "[" or "<<"). Inside, every token is an element; EOF ends
   * the content (returns eof = true). Nesting > MAX_NESTING or too many elements → UnscannableError.
   */
  object(o: Operand, open: string, depth: number, count: { n: number }): boolean {
    if (open === "") return false;
    if (depth >= MAX_NESTING) throw unscannable("nesting");
    for (;;) {
      const t = this.next();
      let e = t.o;
      switch (t.k) {
        case Lx.EOF:
          return true;
        case Lx.ArrEnd:
          if (open === "[") return false;
          continue;
        case Lx.DictEnd:
          if (open === "<<") return false;
          continue;
        case Lx.Keyword:
          e = opnd(T.Other);
          break;
        case Lx.Obj:
          if (this.object(e, t.kw, depth + 1, count)) return true;
      }
      if (++count.n > MAX_OPERANDS) throw unscannable("operands");
      if (open === "[") o.arr.push(e);
    }
  }
}

// ── Interpreter (PLACEMENT_SPEC.md §3.2–§3.6) ──

interface GState {
  ctm: Matrix;
  lw: number;
  fillWhite: boolean;
  strokeWhite: boolean;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  tfs: number;
  trise: number;
  font: Font;
}

interface Subpath {
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  bbox: Rect;
  segs: Rect[];
}

/** The operands if they are exactly n numbers. */
function nums(ops: Operand[], n: number): number[] | undefined {
  if (ops.length !== n) return undefined;
  const out: number[] = [];
  for (const o of ops) {
    if (o.kind !== T.Num) return undefined;
    out.push(o.num);
  }
  return out;
}

function closePath(sp: Subpath): void {
  const seg = pointRect(sp.cx, sp.cy);
  addPoint(seg, sp.sx, sp.sy);
  sp.segs.push(seg);
  sp.cx = sp.sx;
  sp.cy = sp.sy;
}

const PATH_POINTS: Record<string, number> = { l: 2, c: 6, v: 4, y: 4 };

/** A page attribute, following /Parent (depth ≤ 32). */
function inherited(page: Value, key: string): Value | undefined {
  let v = page;
  for (let i = 0; i < MAX_INHERIT; i++) {
    const x = v.key(key);
    if (!x.isNull()) return x;
    v = v.key("Parent");
    if (v.kind() !== "dict") break;
  }
  return undefined;
}

class Scanner {
  bytes = 0;
  ops = 0;
  readonly boxes: Box[] = [];
  private readonly fonts = new Map<number, Font>();

  constructor(private readonly page: Box) {}

  emit(r: Rect): void {
    this.boxes.push(quantise(r));
  }

  /** Font cache keyed by the containing object's number, as the Go reference (digitorus Value.GetPtr) does. */
  font(v: Value): Font {
    if (v.kind() !== "dict") return DEFAULT_FONT;
    const id = v.ptr.id;
    const hit = this.fonts.get(id);
    if (hit && id !== 0) return hit;
    const f = loadFont(v);
    if (id !== 0) this.fonts.set(id, f);
    return f;
  }

  /** Decoded bytes of a content/form stream: no filter, or exactly FlateDecode without parameters. */
  stream(v: Value): Uint8Array {
    if (v.kind() !== "stream") throw unscannable("not a stream");
    const f = v.key("Filter");
    const p = v.key("DecodeParms");
    let flate: boolean;
    if (f.isNull() && p.isNull()) flate = false;
    else if (f.kind() === "name" && f.name() === "FlateDecode" && p.isNull()) flate = true;
    else if (
      f.kind() === "array" && f.len() === 1 && f.index(0).kind() === "name" && f.index(0).name() === "FlateDecode" &&
      (p.isNull() || (p.kind() === "array" && p.len() === 1 && p.index(0).isNull()))
    ) {
      flate = true;
    } else throw unscannable("filter");
    // Go io.NewSectionReader(file, offset, /Length): a negative length reads nothing, past the end of the file reads
    // what is there.
    const x = v.data as PStream;
    const n = v.key("Length").int64();
    const raw = n > 0 ? v.r.bytes.subarray(x.offset, x.offset + n) : EMPTY;
    const left = MAX_BYTES - this.bytes;
    let b: Uint8Array;
    if (flate) {
      try {
        b = zlibInflateStrict(raw, left + 1);
      } catch (e) {
        throw unscannable(e instanceof Error ? e.message : "inflate");
      }
    } else b = raw.subarray(0, left + 1);
    if (b.length > left) throw unscannable("content bytes");
    this.bytes += b.length;
    return b;
  }

  /** /Contents: absent → empty; a stream; or an array of streams joined with LF. */
  pageContent(c: Value): Uint8Array {
    switch (c.kind()) {
      case "null":
        return EMPTY;
      case "stream":
        return this.stream(c);
      case "array": {
        const parts: Uint8Array[] = [];
        let total = 0;
        for (let i = 0; i < c.len(); i++) {
          const b = this.stream(c.index(i));
          parts.push(b);
          total += b.length + (i > 0 ? 1 : 0);
        }
        const out = new Uint8Array(total);
        let at = 0;
        parts.forEach((b, i) => {
          if (i > 0) out[at++] = 0x0a;
          out.set(b, at);
          at += b.length;
        });
        return out;
      }
    }
    throw unscannable("/Contents");
  }

  /** Executes one content stream (page content or a form) from graphics state g0, with its own operand stack, q stack,
   * path and text matrices. */
  run(content: Uint8Array, res: Value | undefined, g0: GState, depth: number): void {
    const l = new Lexer(content);
    let g: GState = { ...g0 };
    const stack: GState[] = [];
    let path: Subpath[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let ops: Operand[] = [];
    const count = { n: 0 };
    const key = (v: Value | undefined, k: string): Value | undefined => v?.key(k);
    const textLine = (ty: number): void => {
      tlm = mul([1, 0, 0, 1, 0, ty], tlm);
      if (!finite(tlm)) throw unscannable("text matrix");
      tm = tlm;
    };
    for (;;) {
      const t = l.next();
      if (t.k === Lx.EOF) return;
      if (t.k === Lx.ArrEnd || t.k === Lx.DictEnd) continue;
      if (t.k === Lx.Obj) {
        if (l.object(t.o, t.kw, 0, count)) return;
        if (++count.n > MAX_OPERANDS) throw unscannable("operands");
        ops.push(t.o);
        continue;
      }
      if (++this.ops > MAX_OPS) throw unscannable("operators");
      const args = ops;
      ops = [];
      count.n = 0;
      const kw = t.kw;
      switch (kw) {
        case "q":
        case "Q":
        case "BT":
          if (args.length !== 0) break;
          if (kw === "BT") {
            tm = IDENTITY;
            tlm = IDENTITY;
          } else if (kw === "Q") {
            const s = stack.pop();
            if (s) g = s;
          } else {
            if (stack.length >= MAX_SAVE) throw unscannable("q nesting");
            stack.push({ ...g });
          }
          break;
        case "cm": {
          const v = nums(args, 6);
          if (v) {
            g.ctm = mul(v as unknown as Matrix, g.ctm);
            if (!finite(g.ctm)) throw unscannable("CTM");
          }
          break;
        }
        case "w": {
          const v = nums(args, 1);
          if (v) g.lw = v[0]!;
          break;
        }
        case "g":
        case "G": {
          const v = nums(args, 1);
          if (v) {
            if (kw === "g") g.fillWhite = v[0]! >= 1;
            else g.strokeWhite = v[0]! >= 1;
          }
          break;
        }
        case "rg":
        case "RG": {
          const v = nums(args, 3);
          if (v) {
            const white = v[0]! >= 1 && v[1]! >= 1 && v[2]! >= 1;
            if (kw === "rg") g.fillWhite = white;
            else g.strokeWhite = white;
          }
          break;
        }
        case "k":
        case "K": {
          const v = nums(args, 4);
          if (v) {
            const white = v[0]! <= 0 && v[1]! <= 0 && v[2]! <= 0 && v[3]! <= 0;
            if (kw === "k") g.fillWhite = white;
            else g.strokeWhite = white;
          }
          break;
        }
        case "cs":
        case "sc":
        case "scn":
          g.fillWhite = false;
          break;
        case "CS":
        case "SC":
        case "SCN":
          g.strokeWhite = false;
          break;

        // ── Path construction (points transformed by the CTM when given) ──
        case "m": {
          const v = nums(args, 2);
          if (v) {
            const [x, y] = apply(g.ctm, v[0]!, v[1]!);
            path.push({ sx: x, sy: y, cx: x, cy: y, bbox: pointRect(x, y), segs: [] });
          }
          break;
        }
        case "l":
        case "c":
        case "v":
        case "y": {
          const n = PATH_POINTS[kw]!;
          const v = nums(args, n);
          if (!v || path.length === 0) break;
          const sp = path[path.length - 1]!;
          const seg = pointRect(sp.cx, sp.cy);
          for (let i = 0; i < n; i += 2) {
            const [x, y] = apply(g.ctm, v[i]!, v[i + 1]!);
            addPoint(seg, x, y);
            addPoint(sp.bbox, x, y);
            sp.cx = x;
            sp.cy = y;
          }
          sp.segs.push(seg);
          break;
        }
        case "h":
          if (args.length === 0 && path.length > 0) closePath(path[path.length - 1]!);
          break;
        case "re": {
          const v = nums(args, 4);
          if (v) {
            const [x0, y0] = apply(g.ctm, v[0]!, v[1]!);
            const p1 = apply(g.ctm, v[0]! + v[2]!, v[1]!);
            const p2 = apply(g.ctm, v[0]! + v[2]!, v[1]! + v[3]!);
            const p3 = apply(g.ctm, v[0]!, v[1]! + v[3]!);
            const sp: Subpath = { sx: x0, sy: y0, cx: x0, cy: y0, bbox: pointRect(x0, y0), segs: [] };
            for (const [px, py] of [p1, p2, p3]) {
              const seg = pointRect(sp.cx, sp.cy);
              addPoint(seg, px, py);
              sp.segs.push(seg);
              addPoint(sp.bbox, px, py);
              sp.cx = px;
              sp.cy = py;
            }
            closePath(sp);
            path.push(sp);
          }
          break;
        }
        case "S":
        case "s":
        case "f":
        case "F":
        case "f*":
        case "B":
        case "B*":
        case "b":
        case "b*":
        case "n": {
          if (args.length !== 0) break;
          if ((kw === "s" || kw === "b" || kw === "b*") && path.length > 0) closePath(path[path.length - 1]!);
          const fill = kw !== "S" && kw !== "s" && kw !== "n";
          const stroke = kw === "S" || kw === "s" || kw === "B" || kw === "B*" || kw === "b" || kw === "b*";
          if (fill && !g.fillWhite) this.fill(path);
          if (stroke && !g.strokeWhite) this.stroke(path, g);
          path = [];
          break;
        }

        // ── Text ──
        case "Tc":
        case "Tw":
        case "Tz":
        case "TL":
        case "Ts": {
          const v = nums(args, 1);
          if (!v) break;
          if (kw === "Tc") g.tc = v[0]!;
          else if (kw === "Tw") g.tw = v[0]!;
          else if (kw === "Tz") g.th = v[0]! / 100;
          else if (kw === "TL") g.tl = v[0]!;
          else g.trise = v[0]!;
          break;
        }
        case "Tf":
          if (args.length === 2 && args[0]!.kind === T.Name && args[1]!.kind === T.Num) {
            const fv = key(key(res, "Font"), args[0]!.name);
            g.font = fv ? this.font(fv) : DEFAULT_FONT;
            g.tfs = args[1]!.num;
          }
          break;
        case "Td":
        case "TD": {
          const v = nums(args, 2);
          if (v) {
            if (kw === "TD") g.tl = -v[1]!;
            tlm = mul([1, 0, 0, 1, v[0]!, v[1]!], tlm);
            if (!finite(tlm)) throw unscannable("text matrix");
            tm = tlm;
          }
          break;
        }
        case "T*":
          if (args.length === 0) textLine(-g.tl);
          break;
        case "Tm": {
          const v = nums(args, 6);
          if (v) {
            tm = v as unknown as Matrix;
            tlm = tm;
          }
          break;
        }
        case "Tj":
        case "'":
        case '"':
        case "TJ": {
          let items: Operand[];
          if ((kw === "Tj" || kw === "'") && args.length === 1 && args[0]!.kind === T.Str) items = args;
          else if (kw === '"' && args.length === 3 && args[0]!.kind === T.Num && args[1]!.kind === T.Num && args[2]!.kind === T.Str) {
            g.tw = args[0]!.num;
            g.tc = args[1]!.num;
            items = args.slice(2);
          } else if (kw === "TJ" && args.length === 1 && args[0]!.kind === T.Arr) items = args[0]!.arr;
          else break;
          if (kw === "'" || kw === '"') textLine(-g.tl);
          tm = this.show(items, g, tm);
          break;
        }
        case "Do": {
          if (args.length !== 1 || args[0]!.kind !== T.Name) break;
          const x = key(key(res, "XObject"), args[0]!.name);
          if (!x) break;
          switch (x.key("Subtype").name()) {
            case "Image":
              this.unitSquare(g.ctm);
              break;
            case "Form": {
              if (x.kind() !== "stream") break;
              if (depth + 1 > MAX_DEPTH) throw unscannable("form depth");
              let fm: Matrix = IDENTITY;
              const m = x.key("Matrix");
              if (m.kind() === "array" && m.len() === 6) {
                const v: number[] = [];
                for (let i = 0; i < 6; i++) {
                  const e = number(m.index(i));
                  if (e === undefined) break;
                  v.push(e);
                }
                if (v.length === 6) fm = v as unknown as Matrix;
              }
              const ctm = mul(fm, g.ctm);
              if (!finite(ctm)) throw unscannable("form matrix");
              let fres: Value | undefined = x.key("Resources");
              if (fres.kind() !== "dict") fres = res;
              const b = this.stream(x);
              this.run(b, fres, { ...g, ctm }, depth + 1);
              break;
            }
          }
          break;
        }
        case "BI":
          this.inlineImage(l, g.ctm);
          break;
      }
    }
  }

  /** One box per subpath; a subpath box covering ≥ half of the page box is a background and is skipped. */
  fill(path: Subpath[]): void {
    const p = this.page;
    for (const sp of path) {
      const q = quantise(sp.bbox);
      const w = Math.min(q[2], p[2]) - Math.max(q[0], p[0]);
      const h = Math.min(q[3], p[3]) - Math.max(q[1], p[1]);
      // Go int64 arithmetic: exact as doubles while every product stays below 2^53; BigInt past that.
      if (w > 0 && h > 0) {
        const pw = p[2] - p[0];
        const ph = p[3] - p[1];
        const lhs = 2 * w * h;
        const rhs = pw * ph;
        const bg = lhs < 2 ** 53 && rhs < 2 ** 53 ? lhs >= rhs : 2n * BigInt(w) * BigInt(h) >= BigInt(pw) * BigInt(ph);
        if (bg) continue;
      }
      this.boxes.push(q);
    }
  }

  /** One box per segment, widened by half the line width mapped through the CTM (|a|+|c|, |b|+|d|). */
  stroke(path: Subpath[], g: GState): void {
    const hw = Math.abs(g.lw) / 2;
    const ex = hw * Math.abs(g.ctm[0]) + hw * Math.abs(g.ctm[2]);
    const ey = hw * Math.abs(g.ctm[1]) + hw * Math.abs(g.ctm[3]);
    for (const sp of path) {
      for (const r of sp.segs) this.emit({ x0: r.x0 - ex, y0: r.y0 - ey, x1: r.x1 + ex, y1: r.y1 + ey });
    }
  }

  unitSquare(ctm: Matrix): void {
    const [x, y] = apply(ctm, 0, 0);
    const r = pointRect(x, y);
    for (const [px, py] of [
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const [qx, qy] = apply(ctm, px, py);
      addPoint(r, qx, qy);
    }
    this.emit(r);
  }

  /** One box per show operator: [min, max] of glyph extents in text space × [rise − 0.3·Tfs, rise + Tfs], through Tm
   * then the CTM. Returns the advanced Tm. */
  show(items: Operand[], g: GState, tm: Matrix): Matrix {
    let x = 0;
    let lo = 0;
    let hi = 0;
    let ext = false;
    for (const it of items) {
      if (it.kind === T.Num) {
        x = x - ((it.num / 1000) * g.tfs) * g.th;
      } else if (it.kind === T.Str) {
        glyphs(g.font, it.str, (w0, space) => {
          const gw = ((w0 / 1000) * g.tfs) * g.th;
          const a = Math.min(x, x + gw);
          const b = Math.max(x, x + gw);
          if (!ext) {
            lo = a;
            hi = b;
            ext = true;
          } else {
            lo = Math.min(lo, a);
            hi = Math.max(hi, b);
          }
          let adv = (w0 / 1000) * g.tfs + g.tc;
          if (space) adv = adv + g.tw;
          x = x + adv * g.th;
        });
      }
    }
    if (ext) {
      const ya = g.trise + g.tfs * -0.3;
      const yb = g.trise + g.tfs;
      let r: Rect | undefined;
      for (const [px, py] of [
        [lo, ya],
        [hi, ya],
        [lo, yb],
        [hi, yb],
      ] as const) {
        const [tx, ty] = apply(tm, px, py);
        const [dx, dy] = apply(g.ctm, tx, ty);
        if (!r) r = pointRect(dx, dy);
        else addPoint(r, dx, dy);
      }
      this.emit(r!);
    }
    const out = mul([1, 0, 0, 1, x, 0], tm);
    if (!finite(out)) throw unscannable("text matrix");
    return out;
  }

  /** BI <key value>… ID <data> EI: data ends at the first "EI" preceded by a whitespace byte and followed by a
   * whitespace byte or the end of the content. No EI → the content ends (no box). */
  inlineImage(l: Lexer, ctm: Matrix): void {
    const count = { n: 0 };
    for (;;) {
      const t = l.next();
      if (t.k === Lx.EOF) return;
      if (t.k === Lx.Obj) {
        if (l.object(t.o, t.kw, 0, count)) return;
        continue;
      }
      if (t.k === Lx.Keyword && t.kw === "ID") break;
    }
    const b = l.b;
    if (l.i < b.length && isSpace(b[l.i]!)) l.i++;
    for (let p = l.i; p + 1 < b.length; p++) {
      if (b[p] === 0x45 && b[p + 1] === 0x49 && p > 0 && isSpace(b[p - 1]!) && (p + 2 === b.length || isSpace(b[p + 2]!))) {
        l.i = p + 2;
        this.unitSquare(ctm);
        return;
      }
    }
    l.i = b.length;
  }

  /** /Rect of every annotation except /Popup, hidden (/F bit 2) or NoView (/F bit 6) and zero-area rects. */
  annots(a: Value): void {
    if (a.kind() !== "array") return;
    if (a.len() > MAX_ANNOTS) throw unscannable("annotations");
    for (let i = 0; i < a.len(); i++) {
      const an = a.index(i);
      if (an.kind() !== "dict" || an.key("Subtype").name() === "Popup") continue;
      const f = an.key("F");
      if (f.data instanceof PInt && (f.data.v & 34n) !== 0n) continue;
      const r = an.key("Rect");
      if (r.kind() !== "array" || r.len() !== 4) continue;
      const v: number[] = [];
      for (let j = 0; j < 4; j++) {
        const e = number(r.index(j));
        if (e === undefined) break;
        v.push(e);
      }
      if (v.length !== 4 || v[0] === v[2] || v[1] === v[3]) continue;
      this.emit({ x0: Math.min(v[0]!, v[2]!), y0: Math.min(v[1]!, v[3]!), x1: Math.max(v[0]!, v[2]!), y1: Math.max(v[1]!, v[3]!) });
    }
  }
}

/**
 * The occupied boxes of a page in default user space, h100 (1/100 pt), outward-rounded, in emission order (content
 * stream order, then /Annots order). `box` is the page's normalised CropBox/MediaBox (h100), used only for the
 * background-fill rule. Throws UnscannableError when the page cannot be scanned — any failure of the object reader
 * while scanning is unscannable too (Go recovers the reader's panics).
 */
export function occupancy(page: Value, box: Box): Box[] {
  try {
    const s = new Scanner(box);
    const content = s.pageContent(page.key("Contents"));
    const res = inherited(page, "Resources");
    s.run(content, res, { ctm: IDENTITY, lw: 1, fillWhite: false, strokeWhite: false, tc: 0, tw: 0, th: 1, tl: 0, tfs: 0, trise: 0, font: DEFAULT_FONT }, 0);
    s.annots(page.key("Annots"));
    return s.boxes;
  } catch (e) {
    if (e instanceof UnscannableError) throw e;
    throw new UnscannableError(`pades: page content not scannable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

// ── Candidates and choice (PLACEMENT_SPEC.md §6) ──

/** Where the stamp ended up and why. */
export type PlaceStatus = "requested" | "moved" | "overlap" | "unscanned";

const PLACE_PAD = 400; // h100: clearance kept around the stamp
const PLACE_STEP = 1200; // h100: vertical step between candidates
const PLACE_STEPS = 100; // at most this many steps up per column

/**
 * The candidate positions (visible space, h100) in trial order: requested (x, y); mirrored (vw − x − w, y); then up the
 * requested column y + k·step (k = 1…, while y + k·step + h ≤ vh − y, k ≤ 100); then up the mirrored column. The mirrored
 * column is left out when it equals the requested one.
 */
export function placeCandidates(vw: number, vh: number, x: number, y: number, w: number, h: number): [number, number][] {
  const xl = vw - x - w;
  const out: [number, number][] = [[x, y]];
  if (xl !== x) out.push([xl, y]);
  const cols = xl !== x ? [x, xl] : [x];
  for (const cx of cols) {
    for (let k = 1; k <= PLACE_STEPS && y + k * PLACE_STEP + h <= vh - y; k++) out.push([cx, y + k * PLACE_STEP]);
  }
  return out;
}

/**
 * The first candidate whose /Rect, grown by PLACE_PAD on every side, overlaps no occupied box (strict overlap: touching
 * edges are free). undefined → none is free (the caller keeps the requested rect).
 */
export function placeVisible(box: number[], rot: number, x: number, y: number, w: number, h: number, occ: Box[]): [number, number] | undefined {
  let vw = box[2]! - box[0]!;
  let vh = box[3]! - box[1]!;
  if (rot === 90 || rot === 270) [vw, vh] = [vh, vw];
  for (const [cx, cy] of placeCandidates(vw, vh, x, y, w, h)) {
    let r: number[];
    try {
      r = visibleRect(box, rot, cx, cy, w, h);
    } catch {
      continue;
    }
    const e0 = r[0]! - PLACE_PAD;
    const e1 = r[1]! - PLACE_PAD;
    const e2 = r[2]! + PLACE_PAD;
    const e3 = r[3]! + PLACE_PAD;
    if (!occ.some((b) => b[0] < e2 && e0 < b[2] && b[1] < e3 && e1 < b[3])) return [cx, cy];
  }
  return undefined;
}
