// Device link v3 (Smart-ID RP-API v3 «dynamic link») — QR / Web2App / App2App холбоосыг RP BACKEND
// угсарна: authCode = HMAC-SHA256(sessionSecret)-ээр хамгаалагдсан, QR-д elapsedSeconds секунд тутам
// шинэчлэгдэнэ. Гэрээ: ca-eidmongolia-mn docs/DEVICE_LINK_V3.md (§3 хэлбэр, §4 authCode).
//
// ⚠️ node:crypto ашигладаг ба sessionSecret шаарддаг тул ЗӨВХӨН backend-д. `/browser` entry-д ОРОХГҮЙ —
// sessionSecret-ийг браузер/апп руу хэзээ ч бүү гарга; QR-ийг секунд тутам backend endpoint-оос ав.

import { createHmac } from "node:crypto";
import { DeviceLinkError } from "./errors.js";

/** Холбоосын төрөл — апп гарын үсгийн `flowType`-д яг энэ утгыг зурна (authCode-оор хамгаалагдсан). */
export type DeviceLinkType = "QR" | "Web2App" | "App2App";

/** Session-ий урсгал: auth = нэвтрэлт, sign = гарын үсэг, cert = гэрчилгээ сонгох. */
export type DeviceLinkSessionType = "auth" | "sign" | "cert";

export interface BuildDeviceLinkInput {
  /** Session start хариуны `deviceLinkBase` (ж: `https://ca.eidmongolia.mn/dl`). */
  deviceLinkBase: string;
  deviceLinkType: DeviceLinkType;
  /** Session start хариуны `sessionToken` — ЯГ ХЭВЭЭР. */
  sessionToken: string;
  /** Session start хариуны `sessionSecret` (стандарт Base64, padding-тэй). ЗӨВХӨН backend-д. */
  sessionSecret: string;
  sessionType: DeviceLinkSessionType;
  /** ISO 639-2 гурван жижиг үсэг (`mon`, `eng`) — зөвхөн `/dl` fallback хуудасны хэл. */
  lang: string;
  /**
   * RP backend session start хариуг ХҮЛЭЭН АВСАН мөч (өөрийн цагаар; ms epoch эсвэл Date).
   * QR-д заавал (`elapsedSeconds = floor(now − receivedAt)`); Web2App/App2App-д ашиглагдахгүй.
   */
  receivedAt?: number | Date;
  /** Одоогийн цаг (тест/тогтмол цагт). Анхдагч `Date.now()`. */
  now?: number | Date;
  /** auth: RP-ийн илгээсэн `rpChallenge` (base64 ТЕКСТЭЭРЭЭ). */
  rpChallenge?: string;
  /** sign: RP-ийн илгээсэн `digest` (base64 текст). */
  digest?: string;
  /** Session start хүсэлтэд илгээсэн ЯГ тэр `relyingPartyName`. */
  relyingPartyName: string;
  /** auth/sign: хүсэлтэд илгээсэн interactions-ийн base64 МӨР (дахин serialize хийхгүй). cert: `""`. */
  interactions: string;
  /**
   * Хүсэлтэд илгээсэн түүхий `initialCallbackUrl`. Web2App/App2App-д заавал; QR-д authCode-д ОРОХГҮЙ
   * (`""`), тиймээс QR ба товчинд ижил session-ий утгыг өгч болно.
   */
  initialCallbackUrl?: string;
  /** Анхдагч `"smart-id"` (серверийн EID_ACSP_SCHEME_NAME). */
  schemeName?: string;
  /** Broker RP-ийн нэр. eID broker дэмждэггүй — анхдагч `""`. */
  brokeredRpName?: string;
}

const TYPES: readonly DeviceLinkType[] = ["QR", "Web2App", "App2App"];
const PROTOCOL: Record<DeviceLinkSessionType, string> = { auth: "ACSP_V2", sign: "RAW_DIGEST_SIGNATURE", cert: "" };
// Холбоосонд URL encoding байхгүй (§3) — утгууд encoding шаардахгүй тэмдэгтээс л бүрдэнэ.
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const LANG_RE = /^[a-z]{3}$/;
const STD_B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const ms = (t: number | Date) => (t instanceof Date ? t.getTime() : t);

function fail(msg: string): never {
  throw new DeviceLinkError(`buildDeviceLink: ${msg}`);
}

/**
 * Device link v3-ийг бүтнээр нь угсарна (`…&authCode=…`). Цэвэр функц — `now`-оос өөр гаднын төлөвгүй.
 *
 * ```
 * QR:      {base}?deviceLinkType=QR&elapsedSeconds={E}&sessionToken={T}&sessionType={S}&version=1.0&lang={L}&authCode={A}
 * Web2App: {base}?deviceLinkType=Web2App&sessionToken={T}&sessionType={S}&version=1.0&lang={L}&authCode={A}
 * ```
 *
 * QR холбоос ~20 секундэд хүчингүй болдог тул секунд тутам дахин дуудаж харуул ({@link qrDeviceLinkTicker}).
 * Web2App/App2App холбоосыг нэг удаа угсарна.
 *
 * @throws {DeviceLinkError} оролт буруу (base https биш, token/lang/secret хэлбэр, төрөлд хэрэгтэй талбар дутуу).
 */
