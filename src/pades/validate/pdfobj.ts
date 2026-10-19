// Revision-ийн шинжилгээнд (revisions.ts) зориулсан ХАТУУ PDF задлагч — Go SDK pades/internal/validate/pdfobj.go-ийн
// (CA-ийн нийтийн шалгагчийн кодын) 1:1 порт. Зөвшөөрөгч биш, татгалзагч: ойлгоогүй зүйл бүр (давхар түлхүүр, танихгүй
// filter, хэт гүн бүтэц, /Encrypt, hybrid xref) алдаа болж, дуудагч нь «гарын үсгийн дараа өөрчлөгдсөн» гэж үзнэ (fail
// closed). Рекурс MAX_PDF_DEPTH-ээр, нийт ажил PdfBudget-ээр хязгаарлагдана.
//
// Go-ийн утгын төрөл ↔ TS: nil → null, bool → boolean, int64 → bigint, float64 → PReal, pdfName → PName, pdfStr → PStr
// (latin1 мөр), pdfRef → PRef, pdfArr → PVal[], pdfDict → Map (null утгагүй), pdfStream → PStream.

import { InflateError, adler32, inflateRaw, type InflateInfo } from "../pdf/inflate.js";

const MAX_PDF_DEPTH = 64;
const MAX_PDF_NODES = 1_000_000;
const MAX_PDF_INFLATE = 64 << 20;
const MAX_XREF_SECTIONS = 128;
export const MAX_OBJECT_NUMBER = 1 << 23;

/** Go errPDFSyntax / errPDFLimit / errNotSignatureOnly — бүгд «зөвшөөрөгдөөгүй». */
export class PdfObjError extends Error {}
export const errPDFSyntax = (): PdfObjError => new PdfObjError("validate: PDF бүтэц танигдсангүй");
export const errPDFLimit = (): PdfObjError => new PdfObjError("validate: PDF шинжилгээний хязгаар хэтэрлээ");

export class PRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
export class PName {
  constructor(readonly v: string) {}
}
export class PStr {
  constructor(readonly v: string) {}
}
export class PReal {
  constructor(readonly v: number) {}
}
export type PDict = Map<string, PVal>;
export class PStream {
  constructor(
    readonly dict: PDict,
    readonly data: Uint8Array,
  ) {}
}
export type PVal = null | boolean | bigint | PReal | PName | PStr | PRef | PVal[] | PDict | PStream;

export const isDict = (v: PVal | undefined): v is PDict => v instanceof Map;
export const isArr = (v: PVal | undefined): v is PVal[] => Array.isArray(v);
export const isInt = (v: PVal | undefined): v is bigint => typeof v === "bigint";
export const isName = (v: PVal | undefined, s?: string): v is PName => v instanceof PName && (s === undefined || v.v === s);
export const isStr = (v: PVal | undefined): v is PStr => v instanceof PStr;
export const isRef = (v: PVal | undefined): v is PRef => v instanceof PRef;

/** Go `d[k]` — байхгүй бол null. */
export const dget = (d: PDict | undefined | null, k: string): PVal => (d ? (d.get(k) ?? null) : null);

class GoPanic extends Error {}

/**
 * Go interface-ийн `==`: динамик төрөл өөр бол false; ижил, харьцуулагдахгүй төрөл (slice, map, stream struct) бол
 * runtime panic (Go-д recover → «зөвшөөрөгдөөгүй») — энд exception.
 */
export function ifaceEq(a: PVal, b: PVal): boolean {
  if (a === null || b === null) return a === b;
  const ta = kindOf(a);
  if (ta !== kindOf(b)) return false;
  switch (ta) {
    case "bool":
    case "int":
      return a === b;
    case "real":
      return (a as PReal).v === (b as PReal).v;
    case "name":
      return (a as PName).v === (b as PName).v;
    case "str":
      return (a as PStr).v === (b as PStr).v;
    case "ref":
      return (a as PRef).num === (b as PRef).num && (a as PRef).gen === (b as PRef).gen;
  }
  throw new GoPanic("comparing uncomparable type");
}

function kindOf(v: Exclude<PVal, null>): string {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (v instanceof PReal) return "real";
  if (v instanceof PName) return "name";
  if (v instanceof PStr) return "str";
  if (v instanceof PRef) return "ref";
  if (Array.isArray(v)) return "arr";
  if (v instanceof Map) return "dict";
  return "stream";
}

