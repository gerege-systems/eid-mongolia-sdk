// PDF уншигч — Go reference-ийн ашигладаг github.com/digitorus/pdf v0.1.2-ийн (read.go, lex.go) зан төлөвийн 1:1 порт.
// Байт-ижил гаралтын тулд түүний онцлогуудыг хадгална: dict-ийн null утгатай түлхүүр Keys()-д үлдэнэ, Keys() байтын
// эрэмбээр, Value нь «эх объектын заагч»-тай (ptr) — serialize шууд утгыг дахин бичиж, өөр объектынхыг "N G R"
// заалтаар үлдээнэ; xref table (Prev гинж, /Size-аар таслах), xref stream (Prev гинж, /W, /Index, PNG Up predictor),
// object stream (/Extends). Шифрлэлтийг уншихгүй (Prepare өмнө нь PDF_ENCRYPTED буцаана).

import { fromLatin1 } from "../bytes.js";
import { zlibInflate } from "./inflate.js";

export class PdfError extends Error {}

export interface ObjPtr {
  id: number;
  gen: number;
}

export const NO_PTR: ObjPtr = { id: 0, gen: 0 };

/** PDF integer (Go int64). */
export class PInt {
  constructor(readonly v: bigint) {}
}
/** PDF real (Go float64). */
export class PReal {
  constructor(readonly v: number) {}
}
/** PDF string — байт (literal escape тайлсан / hex тайлсан). */
export class PStr {
  constructor(readonly b: Uint8Array) {}
}
/** PDF name — байт бүр нэг тэмдэгт (latin1), #xx тайлсан. */
export class PName {
  constructor(readonly n: string) {}
}
export class PRef {
  constructor(
    readonly id: number,
    readonly gen: number,
  ) {}
}
export class PKeyword {
  constructor(readonly k: string) {}
}
export type PDict = Map<string, PObj>;
export class PStream {
  constructor(
    readonly hdr: PDict,
    readonly ptr: ObjPtr,
    readonly offset: number,
  ) {}
}
export type PObj = null | boolean | PInt | PReal | PStr | PName | PDict | PObj[] | PRef | PStream;

class ObjDef {
  constructor(
    readonly ptr: ObjPtr,
    readonly obj: PObj,
  ) {}
}

const EOF_TOKEN = Symbol("eof");
type Token = PObj | PKeyword | ObjDef | typeof EOF_TOKEN;

const isSpace = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number): boolean =>
  c === 0x3c || c === 0x3e || c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

const isKw = (t: Token, k: string): boolean => t instanceof PKeyword && t.k === k;

/** digitorus lex.go buffer — `data[start:]` дээр. */
class Lexer {
  pos: number;
  eof = false;
  private unread: Token[] = [];
  objptr: ObjPtr = NO_PTR;

  constructor(
    private readonly data: Uint8Array,
    start: number,
    private readonly allowEOF = false,
  ) {
    this.pos = start;
  }

  readByte(): number {
    if (this.pos >= this.data.length) {
      if (!this.allowEOF) throw new PdfError(`malformed PDF: reading at offset ${this.pos}: EOF`);
      this.eof = true;
      this.pos = this.data.length + 1; // unreadByte-д тэнцвэр
      return 10;
    }
    return this.data[this.pos++]!;
  }

  unreadByte(): void {
    if (this.pos > 0) this.pos--;
  }

  unreadToken(t: Token): void {
    this.unread.push(t);
  }

  /** Stream-ийн өгөгдлийн эхлэл (readOffset). */
  offset(): number {
    return this.pos;
  }

  seek(p: number): void {
    this.pos = p;
  }

  readToken(): Token {
    const u = this.unread.pop();
    if (u !== undefined) return u;
    let c = this.readByte();
    for (;;) {
      if (isSpace(c)) {
        if (this.eof) return EOF_TOKEN;
        c = this.readByte();
      } else if (c === 0x25) {
        while (c !== 13 && c !== 10) c = this.readByte();
      } else break;
    }
    switch (c) {
      case 0x3c:
        if (this.readByte() === 0x3c) return new PKeyword("<<");
        this.unreadByte();
        return this.readHexString();
      case 0x28:
        return this.readLiteralString();
      case 0x5b:
      case 0x5d:
      case 0x7b:
      case 0x7d:
        return new PKeyword(String.fromCharCode(c));
      case 0x2f:
        return this.readName();
      case 0x3e:
        if (this.readByte() === 0x3e) return new PKeyword(">>");
        this.unreadByte();
      // fallthrough
      default:
        if (isDelim(c)) throw new PdfError(`unexpected delimiter ${String.fromCharCode(c)}`);
        this.unreadByte();
        return this.readKeyword();
    }
  }

