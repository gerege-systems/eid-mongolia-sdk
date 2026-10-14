// serialize.go-ийн порт: container объект доторх ШУУД утгыг дахин бичнэ, өөр объектын утгыг "N G R" заалтаар үлдээнэ.
// Мөр — hex, нэр — #xx, бодит тоо — exponent-гүй (Go strconv.FormatFloat(f, 'f', -1, 64)).

import { toHex } from "../bytes.js";
import { PdfError, PInt, PName, PReal, PStr, Value } from "./reader.js";

const MAX_DEPTH = 32;

export function serialize(v: Value, container: number, depth = 0): string {
  if (depth > MAX_DEPTH) throw new PdfError("pades: утга хэт гүн давхарласан");
  if (v.isNull()) return "null";
  if (v.ptr.id !== container) return `${v.ptr.id} ${v.ptr.gen} R`;
  const d = v.data;
  if (d instanceof PStr) return hexString(d.b);
  if (typeof d === "boolean") return d ? "true" : "false";
  if (d instanceof PInt) return d.v.toString();
  if (d instanceof PReal) return formatFloat(d.v);
  if (d instanceof PName) return "/" + escapeName(d.n);
  if (d instanceof Map) {
    let s = "<<";
    for (const k of v.keys()) s += " /" + escapeName(k) + " " + serialize(v.key(k), container, depth + 1);
    return s + " >>";
  }
  if (Array.isArray(d)) {
    const parts: string[] = [];
    for (let i = 0; i < v.len(); i++) parts.push(serialize(v.index(i), container, depth + 1));
    return "[" + parts.join(" ") + "]";
  }
  throw new PdfError("pades: шууд stream (эсвэл танихгүй утга) хуулах боломжгүй");
}

/** PDF hex string (<...>), байтыг яг хэвээр (жижиг hex). */
export function hexString(raw: Uint8Array): string {
  return "<" + toHex(raw) + ">";
}

/** Name-ийн regular-биш тэмдэгтийг #xx (том hex) болгоно. Нэр нь latin1 (байт бүр нэг тэмдэгт). */
export function escapeName(n: string): string {
  let s = "";
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i) & 0xff;
    if (c < 0x21 || c > 0x7e || "#()<>[]{}/%".includes(String.fromCharCode(c))) {
      s += "#" + c.toString(16).toUpperCase().padStart(2, "0");
    } else s += String.fromCharCode(c);
  }
  return s;
}

/** Go strconv.FormatFloat(f, 'f', -1, 64): хамгийн богино round-trip цифр, exponent-гүй. */
export function formatFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (!Number.isFinite(f)) return f > 0 ? "+Inf" : "-Inf";
  if (Object.is(f, -0)) return "-0";
  const s = String(f);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, ip, fp = "", es] = m;
  const digits = ip! + fp;
  const point = ip!.length + Number(es);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`.replace(/0+$/, "");
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