/** Go map[objKey]: idx < 0 — off байрлал дахь шууд объект; эс бөгөөс off байрлалтай ObjStm-ийн idx дэх объект. */
interface Indirect {
  num: number;
  gen: number;
  val: PVal;
}
interface CachedObj extends Indirect {
  end: number;
}

export interface ObjStm {
  data: Uint8Array;
  nums: number[];
  offs: number[];
  first: number;
}

/** Нэг баримтын бүх харагдацад хуваалцах нөөц ба задлалтын кэш. */
export class PdfBudget {
  nodes = MAX_PDF_NODES;
  inflate = MAX_PDF_INFLATE;
  objs = new Map<string, CachedObj>();
  stms = new Map<number, ObjStm>();

  node(): void {
    if (--this.nodes < 0) throw errPDFLimit();
  }

  /** decode — xref/object stream-ийн агуулга: filter-гүй эсвэл ганц FlateDecode (+ PNG predictor). */
  decode(s: PStream): Uint8Array {
    const single = (v: PVal): PVal => {
      if (!isArr(v)) return v;
      if (v.length === 0) return null;
      if (v.length === 1) return v[0]!;
      throw errPDFSyntax();
    };
    const filter = single(dget(s.dict, "Filter"));
    if (filter === null) return s.data;
    if (!ifaceEq(filter, new PName("FlateDecode"))) throw errPDFSyntax();
    const out = zlibStrict(s.data, this.inflate);
    this.inflate -= out.length;
    if (this.inflate < 0) throw errPDFLimit();
    const parms = single(dget(s.dict, "DecodeParms"));
    if (parms === null) return out;
    if (!isDict(parms)) throw errPDFSyntax();
    const intOr = (key: string, def: bigint): bigint => {
      const v = dget(parms, key);
      if (v === null) return def;
      if (isInt(v)) return v;
      return -1n;
    };
    const pred = intOr("Predictor", 1n);
    const cols = intOr("Columns", 1n);
    if (pred === 1n) return out;
    if (pred < 10n || pred > 15n || cols < 1n || cols > 1n << 16n || intOr("Colors", 1n) !== 1n || intOr("BitsPerComponent", 8n) !== 8n) {
      throw errPDFSyntax();
    }
    return unPNG(out, Number(cols));
  }
}

export const newPDFBudget = (): PdfBudget => new PdfBudget();

/** Go compress/zlib + io.LimitReader(limit+1): header, бүрэн deflate, adler32 (Go шиг шаардана). */
function zlibStrict(src: Uint8Array, limit: number): Uint8Array {
  if (src.length < 2) throw errPDFSyntax();
  const cmf = src[0]!;
  const flg = src[1]!;
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) throw errPDFSyntax();
  const info: InflateInfo = { end: 0, truncated: false };
  let out: Uint8Array;
  try {
    // limit+1 хүртэл: Go LimitReader(inflate+1) — хэтэрвэл дуудагч budget-ээр errPDFLimit.
    out = inflateRaw(src.subarray(2), limit + 1, info);
  } catch (e) {
    if (e instanceof InflateError) {
      if (/хэмжээний хязгаар/.test(e.message)) throw errPDFLimit();
      throw errPDFSyntax();
    }
    throw e;
  }
  if (out.length > limit) return out; // дуудагч budget-ээр барина (Go: checksum уншихгүй)
  if (info.truncated) throw errPDFSyntax();
  const at = 2 + info.end;
  if (at + 4 > src.length) throw errPDFSyntax();
  const want = ((src[at]! << 24) | (src[at + 1]! << 16) | (src[at + 2]! << 8) | src[at + 3]!) >>> 0;
  if (adler32(out) !== want) throw errPDFSyntax();
  return out;
}

