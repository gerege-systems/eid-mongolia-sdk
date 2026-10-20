// «eID-ээр нэвтрэх» — RP backend-ийн бэлэн урсгал (RP-API v3 device link + push дээр). Браузерийн товч
// (`@gerege-systems/eid-mongolia-sdk/button`) энэ handler-уудыг дуудна:
//
//   POST {base}/start   {mode:"qr"}                        → desktop QR session      → {mode, qr, vc, expiresIn}
//   POST {base}/start   {mode:"push", idCode:"УБ12345678"} → утас руу мэдэгдэл       → {mode, vc, expiresIn}
//   GET  {base}/start?mode=web2app                          → утасны хөтөч: 302 → eID апп (Web2App холбоос)
//   GET  {base}/status                                      → PENDING (+шинэ QR) | WAIT_CALLBACK | OK | FAILED | EXPIRED
//   GET  {base}/callback?sessionId&userChallengeVerifier    → Web2App буцалт: шалгаад 303 → таны хуудас
//
// eID сервер Web2App callback-ийн замыг үргэлж `/auth/eid/callback` болгож нормчилдог тул {base} = `/auth/eid`.
// Төлөв (sessionToken, sessionSecret, rpChallenge, acsp) СЕРВЕРТ (store) хадгалагдана; хөтөчид зөвхөн HttpOnly cookie
// (`<sessionId>.<binding>`) — status/callback нь session-ийг ЭХЛҮҮЛСЭН хөтөчид л хариулна (login CSRF, relay хаалт).
// Иргэний мэдээлэл зөвхөн ResponseValidator-аар (гинж + ACSP_V2 + flowType + verifier) ба гэрчилгээний цуцлалтын
// шалгалтаар (OCSP, `revocation`) баталгаажсаны дараа onSuccess-д.
//
// Push (регистрийн дугаараар) нь бүртгэлтэй эсэхийг задлахгүй: eID дугаарыг татгалзвал decoy session (бодит хариутай
// ижил хэлбэр, хэн ч хариулаагүй мэт PENDING → EXPIRED), хариу бүр `pushFloorMs`-оос (анхдагч 1 с) хурдан гарахгүй.

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { EidClient } from "./client.js";
import { buildDeviceLink } from "./devicelinkv3.js";
import { ocspRevocationChecker } from "./ocsp.js";
import { ApiError, AuthenticationError, ForbiddenError, SessionFailedError, ValidationError } from "./errors.js";
import { personMatchesCertificate } from "./session.js";
import type { AcspContext, CertificateLevel, FlowType, PersonBlock, SessionResult } from "./types.js";
import type { RevocationChecker, RevocationOutcome } from "./validator.js";

/** Нэвтрэлтийн горим: desktop QR, регистрээр push, утасны хөтчөөс Web2App. */
export type EidLoginMode = "qr" | "push" | "web2app";

/** Баталгаажсан иргэн — onSuccess-д. */
export interface EidLoginIdentity {
  /** RP-API session-ий id (`sessionId`) — аудит, эсвэл энэ нэвтрэлтийг дараагийн алхамтай (гарын үсэг г.м.) холбоход. */
  sessionId: string;
  /** Гэрчилгээний SERIALNUMBER (`PNOMN-<иргэний дугаар>`). Хэрэглэгчийг ҮҮГЭЭР таньна (нэрээр биш). */
  etsi: string;
  /** `PNOMN-`-гүй иргэний дугаар (цифр); ETSI өөр хэлбэртэй бол null. */
  civilId: string | null;
  /** Гэрчилгээний нэр (латин): GIVENNAME / SURNAME, харуулах нэр. */
  givenName: string | null;
  surname: string | null;
  name: string | null;
  country: string | null;
  /**
   * Нэвтэрсэн төхөөрөмжийн UUID (RP-API `documentNumber`; иргэний бичиг баримтын дугаар ч, `PNOMN-…` ETSI ч биш) —
   * `client.sign.*ByDocument`-аар ижил төхөөрөмж рүү гарын үсэг. Тунгалаг мөр: хэлбэрийг задлахгүй.
   */
  documentNumber: string;
  certificateLevel: string;
  /** Иргэний нэвтрэлтийн гэрчилгээ (DER, base64) — validateAuth-аар гинж шалгагдсан. */
  certificateDerB64: string;
  /** Гарын үсэг зурагдсан урсгал: QR | Notification | Web2App. */
  flowType: FlowType;
  /** Session-ийн `person` блок (кирилл нэр г.м.) — гэрчилгээтэй таарсан үед л, эс бөгөөс null. */
  person: PersonBlock | null;
  /**
   * Гэрчилгээний цуцлалтын шалгалтын дүн: "good" | "unchecked" (OCSP хариугүй, soft-fail-ээр зөвшөөрөв) | "skipped"
   * (`revocation: false`). Аудитад хадгал.
   */
  revocation: RevocationOutcome;
}

/** Серверт хадгалах нэвтрэлтийн төлөв (JSON-д хувирна). */
export interface EidLoginTx {
  sessionId: string;
  /** Cookie-ийн binding-ийн SHA-256 (hex) — түүхий утга хөтчид л. */
  bindingHash: string;
  mode: EidLoginMode;
  expiresAt: number;
  vc: string | null;
  acsp: AcspContext;
  /** QR/Web2App: холбоос угсрах материал. sessionSecret — ЗӨВХӨН серверт. */
  link?: { base: string; token: string; secret: string; receivedAt: number; lang: string };
  /** eID татгалзсан push-ийн оронд өгсөн хуурмаг session (eID-д байхгүй; хэзээ ч дуусахгүй). Зөвхөн серверт. */
  decoy?: boolean;
}

/** Төлөвийн сан. Анхдагч — процессын санах ой ({@link memoryLoginStore}); олон instance бол Redis г.м. */
export interface EidLoginStore {
  get(sessionId: string): Promise<EidLoginTx | undefined> | EidLoginTx | undefined;
  set(sessionId: string, tx: EidLoginTx, ttlMs: number): Promise<void> | void;
  /** Устгана; байсан бол true. Амжилтыг нэг л удаа гаргахад ашиглана (атомар байх ёстой — Redis `DEL`). */
  delete(sessionId: string): Promise<boolean> | boolean;
}

/** {@link memoryLoginStore}-ийн анхдагч дээд хэмжээ (идэвхтэй нэвтрэлт). */
export const MEMORY_LOGIN_STORE_MAX = 10_000;

