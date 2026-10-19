// checkStructure — Go SDK pades/internal/validate/nesting.go (CheckStructure)-ийн порт: PDF-ийг рекурсив parser-т
// (pdf/reader.ts — digitorus/pdf-ийн порт) өгөхөөс ӨМНӨХ хямд урьдчилсан шалгалт. Массив/толийн давхарлалт > 256,
// хэт их уншилт, задалсан ObjStm-ийн хэмжээ эсвэл давтаагүй ObjStm (/DecodeParms) → StructureError (fail-closed).
// Go-той ижил дүрэм (golden validate/v4 deep-nesting*) — нэг баримтад бүх SDK ижил хариу өгнө.

import { fromLatin1 } from "../bytes.js";
import { InflateLimitError, zlibInflate } from "./inflate.js";
import { PRef, PStream, Reader, type ObjPtr, type PObj } from "./reader.js";

/** PDF объектын массив/толийн давхарлалтын дээд гүн (Go validate.MaxNesting). */
export const MAX_NESTING = 256;
const NEST_SCAN_FACTOR = 16; // нийт уншилтын төсөв = 16×len(doc) + 1 MiB
const MAX_OBJSTM_BYTES = 32 << 20; // бүх ObjStm-ийн задалсан нийт хэмжээ (zip bomb)
/** trailer / xref stream-ийн /Size дээд хязгаар (Go maxXrefSize; хууль ёсны 10 MiB баримтад хэдэн арван мянга). */
export const MAX_XREF_SIZE = 1 << 21;
/** /Extends гинжийн дээд урт (Go maxObjStmChain). */
const MAX_OBJSTM_CHAIN = 64;

export class StructureError extends Error {
  constructor() {
    super("PDF-ийн бүтэц хэт гүн давхарласан эсвэл хэт төвөгтэй");
    this.name = "StructureError";
  }
}

// Go regexp `\s` = [\t\n\f\r ] (JS `\s`-ээс ялгаатай).
const ENCRYPT_REF = /\/Encrypt(?:[\t\n\f\r ]+\d+[\t\n\f\r ]+\d+[\t\n\f\r ]+R|[\t\n\f\r ]*<<)/;

const isSpace = (c: number): boolean => c === 0 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
// ()<>[]{}/%
const isDelim = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

const INT_RE = /^[+-]?\d+$/;
const INT64_MAX = 9223372036854775807n;

/** Go strconv.ParseInt(s, 10, 64)-ийн алдаагүй эсэх. */
const isInt = (s: string): boolean => INT_RE.test(s) && BigInt(s) <= INT64_MAX && BigInt(s) >= -INT64_MAX - 1n;

/** Go `v, _ := strconv.ParseInt(s, 10, 64)`: синтакс алдаа → 0, хэтрэлт → ±MaxInt64. */
function parseInt64(s: string): number {
  if (!INT_RE.test(s)) return 0;
  const v = BigInt(s);
  if (v > INT64_MAX) return Number(INT64_MAX);
  if (v < -INT64_MAX - 1n) return -Number(INT64_MAX) - 1;
  return Number(v);
}

const enum Tok {
  EOF,
  Err,
  Arr,
  ArrEnd,
  Dict,
  DictEnd,
  Name,
  Word,
  Str,
}

class Lex {
  val = "";
  constructor(
    readonly b: Uint8Array,
    public pos: number,
  ) {}

