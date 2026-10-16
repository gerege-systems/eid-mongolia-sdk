// Гарын үсгийн ДАРАА нэмэгдсэн revision-ийн шинжилгээ — Go SDK pades/internal/validate/revisions.go-ийн (CA-ийн нийтийн
// шалгагчийн кодын) 1:1 порт. Дүрмийн бүрэн тайлбар Go эх файлын толгойд. Товчоор: гарын үсгийн мужийн төгсгөл хүртэлх
// баримт (суурь) ба бүтэн файлыг ЗАДАЛСАН объектын графаар харьцуулж, ялгаа бүр зөвшөөрөгдсөн жагсаалтад багтвал л «зөвхөн
// гарын үсгээр өргөтгөгдсөн» гэж үзнэ; бусад бүх зүйл (задарч чадаагүйг оруулаад) — modified_after_signing (fail closed).
// Prod нь зөвхөн "own" profile (манай PAdES/digitorus бичигчийн яг хэлбэр); "broad" нь дээд хязгаар (холимог
// хуримтлагдсан алхам ба тест).

import { ownVisible } from "./appearance.js";
import {
  ENT_COMP,
  ENT_USE,
  PName,
  PReal,
  PRef,
  PStr,
  PStream,
  PdfObjError,
  PdfParser,
  allGapSpace,
  dget,
  ent,
  entEq,
  ifaceEq,
  inUse,
  isArr,
  isDict,
  isInt,
  isName,
  isRef,
  isStr,
  newPDFBudget,
  openView,
  pdfEqual,
  pdfRefs,
  type PDict,
  type PVal,
  type PdfBudget,
  type PdfView,
} from "./pdfobj.js";

export type Profile = "own" | "broad";

/** Extract-ийн шалгасан гарын үсгийн харагдах дүрслэлд хэрэгтэй өгөгдөл (объектын дугаараар). */
export interface SigMeta {
  /** ByteRange-ийн төгсгөлөөр эрэмбэлсэн дараалал (1-ээс). */
  revIndex: number;
  /** signer-attributes-v2-ийн ганц claimedRole ("" — байхгүй). */
  role: string;
  /** claimedRole 0 эсвэл яг 1. */
  roleOK: boolean;
}

/** Гарын үсгийн мужийн дараах revision-уудын дүгнэлт. */
export interface LaterChanges {
  signaturesOnly: boolean;
  signatures: number;
  visible: boolean;
}

export const errNotSignatureOnly = (): PdfObjError => new PdfObjError("validate: гарын үсгийн дараах өөрчлөлт зөвшөөрөгдсөн жагсаалтад багтсангүй");

const SIG_FIELD_KEYS = ["Type", "Subtype", "FT", "T", "TU", "V", "Rect", "P", "F", "Ff", "M", "AP"];
const SIG_DICT_KEYS = [
  "Type",
  "Filter",
  "SubFilter",
  "Contents",
  "ByteRange",
  "Cert",
  "M",
  "Name",
  "Location",
  "Reason",
  "ContactInfo",
  "Reference",
  "Prop_Build",
  "Prop_AuthTime",
  "Prop_AuthType",
  "Changes",
  "R",
  "V",
  "TransformMethod",
  "TransformParams",
];
const OWN_FIELD_KEYS = ["Type", "Subtype", "Rect", "P", "F", "FT", "T", "V"];
const OWN_SIG_DICT_KEYS = ["Type", "Filter", "SubFilter", "Prop_Build", "ByteRange", "Contents", "TransformMethod", "TransformParams", "Name", "Location", "Reason", "ContactInfo", "M"];
const PADES_SIG_DICT_KEYS = ["Type", "Filter", "SubFilter", "ByteRange", "Contents", "M", "Name", "Reason"];
const OWN_TEXT_LIMIT = 256;
const OWN_TEXT_FORBIDDEN = [" obj", "endobj", "stream", "xref", "trailer", "startxref", "%%EOF"];

/** Go string(utf16.Decode(units)) — хос бус surrogate → U+FFFD. */
function decodeUTF16(units: number[]): string {
  let out = "";
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u >= 0xd800 && u < 0xdc00 && i + 1 < units.length && units[i + 1]! >= 0xdc00 && units[i + 1]! < 0xe000) {
      out += String.fromCodePoint(0x10000 + ((u - 0xd800) << 10) + (units[i + 1]! - 0xdc00));
      i++;
    } else if (u >= 0xd800 && u < 0xe000) out += "�";
    else out += String.fromCharCode(u);
  }
  return out;
}

