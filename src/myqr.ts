// «Миний QR» (биечлэн шалгах, CA гэрээ myqr-2026-10-26): иргэн апп дээрээ `EIDMN-QR1:<token>` (120 с, нэг удаагийн)
// харуулна → RP скан хийж `qr.start`-аар `POST /authentication/qr` → иргэн утсан дээрээ PIN2-оор (QUALIFIED SIGN түлхүүр)
// «Миний мэдээлэл»-ээ бүхэлд нь хуваалцахыг зөвшөөрнө → `qr.result` нь ИРГЭНИЙ PS256 JWS-ийг (x5c = [SIGN гэрчилгээ,
// олгогч CA]) гинж, цуцлалт (OCSP), гарын үсэг, claim-аар шалгаж өгөгдлийг буцаана. CA өгөгдлийг хадгалахгүй — анхны
// амжилттай уншилтаар устгана (дахин уншвал 410 QR_PRESENTATION_GONE). RP-д зөвхөн `QR_PRESENT` эрх. Go / .NET SDK-тэй
// ижил дүрэм (гэрээний §6; test/fixtures/myqr_vectors.json — CA-ийн файлтай байт-ижил).

import { X509Certificate, constants, createHash, randomBytes, verify as cryptoVerify } from "node:crypto";
import { RP_ROUTES, routePath } from "./contract.js";
import { ApiError, EidError, SessionFailedError } from "./errors.js";
import type { Http } from "./http.js";
import { ocspRevocationChecker } from "./ocsp.js";
import type { SessionApi } from "./session.js";
import { parseSubject } from "./subject.js";
import type { RpCredentials, SessionResult } from "./types.js";
import {
  CITIZEN_INTERMEDIATES_PEM,
  NATIONAL_ROOT_CA_PEM,
  ResponseValidator,
  type RevocationChecker,
  type RevocationStatus,
  type TrustConfig,
} from "./validator.js";

/** Иргэний аппын QR-ийн угтвар: `EIDMN-QR1:<token>`. */
export const QR_PREFIX = "EIDMN-QR1:";
export const DEFAULT_QR_ISSUER = "https://ca.eidmongolia.mn";
/** `iat` / `exp` / гэрчилгээний хугацааны зөрүү (с). */
export const QR_CLOCK_SKEW_SECONDS = 60;
/** `exp − iat`-ийн дээд хэмжээ (с). */
export const QR_MAX_AGE_SECONDS = 300;
/** Өгөгдлийн хязгаар (гэрээний §1.3) — CA, апп, SDK гурвуулаа шалгана. */
export const QR_LIMITS = Object.freeze({ maxFields: 128, maxKeyChars: 64, maxValueBytes: 2048, maxPhotoBytes: 153600 });
const MAX_JWS_BYTES = 524288;

/**
 * Клиент талын алдааны кодууд ({@link QrError.code}, гэрээний §6.2). CA-ийн кодууд (`QR_TOKEN_INVALID` 404,
 * `PERMISSION_DENIED` / `RP_REQUIRED` 403, `NO_SIGNING_CERTIFICATE` 409, `REQUEST_INVALID` 400, `RATE_LIMITED` 429)
 * өөрчлөгдөхгүй `ApiError` / `ForbiddenError`-ийн `code`-д ирнэ; зөвхөн `GET /session`-ийн 410 → `QR_PRESENTATION_GONE`.
 * - `QR_FORMAT_INVALID` — скан хийсэн мөр eID «Миний QR» биш (CA руу явахгүй)
 * - `QR_JWS_MALFORMED` … `QR_DATA_INVALID` — presentation-ийн шалгалт унасан — хариунд ИТГЭХГҮЙ
 * - `QR_REVOCATION_UNKNOWN` — OCSP хариу аваагүй (hard-fail; түр — дахин `verify` хийж болно)
 * - `QR_PRESENTATION_GONE` — presentation аль хэдийн уншигдсан эсвэл хугацаа нь дууссан → шинэ QR уншуулна
 * - `QR_PENDING` — `qr.result`-ийн `maxWaitMs` дууссан ч иргэн хараахан хариулаагүй — дахин `result` / `check`
 */
