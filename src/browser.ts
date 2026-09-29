// @gerege-systems/eid-mongolia-sdk/browser — браузерт аюулгүй хэсэг (node:* импортгүй, secret-гүй).

export {
  deviceLink,
  openOrShowQR,
  isMobileUserAgent,
  type DeviceLinkInput,
  type NavigatorLike,
  type OpenOrShowQROptions,
} from "./devicelink.js";
export { EidError, DeviceLinkError } from "./errors.js";
export type { DeviceLinkSession } from "./types.js";
