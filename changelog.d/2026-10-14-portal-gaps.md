# Порталын дутагдлууд (Go SDK 0.1.2-той ижил) — additive

- **Юу:**
  1. `SessionResult.person` (CA `person` блок), `.tokenCertificate`, `.raw`; `personMatchesCertificate(person, subject)`.
  2. `ApiError` / `ForbiddenError`: `retryAfterMs` (Retry-After секунд / HTTP-огноо) + `headers`; `ApiError.retryable`,
     `RETRYABLE_ERROR_CODES` (PDF_PREPARE_BUSY, DOCUMENT_PENDING, TSA_UNAVAILABLE, LTV_UNAVAILABLE, RATE_LIMITED,
     STATE_UNAVAILABLE, ISSUANCE_PENDING), `parseRetryAfter`; `ClientConfig.pdfTimeoutMs` (анхдагч 80000, өмнө 60000).
  3. `SignOptions.fileName` → хүсэлтийн `fileName`.
  4. `client.person` (PKI_READ: certificates, devices, activity, summary, children), `client.token` (issueCertificate —
     CSR hash тулгалттай, certificateResult, authChallenge, authVerify — identity.etsi = SERIALNUMBER), `verifyTokenCertificates`,
     `tokenAuthDigest` (TOKEN_AUTH тест вектор), `tokenLimitOf`.
  5. `TrustConfig.allowedIssuerSkis` (+ `CITIZEN_ISSUING_CA_SKI`), `checkKeyUsage`, `schemeName`;
     `checkRevocationStatus` → "good" / "unchecked" / "skipped".
  6. `NetworkError` мессеж ба `.op`-д замын `/etsi/…`, `/document/…` (PNOMN/РД/documentNumber) орохгүй; `.timeout`.
  7. `AuthenticationError`: `.code`, `.body`, `.headers` (CA-ийн 401 vs proxy 401).
- **Яагаад:** eID порталыг Go SDK руу шилжүүлэхэд эдгээр нь SDK-д байхгүй тул гараар үлдсэн; CA ↔ TS ↔ Go ↔ developer
  сайт зөрөхгүй байх дүрмээр TS-д ч ижил.
- **Хаана:** `src/{errors,http,session,types,sign,pdf,client,validator,subject,contract,person,token,index}.ts`,
  `test/portal-gaps.test.ts`, `test/contract.test.ts`. `/token/auth/*` CA-д (код + docs/TOKEN_AUTH.md) байгаа ч
  `/.well-known/eid`-д алга тул `RP_ROUTES_UNDISCOVERED` (гэрээний тест WARN).
- **Шалгасан:** `npm run lint`, `npm test` (87 тест; шинэ 17), `npm run test:contract` (live ногоон).