export const QR_ERROR_CODES = [
  "QR_FORMAT_INVALID",
  "QR_JWS_MALFORMED",
  "QR_HEADER_INVALID",
  "QR_CHAIN_INVALID",
  "QR_CERT_REVOKED",
  "QR_REVOCATION_UNKNOWN",
  "QR_SIGNATURE_INVALID",
  "QR_CLAIMS_INVALID",
  "QR_AUDIENCE_MISMATCH",
  "QR_SESSION_MISMATCH",
  "QR_NONCE_MISMATCH",
  "QR_NOT_YET_VALID",
  "QR_EXPIRED",
  "QR_DATA_INVALID",
  "QR_PRESENTATION_GONE",
  "QR_PENDING",
] as const;
export type QrErrorCode = (typeof QR_ERROR_CODES)[number];

/** «Миний QR»-ийн клиент талын алдаа. */
export class QrError extends EidError {
  constructor(
    public readonly code: QrErrorCode,
    public readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
  }
}

export interface ParsedQr {
  token: string;
  /** Хэвийн болгосон QR мөр (`EIDMN-QR1:<token>`, хоосон зайгүй). */
  qr: string;
}

export interface QrConfig {
  /** Хүлээгдэх `iss`; анхдагч {@link DEFAULT_QR_ISSUER} (тест орчинд л). */
  issuer?: string;
}

export interface QrStartInput {
  /** Скан хийсэн агуулга (`EIDMN-QR1:<token>`). */
  qr: string;
  /** RP-ийн nonce (16–128 байт, ASCII 0x21–0x7E) — JWS-ийн `nonce`-д буцна. Өгөөгүй бол base64url(16 санамсаргүй байт). */
  nonce?: string;
  /** Касс / дэд системийн нэр (зөвхөн CA-ийн логт). Анхдагч `credentials.rpName`. */
  relyingPartyName?: string;
}

/** `qr.start`-ийн хариу — JSON-оор хадгалж (stateless backend) `qr.result` / `check`-д дамжуулна. */
export interface QrSession {
  sessionId: string;
  nonce: string;
}

export interface QrClaims {
  iss: string;
  /** Гарын үсэгтний ETSI (`PNOMN-…`) — x5c[0]-ийн subject serialNumber. */
  sub: string;
  /** RP UUID. */
  aud: string;
  /** CA-ийн бүртгэлтэй RP нэр. */
  rp_name: string;
  sid: string;
  nonce: string;
  iat: number;
  exp: number;
  /** Иргэний PIN2-оор зөвшөөрсөн өгүүлбэр. */
  statement: string;
  data: { source: string; fields: Record<string, string>; photo?: string };
}

export interface QrSigner {
  certificate: X509Certificate;
  /** = `claims.sub`. */
  etsi: string;
  givenName?: string;
  surname?: string;
  commonName?: string;
}

/** Шалгагдсан presentation. */
export interface QrPresentation {
  jws: string;
  claims: QrClaims;
  /** «Миний мэдээлэл» — түлхүүр/утга яг апп дээр хадгалсан хэлбэрээр (payload-ийн дарааллаар). */
  data: Record<string, string>;
  /** Иргэний таних мэдээллийн эх сурвалж (`dan`, `passport`, `citizenid`, `gsign`, `guardian`, `unknown`…). */
  source: string;
  /** Нүүрний зураг (JPEG байт), байвал. */
  photo?: Uint8Array;
  signer: QrSigner;
  /** `iat`. */
  signedAt: Date;
  /** hex SHA-256(signingInput) — CA-ийн аудитын `qrsha`-тай тэнцүү (маргаанд тулгах). */
  sha256: string;
}

export interface QrExpect {
  /** RP UUID (том/жижиг үсэг ялгахгүй). */
  rpUUID: string;
  sessionId: string;
  nonce: string;
  /** Анхдагч {@link DEFAULT_QR_ISSUER}. */
  issuer?: string;
  /** Анхдагч одоо. */
  now?: Date;
}

/** `qr.check`-ийн хариу: иргэн хараахан хариулаагүй, эсвэл шалгагдсан presentation. */
export type QrCheck = { complete: false } | { complete: true; result: QrPresentation };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const STD_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/;
const KEY_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE_RE = /\p{Cs}/u;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const fail = (code: QrErrorCode, reason: string) => new QrError(code, reason);

/**
 * Скан хийсэн мөр → `{ token, qr }` (гэрээний §1.2): ASCII хоосон зай хасна; `EIDMN-QR1:` угтвар + 43 тэмдэгт base64url
 * токен. Бусад → {@link QrError} `QR_FORMAT_INVALID`.
 */