export function buildDeviceLink(p: BuildDeviceLinkInput): string {
  const base = p.deviceLinkBase?.trim();
  if (!base) fail("deviceLinkBase хоосон — device-link session-ий хариуг шалга");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    fail(`deviceLinkBase буруу URL: ${base}`);
  }
  if (u.protocol !== "https:" || /[?#]/.test(base)) fail("deviceLinkBase нь query/fragment-гүй https URL байх ёстой");
  if (!TYPES.includes(p.deviceLinkType)) fail(`deviceLinkType ${String(p.deviceLinkType)} (QR | Web2App | App2App)`);
  if (!(p.sessionType in PROTOCOL)) fail(`sessionType ${String(p.sessionType)} (auth | sign | cert)`);
  if (!p.sessionToken || !TOKEN_RE.test(p.sessionToken)) fail("sessionToken хэлбэр буруу");
  if (!LANG_RE.test(p.lang ?? "")) fail("lang нь ISO 639-2 гурван жижиг үсэг (mon, eng)");
  if (!p.sessionSecret || !STD_B64_RE.test(p.sessionSecret)) fail("sessionSecret стандарт Base64 (padding-тэй) биш");

  let challenge = "";
  if (p.sessionType === "auth") {
    if (!p.rpChallenge) fail("auth session-д rpChallenge заавал");
    challenge = p.rpChallenge;
  } else if (p.sessionType === "sign") {
    if (!p.digest) fail("sign session-д digest заавал");
    challenge = p.digest;
  } else if (p.rpChallenge || p.digest) {
    fail("cert session-д rpChallenge/digest байхгүй");
  }

  const qr = p.deviceLinkType === "QR";
  const callback = qr ? "" : (p.initialCallbackUrl ?? "");
  if (!qr && !callback) fail(`${p.deviceLinkType} холбоос initialCallbackUrl-тай session-д л хүчинтэй`);

  let elapsed = "";
  if (qr) {
    if (p.receivedAt == null) fail("QR холбоосонд receivedAt заавал");
    // Цаг ухарсан ч (NTP) сөрөг утга гаргахгүй — сервер ирээдүйн elapsed-ийг татгалздаг.
    const e = Math.max(0, Math.floor((ms(p.now ?? Date.now()) - ms(p.receivedAt)) / 1000));
    if (!Number.isSafeInteger(e)) fail("receivedAt/now буруу");
    elapsed = `&elapsedSeconds=${e}`;
  }

  const unprotected =
    `${base}?deviceLinkType=${p.deviceLinkType}${elapsed}&sessionToken=${p.sessionToken}` +
    `&sessionType=${p.sessionType}&version=1.0&lang=${p.lang}`;
  const payload = [
    p.schemeName ?? "smart-id",
    PROTOCOL[p.sessionType],
    challenge,
    b64(p.relyingPartyName),
    b64(p.brokeredRpName ?? ""),
    p.interactions ?? "",
    callback,
    unprotected,
  ].join("|");
  const authCode = createHmac("sha256", Buffer.from(p.sessionSecret, "base64")).update(payload, "utf8").digest("base64url");
  return `${unprotected}&authCode=${authCode}`;
}

export interface QrDeviceLinkTickerOptions {
  /** Шинэчлэх давтамж (мс). Анхдагч 1000 — Smart-ID-ийн шаардлага. */
  intervalMs?: number;
  /** Цагийн эх үүсвэр (тест). Анхдагч `Date.now`. */
  clock?: () => number;
}

/**
 * Node сервер (SSE/WebSocket)-т: QR холбоосыг шууд нэг удаа, дараа нь секунд тутам `onLink`-ээр гаргана.
 * Буцаах функцээр зогсооно (session дуусах/клиент салахад заавал дууд). Timer процессыг барихгүй (unref).
 * HTTP poll ашиглавал энэ хэрэггүй — хүсэлт бүрд {@link buildDeviceLink}-ийг `deviceLinkType: "QR"`-оор дууд.
 */
export function qrDeviceLinkTicker(
  input: Omit<BuildDeviceLinkInput, "deviceLinkType" | "now">,
  onLink: (link: string) => void,
  opts?: QrDeviceLinkTickerOptions,
): () => void {
  const clock = opts?.clock ?? Date.now;
  const tick = () => onLink(buildDeviceLink({ ...input, deviceLinkType: "QR", now: clock() }));
  tick(); // оролт буруу бол энд шууд шиднэ (timer эхлэхээс өмнө)
  const t = setInterval(tick, opts?.intervalMs ?? 1000);
  t.unref?.();
  return () => clearInterval(t);
}
