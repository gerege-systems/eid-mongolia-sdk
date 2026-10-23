// «Миний QR» (биечлэн шалгах): иргэн апп дээрээ нэг удаагийн QR (120 с) харуулна → RP скан хийж `qr.start`-аар хүссэн
// аттрибутаа CA-аас асууна → иргэн утсан дээрээ PIN1-ээр зөвшөөрнө → `qr.result` нь CA-ийн ES256 гарын үсэгтэй
// presentation (JWS)-ийг JWKS-ээр шалгаж ЗӨВХӨН хүссэн аттрибутуудыг буцаана. Гэрчилгээ, person блок ирэхгүй.
// RP-д AUTH + QR_PRESENT + аттрибут бүрд QR_ATTR:<нэр> эрх хэрэгтэй. Go / .NET SDK-тэй ижил дүрэм
// (testdata/qr_vectors.json — гурван SDK-д ижил).

import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { RP_ROUTES, routePath } from "./contract.js";
import { randomChallenge } from "./crypto.js";
import { EidError, SessionFailedError } from "./errors.js";
import type { Http } from "./http.js";
import type { SessionApi } from "./session.js";
import { parseExpiresAt, type RpCredentials, type SessionResult } from "./types.js";

/** Аттрибутын каталог (CA гэрээ v1, 2026-10-23). */
export const QR_ATTRIBUTES = ["age_over_18", "age_over_21", "full_name", "phone", "birth_date", "civil_id"] as const;
export type QrAttribute = (typeof QR_ATTRIBUTES)[number];

/** Иргэний аппын QR-ийн угтвар: `EIDMN-QR1:<token>`. */
export const QR_PREFIX = "EIDMN-QR1:";
export const DEFAULT_QR_ISSUER = "https://ca.eidmongolia.mn";
export const DEFAULT_QR_JWKS_URL = "https://ca.eidmongolia.mn/.well-known/eid-jwks.json";
export const DEFAULT_QR_JWKS_CACHE_TTL_MS = 3_600_000;
/** Presentation-ийн `iat`-аас хойш хүлээн авах дээд хугацаа (мс). */
export const DEFAULT_QR_MAX_AGE_MS = 600_000;
/** `iat` ирээдүйд байж болох зөрүү (мс). */
export const QR_CLOCK_SKEW_MS = 60_000;
const JWKS_MIN_REFRESH_MS = 30_000;
const MAX_JWS = 16 << 10;
const MAX_JWKS = 64 << 10;

/**
 * QR алдааны кодууд ({@link QrError.code}). CA-ийн 404 `QR_TOKEN_INVALID` нь {@link QrTokenInvalidError}
 * (`ApiError`, `code === "QR_TOKEN_INVALID"`) болж ирнэ.
 * - `QR_FORMAT_INVALID` — скан хийсэн мөр eID «Миний QR» биш (клиент талын)
 * - `QR_TOKEN_INVALID` — токен танигдахгүй / хугацаа дууссан (120 с) / ашиглагдсан → шинэ QR гаргуул
 * - `QR_ATTRIBUTES_INVALID` — аттрибут хоосон / каталогид алга / давхардсан (клиент талын, CA руу явахгүй)
 * - `QR_PRESENTATION_INVALID` — JWS шалгалт унасан — хариунд ИТГЭХГҮЙ
 * - `QR_JWKS_UNAVAILABLE` — CA-ийн JWKS татагдсангүй (түр; дахин оролдож болно)
 * - `QR_PENDING` — `qr.result`-ийн хүлээх хугацаа (`maxWaitMs`) дууссан ч иргэн хараахан хариулаагүй (CA-ийн session
 *   идэвхтэй хэвээр) — дахин `result` / `check` дуудаж болно. CA-ийн жинхэнэ хугацаа дуусалт = SessionFailedError TIMEOUT.
 */
