// X.509 subject DN-ийг талбар болгон задлах — иргэний нэр, ETSI (serialNumber), улс.
// Node-ийн `X509Certificate.subject` нь зөвхөн текст (escape-тэй, олон утгатай RDN-ийг нэгтгэдэг) тул DER-ээс
// шууд уншина. Хамгийн бага, хил шалгасан ASN.1 DER уншигч — шинэ хамааралгүй.

import { X509Certificate } from "node:crypto";
import { ValidationError } from "./errors.js";

/** Задалсан subject. Cert-д байхгүй талбар — undefined. Давхардсан OID-ийн эхнийх нь. */
export interface CertSubject {
  /** 2.5.4.42 GIVENNAME. */
  givenName?: string;
  /** 2.5.4.4 SURNAME. */
  surname?: string;
  /** 2.5.4.3 CN. */
  commonName?: string;
  /** 2.5.4.5 SERIALNUMBER — иргэнд ETSI (`PNOMN-<иргэний дугаар>`). */
  serialNumber?: string;
  /** 2.5.4.6 C (ж: "MN"). */
  country?: string;
  /** 2.5.4.10 O. */
  organization?: string;
  /** 2.5.4.97 organizationIdentifier (ж: `NTRMN-…`). */
  organizationIdentifier?: string;
  /** Харуулах нэр: «givenName surname», эс бөгөөс commonName, эс бөгөөс null. */
  name: string | null;
  /** Бүх атрибут, OID → утга (эхний утга). Дээрхээс бусад OID-д. */
  attributes: Record<string, string>;
}

const OIDS = {
  "2.5.4.42": "givenName",
  "2.5.4.4": "surname",
  "2.5.4.3": "commonName",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "country",
  "2.5.4.10": "organization",
  "2.5.4.97": "organizationIdentifier",
} as const;

interface Tlv {
  tag: number;
  start: number; // агуулгын эхлэл
  end: number; // агуулгын төгсгөл (exclusive)
}

/** Нэг TLV — буферийн хилээс гарвал, indefinite/хэт урт length бол ValidationError. */
function tlv(buf: Uint8Array, pos: number, limit: number): Tlv {
  if (pos + 2 > limit) throw new ValidationError("subject: DER толгой богино");
  const tag = buf[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new ValidationError("subject: олон байт tag дэмжигдээгүй");
  let len = buf[pos + 1]!;
  let i = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3) throw new ValidationError("subject: DER урт буруу");
    if (i + n > limit) throw new ValidationError("subject: DER урт богино");
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++]!;
  }
  if (i + len > limit) throw new ValidationError("subject: DER агуулга хилээс гарна");
  return { tag, start: i, end: i + len };
}

function oidOf(buf: Uint8Array, t: Tlv): string {
  if (t.tag !== 0x06 || t.end === t.start) throw new ValidationError("subject: OID биш");
  const parts: number[] = [];
  let v = 0;
  for (let i = t.start; i < t.end; i++) {
    const b = buf[i]!;
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      if (parts.length === 0) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

/** DirectoryString/PrintableString/IA5String/BMPString → JS мөр. Бусад төрөл → undefined. */
function stringOf(buf: Uint8Array, t: Tlv): string | undefined {
  const bytes = buf.subarray(t.start, t.end);
  switch (t.tag) {
    case 0x0c: // UTF8String
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ValidationError("subject: UTF8String буруу UTF-8");
      }
    case 0x13: // PrintableString
    case 0x16: // IA5String
    case 0x14: // TeletexString (латин-1 гэж үзнэ)
      return Buffer.from(bytes).toString("latin1");
    case 0x1e: {
      // BMPString (UTF-16BE) → LE болгож задална
      if (bytes.length % 2) throw new ValidationError("subject: BMPString урт сондгой");
      return Buffer.from(bytes).swap16().toString("utf16le");
    }
    default:
      return undefined;
  }
}

/**
 * Гэрчилгээний subject-ийг задална. `cert` — `X509Certificate`, DER байт, эсвэл base64 DER
 * (session хариуны `certificateDerB64`). Гэмтсэн DER → {@link ValidationError}.
 *
 * (!) Энэ нь зөвхөн задлалт — гэрчилгээнд итгэх эсэхийг `ResponseValidator` шийднэ. Баталгаажаагүй
 * гэрчилгээний нэрэнд бүү итгэ: `validateAuth`/`validateSign`-ийн `parsedSubject`-ийг ашигла.
 */
export function parseSubject(cert: X509Certificate | Uint8Array | string): CertSubject {
  const der =
    cert instanceof X509Certificate ? new Uint8Array(cert.raw) : typeof cert === "string" ? new Uint8Array(Buffer.from(cert, "base64")) : cert;
  const top = tlv(der, 0, der.length); // Certificate
  if (top.tag !== 0x30) throw new ValidationError("subject: Certificate SEQUENCE биш");
  const tbs = tlv(der, top.start, top.end); // tbsCertificate
  if (tbs.tag !== 0x30) throw new ValidationError("subject: tbsCertificate SEQUENCE биш");
  let pos = tbs.start;
  let first = tlv(der, pos, tbs.end);
  if (first.tag === 0xa0) {
    pos = first.end; // [0] EXPLICIT version
    first = tlv(der, pos, tbs.end);
  }
  // serialNumber, signature, issuer, validity → subject (5 дахь)
  let field = first;
  for (let k = 0; k < 4; k++) field = tlv(der, field.end, tbs.end);
  if (field.tag !== 0x30) throw new ValidationError("subject: Name SEQUENCE биш");

  const out: CertSubject = { name: null, attributes: {} };
  for (let sp = field.start; sp < field.end; ) {
    const rdn = tlv(der, sp, field.end);
    if (rdn.tag !== 0x31) throw new ValidationError("subject: RDN SET биш");
    for (let ap = rdn.start; ap < rdn.end; ) {
      const atv = tlv(der, ap, rdn.end);
      if (atv.tag !== 0x30) throw new ValidationError("subject: AttributeTypeAndValue SEQUENCE биш");
      const oidT = tlv(der, atv.start, atv.end);
      const valT = tlv(der, oidT.end, atv.end);
      const oid = oidOf(der, oidT);
      const value = stringOf(der, valT);
      if (value !== undefined && !(oid in out.attributes)) {
        out.attributes[oid] = value;
        const key = OIDS[oid as keyof typeof OIDS];
        if (key) out[key] = value;
      }
      ap = atv.end;
    }
    sp = rdn.end;
  }
  const full = [out.givenName, out.surname].filter((s) => s).join(" ");
  out.name = full || out.commonName || null;
  return out;
}
