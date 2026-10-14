// dss.go-ийн порт: гарын үсэгтэй баримтын ард /DSS revision (хуучин DSS-ийн мөрүүдийг хадгалж, байт-ижил stream-ийг
// заалтаар дахин ашиглана). Шинэ stream-ууд шахалтгүй.

import { concat, latin1, toHex } from "../bytes.js";
import { sha1, sha256 } from "../crypto.js";
import { Incremental } from "./incremental.js";
import { PdfError } from "./reader.js";
import { escapeName, serialize } from "./serialize.js";

export interface DSSData {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
  /** Гарын үсгийн /Contents (hex тайлсан, тэг дүүргэлттэй) — VRI түлхүүр = SHA1 том hex. Хоосон бол VRI бичихгүй. */
  contents: Uint8Array;
}

const MAX_DSS_STREAM = 4 << 20;

export async function appendDSS(signed: Uint8Array, d: DSSData): Promise<Uint8Array> {
  if (d.certs.length + d.ocsps.length + d.crls.length === 0) throw new PdfError("pades: DSS хоосон");
  const inc = new Incremental(signed);
  const root = inc.root();
  const old = root.key("DSS");
  if (!old.isNull() && old.kind() !== "dict") throw new PdfError("/DSS толь биш");
  const known = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const push = (k: string, ref: string): void => {
    const l = lists.get(k) ?? [];
    l.push(ref);
    lists.set(k, l);
  };
  for (const key of ["Certs", "OCSPs", "CRLs"]) {
    const arr = old.key(key);
    const ap = arr.ptr;
    for (let i = 0; i < arr.len(); i++) {
      const e = arr.index(i);
      const ref = serialize(e, ap.id, 0);
      push(key, ref);
      if (e.kind() === "stream") {
        let data: Uint8Array | undefined;
        try {
          data = e.streamData();
        } catch {
          data = undefined;
        }
        if (data) known.set(toHex(await sha256(data.length > MAX_DSS_STREAM ? data.subarray(0, MAX_DSS_STREAM) : data)), ref);
      }
    }
  }
  const vriEntry: string[][] = [[], [], []];
  const add = async (slot: number, key: string, items: Uint8Array[]): Promise<void> => {
    for (const der of items) {
      const sum = toHex(await sha256(der));
      let ref = known.get(sum);
      if (ref === undefined) {
        const body = concat([latin1(`<< /Length ${der.length} >>\nstream\n`), der, latin1("\nendstream")]);
        const [id] = inc.addObject(body);
        ref = `${id} 0 R`;
        known.set(sum, ref);
        push(key, ref);
      }
      if (!vriEntry[slot]!.includes(ref)) vriEntry[slot]!.push(ref);
    }
  };
  await add(0, "Certs", d.certs);
  await add(1, "OCSPs", d.ocsps);
  await add(2, "CRLs", d.crls);

  let dss = "<<";
  for (const key of ["Certs", "OCSPs", "CRLs"]) {
    const l = lists.get(key) ?? [];
    if (l.length > 0) dss += ` /${key} [${l.join(" ")}]`;
  }
  const vri = old.key("VRI");
  if (d.contents.length > 0 || vri.kind() === "dict") {
    dss += " /VRI <<";
    const vp = vri.ptr;
    const newKey = d.contents.length > 0 ? toHex(await sha1(d.contents)).toUpperCase() : "";
    for (const key of vri.keys()) {
      if (key === newKey) continue;
      dss += " /" + escapeName(key) + " " + serialize(vri.key(key), vp.id, 0);
    }
    if (newKey !== "") {
      dss += " /" + newKey + " <<";
      ["Cert", "OCSP", "CRL"].forEach((k, i) => {
        if (vriEntry[i]!.length > 0) dss += ` /${k} [${vriEntry[i]!.join(" ")}]`;
      });
      dss += " >>";
    }
    dss += " >>";
  }
  dss += " >>";
  const [dssID] = inc.addObject(dss);
  let cat = "<<\n  /Type /Catalog\n";
  cat += inc.catalogCopy("DSS");
  cat += `  /DSS ${dssID} 0 R\n>>`;
  const [catID] = inc.addObject(cat);
  return inc.finish(catID);
}
