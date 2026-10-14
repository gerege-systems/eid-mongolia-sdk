// Баталгаажуулалтын (verify) хуудас — PAGE_SPEC.md (pades-client/1), Go reference pades/internal/core/vpage.go-ийн 1:1
// порт. Content stream шахалтгүй; фонт = тогтмол asset (FontFile2, zlib) — байт-ижил.

import { BOLD, REGULAR, type FontAsset } from "../assets/fonts.js";
import { concat, fromB64, latin1 } from "../bytes.js";
import { Incremental } from "../pdf/incremental.js";
import { PdfError } from "../pdf/reader.js";
import { escapeName, serialize } from "../pdf/serialize.js";
import { qrEncode } from "./qr.js";

export interface PageData {
  brand: string;
  fileName: string;
  documentHash: string;
  fileSize: number;
  docId: string;
  verifyUrl: string;
  trustUrl: string;
  caName: string;
  tsaName: string;
  provider: string;
  /** "mn" (анхдагч, хоосон бол) | "en" — PAGE_SPEC.md §3a. */
  lang: string;
}

interface PageText {
  title: string;
  subtitle: string;
  document: string;
  fileName: string;
  hashAlg: string;
  size: string;
  docHash: string;
  docID: string;
  verification: string;
  scan: string;
  scanHint: string;
  trust: string;
  provider: string;
}

/** PAGE_SPEC.md §3a — тогтмол бичвэр. */
const PAGE_TEXTS: Record<string, PageText> = {
  mn: {
    title: "-аар гарын үсэг зурсан баримт",
    subtitle: "Гарын үсгүүд энэ PDF-д шингэсэн. Доорх холбоосоор эсвэл Adobe Acrobat-ын Signatures самбараар шалгана уу.",
    document: "БАРИМТ",
    fileName: "БАРИМТЫН НЭР",
    hashAlg: "HASH АЛГОРИТМ",
    size: "ХЭМЖЭЭ",
    docHash: "БАРИМТЫН HASH",
    docID: "БАРИМТЫН ID",
    verification: "ШАЛГАХ",
    scan: "Гарын үсгийг шалгах",
    scanHint: "QR кодыг утасны камераар уншуулах эсвэл холбоосыг нээнэ үү.",
    trust: "Adobe Acrobat-д Монгол Улсын үндэсний Root CA-д итгэх заавар:",
    provider: "Үйлчилгээ",
  },
  en: {
    title: " — Electronically signed document",
    subtitle: "Signatures are embedded in this PDF. Verify them with the link below or in Adobe Acrobat's Signatures panel.",
    document: "DOCUMENT",
    fileName: "FILE NAME",
    hashAlg: "HASH ALGORITHM",
    size: "SIZE",
    docHash: "DOCUMENT HASH",
    docID: "DOCUMENT ID",
    verification: "VERIFICATION",
    scan: "Scan to verify",
    scanHint: "Scan this QR code with your phone camera to verify.",
    trust: "Adobe Acrobat: trust the Mongolian National Root CA",
    provider: "Provider",
  },
};

const MEDIA_BOX = "[0 0 595.28 841.89]";
const LEFT = 42;
const WIDTH = 510;
const COL2 = 297;
const QR_MODULE = 2;
const QR_TEXT_X = 136;
const FILE_NAME_MAX = 3;
const C_TEXT = "0.118 0.118 0.118";
const C_MUTED = "0.431 0.431 0.431";
const C_OK = "0.086 0.541 0.31";
const C_BANNER = "0.863 0.961 0.902";
const C_LINE = "0.863 0.863 0.863";
const C_LINK = "0.118 0.431 0.863";
const BANNER =
  "48 800 m\n546 800 l\n549.31 800 552 797.31 552 794 c\n552 754 l\n552 750.69 549.31 748 546 748 c\n" +
  "48 748 l\n44.69 748 42 750.69 42 754 c\n42 794 l\n42 797.31 44.69 800 48 800 c\nh\nf";

interface Font {
  a: FontAsset;
  gid: Map<number, number>;
}

let fonts: [Font, Font] | undefined;
function loadFonts(): [Font, Font] {
  fonts ??= [REGULAR, BOLD].map((a) => ({ a, gid: new Map(a.cmap) })) as [Font, Font];
  return fonts;
}