/** Go-ийн UTF-8 руны давталт (буруу байт бүр нэг U+FFFD). */
export function goUTF8(raw: string): string {
  let out = "";
  const b = (i: number): number => raw.charCodeAt(i);
  for (let i = 0; i < raw.length; ) {
    const c = b(i);
    if (c < 0x80) {
      out += raw[i];
      i++;
      continue;
    }
    let n = 0;
    let cp = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) {
      n = 1;
      cp = c & 0x1f;
    } else if (c >= 0xe0 && c <= 0xef) {
      n = 2;
      cp = c & 0x0f;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 3;
      cp = c & 0x07;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    }
    let ok = n > 0 && i + n < raw.length;
    if (ok) {
      for (let k = 1; k <= n; k++) {
        const x = b(i + k);
        const l = k === 1 ? lo : 0x80;
        const h = k === 1 ? hi : 0xbf;
        if (Number.isNaN(x) || x < l || x > h) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (x & 0x3f);
      }
    }
    if (!ok) {
      out += "�";
      i++;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}

/** PDF text string: BOM-той (FE FF) бол UTF-16BE, эс бөгөөс түүхий байт (Go string — UTF-8 гэж уншина). */
export function pdfTextString(s: PStr): string {
  const raw = s.v;
  if (!raw.startsWith("\xfe\xff")) return goUTF8(raw);
  const units: number[] = [];
  for (let i = 2; i + 1 < raw.length; i += 2) units.push((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
  return decodeUTF16(units);
}

/** v нь digitorus-ийн pdfString-ийн бичдэг хэлбэртэй бичвэр мөн эсэх; тайлсан бичвэрийг буцаана. */
export function ownText(v: PVal, limit: number): string | undefined {
  if (!isStr(v) || v.v.length > limit) return undefined;
  const raw = v.v;
  const utf16be = raw.startsWith("\xfe\xff");
  if (utf16be && raw.length % 2 !== 0) return undefined;
  const text = pdfTextString(v);
  for (const ch of text) {
    const r = ch.codePointAt(0)!;
    if (r < 0x20 || r === 0x7f || (!utf16be && r > 0x7e)) return undefined;
  }
  for (const bad of OWN_TEXT_FORBIDDEN) if (raw.includes(bad) || text.includes(bad)) return undefined;
  return text;
}

/** «Signature N», N = 1…9999 (тэргүүн тэггүй). */
function ownFieldName(s: string): boolean {
  if (!s.startsWith("Signature ")) return false;
  const n = s.slice("Signature ".length);
  return n.length >= 1 && n.length <= 4 && n[0] !== "0" && /^[0-9]*$/.test(n);
}

/** «D:YYYYMMDDHHmmSS±HH'mm'». */
export function ownDate(s: string): boolean {
  if (s.length !== 23 || s.slice(0, 2) !== "D:" || (s[16] !== "+" && s[16] !== "-") || s[19] !== "'" || s[22] !== "'") return false;
  return /^[0-9]*$/.test(s.slice(2, 16) + s.slice(17, 19) + s.slice(20, 22));
}

type Mode = "broad" | "own" | "dssOnly";
const MODE_NUM: Record<Mode, number> = { broad: 0, own: 1, dssOnly: 2 };
const NOTHING: LaterChanges = { signaturesOnly: false, signatures: 0, visible: false };

/** Нэг баримтын бүх гарын үсэгт хуваалцах төлөв: харагдац (эхний N байт) ба алхмын дүнгийн кэш. */
export class Revisions {
  readonly budget: PdfBudget = newPDFBudget();
  private views = new Map<number, PdfView | null>();
  private steps = new Map<string, LaterChanges | null>();
  sigs = new Map<number, SigMeta>();
  docID = "";

  constructor(
    readonly doc: Uint8Array,
    /** Extract-ийн задалж, криптографаар шалгасан гарын үсгүүд: объектын дугаар → ByteRange. */
    readonly known: Map<number, number[]>,
    readonly profile: Profile,
  ) {}

  view(n: number): PdfView | null {
    if (this.views.has(n)) return this.views.get(n)!;
    let v: PdfView | null;
    try {
      v = openView(this.doc.subarray(0, n), this.budget);
    } catch {
      v = null;
    }
    this.views.set(n, v);
    return v;
  }

  /** end (ByteRange-ийн төгсгөл)-ээс хойшхи өөрчлөлтийг ангилна. Алдаа бүр «зөвшөөрөгдөөгүй». */
  async later(end: number): Promise<LaterChanges> {
    try {
      return this.laterSync(end);
    } catch {
      return { ...NOTHING };
    }
  }

  private laterSync(end: number): LaterChanges {
    const n = this.doc.length;
    if (end <= 0 || end >= n) return { ...NOTHING };
    const fin = this.view(n);
    const base = this.view(end);
    if (!fin || !base) return { ...NOTHING };
    const k = fin.sections.length - base.sections.length;
    if (k < 1) return { ...NOTHING };
    const ends = [end];
    for (let i = k - 1; i >= 0; i--) {
      const s = fin.sections[i]!;
      const p = fin.parser(s.end);
      const at = p.startxref();
      let e = p.pos;
      if (i === 0) e = n;
      if (at === undefined || at !== s.off || e <= ends[ends.length - 1]!) return { ...NOTHING };
      ends.push(e);
    }
    const out: LaterChanges = { signaturesOnly: true, signatures: 0, visible: false };
    let sigSteps = 0;
    for (let i = 1; i < ends.length; i++) {
      const hasSig = this.hasSig(ends[i - 1]!, ends[i]!);
      if (hasSig) sigSteps++;
      const st = this.classify(ends[i - 1]!, ends[i]!, true, this.stepMode(hasSig));
      if (!st) return { ...NOTHING };
      out.signatures += st.signatures;
      out.visible = out.visible || st.visible;
    }
    if (k > 1) {
      let mode: Mode = "broad";
      if (sigSteps === k) mode = this.stepMode(true);
      else if (sigSteps === 0) mode = this.stepMode(false);
      const cum = this.classify(ends[0]!, n, false, mode);
      if (!cum || cum.signatures !== out.signatures) return { ...NOTHING };
      out.visible = out.visible || cum.visible;
    }
    return out;
  }

  private stepMode(hasSig: boolean): Mode {
    if (!hasSig) return "dssOnly";
    if (this.profile === "own") return "own";
    return "broad";
  }

  private hasSig(from: number, to: number): boolean {
    const base = this.view(from);
    const fin = this.view(to);
    if (!base || !fin) return true;
    for (const num of this.known.keys()) {
      if (inUse(ent(fin.xref, num)) && !inUse(ent(base.xref, num))) return true;
    }
    return false;
  }

  private classify(from: number, to: number, strict: boolean, mode: Mode): LaterChanges | null {
    const key = `${from},${to},${MODE_NUM[mode] * 2 + (strict ? 1 : 0)}`;
    if (this.steps.has(key)) return this.steps.get(key)!;
    let res: LaterChanges | null = null;
    const base = this.view(from);
    const fin = this.view(to);
    if (base && fin) {
      const c = new Classifier(base, fin, strict, this.known);
      c.sigs = this.sigs;
      c.docID = this.docID;
      c.own = mode === "own";
      c.dssOnly = mode === "dssOnly";
      c.ownProfile = this.profile === "own";
      let ok = true;
      try {
        c.run();
      } catch (e) {
        // Go: алдаа (errNotSignatureOnly, errPDFSyntax, errPDFLimit) → nil. Бусад exception = Go panic → later()-ийн
        // recover (кэшлэгдэхгүй).
        if (!(e instanceof PdfObjError)) throw e;
        ok = false;
      }
      if (ok) res = { signaturesOnly: true, signatures: c.sigDicts.size, visible: c.visible };
    }
    this.steps.set(key, res);
    return res;
  }
}

const ek = (a: number, b: number): string => `${a},${b}`;

function sameExcept(a: PDict | null, b: PDict | null, ...keys: string[]): boolean {
  for (const d of [a, b]) {
    if (!d) continue;
    for (const k of d.keys()) {
      if (!keys.includes(k) && !pdfEqual(dget(a, k), dget(b, k))) return false;
    }
  }
  return true;
}

function onlyKeys(d: PDict | null, ...keys: string[]): boolean {
  if (!d) return true;
  for (const k of d.keys()) if (!keys.includes(k)) return false;
  return true;
}

function sortedKeys(d: PDict | null): string[] {
  return d ? [...d.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)) : [];
}

/** «M.m» (1.0 … 2.9) → M*10+m. */
function pdfVersion(s: string): number | undefined {
  if (s.length !== 3 || s[1] !== "." || (s[0] !== "1" && s[0] !== "2") || s[2]! < "0" || s[2]! > "9") return undefined;
  return (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(2) - 48);
}

function trailerCompatible(base: PDict, later: PDict, infoOmitted: boolean): boolean {
  if (!infoOmitted && !pdfEqual(dget(later, "Info"), dget(base, "Info"))) return false;
  const bid = dget(base, "ID");
  if (isArr(bid) && bid.length === 2 && later.has("ID")) {
    const a = dget(later, "ID");
    if (!isArr(a) || a.length !== 2 || !pdfEqual(a[0]!, bid[0]!)) return false;
  }
  const bsv = dget(base, "Size");
  const bs = isInt(bsv) ? bsv : 0n;
  const ls = dget(later, "Size");
  return isInt(ls) && ls >= bs;
}

const LTV_ROLES = ["catalog", "dss", "vri", "vrient", "ltvarr", "ltv", "info", "metadata"];

export class Classifier {
  readonly end: number;
  own = false;
  dssOnly = false;
  ltvWork = false;
  infoWork = false;
  ownProfile = false;
  rewritten = new Set<number>();
  ownRewrite = new Set<number>();
  root = 0;
  changed = new Set<number>();
  isNew = new Set<number>();
  allowed = new Set<number>();
  exclusive = new Set<number>();
  infra = new Set<number>();
  xrefSelf = new Set<number>();
  edges = new Map<string, number>();
  sigDicts = new Set<number>();
  widgets = new Set<number>();
  role = new Map<number, string>();
  seen = new Set<number>();
  pages = new Set<number>();
  widgetP = new Map<number, number>();
  widgetPage = new Map<number, number>();
  annotsOf = new Map<number, number>();
  fieldNames = new Set<string>();
  visible = false;
  ownVis = new Set<number>();
  sigs = new Map<number, SigMeta>();
  docID = "";
  sigWork = false;

  constructor(
    readonly base: PdfView,
    readonly fin: PdfView,
    readonly strict: boolean,
    readonly known: Map<number, number[]>,
  ) {
    this.end = base.b.length;
  }

  edge(a: number, b: number): void {
    const key = ek(a, b);
    this.edges.set(key, (this.edges.get(key) ?? 0) + 1);
  }

  claim(num: number, role: string): void {
    const r = this.role.get(num);
    if (r !== undefined && r !== role) throw errNotSignatureOnly();
    this.role.set(num, role);
  }

  run(): void {
    this.structure();
    this.diff();
    const refs = this.fin.graph();
    const reach = new Set<number>();
    const queue: number[] = [];
    pdfRefs(this.fin.trailer, (r) => queue.push(r.num));
    while (queue.length > 0) {
      const n = queue.pop()!;
      if (reach.has(n) || !inUse(ent(this.fin.xref, n))) continue;
      reach.add(n);
      queue.push(...(refs.get(n) ?? []));
    }
    for (const n of this.isNew) if (this.strict || reach.has(n)) this.exclusive.add(n);
    let dangling = false;
    const markNew = (r: PRef): void => {
      dangling = dangling || this.isNew.has(r.num);
    };
    pdfRefs(this.base.trailer, markNew);
    for (const [num, e] of this.fin.xref) {
      if (!inUse(e) || this.isNew.has(num)) continue;
      if (this.changed.has(num)) {
        pdfRefs(this.base.get(num), markNew);
      } else {
        for (const to of refs.get(num) ?? []) dangling = dangling || this.isNew.has(to);
      }
    }
    if (dangling) throw errNotSignatureOnly();
    this.catalog();
    for (const p of [...this.pages].sort((a, b) => a - b)) this.page(p);
    for (const n of this.ownRewrite) {
      const r = this.role.get(n);
      if (!this.changed.has(n) || !this.allowed.has(n) || (r !== "page" && r !== "annots")) throw errNotSignatureOnly();
    }
    for (const [w, p] of this.widgetP) {
      const placed = this.widgetPage.has(w);
      const at = this.widgetPage.get(w) ?? 0;
      if ((p !== 0 && (!this.pages.has(p) || (placed && at !== p))) || (this.ownVis.has(w) && (!placed || at !== p))) throw errNotSignatureOnly();
    }
    if (this.dssOnly) this.info();
    for (const n of this.changed) {
      if (!this.allowed.has(n) && !this.infra.has(n) && (this.strict || reach.has(n))) throw errNotSignatureOnly();
      const r = this.role.get(n);
      if (this.own && !this.isNew.has(n) && !(this.allowed.has(n) && (r === "page" || r === "annots"))) throw errNotSignatureOnly();
    }
    if (this.dssOnly) this.dssOnlyRules();
    if (this.own) {
      if (
        !this.isNew.has(this.root) ||
        this.sigDicts.size !== this.widgets.size ||
        this.sigDicts.size === 0 ||
        (this.strict && this.sigDicts.size !== 1) ||
        (this.visible && this.ownVis.size === 0)
      ) {
        throw errNotSignatureOnly();
      }
      for (const n of this.isNew) {
        const r = this.role.get(n) ?? "";
        if (this.strict && !this.xrefSelf.has(n) && r !== "sig" && r !== "field" && r !== "catalog" && (r !== "ap" || this.ownVis.size === 0)) {
          throw errNotSignatureOnly();
        }
      }
    }
    for (const [from, tos] of refs) {
      if ((!this.strict && !reach.has(from)) || this.infra.has(from)) continue;
      const count = new Map<number, number>();
      for (const to of tos) if (this.exclusive.has(to)) count.set(to, (count.get(to) ?? 0) + 1);
      for (const [to, n] of count) if ((this.edges.get(ek(from, to)) ?? 0) !== n) throw errNotSignatureOnly();
    }
    let bad = false;
    for (const [k, v] of this.fin.trailer) {
      if (k !== "Root") pdfRefs(v, (r) => (bad = bad || this.exclusive.has(r.num)));
    }
    if (bad || (this.sigDicts.size === 0 && this.sigWork)) throw errNotSignatureOnly();
  }

  /** xref гинж, trailer, мужийн дараах байтуудын бүрэн хамралт. */
  structure(): void {
    const fs = this.fin.sections;
    const bs = this.base.sections;
    const k = fs.length - bs.length;
    if (k < 1 || (this.strict && k !== 1)) throw errNotSignatureOnly();
    for (let i = 0; i < bs.length; i++) if (fs[k + i]!.off !== bs[i]!.off) throw errNotSignatureOnly();
    const lin = this.fin.parser(0);
    lin.skip();
    let linearized = false;
    try {
      const o = lin.indirect(undefined);
      linearized = isDict(o.val) && dget(o.val, "Linearized") !== null && ifaceEq(dget(o.val, "L"), BigInt(this.fin.b.length));
    } catch {
      // Go: задрахгүй бол алгасна
    }
    if (linearized) throw errNotSignatureOnly();
    const spans: [number, number][] = [];
    for (const s of fs.slice(0, k)) {
      const infoOmitted = this.own && isName(dget(s.trailer, "Type"), "XRef") && dget(s.trailer, "Info") === null;
      if (s.off < this.end || !trailerCompatible(this.base.trailer, s.trailer, infoOmitted)) throw errNotSignatureOnly();
      const p = this.fin.parser(s.end);
      const at = p.startxref();
      if (at === undefined || at !== s.off) throw errNotSignatureOnly();
      spans.push([s.start, p.pos]);
      const keys = ["Size", "Root", "Info", "ID", "Prev"];
      if (this.fin.b[s.start] === 0x78) {
        for (let i = s.start; i < s.end; i++) {
          const c = this.fin.b[i];
          if (c === 0 || c === 0x25) throw errNotSignatureOnly();
        }
      } else {
        keys.push("Type", "W", "Index", "Length", "Filter", "DecodeParms");
        const sp = this.fin.parser(s.start);
        sp.strict = true;
        sp.indirect(undefined);
      }
      if (!onlyKeys(s.trailer, ...keys)) throw errNotSignatureOnly();
      const packed = new Map<number, number>();
      for (const [num, e] of s.ents) {
        if (this.own && e.kind !== ENT_USE) throw errNotSignatureOnly();
        if (this.own && inUse(ent(this.base.xref, num))) this.ownRewrite.add(num);
        if (this.dssOnly && this.ownProfile && inUse(e) && inUse(ent(this.base.xref, num))) this.rewritten.add(num);
        if (e.kind === ENT_USE) {
          const c = this.fin.b[e.off];
          if (e.off < this.end || e.off >= this.fin.b.length || c === undefined || c < 0x30 || c > 0x39) throw errNotSignatureOnly();
          if (e.off === s.start) {
            this.infra.add(num);
            this.xrefSelf.add(num);
            continue;
          }
          const p2 = this.fin.parser(e.off);
          p2.strict = true;
          const o = p2.indirect((r) => this.fin.length(r));
          if (o.num !== num || o.gen !== e.gen) throw errNotSignatureOnly();
          spans.push([e.off, p2.pos]);
        } else if (e.kind === ENT_COMP) {
          const st = ent(this.fin.xref, e.off);
          if (st.kind !== ENT_USE || st.off < this.end) throw errNotSignatureOnly();
          if (this.own) throw errNotSignatureOnly();
          packed.set(e.off, (packed.get(e.off) ?? 0) + 1);
        }
      }
      for (const [stm, n] of packed) {
        if (!this.strict) continue;
        const st = this.fin.objStm(stm);
        if (!s.ents.has(stm) || st.nums.length !== n) throw errNotSignatureOnly();
        for (const off of st.offs) {
          const sp = new PdfParser(st.data, Math.min(st.first + off, st.data.length), this.fin.budget, true);
          sp.value(0);
        }
        this.infra.add(stm);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cur = this.end;
    for (const sp of spans) {
      if (sp[0] < cur || !allGapSpace(this.fin.b.subarray(cur, sp[0]))) throw errNotSignatureOnly();
      cur = sp[1];
    }
    if (!allGapSpace(this.fin.b.subarray(cur))) throw errNotSignatureOnly();
  }

  /** Суурь ба эцсийн xref-ийг харьцуулж changed/isNew-г бөглөнө. */
  diff(): void {
    for (const [num, be] of this.base.xref) {
      if (!inUse(be)) continue;
      if (be.kind === ENT_USE && be.off >= this.end) throw errNotSignatureOnly();
      if (!inUse(ent(this.fin.xref, num))) throw errNotSignatureOnly();
    }
    for (const [num, fe] of this.fin.xref) {
      if (!inUse(fe)) continue;
      const be = ent(this.base.xref, num);
      if (!inUse(be)) {
        this.isNew.add(num);
        this.changed.add(num);
        continue;
      }
      if (entEq(be, fe) && (be.kind === ENT_USE || entEq(ent(this.base.xref, be.off), ent(this.fin.xref, fe.off)))) continue;
      const bo = this.base.get(num);
      const fo = this.fin.get(num);
      const unpack = be.kind === ENT_COMP && fe.kind === ENT_USE && fe.gen === 0 && (this.own || (!this.strict && this.ownProfile && !this.dssOnly));
      if ((be.kind !== fe.kind || be.gen !== fe.gen) && !unpack) throw errNotSignatureOnly();
      if (unpack && pdfEqual(bo, fo)) throw errNotSignatureOnly();
      if (!pdfEqual(bo, fo)) this.changed.add(num);
    }
  }

  /** Эцсийн талын утга fv-г задална; ref бол заасан объект нь шинэ эсвэл суурьт ЯГ энэ байрлалд байсан. */
  container(bv: PVal, fv: PVal, owner: number, role: string): [PVal, number] {
    if (!(fv instanceof PRef)) return [fv, owner];
    if (!this.isNew.has(fv.num) && !ifaceEq(bv, fv)) throw errNotSignatureOnly();
    this.claim(fv.num, role);
    const val = this.fin.deref(fv);
    this.edge(owner, fv.num);
    if (this.changed.has(fv.num)) this.allowed.add(fv.num);
    return [val, fv.num];
  }

  baseDict(v: PVal): PDict | null {
    const o = this.base.resolve(v);
    if (o === null) return null;
    if (!isDict(o)) throw errNotSignatureOnly();
    return o;
  }

  baseArr(v: PVal): PVal[] | null {
    const o = this.base.resolve(v);
    if (o === null) return null;
    if (!isArr(o)) throw errNotSignatureOnly();
    return o;
  }

  catalog(): void {
    const fr = dget(this.fin.trailer, "Root");
    const br = dget(this.base.trailer, "Root");
    if (!isRef(fr) || !isRef(br) || (fr.num !== br.num && !this.isNew.has(fr.num))) throw errNotSignatureOnly();
    const fc = this.fin.deref(fr);
    const bc = this.base.deref(br);
    const except = ["AcroForm", "DSS", "Perms", "Version"];
    if (this.dssOnly) except.push("Extensions", "Metadata");
    if (!isDict(fc) || !isDict(bc) || !sameExcept(bc, fc, ...except)) throw errNotSignatureOnly();
    if (this.own) {
      if (
        !sameExcept(bc, fc, "AcroForm", "Version") ||
        (!pdfEqual(dget(bc, "Version"), dget(fc, "Version")) && (dget(bc, "Version") !== null || !ifaceEq(dget(fc, "Version"), new PName("1.5"))))
      ) {
        throw errNotSignatureOnly();
      }
    }
    this.root = fr.num;
    this.allowed.add(fr.num);
    this.claim(fr.num, "catalog");
    this.pageTree(dget(fc, "Pages"));
    if (!pdfEqual(dget(bc, "Version"), dget(fc, "Version"))) {
      const fvn = dget(fc, "Version");
      const nv = pdfVersion(fvn instanceof PName ? fvn.v : "");
      const bb = this.base.b;
      let head = "";
      for (let i = Math.min(bb.length, 5); i < Math.min(bb.length, 8); i++) head += String.fromCharCode(bb[i]!);
      let floor = pdfVersion(head);
      let ok2 = floor !== undefined;
      if (bc.has("Version")) {
        const bn = dget(bc, "Version");
        const bv = pdfVersion(bn instanceof PName ? bn.v : "");
        ok2 = ok2 && bv !== undefined;
        floor = Math.max(floor ?? 0, bv ?? 0);
      }
      let pfx = "";
      for (let i = 0; i < Math.min(5, bb.length); i++) pfx += String.fromCharCode(bb[i]!);
      if (nv === undefined || !ok2 || pfx !== "%PDF-" || nv < (floor ?? 0)) throw errNotSignatureOnly();
      if (this.dssOnly) this.infoWork = true;
      else this.sigWork = true;
    }
    if (this.dssOnly) {
      this.extensions(dget(bc, "Extensions"), dget(fc, "Extensions"));
      this.metadata(dget(bc, "Metadata"), dget(fc, "Metadata"));
    }
    this.acroForm(dget(bc, "AcroForm"), dget(fc, "AcroForm"));
    if (!pdfEqual(dget(bc, "Perms"), dget(fc, "Perms"))) {
      this.sigWork = true;
      const bpd = this.baseDict(dget(bc, "Perms"));
      const [pv, pn] = this.container(dget(bc, "Perms"), dget(fc, "Perms"), this.root, "perms");
      if (!isDict(pv) || !onlyKeys(pv, "DocMDP", "UR", "UR3")) throw errNotSignatureOnly();
      for (const key of sortedKeys(pv)) {
        const r = dget(pv, key);
        if (!isRef(r) || (!this.sigDicts.has(r.num) && (this.changed.has(r.num) || !ifaceEq(dget(bpd, key), r)))) throw errNotSignatureOnly();
        this.edge(pn, r.num);
      }
    }
    this.dss(dget(bc, "DSS"), dget(fc, "DSS"));
  }

  pageTree(root: PVal): void {
    const stack: PVal[] = [root];
    const visited = new Set<number>();
    while (stack.length > 0) {
      const r = stack.pop()!;
      if (!(r instanceof PRef) || visited.has(r.num)) throw errNotSignatureOnly();
      visited.add(r.num);
      const o = this.fin.deref(r);
      const d = isDict(o) ? o : null;
      const t = dget(d, "Type");
      if (ifaceEq(t, new PName("Page"))) this.pages.add(r.num);
      else if (ifaceEq(t, new PName("Pages"))) {
        const kids = this.fin.resolve(dget(d, "Kids"));
        if (!isArr(kids)) throw errNotSignatureOnly();
        stack.push(...kids);
      } else throw errNotSignatureOnly();
    }
  }

  page(p: number): void {
    const fo = this.fin.get(p);
    if (!isDict(fo) || this.isNew.has(p)) throw errNotSignatureOnly();
    const fd = fo;
    let bd: PDict = fd;
    if (this.changed.has(p)) {
      const bo = this.base.get(p);
      if (!isDict(bo) || !sameExcept(bo, fd, "Annots")) throw errNotSignatureOnly();
      bd = bo;
      this.claim(p, "page");
      this.sigWork = true;
      this.allowed.add(p);
    }
    const ar = dget(fd, "Annots");
    if (!this.changed.has(p) && !(ar instanceof PRef && this.changed.has(ar.num))) return;
    if (ar === null) {
      if (dget(bd, "Annots") !== null) throw errNotSignatureOnly();
      return;
    }
    const ba = this.baseArr(dget(bd, "Annots")) ?? [];
    const [v, anum] = this.container(dget(bd, "Annots"), ar, p, "annots");
    if (!isArr(v)) throw errNotSignatureOnly();
    const fa = v;
    if (anum !== p) {
      if (this.annotsOf.has(anum)) throw errNotSignatureOnly();
      this.annotsOf.set(anum, p);
      if (this.changed.has(anum)) {
        this.sigWork = true;
        this.exclusive.add(anum);
      }
    }
    if (fa.length < ba.length) throw errNotSignatureOnly();
    for (let i = 0; i < fa.length; i++) {
      const e = fa[i]!;
      if (i < ba.length) {
        if (!pdfEqual(ba[i]!, e)) throw errNotSignatureOnly();
        continue;
      }
      const num = e instanceof PRef ? e.num : 0;
      if (!(e instanceof PRef) || !this.widgets.has(num) || this.widgetPage.has(num)) throw errNotSignatureOnly();
      this.widgetPage.set(num, p);
      this.edge(anum, num);
    }
  }

  acroForm(bv: PVal, fv: PVal): void {
    if (fv === null) {
      if (bv !== null) throw errNotSignatureOnly();
      return;
    }
    const bd = this.baseDict(bv);
    const [v, num] = this.container(bv, fv, this.root, "acroform");
    if (!isDict(v) || !sameExcept(bd, v, "Fields", "SigFlags")) throw errNotSignatureOnly();
    const fd = v;
    if (!pdfEqual(dget(bd, "SigFlags"), dget(fd, "SigFlags"))) {
      const nf = dget(fd, "SigFlags");
      const ofv = dget(bd, "SigFlags");
      const was = isInt(ofv);
      const of = was ? ofv : 0n;
      if (!isInt(nf) || (nf !== 1n && nf !== 3n) || (ofv !== null && !was) || nf < of) throw errNotSignatureOnly();
    }
    if (!pdfEqual(dget(bd, "SigFlags"), dget(fd, "SigFlags")) || bd === null) this.sigWork = true;
    if (this.own) {
      if (!isDict(fv) || !isArr(dget(fd, "Fields")) || !ifaceEq(dget(fd, "SigFlags"), 3n)) throw errNotSignatureOnly();
    }
    const bf = this.baseArr(dget(bd, "Fields")) ?? [];
    if (this.own) {
      for (const e of bf) {
        const o = this.base.resolve(e);
        if (!isDict(o) || !(e instanceof PRef)) throw errNotSignatureOnly();
        const t = dget(o, "T");
        if (t instanceof PStr) this.fieldNames.add(pdfTextString(t));
      }
    }
    const [fv2, fnum] = this.container(dget(bd, "Fields"), dget(fd, "Fields"), num, "fields");
    if ((fv2 !== null && !isArr(fv2)) || (isArr(fv2) ? fv2.length : 0) < bf.length) throw errNotSignatureOnly();
    const ff = isArr(fv2) ? fv2 : [];
    for (let i = 0; i < ff.length; i++) {
      const e = ff[i]!;
      if (i < bf.length) {
        if (!pdfEqual(bf[i]!, e)) throw errNotSignatureOnly();
        if (e instanceof PRef && this.changed.has(e.num)) {
          if (this.own) throw errNotSignatureOnly();
          this.filledField(e.num);
        }
      } else if (!(e instanceof PRef)) throw errNotSignatureOnly();
      else this.newField(e, fnum);
    }
  }

  newField(r: PRef, owner: number): void {
    if (!this.isNew.has(r.num) || this.widgets.has(r.num)) throw errNotSignatureOnly();
    const d = this.fin.deref(r);
    if (!isDict(d) || !onlyKeys(d, ...SIG_FIELD_KEYS) || !ifaceEq(dget(d, "FT"), new PName("Sig"))) throw errNotSignatureOnly();
    if (d.has("Type") && !ifaceEq(dget(d, "Type"), new PName("Annot"))) throw errNotSignatureOnly();
    if (d.has("Subtype") && !ifaceEq(dget(d, "Subtype"), new PName("Widget"))) throw errNotSignatureOnly();
    for (const k of ["T", "TU", "M"]) if (d.has(k) && !isStr(dget(d, k))) throw errNotSignatureOnly();
    for (const k of ["F", "Ff"]) if (d.has(k) && !isInt(dget(d, k))) throw errNotSignatureOnly();
    if (this.own) {
      if (d.has("AP")) {
        ownVisible(this, d, r.num);
        this.ownVis.add(r.num);
      } else if (
        !onlyKeys(d, ...OWN_FIELD_KEYS) ||
        !ifaceEq(dget(d, "Type"), new PName("Annot")) ||
        !ifaceEq(dget(d, "Subtype"), new PName("Widget")) ||
        !pdfEqual(dget(d, "Rect"), [0n, 0n, 0n, 0n]) ||
        !ifaceEq(dget(d, "F"), 132n)
      ) {
        throw errNotSignatureOnly();
      }
      const name = ownText(dget(d, "T"), 32);
      if (name === undefined || !ownFieldName(name) || !ifaceEq(dget(d, "T"), new PStr(name)) || this.fieldNames.has(name)) throw errNotSignatureOnly();
      this.fieldNames.add(name);
    }
    this.widgetP.set(r.num, 0);
    if (d.has("P")) {
      const pr = dget(d, "P");
      if (!(pr instanceof PRef)) throw errNotSignatureOnly();
      this.widgetP.set(r.num, pr.num);
    }
    this.claim(r.num, "field");
    this.sigWork = true;
    this.widgets.add(r.num);
    this.allowed.add(r.num);
    this.edge(owner, r.num);
    this.sigValue(dget(d, "V"), r.num);
    this.appearance(null, d, r.num);
  }

  filledField(num: number): void {
    const bd = this.base.get(num);
    const fd = this.fin.get(num);
    if (
      !isDict(bd) ||
      !isDict(fd) ||
      !ifaceEq(dget(bd, "FT"), new PName("Sig")) ||
      dget(bd, "V") !== null ||
      dget(bd, "Kids") !== null ||
      !sameExcept(bd, fd, "V", "AP", "M")
    ) {
      throw errNotSignatureOnly();
    }
    if (bd.has("Type") && !ifaceEq(dget(bd, "Type"), new PName("Annot"))) throw errNotSignatureOnly();
    if (bd.has("Subtype") && !ifaceEq(dget(bd, "Subtype"), new PName("Widget"))) throw errNotSignatureOnly();
    if (fd.has("M") && !isStr(dget(fd, "M"))) throw errNotSignatureOnly();
    this.claim(num, "field");
    this.sigWork = true;
    this.allowed.add(num);
    this.sigValue(dget(fd, "V"), num);
    this.appearance(bd, fd, num);
  }

  sigValue(v: PVal, owner: number): void {
    if (!(v instanceof PRef) || !this.isNew.has(v.num) || this.sigDicts.has(v.num)) throw errNotSignatureOnly();
    const r = v;
    this.claim(r.num, "sig");
    const d = this.fin.deref(r);
    if (!isDict(d) || !onlyKeys(d, ...SIG_DICT_KEYS)) throw errNotSignatureOnly();
    if (this.own && (!onlyKeys(d, ...OWN_SIG_DICT_KEYS) || !ifaceEq(dget(d, "Type"), new PName("Sig")))) throw errNotSignatureOnly();
    if (this.own) {
      if (
        ifaceEq(dget(d, "SubFilter"), new PName("ETSI.CAdES.detached")) &&
        (!onlyKeys(d, ...PADES_SIG_DICT_KEYS) || !ifaceEq(dget(d, "Filter"), new PName("Adobe.PPKLite")) || dget(d, "M") === null)
      ) {
        throw errNotSignatureOnly();
      }
      for (const k of ["Name", "Location", "Reason", "ContactInfo", "M"]) {
        if (!d.has(k)) continue;
        const text = ownText(dget(d, k), OWN_TEXT_LIMIT);
        if (text === undefined || (k === "M" && !ownDate(text))) throw errNotSignatureOnly();
      }
    }
    if (d.has("Type") && !ifaceEq(dget(d, "Type"), new PName("Sig"))) throw errNotSignatureOnly();
    const br = dget(d, "ByteRange");
    if (!isArr(br) || !isStr(dget(d, "Contents")) || br.length !== 4) throw errNotSignatureOnly();
    const n: bigint[] = [];
    for (const x of br) {
      if (!isInt(x)) throw errNotSignatureOnly();
      n.push(x);
    }
    if (n[0] !== 0n || n[1]! <= 0n || n[2]! <= n[1]! || n[3]! < 0n || n[2]! + n[3]! <= BigInt(this.end)) throw errNotSignatureOnly();
    const kb = this.known.get(r.num);
    if (!kb || kb.length !== 4 || kb.some((x, i) => BigInt(x) !== n[i])) throw errNotSignatureOnly();
    let bad = false;
    for (const [k, val] of d) {
      if (k !== "Reference") {
        pdfRefs(val, () => (bad = true));
        continue;
      }
      bad = bad || !isArr(val);
      for (const row of isArr(val) ? val : []) {
        if (!isDict(row) || !onlyKeys(row, "Type", "TransformMethod", "TransformParams", "DigestMethod", "Data")) {
          bad = true;
          continue;
        }
        for (const [rk, rv] of row) {
          if (rk !== "Data") pdfRefs(rv, () => (bad = true));
          else if (rv instanceof PRef && rv.num === this.root) this.edge(r.num, this.root);
          else if (rv instanceof PRef && ifaceEq(rv, dget(this.base.trailer, "Root"))) {
            // суурийн Catalog
          } else bad = true;
        }
      }
    }
    if (bad) throw errNotSignatureOnly();
    this.sigDicts.add(r.num);
    this.allowed.add(r.num);
    this.edge(owner, r.num);
  }

  appearance(base: PDict | null, d: PDict, widget: number): void {
    if (d.has("Rect")) {
      const a = dget(d, "Rect");
      if (!isArr(a) || a.length !== 4) throw errNotSignatureOnly();
      const f: number[] = [];
      for (const x of a) {
        if (isInt(x)) f.push(Number(x));
        else if (x instanceof PReal) f.push(x.v);
        else throw errNotSignatureOnly();
      }
      if (f[0] !== f[2] && f[1] !== f[3]) this.visible = true;
    }
    if (!d.has("AP")) return;
    const ap = dget(d, "AP");
    this.visible = true;
    if (pdfEqual(dget(base, "AP"), ap)) return;
    if (!isDict(ap) || !onlyKeys(ap, "N", "R", "D")) throw errNotSignatureOnly();
    const queue: number[] = [];
    for (const key of sortedKeys(ap)) {
      const r = dget(ap, key);
      if (!(r instanceof PRef) || !this.isNew.has(r.num)) throw errNotSignatureOnly();
      if (!(this.fin.deref(r) instanceof PStream)) throw errNotSignatureOnly();
      this.edge(widget, r.num);
      queue.push(r.num);
    }
    while (queue.length > 0) {
      const n = queue.pop()!;
      if (!this.changed.has(n)) continue;
      if (!this.isNew.has(n) || this.infra.has(n)) throw errNotSignatureOnly();
      this.claim(n, "ap");
      if (this.seen.has(n)) continue;
      this.seen.add(n);
      this.allowed.add(n);
      pdfRefs(this.fin.get(n), (t) => {
        this.edge(n, t.num);
        queue.push(t.num);
      });
    }
  }

  dssNode(bv: PVal, fv: PVal, owner: number, role: string): [PVal, number] {
    const [v, num] = this.container(bv, fv, owner, role);
    if (num !== owner && this.changed.has(num)) {
      this.exclusive.add(num);
      this.ltvWork = true;
    }
    return [v, num];
  }

  baseLTVStreams(bd: PDict | null): Set<number> {
    const out = new Set<number>();
    const add = (d: PDict | null, ...keys: string[]): void => {
      for (const k of keys) {
        for (const e of this.baseArr(dget(d, k)) ?? []) if (e instanceof PRef) out.add(e.num);
      }
    };
    add(bd, "Certs", "OCSPs", "CRLs");
    const vri = this.baseDict(dget(bd, "VRI"));
    for (const e of vri ? vri.values() : []) {
      const ed = this.baseDict(e);
      add(ed, "Cert", "OCSP", "CRL");
      const ts = dget(ed, "TS");
      if (ts instanceof PRef) out.add(ts.num);
    }
    return out;
  }

  dss(bv: PVal, fv: PVal): void {
    if (fv === null) {
      if (bv !== null) throw errNotSignatureOnly();
      return;
    }
    const bd = this.baseDict(bv);
    const old = this.baseLTVStreams(bd);
    const [v, num] = this.dssNode(bv, fv, this.root, "dss");
    if (!isDict(v) || !onlyKeys(v, "Type", "VRI", "Certs", "OCSPs", "CRLs")) throw errNotSignatureOnly();
    const fd = v;
    for (const k of ["Certs", "OCSPs", "CRLs"]) this.ltvArray(dget(bd, k), dget(fd, k), num, old);
    if (dget(fd, "VRI") === null) return;
    const bvri = this.baseDict(dget(bd, "VRI"));
    const [vv, vnum] = this.dssNode(dget(bd, "VRI"), dget(fd, "VRI"), num, "vri");
    if (!isDict(vv)) throw errNotSignatureOnly();
    const fvri = vv;
    for (const key of sortedKeys(fvri)) {
      const bed = this.baseDict(dget(bvri, key));
      const [ev, enumv] = this.dssNode(dget(bvri, key), dget(fvri, key), vnum, "vrient");
      if (!isDict(ev) || !onlyKeys(ev, "Type", "Cert", "OCSP", "CRL", "TU", "TS")) throw errNotSignatureOnly();
      const fed = ev;
      for (const k of ["Cert", "OCSP", "CRL"]) this.ltvArray(dget(bed, k), dget(fed, k), enumv, old);
      if (dget(fed, "TU") !== null && !isStr(dget(fed, "TU"))) throw errNotSignatureOnly();
      if (fed.has("TS")) this.ltvStream(dget(fed, "TS"), enumv, old);
    }
  }

  ltvArray(bv: PVal, fv: PVal, owner: number, old: Set<number>): void {
    if (fv === null) return;
    const [v, num] = this.dssNode(bv, fv, owner, "ltvarr");
    if (!isArr(v)) throw errNotSignatureOnly();
    if (num !== owner) {
      if (this.seen.has(num)) return;
      this.seen.add(num);
    }
    for (const e of v) this.ltvStream(e, num, old);
  }

  ltvStream(v: PVal, owner: number, old: Set<number>): void {
    if (!(v instanceof PRef)) throw errNotSignatureOnly();
    const r = v;
    this.claim(r.num, "ltv");
    this.edge(owner, r.num);
    if (!this.isNew.has(r.num)) {
      if (this.changed.has(r.num) || !old.has(r.num)) throw errNotSignatureOnly();
      return;
    }
    const s = this.fin.deref(r);
    if (!(s instanceof PStream) || !onlyKeys(s.dict, "Length", "Filter", "DecodeParms")) throw errNotSignatureOnly();
    let ok = true;
    pdfRefs(s.dict, () => (ok = false));
    if (!ok) throw errNotSignatureOnly();
    this.allowed.add(r.num);
    this.ltvWork = true;
  }

  dssOnlyRules(): void {
    if (this.sigDicts.size > 0 || this.widgets.size > 0 || this.sigWork || this.visible || ((this.infoWork || this.ownProfile) && !this.ltvWork)) {
      throw errNotSignatureOnly();
    }
    for (const n of this.changed) {
      if (this.infra.has(n) || (!this.strict && !this.allowed.has(n))) continue;
      if (!LTV_ROLES.includes(this.role.get(n) ?? "")) throw errNotSignatureOnly();
    }
    for (const n of this.rewritten) {
      if (!this.changed.has(n) || !this.allowed.has(n) || !LTV_ROLES.includes(this.role.get(n) ?? "")) throw errNotSignatureOnly();
    }
  }

  extensions(bv: PVal, fv: PVal): void {
    if (pdfEqual(bv, fv)) return;
    if (!isDict(fv)) throw errNotSignatureOnly();
    const dev = (x: PVal): boolean => {
      if (!isDict(x) || !onlyKeys(x, "Type", "BaseVersion", "ExtensionLevel", "ExtensionRevision", "URL")) return false;
      if (!(dget(x, "BaseVersion") instanceof PName)) return false;
      if (!isInt(dget(x, "ExtensionLevel"))) return false;
      for (const k of ["ExtensionRevision", "URL"]) if (x.has(k) && !isStr(dget(x, k))) return false;
      if (x.has("Type") && !ifaceEq(dget(x, "Type"), new PName("DeveloperExtensions"))) return false;
      return true;
    };
    for (const [k, v] of fv) {
      if (k === "Type") {
        if (!ifaceEq(v, new PName("Extensions"))) throw errNotSignatureOnly();
        continue;
      }
      if (isArr(v)) {
        for (const e of v) if (!dev(e)) throw errNotSignatureOnly();
      } else if (!dev(v)) throw errNotSignatureOnly();
    }
    this.infoWork = true;
  }

  metadata(bv: PVal, fv: PVal): void {
    if (pdfEqual(bv, fv) && (!(fv instanceof PRef) || !this.changed.has(fv.num))) return;
    if (!(fv instanceof PRef)) throw errNotSignatureOnly();
    const [v, num] = this.container(bv, fv, this.root, "metadata");
    if (
      !(v instanceof PStream) ||
      !onlyKeys(v.dict, "Type", "Subtype", "Length", "Filter", "DecodeParms") ||
      !ifaceEq(dget(v.dict, "Type"), new PName("Metadata")) ||
      !ifaceEq(dget(v.dict, "Subtype"), new PName("XML"))
    ) {
      throw errNotSignatureOnly();
    }
    let bad = false;
    pdfRefs(v.dict, () => (bad = true));
    if (bad) throw errNotSignatureOnly();
    if (this.isNew.has(num)) this.exclusive.add(num);
    this.infoWork = true;
  }

  info(): void {
    const r = dget(this.fin.trailer, "Info");
    if (!(r instanceof PRef) || !this.changed.has(r.num) || this.isNew.has(r.num)) return;
    const d = this.fin.get(r.num);
    if (!isDict(d)) throw errNotSignatureOnly();
    for (const v of d.values()) if (!(v instanceof PStr) && !(v instanceof PName)) throw errNotSignatureOnly();
    this.claim(r.num, "info");
    this.allowed.add(r.num);
    this.infoWork = true;
  }
}
