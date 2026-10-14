// Хамгийн бага DER уншигч/бичигч (X.690). Зөвхөн PAdES-ийн замд хэрэгтэй хэмжээнд.

import { concat, latin1 } from "./bytes.js";

export class Asn1Error extends Error {}

/** Нэг TLV. `raw` — бүтэн TLV, `value` — агуулга. */
export interface Node {
  tag: number;
  raw: Uint8Array;
  value: Uint8Array;
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  ENUMERATED: 0x0a,
  UTF8String: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  PrintableString: 0x13,
  IA5String: 0x16,
  UTCTime: 0x17,
  GeneralizedTime: 0x18,
} as const;

/** `b[off:]`-аас нэг TLV (DER: тодорхой урт, нэг байт tag). */
export function readNode(b: Uint8Array, off = 0): Node {
  if (off + 2 > b.length) throw new Asn1Error("asn1: дутуу");
  const tag = b[off]!;
  if ((tag & 0x1f) === 0x1f) throw new Asn1Error("asn1: олон байт tag дэмжигдэхгүй");
  let len = b[off + 1]!;
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Asn1Error("asn1: урт буруу");
    if (p + n > b.length) throw new Asn1Error("asn1: дутуу");
    if (b[p] === 0) throw new Asn1Error("asn1: урт minimal биш");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i]!;
    if (len < 0x80) throw new Asn1Error("asn1: урт minimal биш");
    p += n;
  }
  if (p + len > b.length) throw new Asn1Error("asn1: дутуу");
  return { tag, raw: b.subarray(off, p + len), value: b.subarray(p, p + len) };
}

/** Ганц TLV, үлдэгдэлгүй. */
export function parseOne(b: Uint8Array): Node {
  const n = readNode(b, 0);
  if (n.raw.length !== b.length) throw new Asn1Error("asn1: илүү өгөгдөл");
  return n;
}

/** Constructed утгын хүүхдүүд. */
export function children(n: Node | Uint8Array): Node[] {
  const v = n instanceof Uint8Array ? n : n.value;
  const out: Node[] = [];
  for (let p = 0; p < v.length; ) {
    const c = readNode(v, p);
    out.push(c);
    p += c.raw.length;
  }
  return out;
}

export function expect(n: Node | undefined, tag: number, what: string): Node {
  if (!n || n.tag !== tag) throw new Asn1Error(`asn1: ${what} хүлээсэн`);
  return n;
}

// ── бичигч ──

function lenBytes(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const out: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) out.unshift(x & 0xff);
  return Uint8Array.from([0x80 | out.length, ...out]);
}

export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const v = concat(content);
  return concat([Uint8Array.of(tag), lenBytes(v.length), v]);
}

export const seq = (...c: Uint8Array[]): Uint8Array => tlv(TAG.SEQUENCE, ...c);
export const set = (...c: Uint8Array[]): Uint8Array => tlv(TAG.SET, ...c);
export const octet = (b: Uint8Array): Uint8Array => tlv(TAG.OCTET_STRING, b);
export const nullDer = (): Uint8Array => Uint8Array.of(0x05, 0x00);
export const ctx = (n: number, constructed: boolean, ...c: Uint8Array[]): Uint8Array => tlv(0x80 | (constructed ? 0x20 : 0) | n, ...c);

/** OID "1.2.3" → DER TLV. */
export function oid(s: string): Uint8Array {
  const parts = s.split(".").map((x) => BigInt(x));
  const body: number[] = [];
  const enc = (v: bigint): void => {
    const tmp: number[] = [Number(v & 0x7fn)];
    for (v >>= 7n; v > 0n; v >>= 7n) tmp.unshift(Number(v & 0x7fn) | 0x80);
    body.push(...tmp);
  };
  enc(parts[0]! * 40n + parts[1]!);
  for (const p of parts.slice(2)) enc(p);
  return tlv(TAG.OID, Uint8Array.from(body));
}

/** OID агуулга → "1.2.3". */
export function oidString(v: Uint8Array): string {
  const out: bigint[] = [];
  let cur = 0n;
  for (const b of v) {
    cur = (cur << 7n) | BigInt(b & 0x7f);
    if (!(b & 0x80)) {
      out.push(cur);
      cur = 0n;
    }
  }
  if (out.length === 0) return "";
  const first = out[0]!;
  const a = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [a, first - a * 40n, ...out.slice(1)].join(".");
}

/** Эерэг/сөрөг бүхэл тоо (big-endian two's complement агуулга) — minimal DER INTEGER. */
export function intFromBig(v: bigint): Uint8Array {
  if (v === 0n) return tlv(TAG.INTEGER, Uint8Array.of(0));
  const bytes: number[] = [];
  if (v > 0n) {
    for (let x = v; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
    if (bytes[0]! & 0x80) bytes.unshift(0);
  } else {
    let x = v;
    for (;;) {
      bytes.unshift(Number(x & 0xffn));
      x >>= 8n;
      if (x === -1n && bytes[0]! & 0x80) break;
    }
  }
  return tlv(TAG.INTEGER, Uint8Array.from(bytes));
}

/** Unsigned big-endian байт → bigint. */
export function bigFromBytes(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** INTEGER агуулга (two's complement) → bigint. */
export function intValue(v: Uint8Array): bigint {
  if (v.length === 0) throw new Asn1Error("asn1: хоосон INTEGER");
  let x = bigFromBytes(v);
  if (v[0]! & 0x80) x -= 1n << BigInt(v.length * 8);
  return x;
}

/** UTCTime/GeneralizedTime → Date (Go encoding/asn1-ийн хүлээн авдаг хэлбэрүүд). */
export function parseTime(n: Node): Date {
  const s = String.fromCharCode(...n.value);
  let m: RegExpExecArray | null;
  if (n.tag === TAG.UTCTime) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})$/.exec(s);
    if (!m) throw new Asn1Error("asn1: UTCTime буруу");
    let y = Number(m[1]);
    y += y < 50 ? 2000 : 1900;
    return mkDate(y, m[2]!, m[3]!, m[4]!, m[5]!, m[6] ?? "00", "", m[7]!);
  }
  if (n.tag === TAG.GeneralizedTime) {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?(Z|[+-]\d{4})$/.exec(s);
    if (!m) throw new Asn1Error("asn1: GeneralizedTime буруу");
    return mkDate(Number(m[1]), m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7] ?? "", m[8]!);
  }
  throw new Asn1Error("asn1: цаг хүлээсэн");
}

/** Секундын бутархайг (нс хүртэл) тусад нь хадгална — Date нь мс нарийвчлалтай. */
export interface PreciseTime {
  date: Date;
  /** Секундын бутархай наносекундээр. */
  nanos: number;
}

export function parsePreciseTime(n: Node): PreciseTime {
  const date = parseTime(n);
  const m = /\.(\d+)/.exec(String.fromCharCode(...n.value));
  const nanos = m ? Number((m[1]! + "000000000").slice(0, 9)) : 0;
  return { date, nanos };
}

function mkDate(y: number, mo: string, d: string, h: string, mi: string, s: string, frac: string, z: string): Date {
  let t = Date.UTC(y, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (frac) t += Math.floor(Number("0" + frac) * 1000);
  if (z !== "Z") {
    const off = (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))) * 60_000;
    t += z[0] === "+" ? -off : off;
  }
  return new Date(t);
}

export const str = (s: string): Uint8Array => latin1(s);
