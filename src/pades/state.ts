// State — Go reference pades/state.go-тэй ижил формат: "EIDPADES1" ‖ uint32 BE толгойн урт ‖ JSON толгой ‖ prepared PDF.
// (Нэг SDK-д бэлтгэсэн state-ийг нөгөөд — ж: хөтчид prepare, Go backend-д complete — дуусгаж болно.)

import { concat, enc, fromB64, toB64, toHex } from "./bytes.js";
import { sha256 } from "./crypto.js";
import type { ByteRange } from "./pdf/signature.js";

const MAGIC = enc.encode("EIDPADES1");

export interface PrepState {
  docId: string;
  signerCert: Uint8Array;
  chain: Uint8Array[];
  signedAttrs: Uint8Array;
  byteRange: ByteRange;
  revIndex: number;
  inSha256: string;
  hasPage: boolean;
  pageSha256: string;
  claimedRole: string;
  preparedSha256: string;
  pdf: Uint8Array;
}

export function encodeState(s: PrepState): Uint8Array {
  const head: Record<string, unknown> = {
    docId: s.docId,
    signerCert: toB64(s.signerCert),
    chain: s.chain.map(toB64),
    signedAttrs: toB64(s.signedAttrs),
    byteRange: s.byteRange,
    revIndex: s.revIndex,
    inSha256: s.inSha256,
    hasPage: s.hasPage,
  };
  if (s.pageSha256) head.pageSha256 = s.pageSha256;
  if (s.claimedRole) head.claimedRole = s.claimedRole;
  head.preparedSha256 = s.preparedSha256;
  const h = enc.encode(JSON.stringify(head));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, h.length);
  return concat([MAGIC, len, h, s.pdf]);
}

export async function decodeState(b: Uint8Array): Promise<PrepState> {
  if (b.length < MAGIC.length + 4 || !MAGIC.every((x, i) => b[i] === x)) throw new Error("state-ийн толгой танигдсангүй");
  const n = new DataView(b.buffer, b.byteOffset + MAGIC.length, 4).getUint32(0);
  const off = MAGIC.length + 4;
  if (n > b.length - off) throw new Error("state таслагдсан");
  const j = JSON.parse(new TextDecoder().decode(b.subarray(off, off + n))) as Record<string, unknown>;
  const pdf = b.slice(off + n);
  const str = (k: string): string => (typeof j[k] === "string" ? (j[k] as string) : "");
  const s: PrepState = {
    docId: str("docId"),
    signerCert: fromB64(str("signerCert")),
    chain: Array.isArray(j.chain) ? j.chain.map((x) => fromB64(String(x))) : [],
    signedAttrs: fromB64(str("signedAttrs")),
    byteRange: (Array.isArray(j.byteRange) ? j.byteRange.map(Number) : [0, 0, 0, 0]) as ByteRange,
    revIndex: Number(j.revIndex ?? 0),
    inSha256: str("inSha256"),
    hasPage: j.hasPage === true,
    pageSha256: str("pageSha256"),
    claimedRole: str("claimedRole"),
    preparedSha256: str("preparedSha256"),
    pdf,
  };
  if (toHex(await sha256(pdf)) !== s.preparedSha256) throw new Error("prepared PDF-ийн hash таарахгүй");
  if (s.signedAttrs.length === 0 || s.signerCert.length === 0 || pdf.length === 0 || !(s.revIndex >= 1) || s.byteRange.length !== 4) {
    throw new Error("state дутуу");
  }
  return s;
}
