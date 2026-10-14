// PAGE_SPEC.md §7 QR — Go reference pades/internal/qr/qr.go-ийн 1:1 порт: byte mode, ECC M, хувилбар 1–6, маск ТОГТМОЛ 0.

interface Version {
  ecPerBlock: number;
  blocks: number;
  dataPerBlock: number;
  align: number[];
}

const VERSIONS: Version[] = [
  { ecPerBlock: 0, blocks: 0, dataPerBlock: 0, align: [] },
  { ecPerBlock: 10, blocks: 1, dataPerBlock: 16, align: [] },
  { ecPerBlock: 16, blocks: 1, dataPerBlock: 28, align: [6, 18] },
  { ecPerBlock: 26, blocks: 1, dataPerBlock: 44, align: [6, 22] },
  { ecPerBlock: 18, blocks: 2, dataPerBlock: 32, align: [6, 26] },
  { ecPerBlock: 24, blocks: 2, dataPerBlock: 43, align: [6, 30] },
  { ecPerBlock: 16, blocks: 4, dataPerBlock: 27, align: [6, 34] },
];

const MASK = 0;

/** QR матриц [row][col], true = хар. Quiet zone үгүй. */
export function qrEncode(data: Uint8Array): boolean[][] {
  let ver = 0;
  for (let v = 1; v <= 6; v++) {
    if (4 + 8 + 8 * data.length <= VERSIONS[v]!.blocks * VERSIONS[v]!.dataPerBlock * 8) {
      ver = v;
      break;
    }
  }
  if (ver === 0) throw new Error("qr: өгөгдөл хэт урт (≤ 106 байт)");
  const vi = VERSIONS[ver]!;
  const total = vi.blocks * vi.dataPerBlock;
  const bits: boolean[] = [];
  const put = (v: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push(((v >> i) & 1) === 1);
  };
  put(0b0100, 4);
  put(data.length, 8);
  for (const b of data) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(false);
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) if (bits[i + j]) b |= 1 << (7 - j);
    cw.push(b);
  }
  for (let i = 0; cw.length < total; i++) cw.push(i % 2 === 0 ? 0xec : 0x11);
  const gen = rsGenerator(vi.ecPerBlock);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let b = 0; b < vi.blocks; b++) {
    dataBlocks.push(cw.slice(b * vi.dataPerBlock, (b + 1) * vi.dataPerBlock));
    ecBlocks.push(rsRemainder(dataBlocks[b]!, gen));
  }
  const final: number[] = [];
  for (let i = 0; i < vi.dataPerBlock; i++) for (let b = 0; b < vi.blocks; b++) final.push(dataBlocks[b]![i]!);
  for (let i = 0; i < vi.ecPerBlock; i++) for (let b = 0; b < vi.blocks; b++) final.push(ecBlocks[b]![i]!);
  return place(ver, vi, final);
}

function place(ver: number, vi: Version, final: number[]): boolean[][] {
  const n = 17 + 4 * ver;
  const m = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, dark: boolean): void => {
    m[r]![c] = dark;
    fn[r]![c] = true;
  };
  const finder = (r0: number, c0: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const r of vi.align) {
    for (const c of vi.align) {
      if ((r < 9 && c < 9) || (r < 9 && c > n - 9) || (r > n - 9 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  const f = formatBits((0b00 << 3) | MASK);
  const fb = (i: number): boolean => ((f >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(i, 8, fb(i));
  set(7, 8, fb(6));
  set(8, 8, fb(7));
  set(8, 7, fb(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, fb(i));
  for (let i = 0; i < 8; i++) set(8, n - 1 - i, fb(i));
  for (let i = 8; i < 15; i++) set(n - 15 + i, 8, fb(i));
  set(n - 8, 8, true);
  let bit = 0;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (fn[r]![c]) continue;
        let dark = false;
        if (bit < final.length * 8) dark = ((final[bit >> 3]! >> (7 - (bit % 8))) & 1) === 1;
        bit++;
        if ((r + c) % 2 === 0) dark = !dark;
        m[r]![c] = dark;
      }
    }
    up = !up;
  }
  return m;
}

function formatBits(data: number): number {
  const g = 0x537;
  let v = data << 10;
  for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= g << (i - 10);
  return ((data << 10) | v) ^ 0x5412;
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    g.forEach((c, j) => {
      next[j]! ^= c;
      next[j + 1]! ^= gfMul(c, GF_EXP[i]!);
    });
    g = next;
  }
  return g.slice(1);
}

function rsRemainder(data: number[], gen: number[]): number[] {
  const rem = new Array<number>(gen.length).fill(0);
  for (const d of data) {
    const f = d ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[rem.length - 1] = 0;
    gen.forEach((g, i) => {
      rem[i]! ^= gfMul(g, f);
    });
  }
  return rem;
}