  next(): Tok {
    const b = this.b;
    for (;;) {
      while (this.pos < b.length && isSpace(b[this.pos]!)) this.pos++;
      if (this.pos < b.length && b[this.pos] === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0d && b[this.pos] !== 0x0a) this.pos++;
        continue;
      }
      break;
    }
    if (this.pos >= b.length) return Tok.EOF;
    const c = b[this.pos++]!;
    switch (c) {
      case 0x3c: // <
        if (this.pos < b.length && b[this.pos] === 0x3c) {
          this.pos++;
          return Tok.Dict;
        }
        while (this.pos < b.length && b[this.pos] !== 0x3e) this.pos++;
        this.pos++;
        return Tok.Str;
      case 0x28: // (
        for (let depth = 1; this.pos < b.length && depth > 0; this.pos++) {
          const x = b[this.pos];
          if (x === 0x28) depth++;
          else if (x === 0x29) depth--;
          else if (x === 0x5c) this.pos++;
        }
        return Tok.Str;
      case 0x5b:
        return Tok.Arr;
      case 0x5d:
        return Tok.ArrEnd;
      case 0x7b:
      case 0x7d:
        this.val = String.fromCharCode(c);
        return Tok.Word;
      case 0x2f: {
        // /нэр (#xx)
        let name = "";
        while (this.pos < b.length && !isDelim(b[this.pos]!) && !isSpace(b[this.pos]!)) {
          if (b[this.pos] === 0x23 && this.pos + 2 < b.length) {
            const hx = String.fromCharCode(b[this.pos + 1]!, b[this.pos + 2]!);
            if (/^[0-9a-fA-F]{2}$/.test(hx)) {
              name += String.fromCharCode(parseInt(hx, 16));
              this.pos += 3;
              continue;
            }
          }
          name += String.fromCharCode(b[this.pos]!);
          this.pos++;
        }
        this.val = name;
        return Tok.Name;
      }
      case 0x3e: // >
        if (this.pos < b.length && b[this.pos] === 0x3e) {
          this.pos++;
          return Tok.DictEnd;
        }
        return Tok.Err;
      case 0x29:
        return Tok.Err;
    }
    const start = this.pos - 1;
    while (this.pos < b.length && !isDelim(b[this.pos]!) && !isSpace(b[this.pos]!)) this.pos++;
    this.val = fromLatin1(b, start, this.pos);
    return Tok.Word;
  }
}

interface Frame {
  dict: boolean;
  expectKey: boolean;
  key: string;
}

interface ObjStmInfo {
  typ: string;
  filter: string;
  filters: number;
  parms: boolean;
  indirect: boolean;
  first: number;
  nCount: number;
}

class Scan {
  /** Дээд түвшний /Size > MAX_XREF_SIZE. */
  bigSize = false;

  constructor(
    public budget: number,
    public inflateLeft: number,
    readonly encrypted: boolean,
  ) {}

  /** b[start:]-аас reader-ийн нэг объектыг (давхар `N G obj`-ийг оруулаад) гүнээр шалгана. */
  object(b: Uint8Array, start: number, allowStream: boolean): void {
    const l = new Lex(b, start);
    try {
      this.objectBody(l, start, allowStream);
    } finally {
      this.budget -= l.pos - start;
    }
  }

  private objectBody(l: Lex, start: number, allowStream: boolean): void {
    const stack: Frame[] = [];
    const info: ObjStmInfo = { typ: "", filter: "", filters: 0, parms: false, indirect: false, first: 0, nCount: 0 };
    for (;;) {
      if (this.budget - (l.pos - start) < 0) throw new StructureError();
      const tok = l.next();
      const top = stack.length - 1;
      if (top >= 0 && stack[top]!.dict && stack[top]!.expectKey) {
        if (tok === Tok.DictEnd) {
          stack.pop();
          if (stack.length === 0) {
            if (allowStream && (info.typ === "ObjStm" || info.indirect)) this.objStm(l, info);
            return;
          }
          const p = stack[stack.length - 1]!;
          p.expectKey = p.dict;
          continue;
        }
        if (tok === Tok.Name) {
          stack[top]!.key = l.val;
          stack[top]!.expectKey = false;
          continue;
        }
        return; // non-name key — reader энд унана
      }
      // Утга уншина.
      let done = false;
      switch (tok) {
        case Tok.EOF:
        case Tok.Err:
        case Tok.DictEnd:
          return;
        case Tok.Arr:
        case Tok.Dict:
          if (stack.length >= MAX_NESTING) throw new StructureError();
          if (stack.length === 1 && stack[0]!.dict && stack[0]!.key === "DecodeParms") info.parms = true;
          stack.push({ dict: tok === Tok.Dict, expectKey: tok === Tok.Dict, key: "" });
          continue;
        case Tok.ArrEnd:
          if (top < 0 || stack[top]!.dict) return;
          stack.pop();
          break;
        case Tok.Word:
          if (isInt(l.val)) {
            const save = l.pos;
            const saveVal = l.val;
            if (l.next() === Tok.Word && isInt(l.val)) {
              const t3 = l.next();
              if (t3 === Tok.Word && l.val === "R") {
                if (stack.length === 1 && stack[0]!.dict && ["Type", "Filter", "DecodeParms", "N", "First"].includes(stack[0]!.key)) info.indirect = true;
                done = true; // лавлагаа = нэг утга
              } else if (t3 === Tok.Word && l.val === "obj") {
                continue; // давхар `N G obj` — дараагийн утга нь энэ объектын үргэлжлэл
              }
            }
            if (!done) {
              l.pos = save;
              l.val = saveVal;
            }
          }
          if (!done) this.noteScalar(stack, info, tok, l.val);
          break;
        case Tok.Name:
        case Tok.Str:
          this.noteScalar(stack, info, tok, l.val);
          break;
      }
      // Нэг утга дууслаа.
      if (stack.length === 0) return;
      const f = stack[stack.length - 1]!;
      if (f.dict) f.expectKey = true;
    }
  }