  private readHexString(): PStr {
    const out: number[] = [];
    for (;;) {
      let c = this.readByte();
      while (isSpace(c) && !this.eof) c = this.readByte();
      if (this.eof) throw new PdfError("unterminated hex string");
      if (c === 0x3e) break;
      let c2 = this.readByte();
      while (isSpace(c2) && !this.eof) c2 = this.readByte();
      if (this.eof) throw new PdfError("unterminated hex string");
      const x = (unhex(c) << 4) | unhex(c2);
      if (unhex(c) < 0 || unhex(c2) < 0 || x < 0) throw new PdfError("malformed hex string");
      out.push(x);
    }
    return new PStr(Uint8Array.from(out));
  }

  private readLiteralString(): PStr {
    const out: number[] = [];
    let depth = 1;
    for (;;) {
      let c = this.readByte();
      // allowEOF: readByte нь төгсгөлд \n-ийг мөнхөд буцаана — хаагдаагүй мөр давталтыг зогсоохгүй.
      if (this.eof) throw new PdfError("unterminated literal string");
      if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 0x5c) {
        c = this.readByte();
        switch (c) {
          case 0x6e:
            out.push(10);
            break;
          case 0x72:
            out.push(13);
            break;
          case 0x62:
            out.push(8);
            break;
          case 0x74:
            out.push(9);
            break;
          case 0x66:
            out.push(12);
            break;
          case 0x28:
          case 0x29:
          case 0x5c:
            out.push(c);
            break;
          case 13:
            if (this.readByte() !== 10) this.unreadByte();
            break;
          case 10:
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let x = c - 0x30;
              for (let i = 0; i < 2; i++) {
                c = this.readByte();
                if (c < 0x30 || c > 0x37) {
                  this.unreadByte();
                  break;
                }
                x = x * 8 + (c - 0x30);
              }
              if (x > 255) throw new PdfError("invalid octal escape");
              out.push(x);
            } else {
              throw new PdfError(`invalid escape sequence \\${String.fromCharCode(c)}`);
            }
        }
      } else {
        out.push(c);
      }
    }
    return new PStr(Uint8Array.from(out));
  }

  private readName(): PName {
    let s = "";
    for (;;) {
      const c = this.readByte();
      if (isDelim(c) || isSpace(c)) {
        this.unreadByte();
        break;
      }
      if (c === 0x23) {
        const h = unhex(this.readByte());
        const l = unhex(this.readByte());
        if (h < 0 || l < 0) throw new PdfError("malformed name");
        s += String.fromCharCode((h << 4) | l);
        continue;
      }
      s += String.fromCharCode(c);
    }
    return new PName(s);
  }

  private readKeyword(): Token {
    let s = "";
    for (;;) {
      const c = this.readByte();
      if (isDelim(c) || isSpace(c)) {
        this.unreadByte();
        break;
      }
      s += String.fromCharCode(c);
    }
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^[+-]?[0-9]+$/.test(s)) {
      const v = BigInt(s);
      if (v > 0x7fffffffffffffffn || v < -0x8000000000000000n) throw new PdfError(`invalid integer ${s}`);
      return new PInt(v);
    }
    if (/^[+-]?[0-9.]+$/.test(s) && /^[+-]?[^.]*\.[^.]*$/.test(s) && /[0-9]/.test(s)) {
      return new PReal(parseFloat(s.startsWith("+") ? s.slice(1) : s));
    }
    if (/^[+-]?\.$/.test(s)) throw new PdfError(`invalid real ${s}`);
    return new PKeyword(s);
  }

  readObject(): PObj | ObjDef | typeof EOF_TOKEN | PKeyword {
    const tok = this.readToken();
    if (tok instanceof PKeyword) {
      switch (tok.k) {
        case "null":
          return null;
        case "endobj":
          this.unreadToken(tok);
          return null;
        case "<<":
          return this.readDict();
        case "[":
          return this.readArray();
      }
      throw new PdfError(`unexpected keyword ${tok.k} parsing object`);
    }
    if (tok instanceof PInt && tok.v >= 0n && tok.v <= 0xffffffffn) {
      const tok2 = this.readToken();
      if (tok2 instanceof PInt && tok2.v >= 0n && tok2.v <= 0xffffn) {
        const tok3 = this.readToken();
        if (isKw(tok3, "R")) return new PRef(Number(tok.v), Number(tok2.v));
        if (isKw(tok3, "obj")) {
          const old = this.objptr;
          const ptr = { id: Number(tok.v), gen: Number(tok2.v) };
          this.objptr = ptr;
          const obj = this.readObject();
          if (!(obj instanceof PStream)) {
            const tok4 = this.readToken();
            if (!isKw(tok4, "endobj")) throw new PdfError("missing endobj after indirect object definition");
          }
          this.objptr = old;
          return new ObjDef(ptr, asObj(obj));
        }
        this.unreadToken(tok3);
      }
      this.unreadToken(tok2);
    }
    return tok;
  }

  private readArray(): PObj[] {
    const x: PObj[] = [];
    for (;;) {
      const tok = this.readToken();
      if (isKw(tok, "]")) break;
      if (tok === EOF_TOKEN) throw new PdfError("unterminated array");
      // readObject нь endobj-ийг буцааж (unread) null өгдөг — массив дотор бол ахихгүй мөнхийн давталт.
      if (isKw(tok, "endobj")) throw new PdfError("unterminated array");
      this.unreadToken(tok);
      x.push(asObj(this.readObject()));
    }
    return x;
  }

  private readDict(): PDict | PStream {
    const x: PDict = new Map();
    for (;;) {
      const tok = this.readToken();
      if (isKw(tok, ">>")) break;
      if (tok === EOF_TOKEN) throw new PdfError("unterminated dictionary");
      if (!(tok instanceof PName)) throw new PdfError("unexpected non-name key parsing dictionary");
      x.set(tok.n, asObj(this.readObject()));
    }
    const tok = this.readToken();
    if (!isKw(tok, "stream")) {
      this.unreadToken(tok);
      return x;
    }
    const c = this.readByte();
    if (c === 13) {
      if (this.readByte() !== 10) this.unreadByte();
    } else if (c !== 10) {
      throw new PdfError("stream keyword not followed by newline");
    }
    return new PStream(x, this.objptr, this.offset());
  }
}

