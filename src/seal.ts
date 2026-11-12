// Байгууллагын цахим тамга (e-Seal): байгууллагын HSM дэх түлхүүрээр digest тамгална. Интерактив биш (иргэн, PIN, апп
// оролцохгүй) — хариу шууд, session-гүй. RP-д тухайн байгууллагын `SEAL:<orgEtsi>` эрх хэрэгтэй (үгүй бол ForbiddenError
// 403); хэт олон хүсэлтэд 429 → ApiError (`retryable`, `retryAfterMs`). Оператор тамгалалт / гэрчилгээ олголтыг унтраасан
// үед 503 `SEAL_SERVICE_DISABLED` → SealServiceDisabledError (`service`, давтахгүй).
//
// PDF-ийг тамгалах: `@gerege-systems/eid-mongolia-sdk/pades`-ийн `sealPdf(eid.seal, orgEtsi, pdf)` (PAdES-BASELINE-LT,
// RFC 3161 timestamp заавал).
//
// Тамганы гэрчилгээ олгох (CA !483, 2026-11-09): `requestCertificate` → 202 PENDING хүсэлт; байгууллагын ADMIN eID аппаараа
// PIN2-оор батална; `getCertificateRequest` / `waitForCertificate`-ээр ISSUED (гэрчилгээтэй) / REJECTED / EXPIRED / FAILED
// хүртэл асууна.

import { X509Certificate } from "node:crypto";
import { RP_ROUTES, SEAL_REQUEST_FIELDS, routePath } from "./contract.js";
import { hashLen } from "./crypto.js";
import { ApiError, SealCertificateRequestError, ValidationError } from "./errors.js";
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
  /** Гэрчилгээнээс өөрөөс нь (QcSSCD байвал `QSCD`, үгүй бол `QUALIFIED`) — CA-ийн одоогийн түлхүүрийн тохиргооноос биш. */
  certificateLevel: CertificateLevel | string;
  /** Серверийн түүхий JSON. */
  raw: unknown;
}

/** Тамганы гэрчилгээний хүсэлтийн төлөв (CA `dto.SealCertificateRequestResponse.status`). */
export type SealCertificateRequestStatus = "PENDING" | "APPROVED" | "ISSUED" | "REJECTED" | "EXPIRED" | "FAILED";

/**
 * `POST /seal/certificate/{orgEtsi}` (202) ба `GET /seal/certificate/{orgEtsi}/requests/{requestId}` (CA
 * `dto.SealCertificateRequestResponse`).
 */
export interface SealCertificateRequest {
  requestId: string;
  orgEtsi: string;
  /** PENDING / APPROVED — хүлээнэ; ISSUED — `certificate` бөглөгдсөн; REJECTED / EXPIRED / FAILED — шинэ хүсэлт. */
  status: SealCertificateRequestStatus | string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339 — батлах хугацааны төгсгөл (дараа нь EXPIRED). */
  expiresAt: string;
  decidedAt?: string;
  /** PIN2 push илгээсэн ADMIN-ийн тоо (шинэ/PENDING хариунд). */
  approvers?: number;
  /**
   * FAILED/EXPIRED үеийн машин код: `EXPIRED` | `SEAL_ISSUANCE_FAILED` | `PUSH_FAILED` | `SEAL_SERVICE_DISABLED` (ADMIN
   * баталсан ч гэрчилгээ олголт унтраалттай байсан — гэрчилгээ гараагүй; олголт асмагц шинэ хүсэлт).
   */
  failure?: string;
  /** ISSUED үед — {@link SealApi.getCertificate}-тэй ижил хэлбэр. */
  certificate?: SealCertificate;
  raw: unknown;
}

/** {@link SealApi.waitForCertificate}-ийн сонголт. */
export interface SealWaitOptions {
  /** Нийт хүлээх дээд хугацаа (мс). Анхдагч {@link DEFAULT_SEAL_WAIT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Poll хоорондын зай (мс). Анхдагч {@link DEFAULT_SEAL_POLL_INTERVAL_MS}; 429/503-ын Retry-After илүү бол түүнийг дагана. */
  intervalMs?: number;
  /** Цуцлах — тасармагц `signal.reason`-ыг шиднэ. */
  signal?: AbortSignal;
}

