// Хамгийн бага QR encoder (ISO/IEC 18004) — зөвхөн byte горим, алдаа засах түвшин M, хувилбар 1–40 автоматаар.
// Device link v3 QR-ийг браузерт зурахад (`/button`) — гадны хамааралгүй, node:* импортгүй.
// Алгоритм нь Project Nayuki «QR Code generator»-ийн (MIT) бүтцийг дагасан.

// Түвшин M: блок бүрийн ECC codeword, блокийн тоо (index = хувилбар).
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35,
  37, 38, 40, 43, 45, 47, 49,
];
const FORMAT_BITS_M = 0;

/** QR-ийн модулиуд: `modules[y][x]` — true = хар. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_M[ver]! * BLOCKS_M[ver]!;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j]! ^= r[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((c, i) => (r[i]! ^= gfMul(c, f)));
  }
  return r;
}

/** UTF-8 текстийг QR болгоно. Багтахгүй бол (≈2300 байтаас их) Error. */
export function encodeQr(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ; ver++) {
    if (ver > 40) throw new Error("qr: өгөгдөл хэт урт");
    const bits = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(ver) * 8) break;
  }
  // Бит урсгал: горим (0100) + урт + өгөгдөл + төгсгөл + дүүргэлт.
  const bb: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bb.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bb.length));
  put(0, (8 - (bb.length % 8)) % 8);
  for (let pad = 0xec; bb.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bb.length; i += 8) data.push(parseInt(bb.slice(i, i + 8).join(""), 2));

  // ECC + interleave.
  const nBlocks = BLOCKS_M[ver]!;
  const eccLen = ECC_PER_BLOCK_M[ver]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= nShort) codewords.push(b[i]!);
    });
  }

  const size = ver * 4 + 17;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mod[y]![x] = dark;
    fn[y]![x] = true;
  };

  // Функциональ хэв: timing, finder, alignment, format (түр), version.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align: number[] = [];
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    align.push(6);
    for (let p = size - 7; align.length < n; p -= step) align.splice(1, 0, p);
  }
  const na = align.length;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const bit = (v: number, i: number) => ((v >>> i) & 1) !== 0;
  const drawFormat = (mask: number) => {
    const d = (FORMAT_BITS_M << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  // Codeword-уудыг зигзагаар байрлуулна.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y]![x] && i < codewords.length * 8) {
          mod[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (fn[y]![x]) continue;
        let inv: boolean;
        switch (m) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (inv) mod[y]![x] = !mod[y]![x];
      }
    }
  };

  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = penalty(mod, size);
    if (s < bestScore) {
      best = m;
      bestScore = s;
    }
    applyMask(m); // буцаана (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return { size, modules: mod };
}

// Маскийн торгууль (ISO 18004 §7.8.3): дараалал, 2×2 блок, finder-тэй төстэй хэв, хар/цагааны тэнцвэр.
function penalty(m: boolean[][], size: number): number {
  let s = 0;
  const at = (x: number, y: number, horiz: boolean) => (horiz ? m[y]![x]! : m[x]![y]!);
  for (const horiz of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && at(b, a, horiz) === at(b - 1, a, horiz)) {
          run++;
        } else {
          if (run >= 5) s += run - 2;
          run = 1;
        }
      }
      // 1:1:3:1:1 хэв, нэг талдаа 4 цагаантай.
      for (let b = 0; b + 7 <= size; b++) {
        const p = [1, 0, 1, 1, 1, 0, 1].every((v, k) => at(b + k, a, horiz) === (v === 1));
        if (!p) continue;
        const light = (from: number) => {
          for (let k = from; k < from + 4; k++) if (k >= 0 && k < size && at(k, a, horiz)) return false;
          return true;
        };
        if (light(b - 4) || light(b + 7)) s += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) dark++;
      if (x < size - 1 && y < size - 1) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) s += 3;
      }
    }
  }
  const total = size * size;
  s += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return s;
}

/** QR-ийг SVG `<path d>` болгоно (модуль бүр 1×1; `border` модуль чимэг зай). viewBox = `0 0 size+2·border`. */
export function qrSvgPath(q: QrMatrix, border = 4): string {
  let d = "";
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (q.modules[y]![x]) d += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  return d;
}