type Link = [number, number, number, number, string];

class PageWriter {
  ops = "";
  links: Link[] = [];
  constructor(
    private readonly reg: Font,
    private readonly bld: Font,
  ) {}

  op(s: string): void {
    this.ops += s + "\n";
  }

  font(id: number): Font {
    return id === 2 ? this.bld : this.reg;
  }

  gids(id: number, s: string): number[] {
    const f = this.font(id);
    const q = f.gid.get(0x3f) ?? 0;
    return Array.from(s, (ch) => f.gid.get(ch.codePointAt(0)!) ?? q);
  }

  width1000(id: number, size: number, s: string): number {
    if (id === 3) return 600 * Array.from(s).length * size;
    const w = this.font(id).a.widths;
    let sum = 0;
    for (const g of this.gids(id, s)) sum += w[Math.min(g, w.length - 1)]!;
    return sum * size;
  }

  text(id: number, size: number, x: number, y: number, color: string, s: string): void {
    const str =
      id === 3
        ? "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")"
        : "<" + this.gids(id, s).map((g) => g.toString(16).toUpperCase().padStart(4, "0")).join("") + ">";
    this.op(`${color} rg`);
    this.op(`BT /F${id} ${size} Tf ${x} ${y} Td ${str} Tj ET`);
  }

  link(id: number, size: number, x: number, y: number, s: string): void {
    const wd = Math.floor((this.width1000(id, size, s) + 999) / 1000);
    this.links.push([x, y - 3, x + wd, y + size, s]);
  }

  hline(y: number): void {
    this.op(`${C_LINE} RG`);
    this.op(`0.75 w ${LEFT} ${y} m ${LEFT + WIDTH} ${y} l S`);
  }

  wrap(id: number, size: number, s: string, maxW: number, maxLines: number): string[] {
    const limit = maxW * 1000;
    const fits = (t: string): boolean => this.width1000(id, size, t) <= limit;
    const lines: string[] = [];
    let cur = "";
    for (let word of s.split(" ")) {
      if (word === "") continue;
      const cand = cur === "" ? word : cur + " " + word;
      if (fits(cand)) {
        cur = cand;
        continue;
      }
      if (cur !== "") {
        lines.push(cur);
        cur = "";
      }
      while (!fits(word)) {
        const r = Array.from(word);
        let n = 1;
        while (n < r.length && fits(r.slice(0, n + 1).join(""))) n++;
        lines.push(r.slice(0, n).join(""));
        word = r.slice(n).join("");
      }
      cur = word;
    }
    if (cur !== "") lines.push(cur);
    if (lines.length > maxLines) {
      let last = Array.from(lines[maxLines - 1]!);
      while (last.length > 0 && !fits(last.join("") + "…")) last = last.slice(0, -1);
      lines.splice(maxLines - 1, lines.length, last.join("") + "…");
    }
    return lines;
  }
}

export function humanSize(b: number): string {
  const tenths = (unit: number): string => {
    const t = Math.floor((b * 10 + Math.floor(unit / 2)) / unit);
    return `${Math.floor(t / 10)}.${t % 10}`;
  };
  if (b < 1 << 10) return `${b} B`;
  if (b < 1 << 20) return tenths(1 << 10) + " KB";
  if (b < 1 << 30) return tenths(1 << 20) + " MB";
  return tenths(1 << 30) + " GB";
}

function urlHost(u: string): string {
  let s = u.startsWith("https://") ? u.slice(8) : u;
  if (s.startsWith("http://")) s = s.slice(7);
  const i = s.indexOf("/");
  if (i > 0) {
    const next = s.slice(i + 1).indexOf("/");
    if (next > 0) return s.slice(0, i + 1 + next);
  }
  return s;
}

function asciiURL(u: string): boolean {
  if (u === "") return false;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x28 || c === 0x29 || c === 0x5c) return false;
  }
  return true;
}

