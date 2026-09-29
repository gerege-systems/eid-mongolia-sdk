// Ижил төхөөрөмж (App2App / Web2App) — device-link session-оос иргэний утсан дээрх eID аппыг
// нээх холбоос. CA-ийн гэрээ: `{deviceLinkBase}?sessionId=<uuid>&vc=<5 орон>` (deviceLinkBase нь
// ж: https://ca.eidmongolia.mn/dl — Universal Link / App Link; апп суугаагүй бол /dl хуудас
// «Аппаар нээх» ба store холбоосыг санал болгоно).
//
// Энэ модуль node:* импортлохгүй — браузерт `@gerege-systems/eid-mongolia-sdk/browser`-ээр орно.
// Зөвхөн https(/http) суурь хүлээн авна: custom scheme-ийг RP зам болгож ХЭЗЭЭ Ч ашиглахгүй.

import { DeviceLinkError } from "./errors.js";
import type { DeviceLinkSession } from "./types.js";

/** Холбоос угсрахад хэрэгтэй талбарууд — backend хариунаас браузерт зөвхөн эдгээрийг дамжуулна. */
export type DeviceLinkInput = Pick<DeviceLinkSession, "sessionId" | "vc" | "deviceLinkBase">;

// CA-ийн /dl хуудастай ижил: sessionId нь lowercase UUID, vc нь яг 5 орон.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VC_RE = /^[0-9]{5}$/;

/**
 * Device-link session-ийн холбоос: `${deviceLinkBase}?sessionId=<uuid>&vc=<код>`.
 * QR-д эсвэл «eID аппаар нээх» товчинд тавина.
 *
 * @throws {DeviceLinkError} deviceLinkBase байхгүй / http(s) биш, sessionId UUID биш, vc 5 орон биш.
 */
export function deviceLink(session: DeviceLinkInput): string {
  const base = session.deviceLinkBase?.trim();
  if (!base) throw new DeviceLinkError("deviceLink: хариунд deviceLinkBase байхгүй — device-link session эсэхийг шалга");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new DeviceLinkError(`deviceLink: deviceLinkBase буруу URL: ${base}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new DeviceLinkError(`deviceLink: deviceLinkBase https URL байх ёстой: ${u.protocol}`);
  }
  if (!SESSION_ID_RE.test(session.sessionId)) throw new DeviceLinkError("deviceLink: sessionId UUID (lowercase) биш");
  if (session.vc == null || !VC_RE.test(session.vc)) throw new DeviceLinkError("deviceLink: vc 5 оронтой тоо биш");
  u.searchParams.set("sessionId", session.sessionId);
  u.searchParams.set("vc", session.vc);
  return u.toString();
}

/** isMobileUserAgent-ийн уншдаг navigator-ийн хэсэг (тестэд орлуулна). */
export interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}

/**
 * Анхдагч гар утас/таблет илрүүлэгч: Android, iPhone/iPod/iPad, UA-CH `mobile`, мөн desktop UA
 * илгээдэг iPadOS (Macintosh + мэдрэгч дэлгэц, maxTouchPoints > 1).
 */
export function isMobileUserAgent(nav?: NavigatorLike): boolean {
  const n = nav ?? (globalThis as { navigator?: NavigatorLike }).navigator;
  if (!n) return false;
  if (n.userAgentData?.mobile === true) return true;
  const ua = n.userAgent ?? "";
  if (/Android|iPhone|iPod|iPad/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (n.maxTouchPoints ?? 0) > 1;
}

export interface OpenOrShowQROptions {
  /** Desktop дээр QR харуулах (link-ийг QR болгох нь RP-ийн UI). */
  showQR: (link: string) => void;
  /** Гар утас эсэх — boolean эсвэл функц. Анхдагч {@link isMobileUserAgent}. */
  isMobile?: boolean | (() => boolean);
}

/**
 * Браузерт: гар утсан дээр eID аппыг шууд нээнэ (`location.assign(link)` — Universal Link /
 * App Link), бусад үед `showQR(link)` дуудна. Буцаах утга: `"opened"` эсвэл `"qr"`.
 *
 * (!) Товчны click handler дотроос ШУУД (await-гүйгээр) дууд — session-ийг урьдчилж эхлүүлээд
 * хадгал. iOS урт async гинжийн дараах навигацийг хэрэглэгчийн үйлдэл гэж тооцохгүй тул Universal
 * Link-ийг алгасаж /dl хуудсыг нээдэг; тэр хуудас «Аппаар нээх» товч ба store холбоосыг санал болгоно.
 *
 * @throws {DeviceLinkError} холбоос угсрах боломжгүй бол ({@link deviceLink}).
 */
export function openOrShowQR(session: DeviceLinkInput, opts: OpenOrShowQROptions): "opened" | "qr" {
  const link = deviceLink(session);
  const mobile = typeof opts.isMobile === "function" ? opts.isMobile() : (opts.isMobile ?? isMobileUserAgent());
  if (mobile) {
    const loc = (globalThis as { location?: { assign(url: string): void } }).location;
    if (!loc) throw new DeviceLinkError("openOrShowQR: location байхгүй — зөвхөн браузерт");
    loc.assign(link);
    return "opened";
  }
  opts.showQR(link);
  return "qr";
}