export const QR_ERROR_CODES = [
  "QR_FORMAT_INVALID",
  "QR_TOKEN_INVALID",
  "QR_ATTRIBUTES_INVALID",
  "QR_PRESENTATION_INVALID",
  "QR_JWKS_UNAVAILABLE",
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

const bad = (reason: string) => new QrError("QR_PRESENTATION_INVALID", reason);

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Скан хийсэн QR-ээс токен: `EIDMN-QR1:<token>` эсвэл зөвхөн токен (43 тэмдэгт base64url). Буруу бол QR_FORMAT_INVALID. */
export function parseQr(scanned: string): string {
  let s = String(scanned ?? "").trim();
  if (s.startsWith(QR_PREFIX)) s = s.slice(QR_PREFIX.length);
  if (!TOKEN_RE.test(s)) throw new QrError("QR_FORMAT_INVALID", "eID «Миний QR» биш");
  return s;
}

function checkAttributes(attrs: readonly string[] | undefined): string[] {
  if (!attrs?.length) throw new QrError("QR_ATTRIBUTES_INVALID", "аттрибут сонгоогүй");
  const seen = new Set<string>();
  for (const a of attrs) {
    if (!(QR_ATTRIBUTES as readonly string[]).includes(a)) throw new QrError("QR_ATTRIBUTES_INVALID", `каталогид алга: ${a}`);
    if (seen.has(a)) throw new QrError("QR_ATTRIBUTES_INVALID", `давхардсан: ${a}`);
    seen.add(a);
  }
  return [...attrs];
}

export interface QrConfig {
  /** Анхдагч {@link DEFAULT_QR_JWKS_URL}. https (http зөвхөн localhost). */
  jwksUrl?: string;
  /** Хүлээгдэх `iss`; анхдагч {@link DEFAULT_QR_ISSUER}. */
  issuer?: string;
  jwksCacheTtlMs?: number;
  maxAgeMs?: number;
}

export interface QrStartInput {
  /** Скан хийсэн агуулга (`EIDMN-QR1:<token>`) эсвэл {@link parseQr}-ийн токен. */
  qr: string;
  /** Хүсэх аттрибутууд (≥ 1, давхардалгүй); RP-д аттрибут бүрийн `QR_ATTR:<нэр>` эрх. */
  attributes: readonly QrAttribute[];
  /** RP-ийн nonce (сонголттой) — JWS-ийн `nonce`-д буцна; өгөөгүй бол rpChallenge. */
  nonce?: string;
}

/** `qr.start`-ийн хариу — JSON-оор хадгалж (stateless backend) `qr.result`-д дамжуулна. `vc`-г кассын дэлгэцэнд харуул. */
export interface QrSession {
  sessionId: string;
  vc: string;
  nonce: string;
  attributes: QrAttribute[];
  /** CA-ийн session дуусах мөч (мс epoch), байвал. */
  expiresAt?: number;
}

export interface QrFullName {
  surname: string;
  givenName: string;
}

/** Баталгаажсан аттрибутууд — хүсээгүй / байхгүй нь алга. */
export interface QrAttrs {
  age_over_18?: boolean;
  age_over_21?: boolean;
  full_name?: QrFullName;
  phone?: string;
  birth_date?: string;
  civil_id?: string;
}

export interface QrPresentation {
  /** Энэ RP-д зориулсан тогтмол pairwise id (иргэний дугаар биш). */
  sub: string;
  attrs: QrAttrs;
  /** Хүссэн боловч бүртгэлд байхгүй (алдаа биш). */
  unavailable: QrAttribute[];
  sessionId: string;
  /** `iat`, мс epoch. */
  issuedAt: number;
  /** Түүхий compact JWS (аудитад хадгалж болно). */
  jws: string;
}

/** `qr.check`-ийн хариу: иргэн хараахан хариулаагүй, эсвэл шалгагдсан presentation. */
export type QrCheck = { state: "RUNNING" } | { state: "COMPLETE"; presentation: QrPresentation };

export interface QrExpect {
  issuer?: string;
  /** RP UUID. */
  audience: string;
  sessionId: string;
  nonce: string;
  attributes: readonly string[];
  /** мс epoch; анхдагч Date.now(). */
  now?: number;
  maxAgeMs?: number;
}

export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}
export interface Jwks {
  keys: Jwk[];
}

class UnknownKid extends Error {}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
function b64url(s: string): Buffer {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw bad("base64url буруу");
  return Buffer.from(s, "base64url");
}

