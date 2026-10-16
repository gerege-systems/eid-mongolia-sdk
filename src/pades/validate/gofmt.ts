// Go-ийн тайлангийн утгуудыг (CA /v3/validate/pdf JSON) байт-ижил гаргах туслахууд: time.Time MarshalJSON (RFC3339Nano),
// pkix.Name.String(), big.Int.Text(16), digitorus pdf Value.Text(), JSON-ийн UTF-8 засвар.

import { TAG, children, oidString, readNode, type Node, type PreciseTime } from "../asn1.js";

/** Go time.Time (UTC): секунд (Unix) + наносекунд. Тэг = 0001-01-01T00:00:00Z. */
export interface GoTime {
  /** Unix мс (секундын бүхэл, бутархайгүй) эсвэл undefined — тэг утга. */
  sec?: number;
  nanos: number;
}

export const ZERO_TIME: GoTime = { nanos: 0 };

export function fromPrecise(t: PreciseTime): GoTime {
  return { sec: Math.floor(t.date.getTime() / 1000), nanos: t.nanos };
}

export function fromDate(d: Date): GoTime {
  const ms = d.getTime();
  const sec = Math.floor(ms / 1000);
  return { sec, nanos: (ms - sec * 1000) * 1_000_000 };
}

export const isZero = (t: GoTime): boolean => t.sec === undefined;

/** a < b */
export function before(a: GoTime, b: GoTime): boolean {
  return cmp(a, b) < 0;
}

/** a > b */
export function after(a: GoTime, b: GoTime): boolean {
  return cmp(a, b) > 0;
}

function cmp(a: GoTime, b: GoTime): number {
  const as = a.sec ?? -62135596800;
  const bs = b.sec ?? -62135596800;
  if (as !== bs) return as < bs ? -1 : 1;
  return a.nanos === b.nanos ? 0 : a.nanos < b.nanos ? -1 : 1;
}

/** t + d мс (сөрөг байж болно). */
export function addMs(t: GoTime, ms: number): GoTime {
  const total = (t.sec ?? -62135596800) * 1000 + Math.floor(t.nanos / 1_000_000) + ms;
  const sec = Math.floor(total / 1000);
  return { sec, nanos: (total - sec * 1000) * 1_000_000 + (t.nanos % 1_000_000) };
}