/** PNG мөрийн predictor-ийг буцаана (нэг байт = нэг пиксел). */
function unPNG(input: Uint8Array, cols: number): Uint8Array {
  if (input.length % (cols + 1) !== 0) throw errPDFSyntax();
  const rows = input.length / (cols + 1);
  const out = new Uint8Array(rows * cols);
  let prev = new Uint8Array(cols);
  for (let r = 0; r < rows; r++) {
    const base = r * (cols + 1);
    const ft = input[base]!;
    const cur = new Uint8Array(cols);
    for (let i = 0; i < cols; i++) {
      let x = input[base + 1 + i]!;
      let left = 0;
      let upLeft = 0;
      if (i > 0) {
        left = cur[i - 1]!;
        upLeft = prev[i - 1]!;
      }
      const up = prev[i]!;
      switch (ft) {
        case 0:
          break;
        case 1:
          x = (x + left) & 0xff;
          break;
        case 2:
          x = (x + up) & 0xff;
          break;
        case 3:
          x = (x + ((left & up) + ((left ^ up) >> 1))) & 0xff;
          break;
        case 4: {
          const pa = Math.abs(up - upLeft);
          const pb = Math.abs(left - upLeft);
          const pc = Math.abs(left + up - 2 * upLeft);
          if (pa <= pb && pa <= pc) x = (x + left) & 0xff;
          else if (pb <= pc) x = (x + up) & 0xff;
          else x = (x + upLeft) & 0xff;
          break;
        }
        default:
          throw errPDFSyntax();
      }
      cur[i] = x;
    }
    out.set(cur, r * cols);
    prev = cur;
  }
  return out;
}

export const isPDFSpace = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const DELIMS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
export const isPDFDelim = (c: number): boolean => DELIMS.has(c);
/** Объект, xref хэсгүүдийн ХООРОНД зөвшөөрөгдөх зай (NUL, тайлбар үгүй). */
export const isGapSpace = (c: number): boolean => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
export function allGapSpace(b: Uint8Array): boolean {
  for (const c of b) if (!isGapSpace(c)) return false;
  return true;
}

const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;
const HEX2 = /^[0-9a-fA-F]{2}$/;
const INT_RE = /^[+-]?[0-9]+$/;
const FLOAT_RE = /^[+-]?([0-9]+\.[0-9]*|\.[0-9]+)$/;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);

function str(b: Uint8Array, s: number, e: number): string {
  let out = "";
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]!);
  return out;
}

export class PdfParser {
  constructor(
    public b: Uint8Array,
    public pos: number,
    public budget: PdfBudget,
    public strict = false,
  ) {}

  skipGap(): void {
    while (this.pos < this.b.length && isGapSpace(this.b[this.pos]!)) this.pos++;
  }

  skipSpace(): void {
    if (this.strict) return this.skipGap();
    while (this.pos < this.b.length && isPDFSpace(this.b[this.pos]!)) this.pos++;
  }

  /** Зай ба тайлбар; хатуу горимд зөвхөн isGapSpace. */
  skip(): void {
    if (this.strict) return this.skipGap();
    while (this.pos < this.b.length) {
      const c = this.b[this.pos]!;
      if (isPDFSpace(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.b.length && this.b[this.pos] !== 10 && this.b[this.pos] !== 13) this.pos++;
      } else return;
    }
  }

  keyword(k: string): boolean {
    const e = this.pos + k.length;
    if (e > this.b.length) return false;
    for (let i = 0; i < k.length; i++) if (this.b[this.pos + i] !== k.charCodeAt(i)) return false;
    if (e < this.b.length && !isPDFSpace(this.b[e]!) && !isPDFDelim(this.b[e]!)) return false;
    this.pos = e;
    return true;
  }

  /** Go uint(): ≤ 18 цифр. */
  uint(): number | undefined {
    const s = this.pos;
    while (this.pos < this.b.length && isDigit(this.b[this.pos])) this.pos++;
    if (this.pos === s || this.pos - s > 18) {
      this.pos = s;
      return undefined;
    }
    return Number(str(this.b, s, this.pos));
  }

