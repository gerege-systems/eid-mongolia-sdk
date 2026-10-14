// SDK ↔ сервер гэрээ: SDK-ийн дууддаг RP-API зам бүр ЗӨВХӨН энд. Модулиуд эндээс уншина;
// гэрээний тест (`npm run test:contract`) энэ файлыг live `/.well-known/eid`-тэй тулгана.
// Runtime import-гүй (тест эх файлыг шууд уншдаг).

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
  signNotificationLinked: { method: "POST", path: "/signature/notification/linked/{documentNumber}" },
  signDeviceLinkEtsi: { method: "POST", path: "/signature/device-link/etsi/{semanticsIdentifier}" },
  signDeviceLinkDocument: { method: "POST", path: "/signature/device-link/document/{documentNumber}" },
  certChoiceDeviceLink: { method: "POST", path: "/signature/certificate-choice/device-link/anonymous" },
  certChoiceEtsi: { method: "POST", path: "/signature/certificate-choice/notification/etsi/{semanticsIdentifier}" },
  orgRepresentations: { method: "GET", path: "/organization/representations/etsi/{personEtsi}" },
  session: { method: "GET", path: "/session/{sessionId}" },
  personCertificates: { method: "GET", path: "/certificates/etsi/{personEtsi}" },
  personDevices: { method: "GET", path: "/devices/etsi/{personEtsi}" },
  personActivity: { method: "GET", path: "/rp/activity/etsi/{personEtsi}" },
  personSummary: { method: "GET", path: "/person/summary/etsi/{personEtsi}" },
  personChildren: { method: "GET", path: "/person/children/etsi/{personEtsi}" },
  tokenCertificate: { method: "POST", path: "/token/certificate" },
  tokenCertificateResult: { method: "GET", path: "/token/certificate/{sessionID}" },
} as const satisfies Record<string, RpRoute>;

/**
 * CA-ийн гэрээнд (код + docs/TOKEN_AUTH.md, PADES_CLIENT_SIDE.md §4.3) байгаа ч live `/.well-known/eid`-д хараахан жагсаагдаагүй замууд. Гэрээний
 * тест эдгээрийг WARN болгоно (fail биш); discovery-д нэмэгдмэгц {@link RP_ROUTES} руу шилжүүлнэ.
 */
export const RP_ROUTES_UNDISCOVERED = {
  tokenAuthChallenge: { method: "POST", path: "/token/auth/challenge" },
  tokenAuthVerify: { method: "POST", path: "/token/auth/verify" },
  pdfSignatures: { method: "POST", path: "/pdf/signatures" },
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
