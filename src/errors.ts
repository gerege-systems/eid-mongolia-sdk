// SDK-ийн typed алдаанууд. RP backend эдгээрийг ялган барьж хэрэглэгчид зөв мессеж/үйлдэл
// сонгоно (ж: 401 → тохиргооны алдаа, USER_REFUSED → дахин оролд, TIMEOUT → дахин эхлүүл).

/** Бүх SDK алдааны суурь. */
export class EidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP хариуны нэмэлт мэдээлэл (алдааны төрлүүдэд). */
export interface HttpErrorInit {
  /** Хариуны header-ууд. */
  headers?: Headers;
  /** Retry-After (секунд эсвэл HTTP-огноо задалсан), мс; байхгүй/буруу бол undefined. */
  retryAfterMs?: number;
}

/**
 * HTTP 401 — API secret буруу/байхгүй. Тохиргооны (RP secret) алдаа. CA-ийн өөрийн 401 нь JSON `{"error"[,"code"]}` —
 * `serverMessage` (ба байвал `code`) бөглөгдөнө; JSON биш (proxy / nginx) бол хоёул undefined — үүгээр CA-ийн 401-ийг
 * proxy-ийнхоос ялгана.
 */
export class AuthenticationError extends EidError {
  /** Серверийн `{"code"}`; байхгүй / JSON биш (proxy) бол undefined. */
  readonly code?: string;
  /** Серверийн `{"error"}` текст (логт); JSON биш (proxy) бол undefined. */
  readonly serverMessage?: string;
  /** Хариуны бие (таслагдаагүй текст). */
  readonly body?: string;
  readonly headers?: Headers;
  constructor(message: string, init?: { code?: string; serverMessage?: string; body?: string; headers?: Headers }) {
    super(message);
    this.code = init?.code;
    this.serverMessage = init?.serverMessage;
    this.body = init?.body;
    this.headers = init?.headers;
  }
}

/**
 * HTTP 403 — IP allowlist/mTLS зөвшөөрөөгүй, RP-д эрх алга, эсвэл onBehalfOf-ийн төлөөлөл татгалзсан.
 * Сервер `{"error","code"}` буцаасан бол `code` (ж: `REPRESENTATION_DENIED`) — салааллыг үүгээр хийнэ.
 */
export class ForbiddenError extends EidError {
  readonly headers?: Headers;
  /** Retry-After (мс), байхгүй бол undefined. */
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    /** Серверийн тогтвортой алдааны код (`{"code"}`), байхгүй бол undefined. */
    public readonly code?: string,
    init?: HttpErrorInit,
  ) {
    super(message);
    this.headers = init?.headers;
    this.retryAfterMs = init?.retryAfterMs;
  }
}

/** RP-API-аас ирсэн бусад HTTP алдаа (4xx/5xx). status ба хариуны биеийг агуулна. */
export class ApiError extends EidError {
  readonly headers?: Headers;
  /**
   * Retry-After (мс, секунд эсвэл HTTP-огноо задалсан); байхгүй/буруу бол undefined. CA түр алдаанд (429
   * PDF_PREPARE_BUSY / RATE_LIMITED, 503 DOCUMENT_PENDING / TSA_UNAVAILABLE / LTV_UNAVAILABLE г.м.) тавина.
   */
  readonly retryAfterMs?: number;
  constructor(
    public readonly status: number,
    public readonly body: string,
    /** Серверийн тогтвортой алдааны код (`{"error","code"}`-ийн `code`), байхгүй бол undefined. */
    public readonly code?: string,
    init?: HttpErrorInit,
  ) {
    super(`RP-API ${status}: ${body}`);
    this.headers = init?.headers;
    this.retryAfterMs = init?.retryAfterMs;
  }

  /**
   * CA-ийн түр алдаа ({@link RETRYABLE_ERROR_CODES}-ийн нэг, эсвэл 429/503 + Retry-After): `retryAfterMs`-ийн дараа
   * ижил хүсэлтийг давтаж болно.
   */
  get retryable(): boolean {
    if (this.code && (RETRYABLE_ERROR_CODES as readonly string[]).includes(this.code)) return true;
    return (this.status === 429 || this.status === 503) && (this.retryAfterMs ?? 0) > 0;
  }
}

/**
 * CA-ийн түр (давтаж болох) алдааны кодууд — `ApiError.code`. PDF_PREPARE_BUSY (429 prepare, Retry-After 5),
 * DOCUMENT_PENDING (503 document, 5), TSA_UNAVAILABLE (503, 30), LTV_UNAVAILABLE (503, 60), RATE_LIMITED (429 токен),
 * STATE_UNAVAILABLE (503 токен), ISSUANCE_PENDING (503 токены үр дүн, 5).
 */
export type RetryableErrorCode =
  | "PDF_PREPARE_BUSY"
  | "DOCUMENT_PENDING"
  | "TSA_UNAVAILABLE"
  | "LTV_UNAVAILABLE"
  | "RATE_LIMITED"
  | "STATE_UNAVAILABLE"
  | "ISSUANCE_PENDING";