/** Санах ойн сан дүүрсэн (хугацаа нь дуусаагүй `max` нэвтрэлт) — start 503 `busy`. */
export class LoginStoreFullError extends Error {
  constructor() {
    super("eid-login: memory store дүүрсэн");
    this.name = "LoginStoreFullError";
  }
}

/**
 * Нэг процессын санах ойн сан (TTL-тэй). Олон instance / serverless-д тохирохгүй. Хэмжээ `max`-аар (анхдагч
 * {@link MEMORY_LOGIN_STORE_MAX}) хязгаарлагдана: дүүрвэл хугацаа дууссаныг цэвэрлээд, хоосроогүй бол ШИНЭ нэвтрэлтийг
 * {@link LoginStoreFullError}-оор татгалзана — эхэлсэн нэвтрэлтүүдийг хэзээ ч устгахгүй (хуучныг шахаж гаргахгүй).
 */
export function memoryLoginStore(max = MEMORY_LOGIN_STORE_MAX): EidLoginStore {
  const m = new Map<string, { tx: EidLoginTx; exp: number }>();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp <= Date.now()) {
        m.delete(k);
        return undefined;
      }
      return e.tx;
    },
    set(k, tx, ttl) {
      const now = Date.now();
      if (!m.has(k) && m.size >= max) {
        for (const [key, e] of m) if (e.exp <= now) m.delete(key);
        if (m.size >= max) throw new LoginStoreFullError();
      }
      m.set(k, { tx, exp: now + ttl });
    },
    delete(k) {
      return m.delete(k);
    },
  };
}

/** Хүсэлтийн хүрээ — onSuccess / rateLimit / onError-д. */
export interface EidLoginContext {
  request: EidLoginRequest;
  mode: EidLoginMode;
}

/** onSuccess-ийн хариу: хаашаа явуулах, хөтчид буцаах өгөгдөл, нэмэлт header (ж: таны session-ийн Set-Cookie). */
export interface EidLoginSuccess {
  /** Нэвтэрсний дараах хуудас (same-origin зам эсвэл URL). Callback (Web2App)-д анхдагч `successRedirect`. */
  redirect?: string;
  /** QR/push-д status хариунд `data` болж хөтчид очно (JSON). Нууц бүү оруул. */
  data?: unknown;
  headers?: Record<string, string | string[]>;
}

/**
 * Аудитын үйл явдал (`onEvent`):
 * - `push_sent` — push start амжилттай хариулсан (meta: mode, pushKey, decoy). `decoy: true` бол eID дугаарыг татгалзаж
 *   утас руу юу ч очоогүй — хөтөч рүү хэзээ ч илэрхийлэгдэхгүй, зөвхөн таны аудитад.
 * - `push_limited` — push хязгаарт хүрсэн, 429 (meta: mode, pushKey; sessionId null).
 * - `refused` — иргэн утсан дээрээ татгалзсан (endResult USER_REFUSED*).
 * - `expired` — eID session хугацаа дууссан (endResult TIMEOUT эсвэл eID-д олдохгүй).
 * - `unverified` — баталгаажуулалт унасан (meta.reason: "validation" | "revoked" | "revocation_unavailable").
 * - `flow_refused` — Web2App callback эхлүүлсэн хөтчийн session-тэй холбогдоогүй (meta.reason: "unbound").
 * - `success` — иргэн баталгаажиж onSuccess дуудагдсан (meta: mode, flow, revocation).
 * - `failed` — бусад endResult (WRONG_VC, DOCUMENT_UNUSABLE г.м.; meta.endResult).
 */
export type EidLoginEventKind =
  | "push_sent"
  | "push_limited"
  | "refused"
  | "expired"
  | "unverified"
  | "flow_refused"
  | "success"
  | "failed";

/** `onEvent`-ийн аргумент. meta-д токен/нууц, регистрийн дугаар (PII) орохгүй. */
export interface EidLoginEvent {
  kind: EidLoginEventKind;
  sessionId: string | null;
  meta: Record<string, unknown>;
}

/** Хязгаарлагч: true — зөвшөөрөх, false — 429. */
export type EidLoginRateLimitFn = (key: string) => boolean | Promise<boolean>;

/** Нэг төрлийн хязгаар: санах ойн гулсах цонх, өөрийн функц, эсвэл `false` (хязгааргүй). */
export type EidLoginRateRule = { limit: number; windowMs: number } | EidLoginRateLimitFn | false;

/** Төрөл тус бүрийн хязгаар: `start` — `start:<ip>`, `push` — `push:<idCode>`. */
export interface EidLoginRateLimits {
  start?: EidLoginRateRule;
  push?: EidLoginRateRule;
}

/**
 * Анхдагч хязгаар — `rateLimit`-ийн объектод өгөөгүй төрөл энүүгээр үлдэнэ. `{ ...defaultRateLimit, start: … }`.
 * push: нэг дугаарт 60 секундэд 3 (MFA fatigue); start (0.19.0-аас): нэг IP-ээс 60 секундэд 20 (ip мэдэгдэж байвал —
 * `req.ip` / `trustProxy`).
 */
export const defaultRateLimit: Readonly<EidLoginRateLimits> = Object.freeze({
  start: Object.freeze({ limit: 20, windowMs: 60_000 }),
  push: Object.freeze({ limit: 3, windowMs: 60_000 }),
});

/** Санах ойн хязгаарлагчийн дээд түлхүүрийн тоо (төрөл тус бүрд). */
const LIMITER_MAX_KEYS = 10_000;

const RATE_KINDS = ["start", "push"] as const;

/**
 * Санах ойн гулсах цонх (түлхүүр тус бүрд), дээд тал нь {@link LIMITER_MAX_KEYS} түлхүүр. Дүүрвэл цонх нь өнгөрсөн
 * түлхүүрийг цэвэрлээд, хоосроогүй бол ШИНЭ түлхүүрийг татгалзана (fail-closed) — байгаа түлхүүрийн тоолуурыг хэзээ ч
 * арилгахгүй тул олон түлхүүрээр дүүргэж тухайн дугаарын хязгаарыг тойрох боломжгүй (0.18.x бүгдийг цэвэрлэдэг байв).
 */
function windowLimiter(limit: number, windowMs: number, maxKeys = LIMITER_MAX_KEYS): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key) => {
    const now = Date.now();
    const h = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (!hits.has(key) && hits.size >= maxKeys) {
      for (const [k, ts] of hits) if (!ts.some((t) => now - t < windowMs)) hits.delete(k);
      if (hits.size >= maxKeys) return false;
    }
    if (h.length >= limit) {
      hits.set(key, h);
      return false;
    }
    h.push(now);
    hits.set(key, h);
    return true;
  };
}

