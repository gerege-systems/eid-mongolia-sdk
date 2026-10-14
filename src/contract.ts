// SDK ↔ сервер гэрээ: SDK-ийн дууддаг RP-API зам бүр ба OIDC-д хүлээдэг утгууд ЗӨВХӨН энд. Модулиуд эндээс уншина;
// гэрээний тест (`npm run test:contract`) энэ файлыг live `/.well-known/eid` ба OIDC discovery-тэй тулгана.
// Runtime import-гүй (тест эх файлыг шууд уншдаг).
import type { EidIdTokenClaims } from "./oidc.js";

export interface RpRoute {
  readonly method: "GET" | "POST";
  /** `{param}`-тай template; {@link routePath}-аар бөглөнө. */
  readonly path: string;
}

export const RP_ROUTES = {
  authNotificationEtsi: { method: "POST", path: "/authentication/notification/etsi/{semanticsIdentifier}" },
  authNotificationDocument: { method: "POST", path: "/authentication/notification/document/{documentNumber}" },
  authDeviceLinkAnonymous: { method: "POST", path: "/authentication/device-link/anonymous" },
  authDeviceLinkEtsi: { method: "POST", path: "/authentication/device-link/etsi/{semanticsIdentifier}" },
  signNotificationEtsi: { method: "POST", path: "/signature/notification/etsi/{semanticsIdentifier}" },
  signNotificationDocument: { method: "POST", path: "/signature/notification/document/{documentNumber}" },
  pdfPrepare: { method: "POST", path: "/pdf/sign/prepare" },
  pdfDocument: { method: "GET", path: "/pdf/sign/{sessionID}/document" },
  orgRepresentations: { method: "GET", path: "/organization/representations/etsi/{personEtsi}" },
  session: { method: "GET", path: "/session/{sessionId}" },
} as const satisfies Record<string, RpRoute>;

/** Template-ийн `{param}`-уудыг дарааллаар нь `encodeURIComponent` хийсэн `args`-аар орлуулна. */
export function routePath(route: RpRoute, ...args: string[]): string {
  let i = 0;
  const out = route.path.replace(/\{[^}]*\}/g, () => {
    const a = args[i++];
    if (a === undefined) throw new Error(`eid: route ${route.path}: параметр дутуу`);
    return encodeURIComponent(a);
  });
  if (i !== args.length) throw new Error(`eid: route ${route.path}: параметр илүү`);
  return out;
}

/** OIDC-д SDK-ийн хүлээдэг утгууд. */
export const OIDC_EXPECT = {
  defaultScope: "openid",
  pkceMethod: "S256",
  idTokenAlg: "ES256",
  /** `Authorization: Basic` (RFC 6749 §2.3.1). */
  tokenEndpointAuthMethod: "client_secret_basic",
} as const;

type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] };

/**
 * {@link EidIdTokenClaims}-ийн талбар бүр (required / optional). `satisfies` нь талбар нэмэгдэх/хасагдахад `npm run lint`-ийг
 * унагана — гэрээний тест эдгээрийг `claims_supported`-тэй тулгана.
 */
export const ID_TOKEN_CLAIMS = {
  iss: "required",
  aud: "required",
  azp: "optional",
  sub: "required",
  exp: "required",
  iat: "required",
  nonce: "required",
  auth_time: "required",
  acr: "required",
  given_name: "required",
  family_name: "required",
  given_name_mn: "optional",
  family_name_mn: "optional",
  pnomn: "optional",
} as const satisfies Record<KnownKeys<EidIdTokenClaims>, "required" | "optional">;