export function parseQr(scanned: string): ParsedQr {
  const s = String(scanned ?? "").replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  const token = s.slice(QR_PREFIX.length);
  if (!s.startsWith(QR_PREFIX) || !TOKEN_RE.test(token)) throw fail("QR_FORMAT_INVALID", "eID «Миний QR» биш");
  return { token, qr: QR_PREFIX + token };
}

/** «Миний QR»-ийн өгүүлбэр (гэрээний §1.4): иргэн PIN2-оор яг үүнийг зөвшөөрсөн. */
export function qrStatement(rpName: string): string {
  return `Та ${rpName}-д «Миний мэдээлэл» хэсгийн бүх мэдээллийг хуваалцах гэж байна`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** base64url (canonical) → UTF-8 (хатуу) → JSON; алдаа бол undefined. */
function jsonSegment(seg: string): unknown {
  try {
    const b = Buffer.from(seg, "base64url");
    if (b.toString("base64url") !== seg) return undefined;
    return JSON.parse(utf8.decode(b));
  } catch {
    return undefined;
  }
}

/** Хатуу стандарт base64 (padding-тай, мөр таслалгүй, canonical); алдаа бол undefined. */
function stdBase64(s: string): Buffer | undefined {
  if (!s || s.length % 4 !== 0 || !STD_B64_RE.test(s)) return undefined;
  const b = Buffer.from(s, "base64");
  return b.toString("base64") === s ? b : undefined;
}

const derToPem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

let defaultChecker: RevocationChecker | undefined;
/** TrustConfig-д revocation алга бол SDK-ийн OCSP шалгагч (AIA; нэг процесст нэг кэш). */
function revocationOf(trust: TrustConfig): RevocationChecker {
  return trust.revocation ?? (defaultChecker ??= ocspRevocationChecker());
}

function checkData(d: unknown): QrClaims["data"] {
  const bad = (why: string) => fail("QR_DATA_INVALID", why);
  if (!isObj(d)) throw bad("data объект биш");
  for (const k of Object.keys(d)) if (k !== "source" && k !== "fields" && k !== "photo") throw bad("data-д илүү гишүүн");
  if (typeof d.source !== "string" || !SOURCE_RE.test(d.source)) throw bad("source буруу");
  if (!isObj(d.fields)) throw bad("fields объект биш");
  const keys = Object.keys(d.fields);
  if (keys.length > QR_LIMITS.maxFields) throw bad(`fields > ${QR_LIMITS.maxFields}`);
  for (const k of keys) {
    const n = [...k].length;
    if (n < 1 || n > QR_LIMITS.maxKeyChars || KEY_FORBIDDEN_RE.test(k) || LONE_SURROGATE_RE.test(k)) throw bad("түлхүүр буруу");
    const v = d.fields[k];
    if (typeof v !== "string") throw bad("утга string биш");
    if (Buffer.byteLength(v, "utf8") > QR_LIMITS.maxValueBytes || v.includes("\u0000") || LONE_SURROGATE_RE.test(v)) {
      throw bad(`утга > ${QR_LIMITS.maxValueBytes} байт эсвэл буруу тэмдэгт`);
    }
  }
  let photo: string | undefined;
  if ("photo" in d) {
    if (typeof d.photo !== "string") throw bad("photo string биш");
    const b = stdBase64(d.photo);
    if (!b) throw bad("photo base64 биш");
    if (b.length > QR_LIMITS.maxPhotoBytes) throw bad(`photo > ${QR_LIMITS.maxPhotoBytes} байт`);
    if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) throw bad("photo JPEG биш");
    photo = d.photo;
  }
  // Гэрээний §1.3: fields хоосон бол photo заавал.
  if (keys.length === 0 && photo === undefined) throw bad("fields хоосон, photo алга");
  return { source: d.source, fields: d.fields as Record<string, string>, ...(photo !== undefined ? { photo } : {}) };
}