  value(depth: number): PVal {
    if (depth > MAX_PDF_DEPTH) throw errPDFSyntax();
    this.budget.node();
    this.skip();
    if (this.pos >= this.b.length) throw errPDFSyntax();
    const c = this.b[this.pos]!;
    if (c === 0x2f) {
      this.pos++;
      return this.name();
    }
    if (c === 0x28) {
      this.pos++;
      return this.literal();
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PVal[] = [];
      for (;;) {
        this.skip();
        if (this.pos < this.b.length && this.b[this.pos] === 0x5d) {
          this.pos++;
          return arr;
        }
        arr.push(this.value(depth + 1));
      }
    }
    if (c === 0x3c) {
      if (this.pos + 1 < this.b.length && this.b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.dict(depth);
      }
      this.pos++;
      return this.hex();
    }
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) return this.number();
    if (this.keyword("true")) return true;
    if (this.keyword("false")) return false;
    if (this.keyword("null")) return null;
    throw errPDFSyntax();
  }

  dict(depth: number): PDict {
    const d: PDict = new Map();
    for (;;) {
      this.skip();
      if (this.pos + 1 < this.b.length && this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        for (const [k, v] of [...d]) if (v === null) d.delete(k);
        return d;
      }
      if (this.pos >= this.b.length || this.b[this.pos] !== 0x2f) throw errPDFSyntax();
      this.pos++;
      const key = this.name().v;
      const dup = d.has(key);
      const old = d.get(key) ?? null;
      const v = this.value(depth + 1);
      if (dup && !pdfEqual(old, v)) throw errPDFSyntax();
      d.set(key, v);
    }
  }

  name(): PName {
    let out = "";
    while (this.pos < this.b.length && !isPDFSpace(this.b[this.pos]!) && !isPDFDelim(this.b[this.pos]!)) {
      let c = this.b[this.pos]!;
      if (c === 0x23) {
        if (this.pos + 2 >= this.b.length) throw errPDFSyntax();
        const h = str(this.b, this.pos + 1, this.pos + 3);
        if (!HEX2.test(h)) throw errPDFSyntax();
        c = parseInt(h, 16);
        this.pos += 2;
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return new PName(out);
  }

  literal(): PStr {
    let out = "";
    for (let depth = 1; ; this.pos++) {
      if (this.pos >= this.b.length) throw errPDFSyntax();
      let c = this.b[this.pos]!;
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        if (--depth === 0) {
          this.pos++;
          return new PStr(out);
        }
      } else if (c === 0x0d) {
        if (this.pos + 1 < this.b.length && this.b[this.pos + 1] === 0x0a) this.pos++;
        c = 0x0a;
      } else if (c === 0x5c) {
        if (++this.pos >= this.b.length) throw errPDFSyntax();
        const e = this.b[this.pos]!;
        if (e === 0x6e) c = 0x0a;
        else if (e === 0x72) c = 0x0d;
        else if (e === 0x74) c = 0x09;
        else if (e === 0x62) c = 0x08;
        else if (e === 0x66) c = 0x0c;
        else if (e === 0x0a) continue;
        else if (e === 0x0d) {
          if (this.pos + 1 < this.b.length && this.b[this.pos + 1] === 0x0a) this.pos++;
          continue;
        } else if (e >= 0x30 && e <= 0x37) {
          c = 0;
          for (let i = 0; i < 3 && this.pos < this.b.length && this.b[this.pos]! >= 0x30 && this.b[this.pos]! <= 0x37; i++) {
            c = ((c << 3) | (this.b[this.pos]! - 0x30)) & 0xff;
            this.pos++;
          }
          this.pos--;
        } else c = e;
      }
      out += String.fromCharCode(c);
    }
  }

  hex(): PStr {
    let digits = "";
    for (; ; this.pos++) {
      if (this.pos >= this.b.length) throw errPDFSyntax();
      const c = this.b[this.pos]!;
      if (c === 0x3e) {
        this.pos++;
        break;
      }
      if (!isPDFSpace(c)) digits += String.fromCharCode(c);
    }
    if (digits.length % 2 === 1) digits += "0";
    let out = "";
    for (let i = 0; i < digits.length; i += 2) {
      const h = digits.slice(i, i + 2);
      if (!HEX2.test(h)) throw errPDFSyntax();
      out += String.fromCharCode(parseInt(h, 16));
    }
    return new PStr(out);
  }

  /** Бүхэл/бодит тоо, эсвэл «n g R» заалт. */
  number(): PVal {
    const s = this.pos;
    while (this.pos < this.b.length && "0123456789+-.".includes(String.fromCharCode(this.b[this.pos]!))) this.pos++;
    const tok = str(this.b, s, this.pos);
    if (this.pos < this.b.length && !isPDFSpace(this.b[this.pos]!) && !isPDFDelim(this.b[this.pos]!)) throw errPDFSyntax();
    if (tok.includes(".")) {
      if (!FLOAT_RE.test(tok)) throw errPDFSyntax();
      const f = Number(tok);
      if (!Number.isFinite(f)) throw errPDFSyntax();
      return new PReal(f);
    }
    if (!INT_RE.test(tok)) throw errPDFSyntax();
    const n = BigInt(tok);
    if (n > I64_MAX || n < I64_MIN) throw errPDFSyntax();
    if (n >= 0n && tok[0] !== "+") {
      const save = this.pos;
      this.skip();
      const g = this.uint();
      if (g !== undefined) {
        this.skip();
        if (this.keyword("R")) {
          if (n >= BigInt(MAX_OBJECT_NUMBER) || g > 65535) throw errPDFSyntax();
          return new PRef(Number(n), g);
        }
      }
      this.pos = save;
    }
    return n;
  }

  /** «n g obj … endobj». length — шууд бус /Length-ийг тухайн харагдацад задална (undefined бол алдаа). */
  indirect(length?: (r: PRef) => bigint): Indirect {
    this.skipSpace();
    const n = this.uint();
    this.skipSpace();
    const g = this.uint();
    this.skipSpace();
    if (n === undefined || g === undefined || n >= MAX_OBJECT_NUMBER || g > 65535 || !this.keyword("obj")) throw errPDFSyntax();
    const o: Indirect = { num: n, gen: g, val: null };
    o.val = this.value(0);
    this.skip();
    if (isDict(o.val) && this.keyword("stream")) {
      const d = o.val;
      if (this.pos < this.b.length && this.b[this.pos] === 0x0d) this.pos++;
      if (this.pos >= this.b.length || this.b[this.pos] !== 0x0a) throw errPDFSyntax();
      this.pos++;
      let size: bigint;
      const l = dget(d, "Length");
      if (isInt(l)) size = l;
      else if (isRef(l)) {
        if (!length) throw errPDFSyntax();
        size = length(l);
      } else throw errPDFSyntax();
      if (size < 0n || size > BigInt(this.b.length - this.pos)) throw errPDFSyntax();
      const sz = Number(size);
      o.val = new PStream(d, this.b.subarray(this.pos, this.pos + sz));
      this.pos += sz;
      this.skipSpace();
      if (!this.keyword("endstream")) throw errPDFSyntax();
      this.skip();
    }
    if (!this.keyword("endobj")) throw errPDFSyntax();
    return o;
  }

  /** «startxref N %%EOF»; N. */
  startxref(): number | undefined {
    this.skipGap();
    if (!this.keyword("startxref")) return undefined;
    this.skipGap();
    const n = this.uint();
    this.skipGap();
    if (n === undefined || n > this.b.length || str(this.b, this.pos, Math.min(this.b.length, this.pos + 5)) !== "%%EOF") return undefined;
    this.pos += 5;
    return n;
  }
}