function asObj(o: PObj | ObjDef | typeof EOF_TOKEN | PKeyword): PObj {
  if (o instanceof ObjDef || o === EOF_TOKEN || o instanceof PKeyword) throw new PdfError("unexpected token in object");
  return o;
}

interface Xref {
  ptr: ObjPtr;
  inStream: boolean;
  stream: ObjPtr;
  offset: number;
}

const ZERO_XREF = (): Xref => ({ ptr: NO_PTR, inStream: false, stream: NO_PTR, offset: 0 });
const ptrEq = (a: ObjPtr, b: ObjPtr): boolean => a.id === b.id && a.gen === b.gen;

/** digitorus Value: data + түүнийг агуулсан объектын заагч. */
export class Value {
  constructor(
    readonly r: Reader,
    readonly ptr: ObjPtr,
    readonly data: PObj | undefined,
  ) {}

  isNull(): boolean {
    return this.data === null || this.data === undefined;
  }

  kind(): "null" | "bool" | "int" | "real" | "string" | "name" | "dict" | "array" | "stream" {
    const d = this.data;
    if (d === null || d === undefined || d instanceof PRef) return "null";
    if (typeof d === "boolean") return "bool";
    if (d instanceof PInt) return "int";
    if (d instanceof PReal) return "real";
    if (d instanceof PStr) return "string";
    if (d instanceof PName) return "name";
    if (d instanceof Map) return "dict";
    if (Array.isArray(d)) return "array";
    return "stream";
  }

  private dict(): PDict | undefined {
    const d = this.data;
    if (d instanceof Map) return d;
    if (d instanceof PStream) return d.hdr;
    return undefined;
  }

  key(k: string): Value {
    const d = this.dict();
    if (!d) return new Value(this.r, NO_PTR, undefined);
    return this.r.resolve(this.ptr, d.has(k) ? d.get(k)! : undefined);
  }

