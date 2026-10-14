// @eid-mongolia/sdk — нийтийн гадаргуу.

export { EidClient, DEFAULT_BASE_URL, resolveBaseUrl, type ClientConfig } from "./client.js";
export { Http, type HttpConfig } from "./http.js";
export { AuthApi, type AuthOptions, type AuthDefaults } from "./auth.js";
export { SignApi, type SignOptions, type SignDefaults } from "./sign.js";
export { SessionApi, parseSessionResult } from "./session.js";
export {
  PdfApi,
  type PdfDefaults,
  type PdfPrepareInput,
  type PdfPrepareSession,
  type PdfSignerRef,
} from "./pdf.js";
export { OrganizationApi } from "./organization.js";
export {
  ResponseValidator,
  type TrustConfig,
  type VerifiedIdentity,
  type VerifiedSignature,
  type ValidateAuthOptions,
  type ValidateSignOptions,
  type RevocationChecker,
  type RevocationStatus,
  verifyPayloadSignature,
  verifyPrehashedSignature,
  userChallengeOf,
} from "./validator.js";
export { parseSubject, type CertSubject } from "./subject.js";
export {
  sha256Base64,
  randomChallenge,
  buildAcspV2Payload,
  acspV2Digest,
  interactionsToBase64,
  type AcspV2Params,
} from "./crypto.js";
export {
  deviceLink,
  openOrShowQR,
  isMobileUserAgent,
  type DeviceLinkInput,
  type NavigatorLike,
  type OpenOrShowQROptions,
} from "./devicelink.js";
export {
  buildDeviceLink,
  qrDeviceLinkTicker,
  type BuildDeviceLinkInput,
  type DeviceLinkType,
  type DeviceLinkSessionType,
  type QrDeviceLinkTickerOptions,
} from "./devicelinkv3.js";
export {
  EidOidcClient,
  EidOidcError,
  EID_OIDC_ISSUER,
  EID_ACR_QUALIFIED,
  EID_ACR_ADVANCED,
  pkceChallenge,
  type EidOidcClientConfig,
  type EidOidcDiscovery,
  type EidOidcErrorCode,
  type CreateAuthorizationOptions,
  type EidAuthorization,
  type EidCallbackChecks,
  type EidCallbackResult,
  type EidIdTokenClaims,
} from "./oidc.js";
export {
  EidError,
  AuthenticationError,
  ForbiddenError,
  ApiError,
  NetworkError,
  SessionFailedError,
  ValidationError,
  DeviceLinkError,
  ON_BEHALF_ERROR_CODES,
  type OnBehalfErrorCode,
} from "./errors.js";
export type {
  CertificateLevel,
  SignatureProtocol,
  SignatureAlgorithm,
  HashAlgorithm,
  FlowType,
  AcspContext,
  SignatureAlgorithmParameters,
  Interaction,
  SessionState,
  EndResult,
  NotificationSession,
  DeviceLinkSession,
  SessionResult,
  RpCredentials,
  OrgResult,
  PdfDocumentStatus,
  PdfSigner,
  PdfSessionBlock,
  Representation,
  RepresentationsResponse,
} from "./types.js";
