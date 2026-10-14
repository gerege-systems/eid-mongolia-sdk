// Браузерийн туслах: гар утас/таблет илрүүлэгч (`button.ts` ашиглана). node:* импортлохгүй.
// Device link холбоосыг backend-д `buildDeviceLink` (devicelinkv3.ts)-ээр угсарна.

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