  /** Дээд түвшний толийн (ба /Filter массивын) энгийн утгыг тэмдэглэнэ. */
  noteScalar(stack: Frame[], info: ObjStmInfo, tok: Tok, val: string): void {
    if (stack.length === 1 && stack[0]!.dict) {
      switch (stack[0]!.key) {
        case "Type":
          if (tok === Tok.Name) info.typ = val;
          break;
        case "Filter":
          if (tok === Tok.Name) {
            info.filter = val;
            info.filters = 1;
          }
          break;
        case "DecodeParms":
          if (!(tok === Tok.Word && val === "null")) info.parms = true;
          break;
        case "N":
          info.nCount = parseInt64(val);
          break;
        case "Size":
          if (tok === Tok.Word && isInt(val) && BigInt(val) > BigInt(MAX_XREF_SIZE)) this.bigSize = true;
          break;
        case "First":
          info.first = parseInt64(val);
          break;
      }
    } else if (stack.length === 2 && stack[0]!.dict && stack[0]!.key === "Filter" && !stack[1]!.dict && tok === Tok.Name) {
      info.filter = val;
      info.filters++;
    }
  }

  /** `stream`-ийн араас FlateDecode өгөгдлийг (zlib өөрөө төгсөнө) задалж, толгойн offset бүрээс объектыг шалгана. */
  private objStm(l: Lex, info: ObjStmInfo): void {
    if (l.next() !== Tok.Word || l.val !== "stream" || this.encrypted) return;
    if (info.indirect) throw new StructureError(); // /Type /Filter /N /First лавлагаагаар — хууль ёсны баримтад гардаггүй
    if (info.typ !== "ObjStm") return;
    const b = l.b;
    let p = l.pos;
    if (p < b.length && b[p] === 0x0d) p++;
    if (p < b.length && b[p] === 0x0a) p++;
    if (info.filters === 0) {
      this.objStmData(b.subarray(p), info); // шахаагүй ObjStm — өгөгдөл нь файлын үлдсэн хэсэг
      return;
    }
    if (info.filters !== 1 || info.filter !== "FlateDecode") return; // reader дэмжихгүй шүүлтүүр
    if (info.parms) throw new StructureError(); // predictor-тэй ObjStm-ийг давтахгүй — fail-closed
    let data: Uint8Array;
    try {
      data = zlibInflate(b.subarray(p), this.inflateLeft, 64 << 10);
    } catch (e) {
      if (e instanceof InflateLimitError) throw new StructureError();
      return; // reader мөн задалж чадахгүй
    }
    this.inflateLeft -= data.length;
    this.budget -= data.length;
    this.objStmData(data, info);
  }

  private objStmData(data: Uint8Array, info: ObjStmInfo): void {
    const l = new Lex(data, 0);
    for (let i = 0; i < info.nCount; i++) {
      if (l.next() === Tok.EOF) break;
      if (l.next() !== Tok.Word) continue;
      if (!isInt(l.val)) continue;
      const off = parseInt64(l.val);
      if (info.first < 0 || off < 0 || info.first + off >= data.length) continue;
      if (this.budget < 0) throw new StructureError();
      this.object(data, info.first + off, false);
    }
    if (this.budget < 0) throw new StructureError();
  }
}

