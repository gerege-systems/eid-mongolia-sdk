### Нэмэгдсэн

- **`/pades` `complete`: LTV retry.** OCSP/CRL (DSS) цуглуулалт унавал ижил state, гарын үсэг, TSA timestamp-аар SDK
  өөрөө 2 удаа дахин оролдоно (нийт 3; хүлээлт ~1 с, ~3 с + 0–25% jitter) — PIN дахин асуухгүй. `ltvRetries` (анхдагч 2,
  `0` — унтраах, 0–10); бүгд унавал `LTV_UNAVAILABLE` (өмнөхтэй ижил). `signal` (`AbortSignal`) — TSA/OCSP/CRL таталт ба
  хүлээлтийг тасалж `signal.reason` (анхдагч `AbortError`) шиднэ.
  Яагаад: 2026-10-16 03:46Z-д үндэсний CRL толь түр 404 байхад иргэний гарын үсэг PIN2-ийн дараа унасан; портал өөрөө
  retry хийдэг (!161), SDK-ийн бусад хэрэглэгч ч хамгаалагдана. Хаана: `src/pades.ts`, `src/pades/fetch.ts`.
- **`PdfRegisterErrorCode` / `PDF_REGISTER_ERROR_CODES`** — `POST /pdf/signatures`-ийн CA кодууд (CA main
  `pades_register.go`, `handlers_pdf.go`, 2026-10-16): REQUEST_INVALID, REQUEST_TOO_LARGE, CMS_INVALID, SIGNATURE_INVALID,
  TIMESTAMP_INVALID, SIGNER_MISMATCH, SIGNER_CERT_INVALID, TOKEN_CERT_INVALID, TOKEN_ORG_MISMATCH, SESSION_MISMATCH,
  SESSION_NOT_COMPLETE, SESSION_FAILED, CLAIMED_ROLE_MISMATCH, REPRESENTATION_REVOKED, DOC_ID_CONFLICT, REGISTRY_CONFLICT,
  DOC_NOT_FOUND, PRIOR_MISMATCH, RATE_LIMITED, STATE_UNAVAILABLE. Go SDK v0.5.2-ийн `eid.PDFRegisterErrorCodes`-тэй ижил.

Шалгасан: `npm run lint`, `npm test` (180/180; шинэ: 2 унаад 3 дахь нь амжвал golden-той байт-ижил, 3-уулаа унавал
LTV_UNAVAILABLE, `ltvRetries: 0`, abort — хүлээлтэд ба урьдчилан).