  /** Байтын эрэмбээр (Go sort.Strings). */
  keys(): string[] {
    const d = this.dict();
    if (!d) return [];
    return [...d.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  index(i: number): Value {
    const d = this.data;
    if (!Array.isArray(d) || i < 0 || i >= d.length) return new Value(this.r, NO_PTR, undefined);
    return this.r.resolve(this.ptr, d[i]);
  }

  len(): number {
    return Array.isArray(this.data) ? this.data.length : 0;
  }

  name(): string {
    return this.data instanceof PName ? this.data.n : "";
  }

  int64(): number {
    return this.data instanceof PInt ? Number(this.data.v) : 0;
  }

  bool(): boolean {
    return this.data === true;
  }

  float64(): number {
    if (this.data instanceof PReal) return this.data.v;
    if (this.data instanceof PInt) return Number(this.data.v);
    return 0;
  }

  rawString(): Uint8Array {
    return this.data instanceof PStr ? this.data.b : new Uint8Array();
  }

  /** digitorus Text(): UTF-16BE (BOM) эсвэл PDFDocEncoding (ASCII хэсэгт ижил). */
  text(): string {
    if (!(this.data instanceof PStr)) return "";
    const b = this.data.b;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      let s = "";
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
      return s;
    }
    return fromLatin1(b);
  }

  /** Stream-ийн тайлсан өгөгдөл (Value.Reader). */
  streamData(): Uint8Array {
    const x = this.data;
    if (!(x instanceof PStream)) throw new PdfError("stream not present");
    const n = this.key("Length").int64();
    if (n < 0 || x.offset + n > this.r.bytes.length) throw new PdfError("stream урт файлаас хэтэрсэн");
    let data: Uint8Array = this.r.bytes.subarray(x.offset, x.offset + n);
    const filter = this.key("Filter");
    const param = this.key("DecodeParms");
    switch (filter.kind()) {
      case "null":
        break;
      case "name":
        data = applyFilter(data, filter.name(), param);
        break;
      case "array":
        for (let i = 0; i < filter.len(); i++) data = applyFilter(data, filter.index(i).name(), param.index(i));
        break;
      default:
        throw new PdfError("unsupported filter");
    }
    return data;
  }
}

function applyFilter(data: Uint8Array, name: string, param: Value): Uint8Array {
  if (name !== "FlateDecode") throw new PdfError(`unknown filter ${name}`);
  const out = zlibInflate(data);
  const pred = param.key("Predictor");
  if (pred.kind() === "null") return out;
  if (pred.int64() !== 12) throw new PdfError("unknown predictor");
  // pngUpReader: мөр бүр [2, columns байт]; hist-д нэмнэ (hist[0] ч мөн нэмэгддэг, гаралтад орохгүй).
  const columns = param.key("Columns").int64();
  const row = 1 + columns;
  const hist = new Uint8Array(row);
  const rows = Math.floor(out.length / row);
  const res = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    if (out[r * row] !== 2) {
      // Go: тэр мөрөөс өмнөх байтыг өгөөд алдаа буцаана.
      return res.slice(0, r * columns);
    }
    for (let i = 0; i < row; i++) hist[i] = (hist[i]! + out[r * row + i]!) & 0xff;
    res.set(hist.subarray(1), r * columns);
  }
  return res;
}

/** digitorus pdf.Reader. */
export class Reader {
  xref: Xref[] = [];
  trailer: PDict = new Map();
  trailerPtr: ObjPtr = NO_PTR;
  /** "table" | "stream" */
  xrefType = "";
  /** Сүүлийн startxref (шинэ revision-ий /Prev). */
  startXref = 0;
  /** Header-ийн "1.x". */
  pdfVersion = "";
  private readonly cache = new Map<string, Value>();

  constructor(readonly bytes: Uint8Array) {
    const b = bytes;
    const ok17 = b.length >= 8 && fromLatin1(b, 0, 7) === "%PDF-1." && b[7]! >= 0x30 && b[7]! <= 0x37;
    const ok20 = b.length >= 8 && fromLatin1(b, 0, 7) === "%PDF-2." && b[7] === 0x30;
    if (!ok17 && !ok20) throw new PdfError("not a PDF file: invalid header");
    this.pdfVersion = fromLatin1(b, 5, 8);
    const startxrefPos = findStartXref(b);
    const lx = new Lexer(b, startxrefPos);
    if (!isKw(lx.readToken(), "startxref")) throw new PdfError("malformed PDF file: missing startxref");
    const sx = lx.readToken();
    if (!(sx instanceof PInt)) throw new PdfError("malformed PDF file: startxref not followed by integer");
    this.startXref = Number(sx.v);
    if (this.startXref < 0 || this.startXref >= b.length) throw new PdfError("startxref буруу");
    const x = new Lexer(b, this.startXref);
    const tok = x.readToken();
    if (isKw(tok, "xref")) this.readXrefTable(x);
    else if (tok instanceof PInt) {
      x.unreadToken(tok);
      this.readXrefStream(x);
    } else throw new PdfError("malformed PDF: cross-reference table not found");
  }

