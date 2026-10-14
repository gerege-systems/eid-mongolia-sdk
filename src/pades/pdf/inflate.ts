// Жижиг синхрон inflate (RFC 1950 zlib + RFC 1951 deflate) — оролтын PDF-ийн object/xref stream-ийг уншихад л.
// Бичихэд шахалт ашиглахгүй (cross-SDK шийдвэр 2026-10-14: runtime-д бичих бүх stream /Filter-гүй).
// DecompressionStream биш: async + эвдэрсэн adler-д унадаг; энд Go-ийн zlib.Reader-тэй адил header шалгаж, adler-ийг
// шаардахгүй (digitorus нь хэрэгтэй байтаа уншаад зогсдог).

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function build(lengths: ArrayLike<number>, n: number): Huff {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!;
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i;
  return { counts, symbols };
}

let fixedLit: Huff | undefined;
let fixedDist: Huff | undefined;

function fixed(): [Huff, Huff] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144);
    l.fill(9, 144, 256);
    l.fill(7, 256, 280);
    l.fill(8, 280, 288);
    fixedLit = build(l, 288);
    fixedDist = build(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

export class InflateError extends Error {}
class Truncated extends InflateError {}

/** zlib (RFC 1950) задлах. `limit` — гаралтын дээд байт. */
export function zlibInflate(src: Uint8Array, limit = 64 << 20): Uint8Array {
  if (src.length < 2) throw new InflateError("zlib: header алга");
  const cmf = src[0]!;
  const flg = src[1]!;
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0) throw new InflateError("zlib: header буруу");
  if (flg & 0x20) throw new InflateError("zlib: preset dictionary");
  return inflateRaw(src.subarray(2), limit);
}

/** Raw deflate (RFC 1951). Төгсгөлийн block хүртэл (дараах байт — adler — үл тоомсорлоно). */
export function inflateRaw(src: Uint8Array, limit = 64 << 20): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.min(limit, Math.max(1024, src.length * 4)));
  let len = 0;

  const need = (n: number): void => {
    if (len + n <= out.length) return;
    if (len + n > limit) throw new InflateError("inflate: хэмжээний хязгаар");
    let cap = out.length * 2;
    while (cap < len + n) cap *= 2;
    const nb = new Uint8Array(Math.min(cap, limit));
    nb.set(out.subarray(0, len));
    out = nb;
  };
  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Truncated("inflate: өгөгдөл дутуу");
      bitBuf |= src[pos++]! << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let l = 1; l < 16; l++) {
      code |= bits(1);
      const count = h.counts[l]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("inflate: код буруу");
  };

  try {
    inflateBlocks();
  } catch (e) {
    // Таслагдсан stream: Go-ийн stream reader шиг тайлсан хэсгийг буцаана (уншигч өөрөө хэмжээг шалгана).
    if (!(e instanceof Truncated)) throw e;
  }
  return out.slice(0, len);

  function inflateBlocks(): void {
  for (;;) {
    const final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new InflateError("inflate: stored header");
      const n = src[pos]! | (src[pos + 1]! << 8);
      const nn = src[pos + 2]! | (src[pos + 3]! << 8);
      pos += 4;
      if ((n ^ 0xffff) !== nn) throw new InflateError("inflate: stored урт");
      if (pos + n > src.length) throw new InflateError("inflate: stored дутуу");
      need(n);
      out.set(src.subarray(pos, pos + n), len);
      len += n;
      pos += n;
    } else if (type === 1 || type === 2) {
      let lit: Huff;
      let dist: Huff;
      if (type === 1) {
        [lit, dist] = fixed();
      } else {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
        const clh = build(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const sym = decode(clh);
          if (sym < 16) {
            lens[i++] = sym;
            continue;
          }
          let rep = 0;
          let val = 0;
          if (sym === 16) {
            if (i === 0) throw new InflateError("inflate: давталт эхэнд");
            val = lens[i - 1]!;
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) throw new InflateError("inflate: урт хэтэрсэн");
          lens.fill(val, i, i + rep);
          i += rep;
        }
        lit = build(lens.subarray(0, hlit), hlit);
        dist = build(lens.subarray(hlit), hdist);
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          need(1);
          out[len++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new InflateError("inflate: урт код");
          const l = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
          const di = decode(dist);
          if (di >= 30) throw new InflateError("inflate: зай код");
          const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
          if (d > len) throw new InflateError("inflate: зай хэтэрсэн");
          need(l);
          for (let k = 0; k < l; k++, len++) out[len] = out[len - d]!;
        }
      }
    } else {
      throw new InflateError("inflate: block төрөл");
    }
    if (final) break;
  }
  }
}