/** `rateLimit` тохиргоог анхдагчтай нэгтгэж нэг функц болгоно. */
function buildRateLimit(opt: EidLoginOptions["rateLimit"]): EidLoginRateLimitFn {
  const extra = typeof opt === "function" ? opt : undefined;
  const user = opt && typeof opt === "object" ? opt : {};
  for (const k of Object.keys(user)) {
    if (!(RATE_KINDS as readonly string[]).includes(k)) throw new Error(`createEidLogin: rateLimit.${k} — зөвхөн start | push`);
  }
  const merged: EidLoginRateLimits = { ...defaultRateLimit, ...user };
  const perKind = new Map<string, EidLoginRateLimitFn>();
  for (const k of RATE_KINDS) {
    const r = merged[k];
    if (r === undefined || r === false) continue;
    if (typeof r === "function") {
      perKind.set(k, r);
      continue;
    }
    if (!(Number.isInteger(r.limit) && r.limit > 0 && r.windowMs > 0)) {
      throw new Error(`createEidLogin: rateLimit.${k} — limit (бүхэл > 0), windowMs (> 0)`);
    }
    perKind.set(k, windowLimiter(r.limit, r.windowMs));
  }
  return async (key) => {
    const fn = perKind.get(key.slice(0, key.indexOf(":")));
    if (fn && !(await fn(key))) return false;
    return extra ? extra(key) : true;
  };
}

export interface EidLoginOptions {
  client: EidClient;
  /**
   * RP-ийн session-ийг ЭНД үүсгэнэ (иргэн баталгаажсан). Хэрэглэгчийг `identity.etsi`-ээр таньж, шинэ session
   * (session fixation-аас сэргийлж шинэ id) үүсгээд Set-Cookie-г `headers`-ээр буцаа.
   */
  onSuccess: (identity: EidLoginIdentity, ctx: EidLoginContext) => Promise<EidLoginSuccess | void> | EidLoginSuccess | void;
  /**
   * Web2App буцах https URL — host нь RP-ийн `callbackHosts`-д, зам нь ЗААВАЛ `/auth/eid/callback`. Өгөөгүй бол
   * утасны хөтчийн урсгал (`mode=web2app`) 400 — QR/push л ажиллана.
   */
  callbackUrl?: string;
  /** Callback амжилттай болоход (onSuccess redirect өгөөгүй бол). Анхдагч "/". */
  successRedirect?: string;
  /** Callback амжилтгүй болоход — `?eid_error=<код>` нэмэгдэнэ. Анхдагч "/". */
  failureRedirect?: string;
  /** Утсанд харагдах текст (≤60). Анхдагч «<rpName>-д нэвтрэх». */
  displayText?: string;
  certificateLevel?: CertificateLevel;
  /**
   * Нэвтрэлтийн хугацаа (мс). Анхдагч 120 000. CA-ийн session-оос урт байхгүй: QR/web2app-д min(ttlMs, CA-ийн
   * `expiresAt` − одоо); push-д (бодит ба decoy ижил) min(ttlMs, discovery `sessionTtl.auth`) — decoy-д CA хариу
   * байхгүй тул хугацааны зөрүү бүртгэлтэй эсэхийн oracle болохгүй.
   */
  ttlMs?: number;
  /** Status-ийн нэг дуудлагад eID-ийг хүлээх (мс). Анхдагч 1000. */
  pollMs?: number;
  store?: EidLoginStore;
  cookie?: { name?: string; path?: string; secure?: boolean; domain?: string };
  /**
   * Хязгаарлалт. Түлхүүр: `start:<ip>` (ip мэдэгдэж байвал), `push:<idCode>`; false → 429.
   * Анхдагч {@link defaultRateLimit}: push-д нэг дугаарт 60 секундэд 3 (санах ойд) — MFA fatigue-ээс; start-д нэг IP-ээс
   * 60 секундэд 20 (0.19.0-аас).
   *
   * - Объект `{ start?, push? }` — анхдагчтай НЭГТГЭГДЭНЭ: өгсөн төрөл анхдагчийг дарна, өгөөгүй нь анхдагчаараа.
   *   Утга: `{ limit, windowMs }` (санах ойн гулсах цонх), функц (Redis г.м.) эсвэл `false` (тухайн төрлийг хязгаарлахгүй).
   * - Функц `(key) => boolean` — бүх түлхүүрт дуудагдана, анхдагч хязгаар ДЭЭР НЭМЭГДЭНЭ (хоёулаа зөвшөөрөх ёстой).
   *   Анхдагчийг сулруулах/солих бол объект хэлбэрээр тухайн төрлийг өг.
   */
  rateLimit?: EidLoginRateLimitFn | EidLoginRateLimits;
  /**
   * `handle(Request)`-ийн клиент IP (`start:<ip>` хязгаарт). Web-standard `Request`-д IP байдаггүй тул эсвэл энийг, эсвэл
   * {@link EidLoginOptions.trustProxy}-г өг; аль нь ч үгүй бол IP-ээр хязгаарлахгүй (анхны дуудлагад onError-оор анхааруулна).
   * Ж: Vercel/Next `req.headers.get("x-real-ip")`, Bun `server.requestIP(req)?.address`, Deno `info.remoteAddr.hostname`.
   */
  getClientIp?: (req: Request) => string | undefined | null;
  /**
   * Итгэмжит reverse proxy-ийн ард: IP-г `X-Forwarded-For`-оос (байхгүй бол `X-Real-IP`) уншина.
   * `true` — XFF-ийн хамгийн зүүн утга (бүх hop итгэмжит; зөвхөн proxy нь клиентийн XFF-ийг дарж бичдэг бол);
   * тоо `n` — баруунаас n дахь утга (n = таны итгэмжит proxy-ийн тоо; nginx нэг бол 1). Proxy-гүй үед бүү асаа —
   * header-ийг клиент хуурамчаар илгээж хязгаарыг тойрно. `handleRequest`-д `req.ip` өгөөгүй үед ч хэрэглэгдэнэ.
   */
  trustProxy?: boolean | number;
  /** Дотоод алдаа (eID API, store). Анхдагч console.error (мессеж л). */
  onError?: (err: unknown, ctx: EidLoginContext) => void;
  /**
   * eID push-ийг дугаарын шалтгаанаар татгалзвал (eID-ийн өөрийн JSON 4xx — танихгүй / ашиглах боломжгүй дугаар) decoy
   * session-оор хариулна (анхдагч `true`). ⚠️ `false` бол `/start` нь «энэ регистр eID-д бүртгэлтэй эсэх»-ийг
   * нэвтрээгүй хэнд ч хэлдэг oracle болно — зөвхөн дотоод/тестийн орчинд.
   */
  decoy?: boolean;
  /**
   * Push start-ийн хариу (бодит, decoy, 502) хамгийн багадаа энэ хугацаанд (мс) гарна: decoy микросекундэд, бодит push
   * eID-ийн round trip-ээр бэлэн болдог тул цаг нь л ялгана. Анхдагч 1000; `0` — унтраана (⚠️ decoy-г хугацаагаар
   * ялгаж болно). Хүсэлт тасарвал (`signal`) хүлээхгүй. Хязгаарлагчийн 429 ба 400-д
   * хамаарахгүй (eID-ийн 429 ба 503 `busy` floor-той).
   */
  pushFloorMs?: number;
  /**
   * Иргэний гэрчилгээний цуцлалт шалгагч (onSuccess-ийн өмнө). Анхдагч {@link ocspRevocationChecker} — гэрчилгээний AIA
   * OCSP. Цуцлагдсан / олгогч мэдэхгүй → FAILED "VALIDATION". ⚠️ `false` — шалгахгүй: цуцалсан (хулгайлагдсан утасны)
   * гэрчилгээгээр нэвтэрнэ.
   */
  revocation?: RevocationChecker | false;
  /**
   * OCSP хариугүй үед (timeout, 5xx, AIA алга): "soft-fail" (анхдагч) — зөвшөөрч onError-оор анхааруулна,
   * `identity.revocation = "unchecked"` (eID порталын EID_OCSP=soft: CA-ийн responder унавал бүх иргэн түгжигдэхгүй);
   * "hard-fail" — FAILED "VALIDATION".
   */
  revocationMode?: "soft-fail" | "hard-fail";
  /**
   * Аудитын hook ({@link EidLoginEventKind}). Хариу өгөхөөс өмнө await хийгдэнэ — удаан ажлыг өөрөө async болго; алдаа нь
   * onError руу (урсгалыг зогсоохгүй). Push-д регистр биш `pushKey` = HMAC-SHA256(auditKey, дугаар)-ын 32 hex.
   */
  onEvent?: (event: EidLoginEvent) => void | Promise<void>;
  /**
   * pushKey-ийн HMAC түлхүүр (≥ 32 байт санал болгоно). Алга бол санамсаргүй — pushKey зөвхөн процесс дотор тогтвортой;
   * instance/restart хооронд харьцуулах бол тогтмол нууц өг.
   */
  auditKey?: string | Uint8Array;
}