/** Бүтцийн тэнцүү байдал: ref-ийг дагахгүй, stream-ийг толь + түүхий байтаар. Тоо төрлөөрөө ч таарна (90 ≠ 90.0). */
export function pdfEqual(a: PVal, b: PVal): boolean {
  if (a === null) return b === null;
  if (isArr(a)) {
    if (!isArr(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!pdfEqual(a[i]!, b[i]!)) return false;
    return true;
  }
  if (isDict(a)) {
    if (!isDict(b) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !pdfEqual(v, b.get(k)!)) return false;
    }
    return true;
  }
  if (a instanceof PStream) {
    if (!(b instanceof PStream) || a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
    return pdfEqual(a.dict, b.dict);
  }
  if (b === null) return false;
  return ifaceEq(a, b);
}

/** Утга доторх бүх ref (шууд давхарлалтаар; ref-ийг дагахгүй). */
export function pdfRefs(v: PVal | undefined, f: (r: PRef) => void): void {
  if (v instanceof PRef) f(v);
  else if (isArr(v)) for (const e of v) pdfRefs(e, f);
  else if (isDict(v)) for (const e of v.values()) pdfRefs(e, f);
  else if (v instanceof PStream) pdfRefs(v.dict, f);
}

// ── Харагдац: баримтын нэг төлөв (эхний N байт) дахь xref гинж ба объектууд ──

export const ENT_FREE = 1;
export const ENT_USE = 2;
export const ENT_COMP = 3;

/** entUse: off = байтын байрлал; entComp: off = ObjStm-ийн дугаар, idx = доторх дараалал. kind 0 = Go-ийн тэг утга. */
export interface XrefEnt {
  kind: number;
  off: number;
  gen: number;
  idx: number;
}
const ZERO: XrefEnt = Object.freeze({ kind: 0, off: 0, gen: 0, idx: 0 });
export const inUse = (e: XrefEnt): boolean => e.kind === ENT_USE || e.kind === ENT_COMP;
export const entEq = (a: XrefEnt, b: XrefEnt): boolean => a.kind === b.kind && a.off === b.off && a.gen === b.gen && a.idx === b.idx;
/** Go `m[num]` — байхгүй бол тэг. */
export const ent = (m: Map<number, XrefEnt>, n: number): XrefEnt => m.get(n) ?? ZERO;

/** Байрлал 0 руу заасан «ашиглагдаж буй» мөр (macOS Quartz) = тодорхойлогдоогүй объект (free). */
function useEnt(off: number, gen: number): XrefEnt {
  if (off === 0) return { kind: ENT_FREE, off: 0, gen: 0, idx: 0 };
  return { kind: ENT_USE, off, gen, idx: 0 };
}

export interface XrefSection {
  off: number;
  start: number;
  end: number;
  trailer: PDict;
  ents: Map<number, XrefEnt>;
}

export class PdfView {
  sections: XrefSection[] = [];
  xref = new Map<number, XrefEnt>();
  trailer: PDict = new Map();
  objs = new Map<number, PVal>();
  inLength = false;
  usedLength = false;
  refs: Map<number, number[]> | undefined;

  constructor(
    readonly b: Uint8Array,
    readonly budget: PdfBudget,
  ) {}

  parser(pos: number): PdfParser {
    return new PdfParser(this.b, pos, this.budget);
  }

  section(off: number): XrefSection {
    const p = this.parser(off);
    p.skipGap();
    const sec: XrefSection = { off, start: p.pos, end: 0, trailer: new Map(), ents: new Map() };
    const c0 = p.b[p.pos];
    if (p.pos >= p.b.length || (c0 !== 0x78 && !isDigit(c0))) throw errPDFSyntax();
    const set = (num: number, e: XrefEnt): void => {
      if (num >= MAX_OBJECT_NUMBER) throw errPDFSyntax();
      if (sec.ents.has(num)) throw errPDFSyntax();
      sec.ents.set(num, e);
      this.budget.node();
    };
    if (p.keyword("xref")) {
      for (;;) {
        p.skipSpace();
        if (p.keyword("trailer")) break;
        const first = p.uint();
        p.skipSpace();
        const count = p.uint();
        if (first === undefined || count === undefined || first >= MAX_OBJECT_NUMBER || count > MAX_OBJECT_NUMBER) throw errPDFSyntax();
        p.skipGap();
        for (let i = 0; i < count; i++) {
          if (p.pos + 20 > p.b.length) throw errPDFSyntax();
          const row = str(p.b, p.pos, p.pos + 20);
          const os = row.slice(0, 10);
          const gs = row.slice(11, 16);
          const eol = row.slice(18);
          if (!/^[0-9]+$/.test(os) || !/^[0-9]+$/.test(gs) || row[10] !== " " || row[16] !== " " || (eol !== " \n" && eol !== " \r" && eol !== "\r\n")) {
            throw errPDFSyntax();
          }
          const o = Number(os);
          const g = Number(gs);
          if (o > p.b.length || g > 65535) throw errPDFSyntax();
          let e: XrefEnt;
          if (row[17] === "n") e = useEnt(o, g);
          else if (row[17] === "f") e = { kind: ENT_FREE, off: 0, gen: 0, idx: 0 };
          else throw errPDFSyntax();
          p.pos += 20;
          set(first + i, e);
        }
      }
      const t = p.value(0);
      if (!isDict(t)) throw errPDFSyntax();
      sec.trailer = t;
      sec.end = p.pos;
      return sec;
    }
    const o = p.indirect(undefined);
    const st = o.val;
    if (!(st instanceof PStream) || !ifaceEq(dget(st.dict, "Type"), new PName("XRef"))) throw errPDFSyntax();
    const data = this.budget.decode(st);
    const w = dget(st.dict, "W");
    if (!isArr(w) || w.length !== 3) throw errPDFSyntax();
    const width: number[] = [];
    for (const x of w) {
      if (!isInt(x) || x < 0n || x > 7n) throw errPDFSyntax();
      width.push(Number(x));
    }
    const size = dget(st.dict, "Size");
    if (!isInt(size) || size < 0n) throw errPDFSyntax();
    let index: PVal[] = [0n, size];
    if (st.dict.has("Index")) {
      const ix = dget(st.dict, "Index");
      if (!isArr(ix) || ix.length % 2 !== 0) throw errPDFSyntax();
      index = ix;
    }
    const row = width[0]! + width[1]! + width[2]!;
    if (row === 0) throw errPDFSyntax();
    let cur = 0;
    const field = (n: number): number => {
      let x = 0;
      for (let i = 0; i < n; i++) x = x * 256 + data[cur + i]!;
      cur += n;
      return x;
    };
    for (let i = 0; i < index.length; i += 2) {
      const first = index[i]!;
      const count = index[i + 1]!;
      if (!isInt(first) || !isInt(count) || first < 0n || first >= BigInt(MAX_OBJECT_NUMBER) || count < 0n || count > BigInt(Math.floor((data.length - cur) / row))) {
        throw errPDFSyntax();
      }
      const f0 = Number(first);
      for (let j = 0; j < Number(count); j++) {
        let kind = 1;
        if (width[0]! > 0) kind = field(width[0]!);
        const f2 = field(width[1]!);
        const f3 = field(width[2]!);
        let e: XrefEnt;
        if (kind === 0) e = { kind: ENT_FREE, off: 0, gen: 0, idx: 0 };
        else if (kind === 1) e = useEnt(f2, f3);
        else if (kind === 2) e = { kind: ENT_COMP, off: f2, gen: 0, idx: f3 };
        else throw errPDFSyntax();
        set(f0 + j, e);
      }
    }
    if (cur !== data.length) throw errPDFSyntax();
    sec.trailer = st.dict;
    sec.end = p.pos;
    return sec;
  }

  /** Ашиглагдаж буй num объектыг задална (толгойн дугаар/үе xref-тэй таарах ёстой). */
  get(num: number): PVal {
    if (this.objs.has(num)) return this.objs.get(num)!;
    let val: PVal;
    const e = ent(this.xref, num);
    if (e.kind === ENT_USE) {
      if (e.off >= this.b.length) throw errPDFSyntax();
      const key = `${e.off},-1`;
      let o = this.budget.objs.get(key);
      if (!o || o.end > this.b.length) {
        const p = this.parser(e.off);
        this.usedLength = false;
        const ind = p.indirect((r) => this.length(r));
        o = { ...ind, end: p.pos };
        if (!this.usedLength) this.budget.objs.set(key, o);
      }
      if (o.num !== num || o.gen !== e.gen) throw errPDFSyntax();
      val = o.val;
    } else if (e.kind === ENT_COMP) {
      const st = this.objStm(e.off);
      if (e.idx >= st.nums.length || st.nums[e.idx] !== num || st.first + st.offs[e.idx]! > st.data.length) throw errPDFSyntax();
      const key = `${ent(this.xref, e.off).off},${e.idx}`;
      let o = this.budget.objs.get(key);
      if (!o) {
        const p = new PdfParser(st.data, st.first + st.offs[e.idx]!, this.budget);
        o = { num: 0, gen: 0, val: p.value(0), end: 0 };
        this.budget.objs.set(key, o);
      }
      val = o.val;
    } else throw errPDFSyntax();
    this.objs.set(num, val);
    return val;
  }

  /** ref-ийн заасан объект; ашиглагдаагүй дугаар бол null, үе таарахгүй бол алдаа. */
  deref(r: PRef): PVal {
    const e = ent(this.xref, r.num);
    if (!inUse(e)) return null;
    if ((e.kind === ENT_USE && e.gen !== r.gen) || (e.kind === ENT_COMP && r.gen !== 0)) throw errPDFSyntax();
    return this.get(r.num);
  }

  resolve(x: PVal): PVal {
    return x instanceof PRef ? this.deref(x) : x;
  }

  length(r: PRef): bigint {
    if (this.inLength) throw errPDFSyntax();
    this.inLength = true;
    try {
      const o = this.deref(r);
      if (!isInt(o)) throw errPDFSyntax();
      this.usedLength = true;
      return o;
    } finally {
      this.inLength = false;
    }
  }

  objStm(num: number): ObjStm {
    if (ent(this.xref, num).kind !== ENT_USE) throw errPDFSyntax();
    const o = this.get(num);
    const off = ent(this.xref, num).off;
    const cached = this.budget.stms.get(off);
    if (cached) return cached;
    if (!(o instanceof PStream)) throw errPDFSyntax();
    const n = dget(o.dict, "N");
    const first = dget(o.dict, "First");
    if (!isInt(n) || !isInt(first) || !isInt(dget(o.dict, "Length")) || !ifaceEq(dget(o.dict, "Type"), new PName("ObjStm")) || dget(o.dict, "Extends") !== null) {
      throw errPDFSyntax();
    }
    const data = this.budget.decode(o);
    if (n < 0n || n > BigInt(data.length) || first < 0n || first > BigInt(data.length)) throw errPDFSyntax();
    const st: ObjStm = { data, nums: [], offs: [], first: Number(first) };
    const p = new PdfParser(data.subarray(0, st.first), 0, this.budget);
    for (let i = 0; i < Number(n); i++) {
      p.skipSpace();
      const id = p.uint();
      p.skipSpace();
      const so = p.uint();
      if (id === undefined || so === undefined || id >= MAX_OBJECT_NUMBER || so > data.length) throw errPDFSyntax();
      this.budget.node();
      st.nums.push(id);
      st.offs.push(so);
    }
    this.budget.stms.set(off, st);
    return st;
  }

  /** Ашиглагдаж буй БҮХ объектыг задалж, объект бүрээс гарах ref-ийн дугааруудыг буцаана. */
  graph(): Map<number, number[]> {
    if (this.refs) return this.refs;
    const refs = new Map<number, number[]>();
    for (const [num, e] of this.xref) {
      if (!inUse(e)) continue;
      const o = this.get(num);
      const out: number[] = [];
      pdfRefs(o, (r) => out.push(r.num));
      refs.set(num, out);
    }
    this.refs = refs;
    return refs;
  }
}

/** b-ийн сүүлийн startxref-ээс /Prev гинжийг дагаж xref-ийг нийлүүлнэ. */
export function openView(b: Uint8Array, budget: PdfBudget): PdfView {
  const v = new PdfView(b, budget);
  const tail = Math.max(0, b.length - 1024);
  const i = lastIndex(b, tail, "startxref");
  if (i < 0) throw errPDFSyntax();
  const p = v.parser(i);
  let off = p.startxref();
  if (off === undefined || !allGapSpace(b.subarray(p.pos))) throw errPDFSyntax();
  const seen = new Set<number>();
  for (;;) {
    if (v.sections.length === MAX_XREF_SECTIONS || seen.has(off) || off >= b.length) throw errPDFSyntax();
    seen.add(off);
    const sec = v.section(off);
    v.sections.push(sec);
    if (dget(sec.trailer, "Encrypt") !== null || dget(sec.trailer, "XRefStm") !== null) throw errPDFSyntax();
    if (!sec.trailer.has("Prev")) break;
    const prev = dget(sec.trailer, "Prev");
    if (!isInt(prev) || prev < 0n || prev >= BigInt(b.length)) throw errPDFSyntax();
    off = Number(prev);
  }
  for (const sec of v.sections) {
    for (const [num, e] of sec.ents) if (!v.xref.has(num)) v.xref.set(num, e);
  }
  v.trailer = v.sections[0]!.trailer;
  const size = dget(v.trailer, "Size");
  if (!isInt(size)) throw errPDFSyntax();
  for (const [num, e] of v.xref) {
    if (inUse(e) && (BigInt(num) >= size || num === 0)) throw errPDFSyntax();
  }
  return v;
}

function lastIndex(b: Uint8Array, from: number, s: string): number {
  outer: for (let i = b.length - s.length; i >= from; i--) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
