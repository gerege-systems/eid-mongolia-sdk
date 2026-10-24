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
  pdfSignatures: { method: "POST", path: "/pdf/signatures" },
  tokenAuthChallenge: { method: "POST", path: "/token/auth/challenge" },
  tokenAuthVerify: { method: "POST", path: "/token/auth/verify" },
  share: { method: "POST", path: "/share" },
  /** «Миний QR» (CA гэрээ v1, 2026-10-23). */
  authQr: { method: "POST", path: "/authentication/qr" },
} as const satisfies Record<string, RpRoute>;

/**
 * CA-ийн гэрээнд (код + docs) байгаа ч live `/.well-known/eid`-д хараахан жагсаагдаагүй замууд. Гэрээний тест эдгээрийг
 * WARN болгоно (fail биш); discovery-д нэмэгдмэгц {@link RP_ROUTES} руу шилжүүлнэ.
 */
export const RP_ROUTES_UNDISCOVERED: Readonly<Record<string, RpRoute>> = {};

/**
 * `POST /pdf/signatures`-ийн биеийн талбарууд — CA `server/internal/dto/pdf.go` `PDFSignatureRegisterRequest`-ийн JSON
 * tag (CA main d948fdd4, !355). CA `DisallowUnknownFields` тул SDK зөвхөн эдгээрийг илгээнэ. Live discovery-ийн
 * `endpoints.pdf.signatures` тайлбартай гэрээний тест тулгана.
 */
export const PDF_SIGNATURE_REGISTER_FIELDS = [
  "docID",
  "revIndex",
  "medium",
  "sessionID",
  "cms",
  "fileName",
  "inSha256",
  "pageSha256",
  "sigRevSha256",
  "outSha256",
  "priorCmsSha256",
  "priorRevisionSha256",
  "onBehalfOf",
  "signerEtsi",
] as const;

/**
 * `POST /share`-ийн multipart талбарууд — CA `server/internal/httpapi/handlers_share.go` `parseShareRequest` (CA main
 * 0329ef95, !371). CA үл мэдэгдэх талбарыг 400 REQUEST_INVALID-аар татгалздаг. Live discovery-ийн `endpoints.share`
 * тайлбартай гэрээний тест тулгана.
 */
export const SHARE_FORM_FIELDS = ["file", "filename", "to", "subject", "message", "lang"] as const;

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