/** `waitForCertificate`-ийн анхдагч хүлээх хугацаа — CA-ийн батлах цонх (sign session TTL + 2 мин)-оос урт. */
export const DEFAULT_SEAL_WAIT_TIMEOUT_MS = 15 * 60_000;
/** `waitForCertificate`-ийн анхдагч poll зай (CA зөвлөмж 2–5 с). */
export const DEFAULT_SEAL_POLL_INTERVAL_MS = 3_000;

/** `POST /seal/{orgEtsi}` (CA `dto.SealResponse`). */
export interface SealResult {
  orgEtsi: string;
  /** digest дээрх ECDSA гарын үсэг (ASN.1 DER). */
  signature: Uint8Array;
  /** ж: `ecdsa-with-SHA256` (digest-ийн hash-аас). */
  signatureAlgorithm: string;
  /** Тамгалсан гэрчилгээ (DER). */
  certificate: Uint8Array;
  /** Тамгалсан гэрчилгээнээс өөрөөс нь (QcSSCD байвал `QSCD`, үгүй бол `QUALIFIED`). */
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

function parseSealCertificate(raw: unknown, orgEtsi: string): SealCertificate {
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

function parseSealRequest(raw: unknown, orgEtsi: string): SealCertificateRequest {
  const r = rec(raw);
  if (typeof r.requestId !== "string" || r.requestId === "" || typeof r.status !== "string" || r.status === "") {
    throw new ValidationError("seal: хүсэлтийн хариунд requestId/status алга");
  }
  const status = r.status;
  if (status === "ISSUED" && !r.certificate) throw new ValidationError("seal: ISSUED хүсэлтэд certificate алга");
  return {
    requestId: r.requestId,
    orgEtsi: String(r.orgEtsi ?? orgEtsi),
    status,
    createdAt: String(r.createdAt ?? ""),
    expiresAt: String(r.expiresAt ?? ""),
    ...(typeof r.decidedAt === "string" ? { decidedAt: r.decidedAt } : {}),
    ...(typeof r.approvers === "number" ? { approvers: r.approvers } : {}),
    ...(typeof r.failure === "string" && r.failure ? { failure: r.failure } : {}),
    ...(r.certificate ? { certificate: parseSealCertificate(r.certificate, orgEtsi) } : {}),
    raw,
  };
}

/** `ms` хүлээнэ; `signal` тасрахад `signal.reason`-аар reject. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SealApi {
  constructor(private readonly http: Http) {}

  /**
   * `GET /seal/certificate/{orgEtsi}` — байгууллагын одоогийн (хамгийн сүүлд олгогдсон, идэвхтэй) тамганы гэрчилгээ
   * (PAdES-ийн signerCert). Шинээр олгохгүй — олголт {@link requestCertificate}. Идэвхтэй cert алга / цуцлагдсан бол 409.
   */
  async getCertificate(orgEtsi: string): Promise<SealCertificate> {
    return parseSealCertificate(await this.http.get(routePath(RP_ROUTES.sealCertificate, orgEtsi)), orgEtsi);
  }

  /**
   * `POST /seal/certificate/{orgEtsi}` — тамганы гэрчилгээний ХҮСЭЛТ (202, `status: "PENDING"`). Байгууллагын ADMIN
   * төлөөлөгч(ид) eID аппаараа PIN2-оор батална; {@link waitForCertificate} / {@link getCertificateRequest}-ээр асууна.
   * Байгууллагад PENDING хүсэлт байвал CA түүнийг буцаана (шинэ push үгүй). Алдаа: 409 {@link
   * SealApproverUnavailableError} (идэвхтэй төхөөрөмжтэй ADMIN алга), 409 `ApiError` (байгууллага ACTIVE биш), 403
   * `ForbiddenError` (`SEAL:<orgEtsi>` эрхгүй), 404 (байгууллага олдсонгүй), 429 `RATE_LIMITED` (байгууллагад 5/цаг;
   * `retryAfterMs`), 503 {@link SealServiceDisabledError} (`service: "issuance"` — оператор гэрчилгээ олголтыг унтраасан;
   * Retry-After-гүй, давтахгүй).
   */
  async requestCertificate(orgEtsi: string): Promise<SealCertificateRequest> {
    return parseSealRequest(await this.http.post(routePath(RP_ROUTES.sealCertificateRequest, orgEtsi), {}), orgEtsi);
  }

  /**
   * `GET /seal/certificate/{orgEtsi}/requests/{requestId}` — хүсэлтийн төлөв; ISSUED үед `certificate` бөглөгдөнө. Олдоогүй
   * (эсвэл өөр байгууллагынх) → {@link SealRequestNotFoundError} 404.
   */
  async getCertificateRequest(orgEtsi: string, requestId: string): Promise<SealCertificateRequest> {
    const raw = await this.http.get(routePath(RP_ROUTES.sealCertificateRequestStatus, orgEtsi, requestId));
    return parseSealRequest(raw, orgEtsi);
  }

  /**
   * Хүсэлт ISSUED болтол `intervalMs` тутамд асууж олгогдсон гэрчилгээг буцаана. REJECTED / EXPIRED / FAILED →
   * {@link SealCertificateRequestError} (`outcome`, `failure`; шинэ хүсэлт хэрэгтэй); `timeoutMs` дуусвал `outcome:
   * "TIMEOUT"` (хүсэлт серверт PENDING хэвээр — ижил `requestId`-аар дахин хүлээж болно). Түр алдаа (`ApiError.retryable`:
   * 429/503 + Retry-After) — Retry-After-ийг хүлээгээд үргэлжилнэ; бусад алдаа шууд шидэгдэнэ ({@link
   * SealServiceDisabledError} ч мөн — давтахгүй). Хүсэлтийг батлах үед олголт унтраалттай байсан бол `FAILED` +
   * `failure: "SEAL_SERVICE_DISABLED"`.
   */
  async waitForCertificate(orgEtsi: string, requestId: string, opts: SealWaitOptions = {}): Promise<SealCertificate> {
    const interval = opts.intervalMs !== undefined && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_SEAL_POLL_INTERVAL_MS;
    const deadline = Date.now() + (opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SEAL_WAIT_TIMEOUT_MS);
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      let wait = interval;
      try {
        const r = await this.getCertificateRequest(orgEtsi, requestId);
        if (r.status === "ISSUED" && r.certificate) return r.certificate;
        if (r.status === "REJECTED" || r.status === "EXPIRED" || r.status === "FAILED") {
          throw new SealCertificateRequestError(r.status, r.requestId, r.failure);
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.retryable)) throw e;
        wait = Math.max(interval, e.retryAfterMs ?? 0);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SealCertificateRequestError("TIMEOUT", requestId);
      await sleep(Math.min(wait, left), opts.signal);
    }
  }

  /**
   * `POST /seal/{orgEtsi}` — digest-ийг байгууллагын тамгаар тамгална. `hashAlgorithm`: SHA-256 (анхдагч) | SHA-384 |
   * SHA-512; digest-ийн урт таарахгүй бол сүлжээнд гарахгүй. Хариуны гарын үсгийг хариуны гэрчилгээгээр digest дээр
   * шалгаж, гэрчилгээ e-Seal ({@link isSealCertificate}) эсэхийг тулгана — эс бөгөөс ValidationError. Гинж/цуцлалтыг
   * `sealPdf` (OCSP/CRL) шалгана. Оператор тамгалалтыг унтраасан үед 503 {@link SealServiceDisabledError} (`service:
   * "sealing"`; Retry-After-гүй, давтахгүй).
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