export function pageContent(p: PageData): { content: string; links: Link[] } {
  if (!asciiURL(p.verifyUrl) || (p.trustUrl !== "" && !asciiURL(p.trustUrl))) throw new PdfError("pades: URL ASCII биш");
  const m = qrEncode(latin1(p.verifyUrl));
  const tx = PAGE_TEXTS[p.lang === "" ? "mn" : p.lang];
  if (!tx) throw new PdfError(`pades: хуудасны хэл ${p.lang}`);
  const [reg, bld] = loadFonts();
  const w = new PageWriter(reg, bld);
  w.op(`${C_BANNER} rg`);
  w.op(BANNER);
  w.text(2, 13, 56, 778, C_OK, p.brand + tx.title);
  w.text(1, 9, 56, 760, C_OK, tx.subtitle);
  let y = 724;
  w.hline(y);
  w.text(2, 11, LEFT, y - 17, C_TEXT, tx.document);
  y -= 34;
  w.text(1, 8, LEFT, y, C_MUTED, tx.fileName);
  y -= 14;
  w.wrap(2, 10, p.fileName, WIDTH, FILE_NAME_MAX).forEach((line, i) => {
    if (i > 0) y -= 14;
    w.text(2, 10, LEFT, y, C_TEXT, line);
  });
  y -= 20;
  w.text(1, 8, LEFT, y, C_MUTED, tx.hashAlg);
  w.text(1, 8, COL2, y, C_MUTED, tx.size);
  w.text(2, 10, LEFT, y - 14, C_TEXT, "SHA256");
  w.text(2, 10, COL2, y - 14, C_TEXT, humanSize(p.fileSize));
  y -= 34;
  w.text(1, 8, LEFT, y, C_MUTED, tx.docHash);
  w.text(3, 9, LEFT, y - 13, C_TEXT, p.documentHash);
  y -= 31;
  w.text(1, 8, LEFT, y, C_MUTED, tx.docID);
  w.text(3, 9, LEFT, y - 13, C_TEXT, p.docId);
  y -= 35;
  w.hline(y);
  w.text(2, 11, LEFT, y - 17, C_TEXT, tx.verification);
  y -= 35;
  w.text(1, 9, LEFT, y, C_LINK, p.verifyUrl);
  w.link(1, 9, LEFT, y, p.verifyUrl);
  y -= 14;
  w.op("0 0 0 rg");
  const n = m.length;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; ) {
      if (!m[r]![c]) {
        c++;
        continue;
      }
      const s = c;
      while (c < n && m[r]![c]) c++;
      w.op(`${LEFT + QR_MODULE * s} ${y - QR_MODULE * (r + 1)} ${QR_MODULE * (c - s)} ${QR_MODULE} re`);
    }
  }
  w.op("f");
  w.text(2, 11, QR_TEXT_X, y - 14, C_TEXT, tx.scan);
  w.text(1, 9, QR_TEXT_X, y - 29, C_MUTED, tx.scanHint);
  w.text(2, 9, QR_TEXT_X, y - 43, C_LINK, urlHost(p.verifyUrl));
  if (p.trustUrl !== "") {
    w.text(1, 9, QR_TEXT_X, y - 60, C_MUTED, tx.trust);
    w.text(2, 9, QR_TEXT_X, y - 74, C_LINK, p.trustUrl);
    w.link(2, 9, QR_TEXT_X, y - 74, p.trustUrl);
  }
  w.hline(71);
  w.text(1, 8, LEFT, 58, C_MUTED, `CA: ${p.caName}  |  TSA: ${p.tsaName}  |  ${tx.provider}: ${p.provider}`);
  return { content: w.ops, links: w.links };
}

/** Content stream мөр (ASCII + glyph hex — бүгд latin1) → байт. */
const asciiBytes = (s: string): Uint8Array => latin1(s);

function streamObj(extra: string, data: Uint8Array): Uint8Array {
  return concat([latin1(`<< /Length ${data.length}${extra} >>\nstream\n`), data, latin1("\nendstream")]);
}