/** Go time.Time.MarshalJSON (UTC): "2006-01-02T15:04:05.999999999Z". */
export function formatTime(t: GoTime): string {
  if (t.sec === undefined) return "0001-01-01T00:00:00Z";
  const d = new Date(t.sec * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  let s = `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  if (t.nanos > 0) s += "." + String(t.nanos).padStart(9, "0").replace(/0+$/, "");
  return s + "Z";
}

/** big.Int.Text(16) томоор (CA hexSerial): INTEGER агуулга → "1A2B". */
export function hexSerial(intContent: Uint8Array): string {
  let neg = intContent.length > 0 && (intContent[0]! & 0x80) !== 0;
  let v = 0n;
  for (const b of intContent) v = (v << 8n) | BigInt(b);
  if (neg) v -= 1n << BigInt(intContent.length * 8);
  neg = v < 0n;
  return (neg ? "-" : "") + (neg ? -v : v).toString(16).toUpperCase();
}

const NO_RUNE = -1;
// digitorus/pdf text.go pdfDocEncoding (PDF 32000-1 Table D.2).
const PDF_DOC: number[] = (() => {
  const t = new Array<number>(256).fill(NO_RUNE);
  t[9] = 9;
  t[10] = 10;
  t[13] = 13;
  [0x02d8, 0x02c7, 0x02c6, 0x02d9, 0x02dd, 0x02db, 0x02da, 0x02dc].forEach((r, i) => (t[0x18 + i] = r));
  for (let i = 0x20; i < 0x7f; i++) t[i] = i;
  [
    0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018, 0x2019, 0x201a, 0x2122,
    0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160, 0x0178, 0x017d, 0x0131, 0x0142, 0x0153, 0x0161, 0x017e, NO_RUNE,
  ].forEach((r, i) => (t[0x80 + i] = r));
  t[0xa0] = 0x20ac;
  for (let i = 0xa1; i <= 0xff; i++) t[i] = i;
  t[0xad] = NO_RUNE;
  return t;
})();

/** digitorus pdf Value.Text(): PDFDocEncoding → UTF-16BE (BOM, тэгш урт) → түүхий байт (Go string). Буцаах нь JSON-д бичигдэх JS string. */
export function pdfText(b: Uint8Array): string {
  const utf16 = b.length >= 2 && b[0] === 0xfe && b[1] === 0xff && b.length % 2 === 0;
  if (!utf16 && b.every((x) => PDF_DOC[x] !== NO_RUNE)) return String.fromCodePoint(...Array.from(b, (x) => PDF_DOC[x]!));
  if (utf16) {
    const u: number[] = [];
    for (let i = 2; i < b.length; i += 2) u.push((b[i]! << 8) | b[i + 1]!);
    return fixSurrogates(String.fromCharCode(...u));
  }
  return goString(b);
}

/** Go utf16.Decode: хосгүй surrogate → U+FFFD. */
export function fixSurrogates(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

/** Түүхий байт (Go string) → JSON-д Go-ийн бичих JS string: хүчингүй UTF-8 байт бүр U+FFFD (encoding/json). */
export function goString(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; ) {
    const [r, n] = decodeRune(b, i);
    out += String.fromCodePoint(r);
    i += n;
  }
  return out;
}

/** Go utf8.DecodeRune: (rune, size); хүчингүй бол (U+FFFD, 1). */
function decodeRune(b: Uint8Array, i: number): [number, number] {
  const c0 = b[i]!;
  if (c0 < 0x80) return [c0, 1];
  const bad: [number, number] = [0xfffd, 1];
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => i + k < b.length && b[i + k]! >= lo && b[i + k]! <= hi;
  if (c0 >= 0xc2 && c0 <= 0xdf) return cont(1) ? [((c0 & 0x1f) << 6) | (b[i + 1]! & 0x3f), 2] : bad;
  if (c0 >= 0xe0 && c0 <= 0xef) {
    const lo = c0 === 0xe0 ? 0xa0 : 0x80;
    const hi = c0 === 0xed ? 0x9f : 0xbf;
    return cont(1, lo, hi) && cont(2) ? [((c0 & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f), 3] : bad;
  }
  if (c0 >= 0xf0 && c0 <= 0xf4) {
    const lo = c0 === 0xf0 ? 0x90 : 0x80;
    const hi = c0 === 0xf4 ? 0x8f : 0xbf;
    return cont(1, lo, hi) && cont(2) && cont(3)
      ? [((c0 & 0x07) << 18) | ((b[i + 1]! & 0x3f) << 12) | ((b[i + 2]! & 0x3f) << 6) | (b[i + 3]! & 0x3f), 4]
      : bad;
  }
  return bad;
}

// ── pkix.Name ──

interface ATV {
  oid: string;
  /** Go asn1-ийн interface{}-д задалсан утга: string (тэмдэгт мөрийн төрлүүд) эсвэл undefined (бусад). */
  str?: string;
  /** Утгын түүхий TLV (string биш үед Go asn1.Marshal-ийн оронд). */
  raw: Node;
}

const ATTR_NAMES: Record<string, string> = {
  "2.5.4.6": "C",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.3": "CN",
  "2.5.4.5": "SERIALNUMBER",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "STREET",
  "2.5.4.17": "POSTALCODE",
};

/** Go encoding/asn1: interface{}-д задлах үед string болох tag-ууд (PrintableString, IA5, T61, UTF8, BMP, NumericString). */
function asn1String(n: Node): string | undefined {
  switch (n.tag) {
    case TAG.PrintableString:
    case TAG.IA5String:
    case 0x12: // NumericString
      return goString(n.value);
    case 0x14: // T61String — Go: байт бүр (ISO-8859-1 биш, шууд string)
      return goString(n.value);
    case TAG.UTF8String:
      return goString(n.value);
    case 0x1e: {
      // BMPString — Go parseBMPString (UCS-2 → UTF-8); сондгой урт → алдаа
      if (n.value.length % 2 !== 0) return undefined;
      const u: number[] = [];
      for (let i = 0; i < n.value.length; i += 2) u.push((n.value[i]! << 8) | n.value[i + 1]!);
      if (u.length > 0 && u[u.length - 1] === 0) u.pop();
      return fixSurrogates(String.fromCharCode(...u));
    }
  }
  return undefined;
}

function rdns(name: Node): ATV[][] {
  return children(name).map((rdn) =>
    children(rdn).map((atv) => {
      const [t, v] = children(atv);
      return { oid: oidString(t!.value), str: asn1String(v!), raw: v! };
    }),
  );
}

/** Go asn1.Marshal(string): PrintableString (зөвшөөрөгдсөн тэмдэгт) эсвэл UTF8String. */
function marshalString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const printable = [...s].every((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || " '()+,-./:=?".includes(ch)
    );
  });
  const tag = printable ? TAG.PrintableString : TAG.UTF8String;
  const len = bytes.length;
  const hdr = len < 0x80 ? [tag, len] : len < 0x100 ? [tag, 0x81, len] : [tag, 0x82, len >> 8, len & 0xff];
  const out = new Uint8Array(hdr.length + len);
  out.set(hdr, 0);
  out.set(bytes, hdr.length);
  return out;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Go pkix.Name.String() (задалсан гэрчилгээний Subject/Issuer: ExtraNames nil). */
export function nameString(rawName: Uint8Array): string {
  const seq = rdns(readNode(rawName, 0));
  // FillFromRDNSequence: string утгатай мэдэгдэх төрлүүдийг талбарт.
  const f: Record<string, string[]> = { C: [], ST: [], L: [], STREET: [], POSTALCODE: [], O: [], OU: [] };
  let cn = "";
  let sn = "";
  const all: ATV[] = [];
  for (const rdn of seq) {
    for (const a of rdn) {
      all.push(a);
      if (a.str === undefined) continue;
      switch (a.oid) {
        case "2.5.4.3":
          cn = a.str;
          break;
        case "2.5.4.5":
          sn = a.str;
          break;
        case "2.5.4.6":
          f.C!.push(a.str);
          break;
        case "2.5.4.7":
          f.L!.push(a.str);
          break;
        case "2.5.4.8":
          f.ST!.push(a.str);
          break;
        case "2.5.4.9":
          f.STREET!.push(a.str);
          break;
        case "2.5.4.17":
          f.POSTALCODE!.push(a.str);
          break;
        case "2.5.4.10":
          f.O!.push(a.str);
          break;
        case "2.5.4.11":
          f.OU!.push(a.str);
          break;
      }
    }
  }
  const out: { oid: string; str?: string; raw?: Node }[][] = [];
  const skip = new Set(["2.5.4.3", "2.5.4.5", "2.5.4.6", "2.5.4.7", "2.5.4.8", "2.5.4.9", "2.5.4.10", "2.5.4.11", "2.5.4.17"]);
  for (const a of all) if (!skip.has(a.oid)) out.push([a]);
  const add = (vals: string[], oid: string): void => {
    if (vals.length > 0) out.push(vals.map((v) => ({ oid, str: v })));
  };
  add(f.C!, "2.5.4.6");
  add(f.ST!, "2.5.4.8");
  add(f.L!, "2.5.4.7");
  add(f.STREET!, "2.5.4.9");
  add(f.POSTALCODE!, "2.5.4.17");
  add(f.O!, "2.5.4.10");
  add(f.OU!, "2.5.4.11");
  if (cn) add([cn], "2.5.4.3");
  if (sn) add([sn], "2.5.4.5");
  let s = "";
  for (let i = 0; i < out.length; i++) {
    const rdn = out[out.length - 1 - i]!;
    if (i > 0) s += ",";
    rdn.forEach((tv, j) => {
      if (j > 0) s += "+";
      const typeName = ATTR_NAMES[tv.oid];
      if (!typeName) {
        // Go: asn1.Marshal(tv.Value) — string бол дахин кодлоно, бусад (RawValue биш, задалсан утга) — түүхий TLV.
        const der = tv.str !== undefined ? marshalString(tv.str) : tv.raw!.raw;
        s += `${tv.oid}=#${toHex(der)}`;
        return;
      }
      const v = tv.str ?? "";
      const chars = [...v];
      let byteIdx = 0;
      const lastByte = new TextEncoder().encode(v).length - 1;
      let esc = "";
      for (const c of chars) {
        let e = false;
        if (",+\"\\<>;".includes(c)) e = true;
        else if (c === " ") e = byteIdx === 0 || byteIdx === lastByte;
        else if (c === "#") e = byteIdx === 0;
        esc += e ? "\\" + c : c;
        byteIdx += new TextEncoder().encode(c).length;
      }
      s += `${typeName}=${esc}`;
    });
  }
  return s;
}

