// Байтын туслахууд (Node ≥ 18 + хөтөч; Buffer-гүй).

export const enc = new TextEncoder();

/** ASCII/latin1 мөр → байт (тэмдэгт бүр нэг байт). */
export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Байт → latin1 мөр (тэмдэгт бүр нэг байт). */
export function fromLatin1(b: Uint8Array, start = 0, end = b.length): string {
  let s = "";
  for (let i = start; i < end; i += 0x8000) s += String.fromCharCode(...b.subarray(i, Math.min(end, i + 0x8000)));
  return s;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** bytes.Compare. */
export function compare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

const HEX = "0123456789abcdef";

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("hex буруу");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function toB64(b: Uint8Array): string {
  return btoa(fromLatin1(b));
}

export function fromB64(s: string): Uint8Array {
  return latin1(atob(s));
}

/** Хуримтлуулагч (bytes.Buffer). */
export class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  len = 0;

  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** ASCII/latin1 мөр. */
  str(s: string): this {
    this.grow(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len + i] = s.charCodeAt(i) & 0xff;
    this.len += s.length;
    return this;
  }

  byte(x: number): this {
    this.grow(1);
    this.buf[this.len++] = x & 0xff;
    return this;
  }

  /** Хуулбар. */
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