/**
 * «Миний QR» presentation-ийг шалгана (гэрээний §6.1, эхний алдаан дээр зогсоно): хэлбэр, header (`alg` PS256, `typ`
 * eidmn-myqr+jwt, `x5c` [гэрчилгээ, олгогч CA], өөр гишүүнгүй), гинж (x5c[1] ∪ trust.intermediates → trust anchor, цаг
 * ± 60 с; CA биш, KU contentCommitment, QUALIFIED, issuer allowlist, RSA ≥ 2048), цуцлалт (`trust.revocation`, алга бол
 * SDK-ийн OCSP; анхдагч hard-fail), PS256 гарын үсэг, claim (`iss`, `sub` = гэрчилгээний serialNumber, өгүүлбэр, `aud`,
 * `sid`, `nonce`, хугацаа), өгөгдлийн хязгаар. Алдаа бол {@link QrError} (§6.2-ийн код) — хариунд ИТГЭХГҮЙ.
 *
 * Итгэлцэл: `trust.trustAnchorsPem` алга бол {@link NATIONAL_ROOT_CA_PEM}; `intermediatesPem` алга бол
 * {@link CITIZEN_INTERMEDIATES_PEM}; issuer allowlist, `revocationMode` нь `TrustConfig`-ийн дүрмээр. `allowUntrusted`,
 * `checkKeyUsage: false` энд үйлчлэхгүй; түвшин үргэлж ≥ QUALIFIED.
 */