  trailerValue(): Value {
    return new Value(this, this.trailerPtr, this.trailer);
  }

  private readXrefStream(b: Lexer): void {
    const def = b.readObject();
    if (!(def instanceof ObjDef) || !(def.obj instanceof PStream)) throw new PdfError("malformed PDF: cross-reference table not found");
    const strm = def.obj;
    const type = strm.hdr.get("Type");
    if (!(type instanceof PName) || type.n !== "XRef") throw new PdfError("malformed PDF: xref stream does not have type XRef");
    const sizeObj = strm.hdr.get("Size");
    if (!(sizeObj instanceof PInt)) throw new PdfError("malformed PDF: xref stream missing Size");
    const size = Number(sizeObj.v);
    if (size < 0 || size > 1 << 24) throw new PdfError("xref Size буруу");
    const table: Xref[] = Array.from({ length: size }, ZERO_XREF);
    this.readXrefStreamData(strm, table, size);
    const seen = new Set<number>();
    let prevoff = strm.hdr.get("Prev");
    while (prevoff !== undefined && prevoff !== null) {
      if (!(prevoff instanceof PInt)) throw new PdfError("malformed PDF: xref Prev is not integer");
      const off = Number(prevoff.v);
      if (seen.has(off)) throw new PdfError("malformed PDF: xref Prev loop detected");
      seen.add(off);
      if (off < 0 || off >= this.bytes.length) throw new PdfError("xref Prev буруу");
      const pd = new Lexer(this.bytes, off).readObject();
      if (!(pd instanceof ObjDef) || !(pd.obj instanceof PStream)) throw new PdfError("malformed PDF: xref prev stream not found");
      const ps = pd.obj;
      prevoff = ps.hdr.get("Prev");
      const prev = new Value(this, NO_PTR, ps);
      if (prev.key("Type").name() !== "XRef") throw new PdfError("malformed PDF: xref prev stream does not have type XRef");
      const psize = prev.key("Size").int64();
      if (psize > size) throw new PdfError("malformed PDF: xref prev stream larger than last stream");
      this.readXrefStreamData(ps, table, psize);
    }
    this.xrefType = "stream";
    this.xref = table;
    this.trailerPtr = def.ptr;
    this.trailer = strm.hdr;
  }

  private readXrefStreamData(strm: PStream, table: Xref[], size: number): void {
    let index = strm.hdr.get("Index");
    if (!Array.isArray(index)) index = [new PInt(0n), new PInt(BigInt(size))];
    if (index.length % 2 !== 0) throw new PdfError("invalid Index array");
    const ww = strm.hdr.get("W");
    if (!Array.isArray(ww)) throw new PdfError("xref stream missing W array");
    const w = ww.map((x) => {
      if (!(x instanceof PInt) || x.v < 0n || x.v > 8n) throw new PdfError("invalid W array");
      return Number(x.v);
    });
    if (w.length < 3) throw new PdfError("invalid W array");
    const wtotal = w.reduce((a, c) => a + c, 0);
    const data = new Value(this, NO_PTR, strm).streamData();
    let p = 0;
    const dec = (n: number): number => {
      let x = 0;
      for (let i = 0; i < n; i++) x = x * 256 + data[p + i]!;
      p += n;
      return x;
    };
    for (let k = 0; k + 1 < index.length; k += 2) {
      const s = index[k];
      const n = index[k + 1];
      if (!(s instanceof PInt) || !(n instanceof PInt)) throw new PdfError("malformed Index pair");
      const start = Number(s.v);
      for (let i = 0; i < Number(n.v); i++) {
        if (p + wtotal > data.length) throw new PdfError("error reading xref stream: EOF");
        const base = p;
        let v1 = dec(w[0]!);
        if (w[0] === 0) v1 = 1;
        const v2 = dec(w[1]!);
        const v3 = dec(w[2]!);
        p = base + wtotal;
        const x = start + i;
        if (x >= table.length) {
          // Go: append(table[:cap], …) — зөвхөн дараагийн нэг мөрийг ургуулна; цаашхи нь index out of range.
          if (x !== table.length) throw new PdfError("xref stream: index out of range");
          table.push(ZERO_XREF());
        }
        if (!ptrEq(table[x]!.ptr, NO_PTR)) continue;
        if (v1 === 0) table[x] = { ptr: { id: 0, gen: 65535 }, inStream: false, stream: NO_PTR, offset: 0 };
        else if (v1 === 1) table[x] = { ptr: { id: x, gen: v3 & 0xffff }, inStream: false, stream: NO_PTR, offset: v2 };
        else if (v1 === 2) table[x] = { ptr: { id: x, gen: 0 }, inStream: true, stream: { id: v2, gen: 0 }, offset: v3 };
      }
    }
  }

