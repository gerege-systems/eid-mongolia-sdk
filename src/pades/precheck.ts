// PRECHECKS.md («хөнгөн» шалгуур, validator-гүй) — Go reference pades/precheck.go-ийн порт. Дараалал, кодууд ижил.

import { TAG, children, oidString, readNode } from "./asn1.js";
import { fromLatin1 } from "./bytes.js";
import { parseSignedData, verifySignedData } from "./cms.js";
import { PdfError, PRef, Reader, Value } from "./pdf/reader.js";
import { checkSignatureFrom, type Certificate } from "./x509.js";

export const MAX_SIGNATURES = 16;
export const VERIFY_URL_PREFIX = "https://ca.eidmongolia.mn/verify/";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PrecheckError extends Error {
  constructor(
    readonly code: "PDF_ENCRYPTED" | "PDF_INVALID" | "PDF_TOO_MANY_SIGNATURES" | "PDF_PRIOR_SIGNATURE_INVALID" | "PDF_LOCKED" | "PDF_FOREIGN_SIGNATURE",
    message: string,
  ) {
    super(message);
  }
}

const ENCRYPT_KEY = /\/Encrypt\s+\d+\s+\d+\s+R/;

function openReader(doc: Uint8Array): Reader | undefined {
  try {
    return new Reader(doc);
  } catch {
    return undefined;
  }
}

/** #4: trailer (xref stream толь)-д /Encrypt; задрахгүй бол файлын байтаас regex. */
export function encrypted(doc: Uint8Array): boolean {
  const r = openReader(doc);
  if (!r) return ENCRYPT_KEY.test(fromLatin1(doc));
  try {
    return !r.trailerValue().key("Encrypt").isNull();
  } catch {
    return false;
  }
}

interface SigDict {
  obj: number;
  byteRange: number[] | undefined;
  subFilter: string;
}

function docMDPP1(sig: Value): boolean {
  const ref = sig.key("Reference");
  for (let i = 0; i < ref.len(); i++) {
    const e = ref.index(i);
    const m = e.key("TransformMethod");
    const p = e.key("TransformParams").key("P");
    if ((m.isNull() || m.name() === "DocMDP") && p.kind() === "int" && p.int64() === 1) return true;
  }
  return false;
}

/** Сүүлийн revision-ий xref-ийн объект бүрээс /ByteRange ба /Contents-тэй толь + DocMDP P=1. */
function scanSignatures(doc: Uint8Array): { sigs: SigDict[]; locked: boolean; hasDSS: boolean } {
  const r = new Reader(doc);
  const root = r.trailerValue().key("Root");
  if (root.kind() !== "dict") throw new PdfError("Catalog алга");
  const hasDSS = root.key("DSS").kind() === "dict";
  let locked = docMDPP1(root.key("Perms").key("DocMDP"));
  const sigs: SigDict[] = [];
  for (const x of r.xref) {
    const v = r.resolve(x.ptr, new PRef(x.ptr.id, x.ptr.gen));
    if (v.kind() !== "dict" || v.key("ByteRange").isNull() || v.key("Contents").isNull()) continue;
    const s: SigDict = { obj: x.ptr.id, byteRange: [], subFilter: v.key("SubFilter").name() };
    const br = v.key("ByteRange");
    for (let i = 0; i < br.len(); i++) {
      const e = br.index(i);
      if (e.kind() !== "int") {
        s.byteRange = undefined;
        break;
      }
      s.byteRange!.push(e.int64());
    }
    if (docMDPP1(v)) locked = true;
    sigs.push(s);
  }
  sigs.sort((a, b) => a.obj - b.obj);
  return { sigs, locked, hasDSS };
}

