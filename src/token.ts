// Иргэний USB токен (PKCS#11, EC P-256):
//   - гэрчилгээ олголт (CA docs/TOKEN_CERT.md, RP-д TOKEN_ISSUE + SIGN эрх): issueCertificate → иргэн утсаараа PIN2-оор
//     батална → session.poll (`tokenCertificate.status` = ISSUED) → certificateResult → verifyTokenCertificates;
//   - токеноор нэвтрэлт (docs/TOKEN_AUTH.md, AUTH эрх): authChallenge → токен tokenAuthDigest-ийг CKM_ECDSA-аар зурна
//     (түүхий r||s) → authVerify.
// Алдаа: `ApiError.code` (TOKEN_LIMIT_REACHED → tokenLimitOf, CHALLENGE_EXPIRED, CERT_INVALID …); түр алдаа
// (RATE_LIMITED, STATE_UNAVAILABLE, ISSUANCE_PENDING) — `retryable` + `retryAfterMs`.

import { X509Certificate, createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { RP_ROUTES, routePath } from "./contract.js";
import { ApiError, ValidationError } from "./errors.js";
import type { Http } from "./http.js";
import type { TokenOrganization } from "./person.js";
import { parseSubject, tlv } from "./subject.js";
import type { RpCredentials } from "./types.js";

export interface TokenCertInput {
  /** Иргэн (PNOMN-…) — батлах push түүний утсанд очно. */
  signerEtsi: string;
  /** PKCS#10 DER (EC P-256, ecdsa-with-SHA256, өөр өөр түлхүүр, ≤ 4 KiB). */
  csrAuth: Uint8Array;
  csrSign: Uint8Array;
  /** `[A-Za-z0-9-]{1,64}`. */
  tokenSerial: string;
  /** Заавал биш (≤ 64). */
  tokenLabel?: string;
  /** Байгууллагын токен (NTRMN-…); хоосон/алга = хувийн токен. */
  onBehalfOf?: string;
}

export interface TokenCertStart {
  sessionId: string;
  /** Иргэнд ХАРУУЛАХ баталгаажуулах код (ПИН биш). */
  vc: string | null;
  /** hex(SHA-256(CSR DER)) — SDK илгээсэн CSR-тэй тулгасан (жижиг үсэг). */
  csrAuthSha256: string;
  csrSignSha256: string;
  expiresAt?: string;
}

export interface TokenCertItem {
  /** base64 DER. */
  certificate: string;
  certificatePem: string;
  serialHex: string;
  notBefore: string;
  notAfter: string;
}

/** GET /token/certificate/{sessionID} (зөвхөн үүсгэсэн RP, 24 цаг идэмпотент). */
export interface TokenCertResult {
  status: string;
  auth: TokenCertItem | null;
  sign: TokenCertItem | null;
  /** base64 DER: 04, 03, 02 (root-гүй). */
  chain: string[];
  chainPem: string;
  /** Хувийн токенд null. */
  organization: TokenOrganization | null;
  keyMedium: string;
  certificateLevel: string;
  raw: unknown;
}

export interface TokenAuthChallenge {
  challengeId: string;
  /** base64 (32 байт). */
  challenge: string;
  /** CA-ийн холбосон RP (жижиг үсэг) — hash-д ЯГ ЭНЭ мөр орно. */
  rpUUID: string;
  expiresAt: string;
}

/** CA-ийн баталгаажуулсан иргэн; givenName/surname — KYC бүртгэлээс (кирилл). */
export interface TokenIdentity {
  etsi: string;
  givenName: string;
  surname: string;
}

export interface TokenAuthResult {
  identity: TokenIdentity;
  serialHex: string;
  notAfter: string;
  /** Токен байгууллагад холбогдсон бол; эс бөгөөс null. */
  organization: TokenOrganization | null;
  raw: unknown;
}

/** 409 TOKEN_LIMIT_REACHED-ийн дэлгэрэнгүй. `limit` 0 = тухайн төрлийн олголт хаалттай. */
export interface TokenLimit {
  kind: "PERSONAL" | "ORGANIZATION";
  limit: number;
  /** Зөвхөн ORGANIZATION-д (NTRMN-…). */
  organization?: string;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function hexSha256Equal(hex: unknown, data: Uint8Array): boolean {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  return timingSafeEqual(createHash("sha256").update(data).digest(), Buffer.from(hex, "hex"));
}

/** CA олголт дуусаагүй бол ≤ 15с хүлээдэг. */
const TOKEN_RESULT_TIMEOUT_MS = 30_000;

export class TokenApi {
  constructor(
    private readonly http: Http,
    private readonly creds: RpCredentials,
  ) {}

  /**
   * POST /token/certificate — токены AUTH + SIGN гэрчилгээ олголт эхлүүлнэ (иргэн утсаараа батална). CA-ийн буцаасан
   * CSR hash-ууд илгээсэнтэй таарахгүй бол ValidationError.
   */
  async issueCertificate(input: TokenCertInput): Promise<TokenCertStart> {
    if (!input.signerEtsi?.trim() || !input.csrAuth?.length || !input.csrSign?.length || !input.tokenSerial?.trim()) {
      throw new Error("token: signerEtsi, csrAuth, csrSign, tokenSerial шаардлагатай");
    }
    // CA DisallowUnknownFields — яг эдгээр талбар.
    const body: Record<string, unknown> = {
      relyingPartyUUID: this.creds.rpUUID,
      relyingPartyName: this.creds.rpName,
      signer: { etsi: input.signerEtsi.trim() },
      csrAuth: Buffer.from(input.csrAuth).toString("base64"),
      csrSign: Buffer.from(input.csrSign).toString("base64"),
      tokenSerial: input.tokenSerial.trim(),
      onBehalfOf: input.onBehalfOf?.trim() ?? "",
      flow: "notification",
    };
    if (input.tokenLabel) body.tokenLabel = input.tokenLabel;
    const r = rec(await this.http.post(routePath(RP_ROUTES.tokenCertificate), body));
    if (!hexSha256Equal(r.csrAuthSha256, input.csrAuth) || !hexSha256Equal(r.csrSignSha256, input.csrSign)) {
      throw new ValidationError("token: CA-ийн csrAuthSha256/csrSignSha256 илгээсэн CSR-тэй таарсангүй");
    }
    const vc = rec(r.vc).value ?? (typeof r.vc === "string" ? r.vc : undefined);
    return {
      sessionId: String(r.sessionID ?? ""),
      vc: vc != null ? String(vc) : null,
      csrAuthSha256: String(r.csrAuthSha256).toLowerCase(),
      csrSignSha256: String(r.csrSignSha256).toLowerCase(),
      ...(typeof r.expiresAt === "string" ? { expiresAt: r.expiresAt } : {}),
    };
  }

  /**
   * GET /token/certificate/{sessionID} — олгосон AUTH + SIGN гэрчилгээ + гинж. Токенд бичихээс өмнө
   * {@link verifyTokenCertificates}-ээр CSR-ийн түлхүүртэй тулга.
   */
  async certificateResult(sessionId: string): Promise<TokenCertResult> {
    const raw = await this.http.get(routePath(RP_ROUTES.tokenCertificateResult, sessionId), TOKEN_RESULT_TIMEOUT_MS);
    const r = rec(raw);
    const item = (v: unknown): TokenCertItem | null => (v && typeof v === "object" ? (v as TokenCertItem) : null);
    return {
      status: String(r.status ?? ""),
      auth: item(r.auth),
      sign: item(r.sign),
      chain: Array.isArray(r.chain) ? r.chain.map(String) : [],
      chainPem: String(r.chainPem ?? ""),
      organization: r.organization && typeof r.organization === "object" ? (r.organization as TokenOrganization) : null,
      keyMedium: String(r.keyMedium ?? ""),
      certificateLevel: String(r.certificateLevel ?? ""),
      raw,
    };
  }

  /** POST /token/auth/challenge — энэ RP-д холбогдсон нэг удаагийн challenge (2 мин). */
  async authChallenge(): Promise<TokenAuthChallenge> {
    const r = rec(
      await this.http.post(routePath(RP_ROUTES.tokenAuthChallenge), {
        relyingPartyUUID: this.creds.rpUUID,
        relyingPartyName: this.creds.rpName,
      }),
    );
    return {
      challengeId: String(r.challengeId ?? ""),
      challenge: String(r.challenge ?? ""),
      rpUUID: String(r.rpUUID ?? ""),
      expiresAt: String(r.expiresAt ?? ""),
    };
  }

  /**
   * POST /token/auth/verify — токены AUTH гэрчилгээ (DER) + challenge дээрх түүхий r||s. CA гинж, төлөв, цуцлалт, гарын
   * үсгийг шалгана; SDK нэмж endResult === OK ба identity.etsi === гэрчилгээний SERIALNUMBER-ийг тулгана (эс бөгөөс
   * ValidationError). Challenge нэг удаагийн — алдааны дараа шинээр авна.
   */
  async authVerify(challengeId: string, certDer: Uint8Array, signature: Uint8Array): Promise<TokenAuthResult> {
    let serial: string | undefined;
    try {
      serial = parseSubject(new X509Certificate(certDer)).serialNumber;
    } catch {
      throw new Error("token auth: гэрчилгээ задарсангүй");
    }
    if (!challengeId || !signature?.length) throw new Error("token auth: challengeId ба signature шаардлагатай");
    const raw = await this.http.post(routePath(RP_ROUTES.tokenAuthVerify), {
      challengeId,
      certificate: Buffer.from(certDer).toString("base64"),
      signature: Buffer.from(signature).toString("base64"),
    });
    const r = rec(raw);
    if (rec(r.result).endResult !== "OK") throw new ValidationError("token auth: endResult OK биш");
    const id = rec(r.identity);
    if (!id.etsi || id.etsi !== serial) throw new ValidationError("token auth: identity.etsi нь гэрчилгээний SERIALNUMBER биш");
    const org = rec(r.organization);
    const cert = rec(r.cert);
    return {
      identity: { etsi: String(id.etsi), givenName: String(id.givenName ?? ""), surname: String(id.surname ?? "") },
      serialHex: String(cert.serialHex ?? ""),
      notAfter: String(cert.notAfter ?? ""),
      organization: org.etsi ? { etsi: String(org.etsi), name: String(org.name ?? "") } : null,
      raw,
    };
  }
}

/** PKCS#10 CSR-ийн SubjectPublicKeyInfo DER (бүтэн TLV). */
function csrSpki(csr: Uint8Array): Buffer {
  const top = tlv(csr, 0, csr.length); // CertificationRequest
  const info = tlv(csr, top.start, top.end); // CertificationRequestInfo
  const version = tlv(csr, info.start, info.end);
  const subject = tlv(csr, version.end, info.end);
  const spki = tlv(csr, subject.end, info.end);
  return createPublicKey({ key: Buffer.from(csr.subarray(subject.end, spki.end)), format: "der", type: "spki" }).export({
    format: "der",
    type: "spki",
  });
}

/**
 * Олгосон AUTH/SIGN гэрчилгээ бүр задарч, илгээсэн CSR-ийн public key-тэй (SPKI) ЯГ таарахыг шалгана. Таарахгүй бол
 * ValidationError — гэрчилгээг токенд бүү бич.
 */
export function verifyTokenCertificates(result: TokenCertResult, csrAuth: Uint8Array, csrSign: Uint8Array): void {
  if (!result?.auth || !result.sign) throw new ValidationError("token: auth/sign гэрчилгээ алга");
  for (const [name, item, csr] of [
    ["auth", result.auth, csrAuth],
    ["sign", result.sign, csrSign],
  ] as const) {
    let want: Buffer;
    try {
      want = csrSpki(csr);
    } catch {
      throw new Error(`token: ${name} CSR задарсангүй`);
    }
    let got: Buffer;
    try {
      got = new X509Certificate(Buffer.from(item.certificate, "base64")).publicKey.export({ format: "der", type: "spki" });
    } catch {
      throw new ValidationError(`token: ${name} гэрчилгээ задарсангүй`);
    }
    if (!got.equals(want)) throw new ValidationError(`token: ${name} гэрчилгээний түлхүүр CSR-ийнхтэй таарсангүй`);
  }
}

/**
 * Токены зурах 32 байт: SHA-256("eID-TOKEN-AUTH" || rpUUID || challenge) (docs/TOKEN_AUTH.md). `rpUUID` — challenge
 * хариуны `rpUUID` (жижиг үсэг, 36), `challengeB64` — 32 байт base64. Токен үүнийг CKM_ECDSA-аар зурж, түүхий r||s
 * (64 байт)-ийг authVerify-д өгнө.
 */
export function tokenAuthDigest(rpUUID: string, challengeB64: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rpUUID)) {
    throw new Error("token auth: rpUUID жижиг үсгийн 36 тэмдэгт UUID биш");
  }
  const ch = Buffer.from(challengeB64, "base64");
  if (ch.length !== 32 || ch.toString("base64") !== challengeB64) throw new Error("token auth: challenge 32 байт base64 биш");
  return createHash("sha256").update("eID-TOKEN-AUTH", "ascii").update(rpUUID, "ascii").update(ch).digest();
}

/**
 * err нь 409 TOKEN_LIMIT_REACHED бол түүний `{kind, limit, organization}`. Гэрээнээс гадуур хэлбэр бол undefined —
 * татгалзал хүчинтэй хэвээр, дэлгэрэнгүйгүй.
 */
export function tokenLimitOf(err: unknown): TokenLimit | undefined {
  if (!(err instanceof ApiError) || err.code !== "TOKEN_LIMIT_REACHED") return undefined;
  let b: Record<string, unknown>;
  try {
    b = rec(JSON.parse(err.body));
  } catch {
    return undefined;
  }
  if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 0) return undefined;
  if (b.kind === "PERSONAL") return { kind: "PERSONAL", limit: b.limit };
  if (b.kind === "ORGANIZATION" && typeof b.organization === "string" && b.organization.startsWith("NTRMN-")) {
    return { kind: "ORGANIZATION", limit: b.limit, organization: b.organization };
  }
  return undefined;
}
