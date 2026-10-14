// @eid-mongolia/sdk — нийтийн гадаргуу.

export { EidClient, DEFAULT_BASE_URL, resolveBaseUrl, type ClientConfig } from "./client.js";
export { Http, type HttpConfig } from "./http.js";
export { AuthApi, type AuthOptions, type AuthDefaults } from "./auth.js";
export { SignApi, type SignOptions, type SignDefaults, type CertChoiceOptions, type SignerRef } from "./sign.js";
export { SessionApi, parseSessionResult, personMatchesCertificate } from "./session.js";
export {
  PdfApi,
  DEFAULT_PDF_TIMEOUT_MS,
  DEFAULT_PDF_MAX_BYTES,
  type PdfDefaults,
  type PdfTokenPrepareInput,
  type PdfTokenPrepareSession,
  type PdfPrepareInput,
  type PdfPrepareSession,
  type PdfSignerRef,
} from "./pdf.js";
export { OrganizationApi } from "./organization.js";
export {
  PersonApi,
  type TokenOrganization,
  type PersonCertificate,
  type PersonCertificates,
  type CertCounts,
  type PersonDevice,
  type PersonDevices,
  type ActivityItem,
  type ActivityCounts,
  type ActivityQuery,
  type PersonActivity,
  type PersonSummary,
  type PersonChild,
  type PersonChildren,
} from "./person.js";
export {
  TokenApi,
  verifyTokenCertificates,
  tokenAuthDigest,
  tokenLimitOf,
  type TokenCertInput,
  type TokenCertStart,
  type TokenCertItem,
  type TokenCertResult,
  type TokenAuthChallenge,
  type TokenIdentity,
  type TokenAuthResult,
  type TokenLimit,
} from "./token.js";
export {
  ResponseValidator,
  type TrustConfig,
  type VerifiedIdentity,
  type VerifiedSignature,
  type ValidateAuthOptions,
  type ValidateSignOptions,
  type Signer,
  type RevocationChecker,
  type RevocationStatus,
  type RevocationOutcome,
  CITIZEN_ISSUING_CA_SKI,
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
  deviceLinkInput,
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
  ResponseTooLargeError,
  ON_BEHALF_ERROR_CODES,
  RETRYABLE_ERROR_CODES,
  parseRetryAfter,
  type OnBehalfErrorCode,
  type RetryableErrorCode,
  type HttpErrorInit,
} from "./errors.js";
export { DEFAULT_SIGN_SESSION_TTL_MS, sessionExpiry } from "./types.js";
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
  SignContext,
  SessionResult,
  RpCredentials,
  OrgResult,
  PdfDocumentStatus,
  PdfSigner,
  PdfSessionBlock,
  Representation,
  RepresentationsResponse,
  PersonBlock,
  TokenCertStatus,
  TokenCertSessionBlock,
} from "./types.js";