/** {@link RetryableErrorCode}-ийн бүх утга. */
export const RETRYABLE_ERROR_CODES: readonly RetryableErrorCode[] = [
  "PDF_PREPARE_BUSY",
  "DOCUMENT_PENDING",
  "TSA_UNAVAILABLE",
  "LTV_UNAVAILABLE",
  "RATE_LIMITED",
  "STATE_UNAVAILABLE",
  "ISSUANCE_PENDING",
];

/** RFC 9110 §10.2.3: delay-seconds эсвэл HTTP-date → мс. Буруу / өнгөрсөн / 24 цагаас их → undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    return n > 0 && n <= 86_400 ? n * 1000 : undefined;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) || t <= now ? undefined : t - now;
}

/**
 * Байгууллагын нэрийн өмнөөс (`onBehalfOf`) урсгалын татгалзлын кодууд — `ForbiddenError.code` /
 * `ApiError.code`-д ирнэ. 403: REPRESENTATION_DENIED (идэвхтэй төлөөлөгч биш), REPRESENTATION_PENDING (PIN2-оор
 * баталгаажуулаагүй), REPRESENTATION_EXPIRED (хугацааны гадна), ORG_NOT_ACTIVE, SIGNER_UNIDENTIFIED (anonymous
 * session); 404: ORG_NOT_FOUND; PDF баримт татахад 403 REPRESENTATION_REVOKED (prepare-ээс хойш эрх хасагдсан —
 * баримт үүсээгүй).
 */
export type OnBehalfErrorCode =
  | "REPRESENTATION_DENIED"
  | "REPRESENTATION_PENDING"
  | "REPRESENTATION_EXPIRED"
  | "ORG_NOT_ACTIVE"
  | "SIGNER_UNIDENTIFIED"
  | "ORG_NOT_FOUND"
  | "REPRESENTATION_REVOKED";

/** {@link OnBehalfErrorCode}-ийн бүх утга (runtime шалгалтад). */
export const ON_BEHALF_ERROR_CODES: readonly OnBehalfErrorCode[] = [
  "REPRESENTATION_DENIED",
  "REPRESENTATION_PENDING",
  "REPRESENTATION_EXPIRED",
  "ORG_NOT_ACTIVE",
  "SIGNER_UNIDENTIFIED",
  "ORG_NOT_FOUND",
  "REPRESENTATION_REVOKED",
];

/**
 * Сүлжээ/timeout — upstream хариу өгсөнгүй. Мессеж ба `op`-д хувь хүний таних тэмдэг ОРОХГҮЙ (замын `/etsi/{…}`,
 * `/document/{…}` → `…`) — шууд лог руу бичиж болно.
 */
export class NetworkError extends EidError {
  /** "GET /session/…" (таних тэмдэг хасагдсан зам). */
  readonly op?: string;
  /** Хүсэлт хугацаа хэтэрсэн. */
  readonly timeout?: boolean;
  constructor(message: string, init?: { op?: string; timeout?: boolean }) {
    super(message);
    this.op = init?.op;
    this.timeout = init?.timeout;
  }
}

/**
 * Хариуны бие SDK-ийн хязгаараас их (JSON 4 MiB, PDF `pdfMaxBytes`) — бие таслагдаж задлагдахгүй. `op` — method +
 * таних тэмдэггүй зам.
 */
export class ResponseTooLargeError extends EidError {
  constructor(
    readonly op: string,
    readonly limit: number,
  ) {
    super(`${op}: хариу ${limit} байтаас их`);
  }
}

/** Алдаа/логт орох зам: `/etsi/{…}`, `/document/{…}` → `…`, query хасагдана. */
export function maskPath(path: string): string {
  return path.split(/[?#]/)[0]!.replace(/\/(etsi|document)\/[^/?#\s]+/g, "/$1/…");
}

/**
 * Session амжилтгүй дууссан (endResult ≠ OK): TIMEOUT, USER_REFUSED*, DOCUMENT_UNUSABLE гм.
 * endResult-оор салгаж RP UI-д тохирох мессеж харуулна.
 */
export class SessionFailedError extends EidError {
  constructor(public readonly endResult: string) {
    super(`Session амжилтгүй: ${endResult}`);
  }
}

/**
 * Хариуны баталгаажуулалт бүтэлгүйтсэн — cert chain итгэлцэлгүй, signature challenge-тэй
 * таарсангүй, эсвэл certLevel хүрэлцээгүй. ЭНЭ алдаа гарвал хариунд ИТГЭХГҮЙ
 * (хуурамч/proxy хийгдсэн байж болзошгүй).
 */
export class ValidationError extends EidError {}

/**
 * Device-link (App2App/Web2App) холбоос угсрах боломжгүй — хариунд `deviceLinkBase` байхгүй,
 * эсвэл sessionId/vc/суурь URL хэлбэр буруу. Session-ийг дахин эхлүүлнэ; холбоосыг таахгүй.
 */
export class DeviceLinkError extends EidError {}