/** base-ийн ард verify хуудсыг incremental update-аар нэмнэ (Catalog өөрчлөгдөхгүй). */
export function appendVerifyPage(base: Uint8Array, p: PageData): Uint8Array {
  const [reg, bld] = loadFonts();
  const { content, links } = pageContent(p);
  const inc = new Incremental(base);
  const root = inc.root();
  const pages = root.key("Pages");
  const pp = pages.ptr;
  const rp = root.ptr;
  if (pages.kind() !== "dict" || pages.key("Type").name() !== "Pages" || (pp.id === rp.id && pp.gen === rp.gen) || pp.id === 0) {
    throw new PdfError("/Pages үндэс алга");
  }
  const count = pages.key("Count").int64();
  if (count < 0 || pages.key("Kids").kind() !== "array") throw new PdfError("/Pages /Kids /Count буруу");
  if (rp.gen !== 0) throw new PdfError("Catalog-ийн үе 0 биш");
  const pageID = inc.reserve();
  const contentID = inc.reserve();
  const fontIDs = [0, 1].map(() => [inc.reserve(), inc.reserve(), inc.reserve(), inc.reserve(), inc.reserve()]) as [number[], number[]];
  const courierID = inc.reserve();
  const linkIDs = links.map(() => inc.reserve());

  let pg = `<< /Type /Page /Parent ${pp.id} ${pp.gen} R /MediaBox ${MEDIA_BOX} /CropBox ${MEDIA_BOX} /Rotate 0 /Resources << /Font << /F1 ${fontIDs[0][0]} 0 R /F2 ${fontIDs[1][0]} 0 R /F3 ${courierID} 0 R >> >> /Contents ${contentID} 0 R`;
  if (linkIDs.length > 0) pg += " /Annots [" + linkIDs.map((id) => `${id} 0 R`).join(" ") + "]";
  pg += " >>";
  inc.writeObject(pageID, pg);
  inc.writeObject(contentID, streamObj("", asciiBytes(content)));
  [reg, bld].forEach((f, i) => writeFont(inc, fontIDs[i]!, f));
  inc.writeObject(courierID, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  links.forEach((l, i) => {
    inc.writeObject(linkIDs[i]!, `<< /Type /Annot /Subtype /Link /Rect [${l[0]} ${l[1]} ${l[2]} ${l[3]}] /Border [0 0 0] /A << /S /URI /URI (${l[4]}) >> >>`);
  });

  let pn = "<<";
  for (const key of pages.keys()) {
    if (key === "Kids" || key === "Count") continue;
    pn += " /" + escapeName(key) + " " + serialize(pages.key(key), pp.id, 0);
  }
  const kids = pages.key("Kids");
  const kp = kids.ptr;
  pn += " /Kids [";
  for (let i = 0; i < kids.len(); i++) pn += serialize(kids.index(i), kp.id, 0) + " ";
  pn += `${pageID} 0 R] /Count ${count + 1} >>`;
  inc.writeObject(pp.id, pn, pp.gen);
  return inc.finish(rp.id);
}

function writeFont(inc: Incremental, ids: number[], f: Font): void {
  const a = f.a;
  inc.writeObject(ids[0]!, `<< /Type /Font /Subtype /Type0 /BaseFont /${a.psName} /Encoding /Identity-H /DescendantFonts [${ids[1]} 0 R] /ToUnicode ${ids[4]} 0 R >>`);
  inc.writeObject(
    ids[1]!,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${a.psName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ids[2]} 0 R /CIDToGIDMap /Identity /W [0 [${a.widths.join(" ")}]] >>`,
  );
  inc.writeObject(
    ids[2]!,
    `<< /Type /FontDescriptor /FontName /${a.psName} /Flags 32 /FontBBox [${a.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${a.ascent} /Descent ${a.descent} /CapHeight ${a.capHeight} /StemV 80 /FontFile2 ${ids[3]} 0 R >>`,
  );
  inc.writeObject(ids[3]!, streamObj(` /Length1 ${a.length1} /Filter /FlateDecode`, fromB64(a.stream)));
  inc.writeObject(ids[4]!, streamObj("", latin1(toUnicode(f))));
}

function toUnicode(f: Font): string {
  const uni = new Map<number, number>();
  for (const [r, g] of f.a.cmap) {
    const old = uni.get(g);
    if (old === undefined || r < old) uni.set(g, r);
  }
  const pairs: [number, number][] = [];
  for (let g = 0; g < f.a.widths.length; g++) {
    const r = uni.get(g);
    if (r !== undefined) pairs.push([g, r]);
  }
  const hx = (n: number): string => n.toString(16).toUpperCase().padStart(4, "0");
  let b =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (let i = 0; i < pairs.length; i += 100) {
    const chunk = pairs.slice(i, i + 100);
    b += `${chunk.length} beginbfchar\n`;
    for (const [g, r] of chunk) b += `<${hx(g)}> <${hx(r)}>\n`;
    b += "endbfchar\n";
  }
  return b + "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
}