  private readXrefTable(b: Lexer): void {
    let table: Xref[] = [];
    this.readXrefTableData(b, table);
    const trailer = b.readObject();
    if (!(trailer instanceof Map)) throw new PdfError("malformed PDF: xref table not followed by trailer dictionary");
    const seen = new Set<number>();
    let prevoff = trailer.get("Prev");
    while (prevoff !== undefined && prevoff !== null) {
      if (!(prevoff instanceof PInt)) throw new PdfError("malformed PDF: xref Prev is not integer");
      const off = Number(prevoff.v);
      if (seen.has(off)) throw new PdfError("malformed PDF: xref Prev loop detected");
      seen.add(off);
      if (off < 0 || off >= this.bytes.length) throw new PdfError("xref Prev буруу");
      const pb = new Lexer(this.bytes, off);
      if (!isKw(pb.readToken(), "xref")) throw new PdfError("malformed PDF: xref Prev does not point to xref");
      this.readXrefTableData(pb, table);
      const t2 = pb.readObject();
      if (!(t2 instanceof Map)) throw new PdfError("malformed PDF: xref Prev table not followed by trailer dictionary");
      prevoff = t2.get("Prev");
    }
    const size = trailer.get("Size");
    if (!(size instanceof PInt)) throw new PdfError("malformed PDF: trailer missing /Size entry");
    if (Number(size.v) < table.length) table = table.slice(0, Math.max(0, Number(size.v)));
    this.xrefType = "table";
    this.xref = table;
    this.trailer = trailer;
    this.trailerPtr = NO_PTR;
  }

  private readXrefTableData(b: Lexer, table: Xref[]): void {
    for (;;) {
      const tok = b.readToken();
      if (isKw(tok, "trailer")) break;
      const n = b.readToken();
      if (!(tok instanceof PInt) || !(n instanceof PInt)) throw new PdfError("malformed xref table");
      const start = Number(tok.v);
      const count = Number(n.v);
      if (start < 0 || count < 0 || start + count > 1 << 24) throw new PdfError("malformed xref table");
      for (let i = 0; i < count; i++) {
        const off = b.readToken();
        const gen = b.readToken();
        const alloc = b.readToken();
        if (!(off instanceof PInt) || !(gen instanceof PInt) || !(alloc instanceof PKeyword) || (alloc.k !== "f" && alloc.k !== "n")) {
          throw new PdfError("malformed xref table");
        }
        const x = start + i;
        while (table.length <= x) table.push(ZERO_XREF());
        if (alloc.k === "n" && table[x]!.offset === 0) {
          table[x] = { ptr: { id: x, gen: Number(gen.v) & 0xffff }, inStream: false, stream: NO_PTR, offset: Number(off.v) };
        }
      }
    }
  }

  /** digitorus resolve(parent, x). */
  resolve(parent: ObjPtr, x: PObj | undefined): Value {
    if (x instanceof PRef) {
      const key = `${x.id} ${x.gen}`;
      const hit = this.cache.get(key);
      if (hit) return hit;
      const v = this.load(x);
      this.cache.set(key, v);
      return v;
    }
    return new Value(this, parent, x);
  }