/** Go pkix.Name.CommonName (сүүлийн string CN). */
export function commonName(rawName: Uint8Array): string {
  let cn = "";
  for (const rdn of rdns(readNode(rawName, 0))) for (const a of rdn) if (a.oid === "2.5.4.3" && a.str !== undefined) cn = a.str;
  return cn;
}

/** eidcrypto.SubjectNames: Subject.Names-ийн GIVENNAME (2.5.4.42) ба SURNAME (2.5.4.4) — сүүлийнх; string биш бол "". */
export function subjectNames(rawSubject: Uint8Array): { given: string; surname: string } {
  let given = "";
  let surname = "";
  for (const rdn of rdns(readNode(rawSubject, 0))) {
    for (const a of rdn) {
      if (a.oid === "2.5.4.42") given = a.str ?? "";
      if (a.oid === "2.5.4.4") surname = a.str ?? "";
    }
  }
  return { given, surname };
}

/** Go pkix.Name.SerialNumber (сүүлийн string SERIALNUMBER). */
export function subjectSerialNumber(rawSubject: Uint8Array): string {
  let sn = "";
  for (const rdn of rdns(readNode(rawSubject, 0))) for (const a of rdn) if (a.oid === "2.5.4.5" && a.str !== undefined) sn = a.str;
  return sn;
}