/** #8: ByteRange, /Contents-ийн эхний SEQUENCE = CMS SignedData (signer ганц), гарын үсэг ByteRange-ийн байт дээр. */
async function checkPriorSignature(doc: Uint8Array, s: SigDict): Promise<{ leaf: Certificate; stamped: boolean }> {
  const br = s.byteRange;
  if (!br || br.length !== 4 || br[0] !== 0 || br[1]! <= 0 || br[2]! <= br[1]! + 1 || br[3]! < 0 || br[2]! + br[3]! > doc.length) {
    throw new Error("ByteRange буруу");
  }
  const [, a, b, c] = br as [number, number, number, number];
  if (doc[a] !== 0x3c || doc[b - 1] !== 0x3e) throw new Error("ByteRange нь /Contents-ийг заахгүй");
  // Гарын үсгийн revision-ий төгсгөл: doc[:b+c]-ийн төгсгөлийн CR/LF-ийг хассаны дараа "%%EOF".
  let end = b + c;
  while (end > 0 && (doc[end - 1] === 10 || doc[end - 1] === 13)) end--;
  if (end < 5 || fromLatin1(doc, end - 5, end) !== "%%EOF") throw new Error("ByteRange нь revision-ий төгсгөл (%%EOF) хүртэл биш");
  if ((b - a - 2) % 2 !== 0) throw new Error("/Contents hex сондгой");
  const hex = fromLatin1(doc, a + 1, b - 1);
  if (/[^0-9a-fA-F]/.test(hex)) throw new Error("/Contents hex");
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.substr(i * 2, 2), 16);
  const der = readNode(raw, 0);
  if (der.tag !== TAG.SEQUENCE) throw new Error("CMS DER биш");
  const sd = parseSignedData(der.raw);
  if (sd.signerInfos.length !== 1) throw new Error("signer ганц биш");
  const sid = children(sd.signerInfos[0]!)[1]!;
  if (sid.tag !== TAG.SEQUENCE) throw new Error("signer cert алга");
  const [iss, ser] = children(sid);
  const leaf = sd.certificates.find((x) => eq(x.rawIssuer, iss!.raw) && eq(x.serial, ser!.value));
  if (!leaf) throw new Error("signer cert алга");
  const signed = new Uint8Array(a + c);
  signed.set(doc.subarray(0, a), 0);
  signed.set(doc.subarray(b, b + c), a);
  if (!(await verifySignedData({ ...sd, content: signed }))) throw new Error("гарын үсэг");
  let stamped = false;
  for (const f of children(sd.signerInfos[0]!)) {
    if (f.tag !== 0xa1) continue;
    for (const at of children(f)) {
      const t = children(at)[0];
      if (t?.tag === TAG.OID && oidString(t.value) === OID_TST) stamped = true;
    }
  }
  return { leaf, stamped };
}

const OID_TST = "1.2.840.113549.1.9.16.2.14";

const eq = (x: Uint8Array, y: Uint8Array): boolean => x.length === y.length && x.every((v, i) => v === y[i]);

async function issuedByAny(leaf: Certificate, issuers: Certificate[]): Promise<boolean> {
  for (const is of issuers) if (eq(leaf.rawIssuer, is.rawSubject) && (await checkSignatureFrom(leaf, is))) return true;
  return false;
}