  private load(ptr: PRef): Value {
    if (ptr.id >= this.xref.length) return new Value(this, NO_PTR, undefined);
    const xr = this.xref[ptr.id]!;
    if (xr.ptr.id !== ptr.id || xr.ptr.gen !== ptr.gen || (!xr.inStream && xr.offset === 0)) return new Value(this, NO_PTR, undefined);
    const p: ObjPtr = { id: ptr.id, gen: ptr.gen };
    let x: PObj;
    if (xr.inStream) {
      let strm = this.resolve(p, new PRef(xr.stream.id, xr.stream.gen));
      for (let guard = 0; ; guard++) {
        if (guard > 64) throw new PdfError("object stream /Extends гинж хэт урт");
        if (strm.kind() !== "stream") throw new PdfError("not a stream");
        if (strm.key("Type").name() !== "ObjStm") throw new PdfError("not an object stream");
        const n = strm.key("N").int64();
        const first = strm.key("First").int64();
        if (first === 0) throw new PdfError("missing First");
        const data = strm.streamData();
        const b = new Lexer(data, 0, true);
        let found: PObj | undefined;
        let ok = false;
        for (let i = 0; i < n; i++) {
          const id = b.readToken();
          const off = b.readToken();
          if (id === EOF_TOKEN || off === EOF_TOKEN) break; // /N нь stream-ээс урт — үлдсэн мөр байхгүй
          const idn = id instanceof PInt ? Number(BigInt.asUintN(32, id.v)) : 0;
          if (idn === ptr.id) {
            const o = off instanceof PInt ? Number(off.v) : 0;
            b.seek(first + o);
            found = asObj(b.readObject());
            ok = true;
            break;
          }
        }
        if (ok) {
          x = found ?? null;
          break;
        }
        const ext = strm.key("Extends");
        if (ext.kind() !== "stream") throw new PdfError("cannot find object in stream");
        strm = ext;
      }
    } else {
      const b = new Lexer(this.bytes, xr.offset);
      const def = b.readObject();
      if (!(def instanceof ObjDef)) throw new PdfError(`loading ${ptr.id} ${ptr.gen}: not an objdef`);
      if (!ptrEq(def.ptr, p)) throw new PdfError(`loading ${ptr.id} ${ptr.gen}: found ${def.ptr.id} ${def.ptr.gen}`);
      x = def.obj;
    }
    return new Value(this, p, x!);
  }
}

/**
 * digitorus NewReader-ийн %%EOF/startxref хайлт: төгсгөлөөс 200, 400, … байтын цонхонд сүүлийн "%%EOF"-ийг олж, түүний
 * өмнөх 200 байтад мөрийн эхэнд байгаа сүүлийн "startxref"-ийг авна.
 */
function findStartXref(b: Uint8Array): number {
  const end = b.length;
  // Go-ийн давталт (цонх 200, 400, …; цонх бүрд төгсгөлийн \r\n\t зайг хасаад доош "%%EOF" хайна) нь O(n²/200) —
  // %%EOF-гүй 10 MiB баримтад хөтчийг цагаар гацаана. Ижил үр дүнг нэг удаагийн хайлтаар: хассан төгсгөлөөс доош сүүлийн
  // "%%EOF" (idx), түүнийг олох цонх = 200m > end − idx (цонхны яг эхэнд таарвал Go дараагийн цонхонд олдог), 200m ≤ end.
  let hi = end;
  while (hi > 0 && (b[hi - 1] === 10 || b[hi - 1] === 13 || b[hi - 1] === 9 || b[hi - 1] === 32)) hi--;
  let idx = -1;
  for (let i = hi - 5; i >= 0; i--) {
    if (b[i] === 0x25 && b[i + 1] === 0x25 && b[i + 2] === 0x45 && b[i + 3] === 0x4f && b[i + 4] === 0x46) {
      idx = i;
      break;
    }
  }
  if (idx < 0 || 200 * (Math.floor((end - idx) / 200) + 1) > end) throw new PdfError("not a PDF file: missing %%EOF");
  const eofEnd = idx + 5;
  const winStart = eofEnd - 200;
  // Go: buf 200 байт, ReadAt(winStart) — сөрөг бол уншихгүй (бүх тэг) → startxref олдохгүй.
  if (winStart < 0) throw new PdfError("malformed PDF file: missing final startxref");
  const buf = b.subarray(winStart, eofEnd);
  const i = findLastLine(buf, "startxref");
  if (i < 0) throw new PdfError("malformed PDF file: missing final startxref");
  return winStart + i;
}

function findLastLine(buf: Uint8Array, s: string): number {
  const str = fromLatin1(buf);
  let max = buf.length;
  for (;;) {
    const i = str.lastIndexOf(s, max - s.length);
    if (i <= 0 || i + s.length >= buf.length) return -1;
    const before = buf[i - 1];
    const after = buf[i + s.length];
    if ((before === 10 || before === 13) && (after === 10 || after === 13)) return i;
    max = i;
  }
}
