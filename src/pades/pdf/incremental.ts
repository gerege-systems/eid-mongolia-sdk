// incremental.go-ийн порт: нэг incremental update (revision). Гаралт = base + "\n" + шинэ объектууд + xref + trailer;
// base-ийн байт хэзээ ч өөрчлөгдөхгүй. Xref нь base-ийн сүүлийн хэсэгтэй ижил төрөл (table эсвэл stream); xref stream
// ШАХАЛТГҮЙ (/Filter-гүй — cross-SDK шийдвэр 2026-10-14).

import { ByteWriter, latin1 } from "../bytes.js";
import { PdfError, Reader, Value } from "./reader.js";
import { escapeName, hexString, serialize } from "./serialize.js";

interface Entry {
  id: number;
  gen: number;
  offset: number;
}

export class Incremental {
  readonly rdr: Reader;
  readonly out = new ByteWriter();
  nextID: number;
  private readonly entries: Entry[] = [];
  readonly stream: boolean;

  constructor(base: Uint8Array) {
    const rdr = new Reader(base);
    const tr = rdr.trailerValue();
    if (!tr.key("Encrypt").isNull()) throw new PdfError("шифрлэгдсэн PDF");
    if (tr.key("Root").kind() !== "dict") throw new PdfError("Catalog алга");
    if (rdr.xrefType !== "table" && rdr.xrefType !== "stream") throw new PdfError(`xref төрөл ${rdr.xrefType}`);
    this.rdr = rdr;
    this.stream = rdr.xrefType === "stream";
    let maxID = 0;
    for (const x of rdr.xref) if (x.ptr.id > maxID) maxID = x.ptr.id;
    const size = tr.key("Size").int64();
    if (size <= 0 || size > 1 << 23) throw new PdfError("/Size буруу");
    this.nextID = Math.max(size, maxID + 1);
    this.out.bytes(base);
    this.out.byte(10);
  }

  root(): Value {
    return this.rdr.trailerValue().key("Root");
  }

  reserve(): number {
    return this.nextID++;
  }

  /** Объект бичиж xref-д бүртгэнэ; body-ийн эхлэх байрлал. `body` — latin1 мөр эсвэл байт. */
  writeObject(id: number, body: string | Uint8Array, gen = 0): number {
    this.out.byte(10);
    this.entries.push({ id, gen, offset: this.out.len });
    this.out.str(`${id} ${gen} obj\n`);
    const start = this.out.len;
    this.out.bytes(trimSpace(typeof body === "string" ? latin1(body) : body));
    this.out.str("\nendobj\n");
    return start;
  }

  addObject(body: string | Uint8Array): [number, number] {
    const id = this.reserve();
    return [id, this.writeObject(id, body)];
  }

  finish(root: number): Uint8Array {
    if (this.entries.length === 0) throw new PdfError("pades: шинэ объект алга");
    this.out.byte(10);
    const xrefStart = this.out.len;
    let xid = 0;
    if (this.stream) {
      xid = this.reserve();
      this.entries.push({ id: xid, gen: 0, offset: xrefStart });
    }
    this.entries.sort((a, b) => a.id - b.id); // Go slices.SortFunc (давхардалгүй тул тогтвортой эсэх хамаагүй)
    const runs: [number, number][] = [];
    this.entries.forEach((e, i) => {
      const prev = this.entries[i - 1];
      if (prev && e.id === prev.id) throw new PdfError("pades: объектын дугаар давхардсан");
      if (prev && e.id === prev.id + 1) {
        runs[runs.length - 1]![1]++;
        return;
      }
      runs.push([i, 1]);
    });
    const prev = this.rdr.startXref;
    const tr = this.rdr.trailerValue();
    let extra = "";
    const info = tr.key("Info");
    if (!info.isNull()) {
      const p = info.ptr;
      const tp = tr.ptr;
      if (p.id === tp.id && p.gen === tp.gen) extra += " /Info " + serialize(info, tp.id, 0);
      else extra += ` /Info ${p.id} ${p.gen} R`;
    }
    const idv = tr.key("ID");
    if (idv.kind() === "array" && idv.len() === 2) {
      extra += ` /ID [${hexString(idv.index(0).rawString())} ${hexString(idv.index(1).rawString())}]`;
    }
    if (!this.stream) {
      this.out.str("xref\n");
      for (const [s, n] of runs) {
        this.out.str(`${this.entries[s]!.id} ${n}\n`);
        for (const e of this.entries.slice(s, s + n)) {
          this.out.str(`${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`);
        }
      }
      this.out.str(`trailer\n<< /Size ${this.nextID} /Root ${root} 0 R${extra} /Prev ${prev} >>\nstartxref\n${xrefStart}\n%%EOF\n`);
      return this.out.result();
    }
    const rows = new Uint8Array(this.entries.length * 6);
    this.entries.forEach((e, i) => {
      if (e.offset > 0xffffffff) throw new PdfError("pades: offset 4 байтад багтахгүй");
      if (e.gen > 0xff) throw new PdfError("pades: үеийн дугаар 1 байтад багтахгүй");
      const o = i * 6;
      rows[o] = 1;
      rows[o + 1] = (e.offset >>> 24) & 0xff;
      rows[o + 2] = (e.offset >>> 16) & 0xff;
      rows[o + 3] = (e.offset >>> 8) & 0xff;
      rows[o + 4] = e.offset & 0xff;
      rows[o + 5] = e.gen;
    });
    const index = runs.map(([s, n]) => `${this.entries[s]!.id} ${n}`).join(" ");
    this.out.str(
      `${xid} 0 obj\n<< /Type /XRef /Length ${rows.length} /W [1 4 1] /Prev ${prev} /Size ${this.nextID} /Index [${index}] /Root ${root} 0 R${extra} >>\nstream\n`,
    );
    this.out.bytes(rows);
    this.out.str(`\nendstream\nendobj\nstartxref\n${xrefStart}\n%%EOF\n`);
    return this.out.result();
  }

  /** Catalog-ийн skip-ээс бусад түлхүүрийг "  /Key value\n" хэлбэрээр (digitorus createCatalog). */
  catalogCopy(...skip: string[]): string {
    const root = this.root();
    const rp = root.ptr;
    let s = "";
    for (const key of root.keys()) {
      if (key === "Type" || skip.includes(key)) continue;
      s += `  /${escapeName(key)} ` + serialize(root.key(key), rp.id, 0) + "\n";
    }
    return s;
  }
}

/** Go bytes.TrimSpace (ASCII хэсэг — манай body-д өөр зай үгүй). */
function trimSpace(b: Uint8Array): Uint8Array {
  const ws = (c: number): boolean => c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
  let lo = 0;
  let hi = b.length;
  while (lo < hi && ws(b[lo]!)) lo++;
  while (hi > lo && ws(b[hi - 1]!)) hi--;
  return b.subarray(lo, hi);
}