/**
 * Go validate.CheckStructure: reader объектыг задалж эхэлдэг байж болох бүх цэгээс (`obj` ба `trailer` түлхүүр үгийн
 * дараа, /Type /ObjStm stream-ийн толгойн offset бүрээс) эхний объект дуусах хүртэл давхарлалтын гүнийг тоолно.
 * Хамгаалалтын нэг давхарга — итгэлгүй PDF задлалыг бүхэлд нь аюулгүй болгохгүй.
 * @throws {StructureError}
 */
export function checkStructure(doc: Uint8Array): void {
  const text = fromLatin1(doc);
  const s = new Scan(NEST_SCAN_FACTOR * doc.length + (1 << 20), MAX_OBJSTM_BYTES, ENCRYPT_REF.test(text));
  for (const kw of ["obj", "trailer"]) {
    for (let i = 0; ; ) {
      const k = text.indexOf(kw, i);
      if (k < 0) break;
      const at = k + kw.length;
      i = at;
      // Токен нь хоёр талдаа зай/хязгаарлагчтай (`endobj`, `objx` — өөр түлхүүр үг).
      if ((k > 0 && !isSpace(doc[k - 1]!) && !isDelim(doc[k - 1]!)) || (at < doc.length && !isSpace(doc[at]!) && !isDelim(doc[at]!))) continue;
      s.object(doc, at, true);
    }
  }
  if (s.bigSize) throw new StructureError();
  checkObjStmGraph(doc);
}

/**
 * Go checkObjStmGraph (PRECHECKS #2b): уншигч ObjStm доторх объектыг уншихдаа агуулагч stream-ийг (мөн толгойн
 * /Length /Filter /DecodeParms /N /First /Extends лавлагааг) рекурсээр resolve хийдэг — мөчлөг нь хязгааргүй рекурс.
 * ISO 32000-1 §7.5.7-оор хууль ёсны баримтад гардаггүй тул fail-closed: агуулагч нь өөрөө ObjStm доторх объект;
 * агуулагч (ба /Extends-ээр холбогдсон) stream-ийн толгойн лавлагаа ObjStm доторх объект руу; /Extends мөчлөг / > 64.
 * Уншигч нээгдэхгүй эсвэл задрахгүй бол энд шийдэхгүй (дуудагч өөрөө PDF_INVALID болгоно).
 */
function checkObjStmGraph(doc: Uint8Array): void {
  let r: Reader;
  try {
    r = new Reader(doc);
  } catch {
    return;
  }
  const xr = r.xref;
  const registered = (p: ObjPtr): boolean => p.id < xr.length && xr[p.id]!.ptr.id === p.id && xr[p.id]!.ptr.gen === p.gen;
  const inStream = (p: ObjPtr): boolean => registered(p) && xr[p.id]!.inStream;
  const containers = new Map<string, ObjPtr>();
  for (const e of xr) {
    if (!e.inStream) continue;
    if (inStream(e.stream)) throw new StructureError();
    containers.set(`${e.stream.id} ${e.stream.gen}`, e.stream);
  }
  for (const c of containers.values()) {
    const seen = new Set<string>();
    for (let p = c; registered(p); ) {
      const k = `${p.id} ${p.gen}`;
      if (seen.has(k) || seen.size > MAX_OBJSTM_CHAIN) throw new StructureError();
      seen.add(k);
      let v: PObj | undefined;
      try {
        const e = xr[p.id]!.ptr;
        v = r.resolve(e, new PRef(e.id, e.gen)).data;
      } catch {
        return; // уншигч энд унадаг баримт — дуудагч PDF_INVALID
      }
      if (!(v instanceof PStream)) break;
      let bad = false;
      walkRefs(v.hdr, 0, (x) => (bad ||= inStream(x)));
      if (bad) throw new StructureError();
      const ext = v.hdr.get("Extends");
      if (!(ext instanceof PRef)) break;
      p = { id: ext.id, gen: ext.gen };
    }
  }
}

/** Go walkRefs — задалсан утга (dict / array) доторх бүх лавлагаа. */
function walkRefs(v: PObj | undefined, depth: number, fn: (p: ObjPtr) => void): void {
  if (depth > MAX_NESTING) return;
  if (v instanceof PRef) fn({ id: v.id, gen: v.gen });
  else if (v instanceof Map) for (const x of v.values()) walkRefs(x, depth + 1, fn);
  else if (Array.isArray(v)) for (const x of v) walkRefs(x, depth + 1, fn);
}