export async function verifyQrPresentation(jws: string, expect: QrExpect, trust: TrustConfig): Promise<QrPresentation> {
  // 1. хэлбэр
  if (typeof jws !== "string" || Buffer.byteLength(jws, "utf8") > MAX_JWS_BYTES) throw fail("QR_JWS_MALFORMED", "JWS хэт урт эсвэл string биш");
  const seg = jws.split(".");
  if (seg.length !== 3 || !seg.every((s) => SEGMENT_RE.test(s))) throw fail("QR_JWS_MALFORMED", "compact JWS биш");
  const [h64, p64, s64] = seg as [string, string, string];

  // 2–3. header, x5c
  const badHeader = (why: string) => fail("QR_HEADER_INVALID", why);
  const hdr = jsonSegment(h64);
  if (!isObj(hdr)) throw badHeader("header JSON объект биш");
  const hk = Object.keys(hdr);
  if (hk.length !== 3 || !hk.includes("alg") || !hk.includes("typ") || !hk.includes("x5c")) throw badHeader("header зөвхөн alg, typ, x5c");
  if (hdr.alg !== "PS256") throw badHeader("alg PS256 биш");
  if (hdr.typ !== "eidmn-myqr+jwt") throw badHeader("typ eidmn-myqr+jwt биш");
  const x5c = hdr.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every((c) => typeof c === "string" && c.length > 0)) {
    throw badHeader("x5c 2 гэрчилгээ биш");
  }
  const certs = (x5c as string[]).map((c) => {
    const der = stdBase64(c);
    if (!der) throw badHeader("x5c base64 биш");
    try {
      const cert = new X509Certificate(der);
      if (!cert.raw.equals(der)) throw new Error("trailing");
      return cert;
    } catch {
      throw badHeader("x5c гэрчилгээ биш");
    }
  });
  const leaf = certs[0]!;

  // 4. гинж (x5c[1] — зөвхөн завсрын нэр дэвшигч, хэзээ ч anchor биш)
  const nowMs = (expect.now ?? new Date()).getTime();
  const validator = new ResponseValidator({
    ...trust,
    trustAnchorsPem: trust.trustAnchorsPem?.length ? trust.trustAnchorsPem : [NATIONAL_ROOT_CA_PEM],
    intermediatesPem: [...(trust.intermediatesPem ?? CITIZEN_INTERMEDIATES_PEM), derToPem(certs[1]!.raw)],
    requiredLevel: trust.requiredLevel === "QSCD" ? "QSCD" : "QUALIFIED",
    allowUntrusted: false,
  });
  let issuer: X509Certificate | undefined;
  try {
    issuer = validator.verifyQrSigner(leaf, nowMs, QR_CLOCK_SKEW_SECONDS * 1000);
  } catch (e) {
    throw fail("QR_CHAIN_INVALID", e instanceof Error ? e.message : "гинж хүчингүй");
  }
  const kt = leaf.publicKey.asymmetricKeyType;
  if ((kt !== "rsa" && kt !== "rsa-pss") || (leaf.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw fail("QR_CHAIN_INVALID", "гарын үсэгтний түлхүүр RSA ≥ 2048 биш");
  }

  // 5. цуцлалт
  let status: RevocationStatus | string;
  try {
    status = await revocationOf(trust)(leaf, issuer);
  } catch {
    status = "unknown";
  }
  if (status === "revoked") throw fail("QR_CERT_REVOKED", "гэрчилгээ цуцлагдсан");
  if (status !== "good" && (trust.revocationMode ?? "hard-fail") === "hard-fail") {
    throw fail("QR_REVOCATION_UNKNOWN", "гэрчилгээний цуцлалтын төлөв тогтоогдсонгүй");
  }

  // 6. PS256 (SHA-256, MGF1-SHA-256, salt 32) — хүлээн авсан байтаар, дахин serialize хийхгүй
  const signingInput = Buffer.from(`${h64}.${p64}`, "ascii");
  let sigOk = false;
  try {
    const sig = Buffer.from(s64, "base64url");
    sigOk =
      sig.toString("base64url") === s64 &&
      cryptoVerify("sha256", signingInput, { key: leaf.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) throw fail("QR_SIGNATURE_INVALID", "гарын үсэг таарсангүй");

  // 7. payload, claim
  const c = jsonSegment(p64);
  if (!isObj(c)) throw fail("QR_JWS_MALFORMED", "payload JSON объект биш");
  const badClaims = (why: string) => fail("QR_CLAIMS_INVALID", why);
  if (c.iss !== (expect.issuer || DEFAULT_QR_ISSUER)) throw badClaims("iss таарсангүй");
  const subj = parseSubject(leaf);
  if (typeof c.sub !== "string" || !subj.serialNumber || c.sub !== subj.serialNumber) throw badClaims("sub ≠ гэрчилгээний serialNumber");
  for (const k of ["rp_name", "statement", "nonce", "sid", "aud"] as const) if (typeof c[k] !== "string") throw badClaims(`${k} string биш`);
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)) throw badClaims("iat/exp бүхэл тоо биш");
  if (c.statement !== qrStatement(c.rp_name as string)) throw badClaims("statement таарсангүй");
  const iat = c.iat as number;
  const exp = c.exp as number;

  // 8–10. RP, session, nonce
  if (!expect.rpUUID || (c.aud as string).toLowerCase() !== expect.rpUUID.toLowerCase()) throw fail("QR_AUDIENCE_MISMATCH", "aud (RP UUID) таарсангүй");
  if (!expect.sessionId || c.sid !== expect.sessionId) throw fail("QR_SESSION_MISMATCH", "sid таарсангүй");
  if (!expect.nonce || c.nonce !== expect.nonce) throw fail("QR_NONCE_MISMATCH", "nonce таарсангүй");

  // 11. хугацаа
  const now = nowMs / 1000;
  if (exp - iat <= 0 || exp - iat > QR_MAX_AGE_SECONDS) throw badClaims(`exp − iat ∉ (0, ${QR_MAX_AGE_SECONDS}]`);
  if (iat > now + QR_CLOCK_SKEW_SECONDS) throw fail("QR_NOT_YET_VALID", "iat ирээдүйд");
  if (now >= exp + QR_CLOCK_SKEW_SECONDS) throw fail("QR_EXPIRED", "presentation-ийн хугацаа дууссан");

  // 12. өгөгдөл
  const data = checkData(c.data);

  // 13. үр дүн
  const claims: QrClaims = {
    iss: c.iss as string,
    sub: c.sub,
    aud: c.aud as string,
    rp_name: c.rp_name as string,
    sid: c.sid as string,
    nonce: c.nonce as string,
    iat,
    exp,
    statement: c.statement as string,
    data,
  };
  return {
    jws,
    claims,
    data: Object.fromEntries(Object.entries(data.fields)),
    source: data.source,
    ...(data.photo !== undefined ? { photo: new Uint8Array(Buffer.from(data.photo, "base64")) } : {}),
    signer: {
      certificate: leaf,
      etsi: c.sub,
      ...(subj.givenName ? { givenName: subj.givenName } : {}),
      ...(subj.surname ? { surname: subj.surname } : {}),
      ...(subj.commonName ? { commonName: subj.commonName } : {}),
    },
    signedAt: new Date(iat * 1000),
    sha256: createHash("sha256").update(signingInput).digest("hex"),
  };
}

export interface QrApiDeps {
  http: Http;
  session: SessionApi;
  credentials: RpCredentials;
  /** Клиентийн TrustConfig (`ClientConfig.trust`). */
  trust?: TrustConfig;
  /** Хүлээгдэх `iss` (`ClientConfig.qr.issuer`); анхдагч {@link DEFAULT_QR_ISSUER}. */
  issuer?: string;
}

/** `client.qr` — «Миний QR»: parse → start → result / check. */
export class QrApi {
  constructor(private readonly d: QrApiDeps) {}

