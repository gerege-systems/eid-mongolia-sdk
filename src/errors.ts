// SDK-ийн typed алдаанууд. RP backend эдгээрийг ялган барьж хэрэглэгчид зөв мессеж/үйлдэл
// сонгоно (ж: 401 → тохиргооны алдаа, USER_REFUSED → дахин оролд, TIMEOUT → дахин эхлүүл).

/** Бүх SDK алдааны суурь. */
export class EidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP 401 — API secret буруу/байхгүй. Тохиргооны (RP secret) алдаа. */
export class AuthenticationError extends EidError {}

/** HTTP 403 — IP allowlist/mTLS зөвшөөрөөгүй. Танай серверийн IP бүртгэгдээгүй байж магадгүй. */
export class ForbiddenError extends EidError {}

/** RP-API-аас ирсэн бусад HTTP алдаа (4xx/5xx). status ба хариуны биеийг агуулна. */
export class ApiError extends EidError {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`RP-API ${status}: ${body}`);
  }
}

/** Сүлжээ/timeout — upstream хариу өгсөнгүй. */
export class NetworkError extends EidError {}

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