/** precheck — {newDoc, revIndex}. PDF_ENCRYPTED шалгалтыг дуудагч өмнө нь хийнэ (#4 → #5 дараалал). */
export async function precheck(doc: Uint8Array, issuers: Certificate[]): Promise<{ newDoc: boolean; revIndex: number }> {
  if (encrypted(doc)) throw new PrecheckError("PDF_ENCRYPTED", "шифрлэгдсэн PDF дэмжигдэхгүй");
  let scan: ReturnType<typeof scanSignatures>;
  try {
    scan = scanSignatures(doc);
  } catch (e) {
    throw new PrecheckError("PDF_INVALID", `PDF биш эсвэл эвдэрсэн: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { sigs, locked, hasDSS } = scan;
  if (sigs.length === 0) return { newDoc: true, revIndex: 1 };
  if (sigs.length >= MAX_SIGNATURES) throw new PrecheckError("PDF_TOO_MANY_SIGNATURES", "баримтад хэт олон гарын үсэг байна");
  const leaves: { leaf: Certificate; stamped: boolean }[] = [];
  for (const s of sigs) {
    try {
      leaves.push(await checkPriorSignature(doc, s));
    } catch (e) {
      throw new PrecheckError("PDF_PRIOR_SIGNATURE_INVALID", `өмнөх гарын үсэг хүчингүй: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (locked) throw new PrecheckError("PDF_LOCKED", "баримт certification (DocMDP P=1) гарын үсгээр түгжигдсэн");
  for (let i = 0; i < sigs.length; i++) {
    const l = leaves[i]!;
    if (sigs[i]!.subFilter !== "ETSI.CAdES.detached" || !(await issuedByAny(l.leaf, issuers)) || !l.stamped || !hasDSS) {
      throw new PrecheckError("PDF_FOREIGN_SIGNATURE", "баримтад eID-ийн биш гарын үсэг байна");
    }
  }
  return { newDoc: false, revIndex: sigs.length + 1 };
}

/** Эхний eID гарын үсгийн хуудасны /Link annotation-ийн URI-аас docId. */
export function docIdFromPage(doc: Uint8Array): string {
  try {
    const r = new Reader(doc);
    for (const x of r.xref) {
      const v = r.resolve(x.ptr, new PRef(x.ptr.id, x.ptr.gen));
      if (v.kind() !== "dict" || v.key("Subtype").name() !== "Link") continue;
      const u = fromLatin1(v.key("A").key("URI").rawString());
      if (u.startsWith(VERIFY_URL_PREFIX) && UUID_RE.test(u.slice(VERIFY_URL_PREFIX.length))) return u.slice(VERIFY_URL_PREFIX.length);
    }
  } catch {
    /* Go: recover → "" */
  }
  return "";
}


/** Баримтын нэг гарын үсэг — {@link signatureCMSList}. */
export interface SignatureEntry {
  /** CMS DER (тэг дүүргэлтгүй, ASN.1 уртаар); задрахгүй бол undefined (Go: CMSSHA256 хоосон). */
  cms: Uint8Array | undefined;
  /**
   * ByteRange[2] + ByteRange[3] — гарын үсгийн revision-ий төгсгөл (Go validate SignedEnd); ByteRange буруу/файлаас
   * хэтэрсэн бол undefined. `sha256(doc[0:end])` = CA горим A-ийн `sig_rev_sha256` (`priorRevisionSha256`).
   */
  end: number | undefined;
}

/**
 * Баримтын гарын үсгүүд (CMS + revision-ий төгсгөл) — Go validate.Extract-ийн дараалал (xref/объектын дугаараар,
 * /Type нь алга эсвэл /Sig).
 */
export function signatureCMSList(doc: Uint8Array): SignatureEntry[] {
  const r = new Reader(doc);
  const out: SignatureEntry[] = [];
  for (const x of r.xref) {
    const v = r.resolve(x.ptr, new PRef(x.ptr.id, x.ptr.gen));
    if (v.kind() !== "dict" || v.key("Contents").isNull() || v.key("ByteRange").isNull()) continue;
    const t = v.key("Type").name();
    if (t !== "" && t !== "Sig") continue;
    let cms: Uint8Array | undefined;
    try {
      const n = readNode(v.key("Contents").rawString(), 0);
      cms = n.tag === TAG.SEQUENCE ? n.raw : undefined;
    } catch {
      cms = undefined;
    }
    let end: number | undefined;
    const br = v.key("ByteRange");
    if (br.len() === 4 && br.index(2).kind() === "int" && br.index(3).kind() === "int") {
      const e = br.index(2).int64() + br.index(3).int64();
      if (e > 0 && e <= doc.length) end = e;
    }
    out.push({ cms, end });
  }
  return out;
}