  /** {@link parseQr}. */
  parse(scanned: string): ParsedQr {
    return parseQr(scanned);
  }

  /**
   * `POST /authentication/qr` — QR-ийн токеныг (нэг удаагийн) CA-д өгч иргэний утас руу хүсэлт илгээнэ (VC алга). Буруу
   * мөр → {@link QrError} `QR_FORMAT_INVALID` (CA руу явахгүй). CA-ийн алдаа: 404 `QrTokenInvalidError` (шинэ QR), 409
   * `NoSigningCertificateError`, 403 `ForbiddenError` (`PERMISSION_DENIED` — `QR_PRESENT` алга, `RP_REQUIRED`), 400
   * `RequestInvalidError` (nonce буруу г.м.), 429 `RATE_LIMITED`.
   */
  async start(input: QrStartInput): Promise<QrSession> {
    const p = parseQr(input.qr);
    const nonce = input.nonce ?? randomBytes(16).toString("base64url");
    const body = {
      qr: p.qr,
      relyingPartyUUID: this.d.credentials.rpUUID,
      relyingPartyName: input.relyingPartyName ?? this.d.credentials.rpName,
      nonce,
    };
    const r = (await this.d.http.post(routePath(RP_ROUTES.authQr), body)) as Record<string, unknown>;
    const sessionId = typeof r?.sessionID === "string" ? r.sessionID : "";
    if (!sessionId) throw new EidError("POST /authentication/qr: sessionID алга");
    return { sessionId, nonce };
  }

  /**
   * Session дуустал long-poll хийж presentation-ийг {@link verifyQrPresentation}-аар шалгана. Татгалзсан / хугацаа
   * дууссан → SessionFailedError (`endResult`); `maxWaitMs` дуусахад иргэн хариулаагүй → `QR_PENDING`; 410 →
   * `QR_PRESENTATION_GONE` (CA presentation-ийг нэг л удаа өгнө — шинэ QR уншуулна).
   */
  async result(session: QrSession, opts?: { maxWaitMs?: number; serverPollMs?: number }): Promise<QrPresentation> {
    if (!session?.sessionId) throw new EidError("qr.result: QrSession шаардлагатай");
    const r = await gone(this.d.session.waitForResult(session.sessionId, opts));
    if (r.state !== "COMPLETE") throw fail("QR_PENDING", "иргэн хараахан хариулаагүй");
    return this.finish(r, session);
  }

  /** Нэг удаагийн шалгалт (polling UI): `GET /session/{id}` (`serverPollMs` хүртэл, анхдагч 1000 мс). Алдаа {@link result}-тэй ижил. */
  async check(session: QrSession, opts?: { serverPollMs?: number }): Promise<QrCheck> {
    if (!session?.sessionId) throw new EidError("qr.check: QrSession шаардлагатай");
    const r = await gone(this.d.session.poll(session.sessionId, opts?.serverPollMs ?? 1_000));
    if (r.state !== "COMPLETE") return { complete: false };
    return { complete: true, result: await this.finish(r, session) };
  }

  /** Presentation JWS-ийг шалгана; `rpUUID` анхдагч `credentials.rpUUID`, `issuer` — клиентийн тохиргоо. */
  verify(jws: string, expect: Omit<QrExpect, "rpUUID"> & { rpUUID?: string }): Promise<QrPresentation> {
    return verifyQrPresentation(
      jws,
      { ...expect, rpUUID: expect.rpUUID ?? this.d.credentials.rpUUID, issuer: expect.issuer ?? this.d.issuer },
      this.d.trust ?? {},
    );
  }

  private finish(r: SessionResult, session: QrSession): Promise<QrPresentation> {
    if (r.endResult !== "OK") throw new SessionFailedError(r.endResult ?? "UNKNOWN");
    const jws = r.presentation?.jws;
    if (!jws) throw fail("QR_JWS_MALFORMED", "хариунд presentation алга");
    return this.verify(jws, { sessionId: session.sessionId, nonce: session.nonce });
  }
}

/** `GET /session`-ийн 410 → {@link QrError} `QR_PRESENTATION_GONE`. */
async function gone(p: Promise<SessionResult>): Promise<SessionResult> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) throw fail("QR_PRESENTATION_GONE", "presentation аль хэдийн уншигдсан эсвэл хугацаа дууссан");
    throw e;
  }
}