/** Framework-аас хамааралгүй хүсэлт (Express: `req.headers`, `req.body`, `req.ip`). */
export interface EidLoginRequest {
  method: string;
  /** Зам + query (`/auth/eid/status?…`) эсвэл бүтэн URL. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** POST-ийн задалсан JSON (Express `express.json()`), эсвэл түүхий мөр. */
  body?: unknown;
  ip?: string;
  /** Хүсэлт тасрахад (клиент холболтоо хаасан) — `pushFloorMs` ба decoy poll-ын хүлээлтийг таслана. */
  signal?: AbortSignal;
}

export interface EidLoginResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface EidLogin {
  /** Сүүлийн замын хэсгээр (`start` | `status` | `callback`) чиглүүлнэ. */
  handleRequest(req: EidLoginRequest): Promise<EidLoginResponse>;
  /** Web-standard (Next.js App Router, Hono, Bun, Deno). */
  handle(req: Request): Promise<Response>;
}

const CALLBACK_PATH = "/auth/eid/callback";

/**
 * Итгэмжит proxy-ийн header-ээс клиент IP (`trustProxy`-ийн дүрэм). XFF-д хангалттай hop байхгүй бол хамгийн зүүн
 * утгыг (proxy-д ирсэн анхны) биш undefined буцаана — хуурамч header-ээр тойрохоос.
 */
export function forwardedClientIp(headers: EidLoginRequest["headers"], trustProxy: boolean | number): string | undefined {
  if (trustProxy === false || trustProxy === 0) return undefined;
  const xff = header(headers, "x-forwarded-for")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (xff.length) {
    if (trustProxy === true) return xff[0];
    const n = Math.floor(trustProxy);
    return n >= 1 && n <= xff.length ? xff[xff.length - n] : undefined;
  }
  return header(headers, "x-real-ip").trim() || undefined;
}
const ID_RE = /^(\p{L}{2}[0-9]{8}|[0-9]{8,14}|PNOMN-[0-9]{8,14})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{43}$/;