function keyFor(jwks: Jwks | null | undefined, kid: string): KeyObject {
  const j = jwks?.keys?.find((k) => k?.kid === kid);
  if (!j) throw new UnknownKid();
  if (j.kty !== "EC" || j.crv !== "P-256" || (j.alg && j.alg !== "ES256") || (j.use && j.use !== "sig")) {
    throw bad(`kid ${kid} нь ES256 P-256 түлхүүр биш`);
  }
  try {
    if (b64url(j.x ?? "").length !== 32 || b64url(j.y ?? "").length !== 32) throw new Error("x/y");
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: j.x, y: j.y }, format: "jwk" });
  } catch {
    throw bad(`kid ${kid}: түлхүүр буруу`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function setAttr(out: QrAttrs, name: string, v: unknown): void {
  const wrong = () => bad(`${name}-ийн төрөл буруу`);
  switch (name) {
    case "age_over_18":
    case "age_over_21":
      if (typeof v !== "boolean") throw wrong();
      out[name] = v;
      return;
    case "full_name":
      if (!isObj(v) || typeof v.surname !== "string" || typeof v.givenName !== "string" || !v.givenName) throw wrong();
      out.full_name = { surname: v.surname, givenName: v.givenName };
      return;
    case "phone":
      if (typeof v !== "string" || !PHONE_RE.test(v)) throw wrong();
      out.phone = v;
      return;
    case "birth_date":
      if (typeof v !== "string" || !validDate(v)) throw wrong();
      out.birth_date = v;
      return;
    case "civil_id":
      if (typeof v !== "string" || !v) throw wrong();
      out.civil_id = v;
      return;
  }
  throw wrong();
}

function numericDate(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e11 ? v * 1000 : undefined;
}

function verifyInner(jws: string, jwks: Jwks | null | undefined, exp: QrExpect): QrPresentation {
  if (typeof jws !== "string" || !jws || jws.length > MAX_JWS) throw bad("JWS хоосон эсвэл хэт урт");
  const parts = jws.split(".");
  if (parts.length !== 3) throw bad("compact JWS биш");
  const [h64, p64, s64] = parts as [string, string, string];
  const hb = b64url(h64);
  const pb = b64url(p64);
  const sig = b64url(s64);
  let hdr: unknown;
  try {
    hdr = JSON.parse(hb.toString("utf8"));
  } catch {
    throw bad("header JSON биш");
  }
  if (!isObj(hdr) || hdr.alg !== "ES256") throw bad("alg ES256 биш");
  if ("crit" in hdr) throw bad("crit дэмжихгүй");
  if (typeof hdr.kid !== "string" || !hdr.kid) throw bad("kid алга");
  const key = keyFor(jwks, hdr.kid);
  if (sig.length !== 64) throw bad("ES256 гарын үсэг 64 байт биш");
  const ok = cryptoVerify("sha256", Buffer.from(`${h64}.${p64}`, "ascii"), { key, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) throw bad("гарын үсэг таарсангүй");

  let c: unknown;
  try {
    c = JSON.parse(pb.toString("utf8"));
  } catch {
    throw bad("payload JSON биш");
  }
  if (!isObj(c)) throw bad("payload JSON объект биш");
  if (c.iss !== (exp.issuer || DEFAULT_QR_ISSUER)) throw bad("iss таарсангүй");
  // aud = RP UUID (CA жижиг үсгээр бичнэ) — том/жижиг үсэг ялгахгүй.
  if (!exp.audience || typeof c.aud !== "string" || c.aud.toLowerCase() !== exp.audience.toLowerCase()) throw bad("aud (RP UUID) таарсангүй");
  if (!exp.sessionId || c.sid !== exp.sessionId) throw bad("sid таарсангүй");
  if (!exp.nonce || c.nonce !== exp.nonce) throw bad("nonce таарсангүй");
  if (typeof c.sub !== "string" || !c.sub) throw bad("sub алга");
  const now = exp.now ?? Date.now();
  const iat = numericDate(c.iat);
  if (iat === undefined) throw bad("iat алга");
  if (iat > now + QR_CLOCK_SKEW_MS) throw bad("iat ирээдүйд");
  if (now - iat > (exp.maxAgeMs && exp.maxAgeMs > 0 ? exp.maxAgeMs : DEFAULT_QR_MAX_AGE_MS)) throw bad("presentation хуучирсан");
  if ("exp" in c) {
    const e = numericDate(c.exp);
    if (e === undefined || now >= e + QR_CLOCK_SKEW_MS) throw bad("exp дууссан");
  }

  const want = new Set(exp.attributes);
  const got = new Set<string>();
  let attrs: Record<string, unknown> = {};
  if ("attrs" in c) {
    if (!isObj(c.attrs)) throw bad("attrs объект биш");
    attrs = c.attrs;
  }
  const out: QrPresentation = { sub: c.sub, attrs: {}, unavailable: [], sessionId: exp.sessionId, issuedAt: iat, jws };
  for (const [name, v] of Object.entries(attrs)) {
    if (!want.has(name)) throw bad(`хүсээгүй аттрибут: ${name}`);
    setAttr(out.attrs, name, v);
    got.add(name);
  }
  if ("unavailable" in c) {
    if (!Array.isArray(c.unavailable)) throw bad("unavailable массив биш");
    for (const x of c.unavailable) {
      if (typeof x !== "string" || !want.has(x) || got.has(x)) throw bad(`unavailable буруу: ${String(x)}`);
      got.add(x);
      out.unavailable.push(x as QrAttribute);
    }
  }
  if (got.size !== want.size) throw bad("хүссэн аттрибутын хариу дутуу");
  return out;
}

/**
 * Compact JWS-ийг `jwks`-ээр шалгаж (ES256, kid) claim-уудыг тулгана: iss, aud (RP UUID), sid, nonce, iat (≤ now+60 с,
 * ≥ now−maxAge), exp (байвал), attrs ∪ unavailable = хүссэн аттрибутууд яг, аттрибут бүрийн төрөл. Алдаа бол
 * {@link QrError} `QR_PRESENTATION_INVALID` — хариунд ИТГЭХГҮЙ. Сүлжээгүй (хадгалсан presentation-ийг дахин шалгах, тест).
 */
export function verifyQrPresentation(jws: string, jwks: Jwks | null | undefined, expect: QrExpect): QrPresentation {
  try {
    return verifyInner(jws, jwks, expect);
  } catch (e) {
    if (e instanceof UnknownKid) throw bad("JWKS-д kid алга");
    throw e;
  }
}

export interface QrApiDeps {
  http: Http;
  session: SessionApi;
  credentials: RpCredentials;
  config?: QrConfig;
  fetchImpl?: typeof fetch;
  dispatcher?: unknown;
  timeoutMs?: number;
}

/** `client.qr` — «Миний QR»: parse → start → result. */
export class QrApi {
  private jwks: Jwks | null = null;
  private fetchedAt = 0;
  private lastAttempt = 0;
  private inflight: Promise<Jwks> | null = null;

  constructor(private readonly d: QrApiDeps) {}

  /** {@link parseQr}. */
  parse(scanned: string): string {
    return parseQr(scanned);
  }

  /**
   * `POST /authentication/qr` — QR-ийн токеныг (нэг удаагийн) CA-д өгч иргэний утас руу хүсэлт илгээнэ; `vc`-г кассын
   * дэлгэцэнд харуул. Алдаа: {@link QrError} (FORMAT / ATTRIBUTES — CA руу явахгүй), 404 {@link QrTokenInvalidError}
   * (шинэ QR гаргуул), 403 ForbiddenError (QR_PRESENT / QR_ATTR:* эрх алга).
   */
  async start(input: QrStartInput): Promise<QrSession> {
    const token = parseQr(input.qr);
    const attributes = checkAttributes(input.attributes) as QrAttribute[];
    const rpChallenge = randomChallenge(32);
    const nonce = input.nonce?.trim() || undefined;
    const body = {
      qr: QR_PREFIX + token,
      attributes,
      relyingPartyUUID: this.d.credentials.rpUUID,
      relyingPartyName: this.d.credentials.rpName,
      signatureProtocol: "ACSP_V2",
      signatureProtocolParameters: { rpChallenge },
      ...(nonce ? { nonce } : {}),
    };
    const r = (await this.d.http.post(routePath(RP_ROUTES.authQr), body)) as Record<string, unknown>;
    const sessionId = typeof r.sessionID === "string" ? r.sessionID : "";
    if (!sessionId) throw new EidError("POST /authentication/qr: sessionID алга");
    const vcRaw = r.vc;
    const vc = typeof vcRaw === "string" ? vcRaw : isObj(vcRaw) && vcRaw.value != null ? String(vcRaw.value) : "";
    const expiresAt = parseExpiresAt(r.expiresAt);
    return { sessionId, vc, nonce: nonce ?? rpChallenge, attributes, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }

  /**
   * Session дуустал long-poll хийж presentation-ийг CA-ийн JWKS-ээр шалгана. Татгалзсан / хугацаа дууссан бол
   * SessionFailedError (`USER_REFUSED`, `TIMEOUT` г.м.); шалгалт унавал {@link QrError} `QR_PRESENTATION_INVALID`;
   * JWKS татагдахгүй бол `QR_JWKS_UNAVAILABLE` (дахин оролдож болно).
   */
  async result(session: QrSession, opts?: { maxWaitMs?: number; serverPollMs?: number }): Promise<QrPresentation> {
    if (!session?.sessionId) throw new EidError("qr.result: QrSession шаардлагатай");
    const r = await this.d.session.waitForResult(session.sessionId, { expiresAt: session.expiresAt, ...opts });
    if (r.state !== "COMPLETE") throw new QrError("QR_PENDING", "иргэн хараахан хариулаагүй");
    return this.finish(r, session);
  }

  /**
   * Нэг удаагийн шалгалт (polling UI-д): `GET /session/{id}` (`serverPollMs` хүртэл, анхдагч 1000 мс) — иргэн хараахан
   * хариулаагүй бол `{ state: "RUNNING" }`, зөвшөөрсөн бол JWS/JWKS-ээр шалгасан `{ state: "COMPLETE", presentation }`.
   * Татгалзсан / CA-ийн хугацаа дууссан бол SessionFailedError; бусад алдаа {@link result}-тэй ижил.
   */
  async check(session: QrSession, opts?: { serverPollMs?: number }): Promise<QrCheck> {
    if (!session?.sessionId) throw new EidError("qr.check: QrSession шаардлагатай");
    const r = await this.d.session.poll(session.sessionId, opts?.serverPollMs ?? 1_000);
    if (r.state !== "COMPLETE") return { state: "RUNNING" };
    return { state: "COMPLETE", presentation: await this.finish(r, session) };
  }

  private finish(r: SessionResult, session: QrSession): Promise<QrPresentation> {
    if (r.endResult !== "OK") throw new SessionFailedError(r.endResult ?? "UNKNOWN");
    const jws = r.presentation?.jws;
    if (!jws) throw bad("хариунд presentation алга");
    return this.verify(jws, session);
  }

  /** Хадгалсан presentation JWS-ийг QrSession-тэй тулгаж шалгана (JWKS кэш; танихгүй kid → нэг удаа дахин татна). */
  async verify(jws: string, session: QrSession): Promise<QrPresentation> {
    const cfg = this.d.config ?? {};
    const exp: QrExpect = {
      issuer: cfg.issuer,
      audience: this.d.credentials.rpUUID,
      sessionId: session.sessionId,
      nonce: session.nonce,
      attributes: session.attributes,
      maxAgeMs: cfg.maxAgeMs,
    };
    try {
      return verifyInner(jws, await this.keys(false), exp);
    } catch (e) {
      if (!(e instanceof UnknownKid)) throw e;
    }
    return verifyQrPresentation(jws, await this.keys(true), exp);
  }

  private async keys(force: boolean): Promise<Jwks> {
    const ttl = this.d.config?.jwksCacheTtlMs && this.d.config.jwksCacheTtlMs > 0 ? this.d.config.jwksCacheTtlMs : DEFAULT_QR_JWKS_CACHE_TTL_MS;
    const now = Date.now();
    const fresh = this.jwks && now - this.fetchedAt < ttl;
    if (fresh && (!force || now - this.lastAttempt < JWKS_MIN_REFRESH_MS)) return this.jwks!;
    if (!this.inflight) {
      this.lastAttempt = now;
      this.inflight = this.fetchJwks()
        .then((k) => {
          this.jwks = k;
          this.fetchedAt = Date.now();
          return k;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async fetchJwks(): Promise<Jwks> {
    const url = this.d.config?.jwksUrl || DEFAULT_QR_JWKS_URL;
    const fail = (why: string) => new QrError("QR_JWKS_UNAVAILABLE", why);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw fail("jwksUrl буруу");
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) {
      throw fail("jwksUrl https байх ёстой");
    }
    // RP secret ЭНД ИЛГЭЭХГҮЙ — нийтийн түлхүүр.
    const init: Record<string, unknown> = {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.d.timeoutMs ?? 15_000),
    };
    if (this.d.dispatcher) init.dispatcher = this.d.dispatcher;
    let res: Response;
    try {
      res = await (this.d.fetchImpl ?? fetch)(url, init as RequestInit);
    } catch (e) {
      throw fail(`татагдсангүй: ${(e as Error).message}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw fail(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length > MAX_JWKS) throw fail("JWKS хэт том");
    let k: unknown;
    try {
      k = JSON.parse(text);
    } catch {
      throw fail("JWKS JSON биш");
    }
    if (!isObj(k) || !Array.isArray(k.keys) || k.keys.length === 0) throw fail("JWKS хоосон");
    return k as unknown as Jwks;
  }
}
