// Байгууллагын цахим тамга (e-Seal): байгууллагын HSM дэх түлхүүрээр digest тамгална. Интерактив биш (иргэн, PIN, апп
// оролцохгүй) — хариу шууд, session-гүй. RP-д тухайн байгууллагын `SEAL:<orgEtsi>` эрх хэрэгтэй (үгүй бол ForbiddenError
// 403); хэт олон хүсэлтэд 429 → ApiError (`retryable`, `retryAfterMs`).
//
// PDF-ийг тамгалах: `@gerege-systems/eid-mongolia-sdk/pades`-ийн `sealPdf(eid.seal, orgEtsi, pdf)` (PAdES-BASELINE-LT,
// RFC 3161 timestamp заавал). Тамганы гэрчилгээ олгох (`POST /seal/certificate/{orgEtsi}`) энэ хувилбарт алга —
// байгууллагын баталгаажуулалттай олголтын урсгал CA-д нэвтэрмэгц нэмэгдэнэ.

import { X509Certificate } from "node:crypto";
import { RP_ROUTES, SEAL_REQUEST_FIELDS, routePath } from "./contract.js";
import { hashLen } from "./crypto.js";
import { ValidationError } from "./errors.js";
import type { Http } from "./http.js";
import type { CertificateLevel, HashAlgorithm } from "./types.js";
import { verifyPrehashedSignature } from "./validator.js";
import { certExtension, tlv } from "./subject.js";

/** `GET /seal/certificate/{orgEtsi}` (CA `dto.SealCertificateResponse`). */
export interface SealCertificate {
  orgEtsi: string;
  /** DER. */
  certificate: Uint8Array;
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  /** RFC 3339. */
  notBefore: string;
  notAfter: string;
  certificateLevel: CertificateLevel | string;
  /** Серверийн түүхий JSON. */
  raw: unknown;
}

/** `POST /seal/{orgEtsi}` (CA `dto.SealResponse`). */
export interface SealResult {
  orgEtsi: string;
  /** digest дээрх ECDSA гарын үсэг (ASN.1 DER). */
  signature: Uint8Array;
  /** ж: `ecdsa-with-SHA256` (digest-ийн hash-аас). */
  signatureAlgorithm: string;
  /** Тамгалсан гэрчилгээ (DER). */
  certificate: Uint8Array;
  certificateLevel: CertificateLevel | string;
  /** RFC 3339. */
  sealedAt: string;
  raw: unknown;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const b64 = (s: unknown, what: string): Uint8Array => {
  if (typeof s !== "string" || s === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new ValidationError(`seal: ${what} base64 биш эсвэл хоосон`);
  return new Uint8Array(Buffer.from(s, "base64"));
};

/**
 * e-Seal профайл: KeyUsage-д nonRepudiation (contentCommitment) байгаа, digitalSignature байхгүй, EKU байхгүй, CA биш
 * (CA/SDK шалгагчийн `usage: "seal"` ангилалтай ижил; Go `eid.IsSealCertificate`).
 */
export function isSealCertificate(cert: X509Certificate | Uint8Array): boolean {
  let c: X509Certificate;
  try {
    c = cert instanceof X509Certificate ? cert : new X509Certificate(Buffer.from(cert));
  } catch {
    return false;
  }
  if (c.ca || certExtension(c.raw, "2.5.29.37")) return false;
  const v = certExtension(c.raw, "2.5.29.15");
  if (!v) return false;
  const bs = tlv(v, 0, v.length);
  if (bs.tag !== 0x03 || bs.end - bs.start < 2) return false;
  const bits = v[bs.start + 1]!;
  return (bits & 0x40) !== 0 && (bits & 0x80) === 0;
}

export class SealApi {
  constructor(private readonly http: Http) {}

  /** `GET /seal/certificate/{orgEtsi}` — байгууллагын идэвхтэй тамганы гэрчилгээ (PAdES-ийн signerCert). */
  async getCertificate(orgEtsi: string): Promise<SealCertificate> {
    const raw = await this.http.get(routePath(RP_ROUTES.sealCertificate, orgEtsi));
    const r = rec(raw);
    return {
      orgEtsi: String(r.orgEtsi ?? orgEtsi),
      certificate: b64(r.certificate, "certificate"),
      serialNumber: String(r.serialNumber ?? ""),
      subjectDn: String(r.subjectDn ?? ""),
      issuerDn: String(r.issuerDn ?? ""),
      notBefore: String(r.notBefore ?? ""),
      notAfter: String(r.notAfter ?? ""),
      certificateLevel: String(r.certificateLevel ?? ""),
      raw,
    };
  }

  /**
   * `POST /seal/{orgEtsi}` — digest-ийг байгууллагын тамгаар тамгална. `hashAlgorithm`: SHA-256 (анхдагч) | SHA-384 |
   * SHA-512; digest-ийн урт таарахгүй бол сүлжээнд гарахгүй. Хариуны гарын үсгийг хариуны гэрчилгээгээр digest дээр
   * шалгаж, гэрчилгээ e-Seal ({@link isSealCertificate}) эсэхийг тулгана — эс бөгөөс ValidationError. Гинж/цуцлалтыг
   * `sealPdf` (OCSP/CRL) шалгана.
   */
  async seal(orgEtsi: string, digest: Uint8Array, hashAlgorithm: HashAlgorithm = "SHA-256"): Promise<SealResult> {
    if (!["SHA-256", "SHA-384", "SHA-512"].includes(hashAlgorithm)) throw new ValidationError(`seal: дэмжигдээгүй hashAlgorithm ${hashAlgorithm}`);
    if (!(digest instanceof Uint8Array) || digest.length !== hashLen(hashAlgorithm)) {
      throw new ValidationError(`seal: digest нь ${hashAlgorithm}-ийн урт (${hashLen(hashAlgorithm)} байт) байх ёстой`);
    }
    const body: Record<(typeof SEAL_REQUEST_FIELDS)[number], string> = {
      digest: Buffer.from(digest).toString("base64"),
      hashType: hashAlgorithm.replace("-", ""),
    };
    const raw = await this.http.post(routePath(RP_ROUTES.seal, orgEtsi), body);
    const r = rec(raw);
    const sig = rec(r.signature);
    const cert = rec(r.cert);
    const signature = b64(sig.value, "signature.value");
    const certificate = b64(cert.value, "cert.value");
    let x: X509Certificate;
    try {
      x = new X509Certificate(Buffer.from(certificate));
    } catch (e) {
      const err = new ValidationError("seal: cert задарсангүй");
      (err as { cause?: unknown }).cause = e;
      throw err;
    }
    if (!isSealCertificate(x)) throw new ValidationError("seal: хариуны гэрчилгээ e-Seal биш (KeyUsage)");
    if (x.publicKey.asymmetricKeyType !== "ec" || !verifyPrehashedSignature(Buffer.from(digest), String(sig.value), x.publicKey, "ecdsa-with-SHA256", hashAlgorithm)) {
      throw new ValidationError("seal: гарын үсэг digest-тэй таарсангүй");
    }
    return {
      orgEtsi: String(r.orgEtsi ?? orgEtsi),
      signature,
      signatureAlgorithm: String(sig.signatureAlgorithm ?? ""),
      certificate,
      certificateLevel: String(cert.certificateLevel ?? ""),
      sealedAt: String(r.sealedAt ?? ""),
      raw,
    };
  }
}