// Апп approve-ийн дараа эхэлсэн хөтөч рүү буцах hint (ca-eidmongolia-mn docs/RP_GEREGE_INTEGRATION.md §1.1b).
const IOS_BROWSERS: Array<[RegExp, string]> = [
  [/CriOS/i, "googlechromes"],
  [/EdgiOS/i, "microsoft-edge-https"],
  [/FxiOS/i, "firefox"],
  [/OPT\//i, "touch-https"],
  [/OPiOS|OPR\//i, "opera-https"],
  [/DuckDuckGo/i, "ddgQuickLink"],
];
const ANDROID_BROWSERS: Array<[RegExp, string]> = [
  [/EdgA\//i, "com.microsoft.emmx"],
  [/Opera Mini/i, "com.opera.mini.native"],
  [/OPR\//i, "com.opera.browser"],
  [/SamsungBrowser\//i, "com.sec.android.app.sbrowser"],
  [/YaBrowser\//i, "com.yandex.browser"],
  [/DuckDuckGo\//i, "com.duckduckgo.mobile.android"],
  [/Vivaldi\//i, "com.vivaldi.browser"],
  [/Firefox\//i, "org.mozilla.firefox"],
  [/Chrome\//i, "com.android.chrome"],
];

/** `callbackUrl`-д буцах хөтчийн hint (`retScheme` iOS / `retPkg` Android) нэмнэ; танихгүй бол хэвээр. */
export function withReturnHint(callbackUrl: string, userAgent: string): string {
  const u = new URL(callbackUrl);
  const pick = (t: Array<[RegExp, string]>) => t.find(([re]) => re.test(userAgent))?.[1];
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    const v = pick(IOS_BROWSERS);
    if (v) u.searchParams.set("retScheme", v);
  } else if (/Android/i.test(userAgent)) {
    const v = pick(ANDROID_BROWSERS);
    if (v) u.searchParams.set("retPkg", v);
  }
  return u.toString();
}

function header(h: EidLoginRequest["headers"], name: string): string {
  const v = h[name] ?? h[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function readCookie(h: EidLoginRequest["headers"], name: string): string {
  for (const part of header(h, "cookie").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** ms хүлээнэ, эсвэл signal тасрах хүртэл. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * eID-ийн ӨӨРИЙН (JSON биетэй) 4xx: дугаарыг татгалзсан (танихгүй / ашиглах боломжгүй, хүсэлтийн параметр). JSON бус 4xx
 * нь eID-ийн өмнөх proxy-ийнх (mTLS татгалзал г.м.) — тасалдал. 401/403 (AuthenticationError / ForbiddenError — RP-ийн
 * нууц/эрх) ба 429 нь дугаараас хамаардаггүй тул decoy-гүй — тэдгээрийг нуувал тасалдал харагдахгүй.
 */
function isRefusal(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status < 400 || e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 429) {
    return false;
  }
  try {
    JSON.parse(e.body);
    return true;
  } catch {
    return false;
  }
}

/** Гэрчилгээний цуцлалтын шалгалт унасан (ValidationError — FAILED "VALIDATION"). */
class RevocationFailure extends ValidationError {
  constructor(
    message: string,
    readonly revoked: boolean,
  ) {
    super(message);
  }
}

function toIdentity(
  sessionId: string,
  r: SessionResult,
  v: ReturnType<EidClient["validator"]["validateAuth"]>,
  flowType: FlowType,
  revocation: RevocationOutcome,
): EidLoginIdentity {
  const s = v.parsedSubject;
  const etsi = s.serialNumber ?? "";
  const m = /^PNOMN-([0-9]+)$/.exec(etsi);
  return {
    sessionId,
    etsi,
    civilId: m ? m[1]! : null,
    givenName: s.givenName ?? null,
    surname: s.surname ?? null,
    name: s.name,
    country: s.country ?? null,
    documentNumber: v.documentNumber,
    certificateLevel: v.certificateLevel,
    certificateDerB64: r.certificateDerB64 ?? "",
    flowType,
    person: personMatchesCertificate(r.person, s) ? (r.person ?? null) : null,
    revocation,
  };
}

/**
 * «eID-ээр нэвтрэх»-ийн backend handler-ууд. Нэг instance-ийг модулийн түвшинд үүсгээд бүх хүсэлтэд ашиглана.
 *
 * @throws Error `callbackUrl` https биш эсвэл зам нь `/auth/eid/callback` биш бол.
 */
export function createEidLogin(opts: EidLoginOptions): EidLogin {
  const client = opts.client;
  if (!opts.onSuccess) throw new Error("createEidLogin: onSuccess шаардлагатай");
  if (opts.callbackUrl) {
    const u = new URL(opts.callbackUrl);
    if (u.protocol !== "https:" || u.pathname !== CALLBACK_PATH) {
      throw new Error(`createEidLogin: callbackUrl нь https://<таны host>${CALLBACK_PATH} байх ёстой`);
    }
  }
  const store = opts.store ?? memoryLoginStore();
  const ttl = opts.ttlMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1000;
  const cookieName = opts.cookie?.name ?? "eid_login";
  const cookiePath = opts.cookie?.path ?? "/";
  const secure = opts.cookie?.secure ?? true;
  const successRedirect = opts.successRedirect ?? "/";
  const failureRedirect = opts.failureRedirect ?? "/";
  const onError = opts.onError ?? ((e: unknown) => console.error("eid-login:", e instanceof Error ? e.message : e));
  const rateLimit = buildRateLimit(opts.rateLimit);
  const decoyOn = opts.decoy !== false;
  const pushFloorMs = opts.pushFloorMs ?? 1000;
  const revocation = opts.revocation === false ? undefined : (opts.revocation ?? ocspRevocationChecker());
  const revocationMode = opts.revocationMode ?? "soft-fail";
  const auditKey = opts.auditKey ?? randomBytes(32);
  // CA-ийн нэвтрэлтийн session-ий хугацаа (discovery sessionTtl.auth; хуучин CA-д бодит push-ээс ажигласан), кэштэй.
  let caTtl = 0;
  let caTtlNext = 0;
  let caTtlInflight: Promise<number> | undefined;
  /** Бодит ба decoy push хоёулаа дууддаг — ижил хоцрол. Татаж чадахгүй бол өмнөх утга (эсвэл 0); 10 мин кэш, алдаа 1 мин. */
  function authTtl(ctx: EidLoginContext): Promise<number> {
    if (Date.now() < caTtlNext) return Promise.resolve(caTtl);
    caTtlInflight ??= (async () => {
      caTtlNext = Date.now() + 60_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const t = await Promise.race([
          client.auth.sessionTtl(),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error("discovery timeout")), 2000);
          }),
        ]);
        caTtlNext = Date.now() + 600_000;
        if (t.authMs > 0) caTtl = t.authMs;
      } catch (e) {
        onError(new Error(`eid-login: discovery sessionTtl: ${e instanceof Error ? e.message : e}`), ctx);
      } finally {
        clearTimeout(timer);
        caTtlInflight = undefined;
      }
      return caTtl;
    })();
    return caTtlInflight;
  }
  /** Хуучин CA (discovery-д sessionTtl алга): бодит push-ийн expiresAt − илгээсэн мөчөөс (±1 с). */
  function observeAuthTtl(sent: number, expiresAt: number | undefined) {
    if (expiresAt === undefined || caTtl > 0) return;
    const d = Math.round((expiresAt - sent) / 1000) * 1000;
    if (d > 0) caTtl = d;
  }
  const pushKey = (idCode: string) => createHmac("sha256", auditKey).update(`eid-push-audit:${idCode}`).digest("hex").slice(0, 32);

  async function emit(kind: EidLoginEventKind, sessionId: string | null, meta: Record<string, unknown>, ctx: EidLoginContext) {
    if (!opts.onEvent) return;
    try {
      await opts.onEvent({ kind, sessionId, meta });
    } catch (e) {
      onError(e, ctx);
    }
  }
  /** COMPLETE, endResult != OK-ийн аудит. */
  function endEvent(tx: EidLoginTx, endResult: string | null | undefined, ctx: EidLoginContext) {
    const kind: EidLoginEventKind = endResult?.startsWith("USER_REFUSED") ? "refused" : endResult === "TIMEOUT" ? "expired" : "failed";
    return emit(kind, tx.sessionId, { mode: tx.mode, endResult: endResult ?? "UNKNOWN" }, ctx);
  }
  function unverified(tx: EidLoginTx, e: unknown, ctx: EidLoginContext) {
    const reason = e instanceof RevocationFailure ? (e.revoked ? "revoked" : "revocation_unavailable") : "validation";
    return emit("unverified", tx.sessionId, { mode: tx.mode, reason }, ctx);
  }

  const displayText = (opts.displayText ?? `${client.rpName}-д нэвтрэх`).slice(0, 60);
  const interactions = [{ type: "displayTextAndPIN" as const, displayText60: displayText }];

  const json = (status: number, body: unknown, extra: Record<string, string | string[]> = {}): EidLoginResponse => ({
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
    body: JSON.stringify(body),
  });
  const cookieAttrs = (maxAge: number) =>
    `Path=${cookiePath}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}` +
    (opts.cookie?.domain ? `; Domain=${opts.cookie.domain}` : "");
  const clearCookie = `${cookieName}=; ${cookieAttrs(0)}`;
  const redirect = (to: string, extra: Record<string, string | string[]> = {}): EidLoginResponse => ({
    status: 303,
    headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra },
    body: "",
  });
  const failTo = (code: string) => {
    const u = new URL(failureRedirect, "http://x");
    u.searchParams.set("eid_error", code);
    return /^https?:/i.test(failureRedirect) ? u.toString() : u.pathname + u.search + u.hash;
  };
  const mergeHeaders = (a: Record<string, string | string[]>, b?: Record<string, string | string[]>) => {
    const out: Record<string, string | string[]> = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      const key = Object.keys(out).find((x) => x.toLowerCase() === k.toLowerCase()) ?? k;
      const prev = out[key];
      out[key] = key.toLowerCase() === "set-cookie" && prev ? [...[prev].flat(), ...[v].flat()] : v;
    }
    return out;
  };

  /** Cookie → tx (binding таарсан, хугацаа дотор). */
  async function loadTx(req: EidLoginRequest): Promise<EidLoginTx | undefined> {
    const raw = readCookie(req.headers, cookieName);
    const dot = raw.indexOf(".");
    const sid = raw.slice(0, dot);
    const binding = raw.slice(dot + 1);
    if (dot < 0 || !UUID_RE.test(sid) || !B64URL_RE.test(binding)) return undefined;
    const tx = await store.get(sid);
    if (!tx || !safeEqualHex(tx.bindingHash, sha256hex(binding))) return undefined;
    if (tx.expiresAt <= Date.now()) {
      await store.delete(sid);
      return undefined;
    }
    return tx;
  }

  function qrLink(tx: EidLoginTx): string | undefined {
    if (tx.mode !== "qr" || !tx.link) return undefined;
    return buildDeviceLink({
      deviceLinkBase: tx.link.base,
      deviceLinkType: "QR",
      sessionToken: tx.link.token,
      sessionSecret: tx.link.secret,
      sessionType: "auth",
      lang: tx.link.lang,
      receivedAt: tx.link.receivedAt,
      rpChallenge: tx.acsp.rpChallenge,
      relyingPartyName: tx.acsp.relyingPartyName,
      interactions: tx.acsp.interactions,
    });
  }

  /** ttlMs — push-д discovery-оор таслагдсан; QR/web2app-д CA-ийн expiresAt-аар дахин таслагдана. */
  async function begin(req: EidLoginRequest, mode: EidLoginMode, idCode: string, lang: string, ttlMs: number) {
    const sent = Date.now();
    const level = opts.certificateLevel ? { certificateLevel: opts.certificateLevel } : {};
    let tx: Omit<EidLoginTx, "bindingHash" | "expiresAt">;
    let appLink: string | undefined;
    if (mode === "push") {
      const s = await client.auth.notificationByEtsi(idCode, interactions, level);
      tx = { sessionId: s.sessionId, mode, vc: s.vc, acsp: s.acsp! };
      observeAuthTtl(sent, s.expiresAt);
    } else {
      const callbackUrl = mode === "web2app" ? withReturnHint(opts.callbackUrl!, header(req.headers, "user-agent")) : undefined;
      const s = await client.auth.deviceLinkAnonymous(interactions, { ...level, callbackUrl });
      if (!s.deviceLinkBase || !s.sessionToken || !s.sessionSecret || !s.acsp) throw new Error("eID хариунд device link талбар дутуу");
      if (s.expiresAt !== undefined) ttlMs = Math.min(ttlMs, Math.floor((s.expiresAt - Date.now()) / 1000) * 1000);
      tx = {
        sessionId: s.sessionId,
        mode,
        vc: s.vc,
        acsp: s.acsp,
        link: { base: s.deviceLinkBase, token: s.sessionToken, secret: s.sessionSecret, receivedAt: s.receivedAt, lang },
      };
      if (mode === "web2app") {
        appLink = buildDeviceLink({
          deviceLinkBase: s.deviceLinkBase,
          deviceLinkType: "Web2App",
          sessionToken: s.sessionToken,
          sessionSecret: s.sessionSecret,
          sessionType: "auth",
          lang,
          rpChallenge: s.acsp.rpChallenge,
          relyingPartyName: s.acsp.relyingPartyName,
          interactions: s.acsp.interactions,
          initialCallbackUrl: s.acsp.initialCallbackUrl,
        });
      }
    }
    if (ttlMs < 1000) throw new Error("eID session-ий хугацаа дууссан (expiresAt)");
    return { ...(await save(tx, ttlMs)), appLink };
  }

  /** Cookie binding үүсгэж tx-ийг ttlMs-тэй хадгална. */
  async function save(tx: Omit<EidLoginTx, "bindingHash" | "expiresAt">, ttlMs: number) {
    const binding = randomBytes(32).toString("base64url");
    const full: EidLoginTx = { ...tx, bindingHash: sha256hex(binding), expiresAt: Date.now() + ttlMs };
    await store.set(full.sessionId, full, ttlMs);
    const expiresIn = Math.ceil(ttlMs / 1000);
    const setCookie = `${cookieName}=${full.sessionId}.${binding}; ${cookieAttrs(expiresIn)}`;
    return { tx: full, setCookie, expiresIn, appLink: undefined as string | undefined };
  }

  /**
   * eID-д байхгүй, хэзээ ч дуусахгүй push session: санамсаргүй UUID v4, eID-тэй ижил 5 оронтой vc (CA: %05d), бодит
   * push-ийн ttlMs (min(ttlMs, discovery sessionTtl.auth)). Status нь pollMs-ийн хугацаанд барьж PENDING, TTL-ийн дараа EXPIRED — утсаа аваагүй иргэнтэй ижил.
   */
  function startDecoy(ttlMs: number) {
    const acsp = undefined as unknown as AcspContext; // decoy-д ACSP байхгүй (хэзээ ч баталгаажуулахгүй)
    return save({ sessionId: randomUUID(), mode: "push", vc: String(randomInt(100000)).padStart(5, "0"), acsp, decoy: true }, ttlMs);
  }

  async function start(req: EidLoginRequest): Promise<EidLoginResponse> {
    const url = new URL(req.url, "http://x");
    // CSRF: cross-site хүсэлтээр session/push эхлүүлэхгүй. POST нь JSON (simple request биш → CORS preflight).
    const site = header(req.headers, "sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") return json(403, { error: "cross_site" });
    let body: Record<string, unknown> = {};
    if (req.method === "GET") {
      if (url.searchParams.get("mode") !== "web2app") return json(405, { error: "method_not_allowed" });
      body = { mode: "web2app", lang: url.searchParams.get("lang") ?? undefined };
    } else if (req.method === "POST") {
      if (!header(req.headers, "content-type").toLowerCase().startsWith("application/json")) {
        return json(415, { error: "json_required" });
      }
      try {
        const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        if (b && typeof b === "object") body = b as Record<string, unknown>;
      } catch {
        return json(400, { error: "invalid_body" });
      }
    } else {
      return json(405, { error: "method_not_allowed" });
    }
    const mode = body.mode;
    if (mode !== "qr" && mode !== "push" && mode !== "web2app") return json(400, { error: "invalid_mode" });
    const lang = body.lang === "en" ? "eng" : "mon";
    const ctx: EidLoginContext = { request: req, mode };
    if (mode === "web2app" && !opts.callbackUrl) return json(400, { error: "web2app_not_configured" });
    const idCode = typeof body.idCode === "string" ? body.idCode.replace(/\s+/g, "").toUpperCase() : "";
    if (mode === "push" && !ID_RE.test(idCode)) return json(400, { error: "invalid_id" });

    const limited = async () => {
      if (mode === "push") await emit("push_limited", null, { mode, pushKey: pushKey(idCode) }, ctx);
      return json(429, { error: "rate_limited" }, { "Retry-After": "60" });
    };
    const ip = req.ip || (opts.trustProxy ? forwardedClientIp(req.headers, opts.trustProxy) : undefined);
    if (ip && !(await rateLimit(`start:${ip}`))) return limited();
    if (mode === "push" && !(await rateLimit(`push:${idCode}`))) return limited();

    const began = Date.now();
    let ttlMs = ttl;
    if (mode === "push") {
      // Бодит ба decoy push ижил хугацаа авна — CA-ийн хариунаас биш (decoy-д байхгүй), discovery-оос.
      const ca = await authTtl(ctx);
      if (ca > 0) ttlMs = Math.min(ttlMs, ca);
    }
    let r: Awaited<ReturnType<typeof begin>> | undefined;
    let err: unknown;
    let decoy = false;
    try {
      r = await begin(req, mode, idCode, lang, ttlMs);
    } catch (e) {
      err = e;
    }
    if (err !== undefined && mode === "push" && decoyOn && isRefusal(err)) {
      // eID дугаарыг татгалзсан (танихгүй / ашиглах боломжгүй): ялгаатай хариу нь «энэ регистр бүртгэлтэй эсэх»-ийн
      // oracle болно. Хэн ч хариулаагүй push-тэй ижил decoy өгнө; шалтгаан onError ба onEvent-д л үлдэнэ.
      // Биеийг дамжуулахгүй (дугаарыг давтаж болзошгүй) — статус/код л.
      const ae = err as ApiError;
      onError(new Error(`eid-login: eID push-ийг татгалзав (${ae.status}${ae.code ? ` ${ae.code}` : ""}); decoy session-оор хариулав`), ctx);
      err = undefined;
      try {
        r = await startDecoy(ttlMs);
        decoy = true;
      } catch (e) {
        err = e;
      }
    }
    // Decoy микросекундэд, бодит push eID-ийн round trip-ээр бэлэн болно — хоёуланг ижил доод хугацаанд барина.
    if (mode === "push" && pushFloorMs > 0) await sleep(began + pushFloorMs - Date.now(), req.signal);
    if (err !== undefined || !r) {
      // eID-ийн 5xx / холболт / 401-403 — манай талын тасалдал (decoy-оор нуувал иргэн дуусахгүй spinner харна).
      // Бүртгэлтэй ба бүртгэлгүй дугаар хоёулаа ижил 502 авна.
      onError(err, ctx);
      if (err instanceof ApiError && err.status === 429) return limited();
      if (err instanceof LoginStoreFullError) return json(503, { error: "busy" }, { "Retry-After": "30" });
      return json(502, { error: "eid_unavailable" });
    }
    if (mode === "push") await emit("push_sent", r.tx.sessionId, { mode, pushKey: pushKey(idCode), decoy }, ctx);
    if (mode === "web2app") {
      // iOS Universal Link зөвхөн хэрэглэгчийн tap-аас эхэлсэн redirect гинжид аппыг нээнэ — JS биш, 302.
      return { status: 302, headers: { Location: r.appLink!, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": r.setCookie }, body: "" };
    }
    return json(
      200,
      { mode, vc: r.tx.vc, ...(mode === "qr" ? { qr: qrLink(r.tx) } : {}), expiresIn: r.expiresIn },
      { "Set-Cookie": r.setCookie },
    );
  }

  /** COMPLETE/OK үр дүнг шалгаж, нэг удаа onSuccess дуудна. ValidationError-ийг дуудагч барина. */
  async function finish(req: EidLoginRequest, tx: EidLoginTx, r: SessionResult, flow: FlowType, verifier?: string) {
    const v = client.validator.validateAuth(r, tx.acsp, { expectedFlowType: flow, userChallengeVerifier: verifier });
    const ctx: EidLoginContext = { request: req, mode: tx.mode };
    let rev: RevocationOutcome;
    let status: string | undefined;
    const checker: RevocationChecker | undefined = revocation && (async (c, i) => (status = await revocation(c, i)));
    try {
      rev = await client.validator.checkRevocationWith(v.certificate, checker, revocationMode);
    } catch (e) {
      // revoked → ValidationError; checker-ийн өөрийн алдаа — итгэхгүй, гэхдээ 500 биш: баталгаажуулалт унасан.
      throw new RevocationFailure(`revocation: ${e instanceof Error ? e.message : String(e)}`, status === "revoked");
    }
    if (rev === "unchecked") onError(new Error("eid-login: OCSP хариугүй — цуцлалт шалгалгүй зөвшөөрөв (soft-fail)"), ctx);
    if (!(await store.delete(tx.sessionId))) return undefined; // зэрэг хүсэлт аль хэдийн дуусгасан
    const out = (await opts.onSuccess(toIdentity(tx.sessionId, r, v, flow, rev), ctx)) ?? {};
    await emit("success", tx.sessionId, { mode: tx.mode, flow, revocation: rev }, ctx);
    return out;
  }

  async function status(req: EidLoginRequest): Promise<EidLoginResponse> {
    if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
    const tx = await loadTx(req);
    if (!tx) return json(200, { state: "EXPIRED" }, { "Set-Cookie": clearCookie });
    const ctx: EidLoginContext = { request: req, mode: tx.mode };
    let r: SessionResult;
    if (tx.decoy) {
      // eID-ээс асуухгүй (асуувал 404 → EXPIRED болж ялгарна): бодит long-poll шиг pollMs-ийн хугацаанд барина.
      await sleep(pollMs, req.signal);
      r = { state: "RUNNING" } as SessionResult;
    } else {
      try {
        r = await client.session.poll(tx.sessionId, pollMs);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          await store.delete(tx.sessionId);
          await emit("expired", tx.sessionId, { mode: tx.mode }, ctx);
          return json(200, { state: "EXPIRED" }, { "Set-Cookie": clearCookie });
        }
        onError(e, ctx);
        return json(502, { error: "eid_unavailable" });
      }
    }
    const expiresIn = Math.max(0, Math.ceil((tx.expiresAt - Date.now()) / 1000));
    if (r.state !== "COMPLETE") return json(200, { state: "PENDING", qr: qrLink(tx), vc: tx.vc, expiresIn });
    if (r.endResult !== "OK") {
      await store.delete(tx.sessionId);
      await endEvent(tx, r.endResult, ctx);
      // Хариугүй бодит push decoy-той ижил төгсөнө (EXPIRED) — FAILED/TIMEOUT нь «бүртгэлтэй» гэж хэлнэ.
      if (tx.mode === "push" && r.endResult === "TIMEOUT") return json(200, { state: "EXPIRED" }, { "Set-Cookie": clearCookie });
      return json(200, { state: "FAILED", error: r.endResult ?? "UNKNOWN" }, { "Set-Cookie": clearCookie });
    }
    // Web2App-аар баталгаажсан session-ийг ЗӨВХӨН callback (userChallengeVerifier) дуусгана.
    if (tx.mode === "web2app") return json(200, { state: "WAIT_CALLBACK" });
    try {
      const out = await finish(req, tx, r, tx.mode === "qr" ? "QR" : "Notification");
      if (!out) return json(200, { state: "EXPIRED" }, { "Set-Cookie": clearCookie });
      return json(200, { state: "OK", redirect: out.redirect, data: out.data }, mergeHeaders({ "Set-Cookie": clearCookie }, out.headers));
    } catch (e) {
      onError(e, ctx);
      if (!(e instanceof ValidationError || e instanceof SessionFailedError)) return json(500, { error: "internal" });
      await store.delete(tx.sessionId);
      await unverified(tx, e, ctx);
      return json(200, { state: "FAILED", error: "VALIDATION" }, { "Set-Cookie": clearCookie });
    }
  }

  async function callback(req: EidLoginRequest): Promise<EidLoginResponse> {
    if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
    const q = new URL(req.url, "http://x").searchParams;
    const sid = q.get("sessionId") ?? "";
    const verifier = q.get("userChallengeVerifier") ?? "";
    const fail = (code: string) => redirect(failTo(code), { "Set-Cookie": clearCookie });
    const tx = await loadTx(req);
    // Эхлүүлсэн хөтчийн cookie заавал: өөр хөтчид нээгдсэн callback-ийг (хулгайлсан/илгээсэн URL) хүлээн авахгүй.
    if (!tx) return fail("expired");
    const ctx: EidLoginContext = { request: req, mode: tx.mode };
    if (tx.sessionId !== sid || tx.mode !== "web2app" || !verifier) {
      await emit("flow_refused", tx.sessionId, { mode: tx.mode, reason: "unbound" }, ctx);
      return fail("unbound");
    }
    let r: SessionResult;
    try {
      r = await client.session.poll(tx.sessionId, 10_000);
    } catch (e) {
      onError(e, ctx);
      return fail("eid_unavailable");
    }
    if (r.state !== "COMPLETE") return fail("not_complete");
    if (r.endResult !== "OK") {
      await store.delete(tx.sessionId);
      await endEvent(tx, r.endResult, ctx);
      return fail(r.endResult ?? "UNKNOWN");
    }
    try {
      const out = await finish(req, tx, r, "Web2App", verifier);
      if (!out) return fail("expired");
      return redirect(out.redirect ?? successRedirect, mergeHeaders({ "Set-Cookie": clearCookie }, out.headers));
    } catch (e) {
      onError(e, ctx);
      if (!(e instanceof ValidationError || e instanceof SessionFailedError)) return fail("internal");
      await store.delete(tx.sessionId);
      await unverified(tx, e, ctx);
      return fail("VALIDATION");
    }
  }

  async function handleRequest(req: EidLoginRequest): Promise<EidLoginResponse> {
    const seg = new URL(req.url, "http://x").pathname.replace(/\/+$/, "").split("/").pop();
    try {
      if (seg === "start") return await start(req);
      if (seg === "status") return await status(req);
      if (seg === "callback") return await callback(req);
    } catch (e) {
      // store/onSuccess алдаа — дотоод мэдээллийг хөтчид гаргахгүй.
      onError(e, { request: req, mode: "qr" });
      if (e instanceof AuthenticationError || e instanceof ForbiddenError) return json(502, { error: "eid_unavailable" });
      return json(500, { error: "internal" });
    }
    return json(404, { error: "not_found" });
  }

  let warnedNoIp = false;
  async function handle(req: Request): Promise<Response> {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const body = req.method === "POST" ? await req.text() : undefined;
    const ip = opts.getClientIp?.(req) || undefined;
    if (!ip && !opts.getClientIp && !opts.trustProxy && !warnedNoIp) {
      warnedNoIp = true;
      onError(new Error("eid-login: handle(Request)-д клиент IP алга — `start:<ip>` хязгаар ажиллахгүй; getClientIp эсвэл trustProxy өг"), {
        request: { method: req.method, url: req.url, headers },
        mode: "qr",
      });
    }
    const r = await handleRequest({ method: req.method, url: req.url, headers, body, ip, signal: req.signal });
    const h = new Headers();
    for (const [k, v] of Object.entries(r.headers)) for (const x of [v].flat()) h.append(k, x);
    return new Response(r.status === 302 || r.status === 303 || r.body === "" ? null : r.body, { status: r.status, headers: h });
  }

  return { handleRequest, handle };
}
