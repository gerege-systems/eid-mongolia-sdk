### Fixed — SDK аудитын кодын алдаанууд (Go / .NET / Swift / Kotlin-той нийцүүлэв)

**Юу ба яагаад.**
- `session.waitForResult` 150 с-т таслахаа болив (CA auth 300 с, sign 600 с — иргэн 150 с-ээс хойш баталбал RUNNING
  буцаж validator унадаг байв). `maxWaitMs` өгөөгүй бол: `expiresAt` (шинэ опц; start хариуны `expiresAt`) +
  `WAIT_GRACE_MS` (15 с) → discovery `sessionTtl` (max(auth, sign)) + 15 с → `DEFAULT_MAX_WAIT_MS` (600 с). `maxWaitMs`
  өгвөл түүнийг л дагана; long-poll хэвээр. Хугацаа өнгөрсөн `expiresAt`-д ч нэг poll хийнэ (CA-ийн TIMEOUT-ийг авна).
- Токены кодууд: тусдаа тогтмол `TOKEN_ISSUANCE_PENDING`, `KYC_INCOMPLETE`, `NO_ACTIVE_DEVICE`, `CSR_KEY_REUSED` ба шинэ
  `TokenErrorCode` / `TOKEN_ERROR_CODES` (CA `tokencert.go`, `token_auth.go`-ийн бүх код). `TokenConflictCode` өөрчлөгдөөгүй —
  exhaustive `switch` эвдрэхгүй (`APP_ATTESTATION_INVALID`-ийн загвар).
- `registrationFromCompleted`: `medium` алга бол `sessionID`-аас (phone ⇔ sessionID) тодорхойлж биед тавина; phone +
  sessionID алга, token + sessionID, үл мэдэгдэх medium → `ValidationError` (`buildRegisterBody` ч token + sessionID-ийг
  татгалзана). `PadesCompleted.claimedRole` (шинэ); claimedRole-той гарын үсэгт `onBehalfOf` алга бол `ValidationError`
  (өмнө CA дараа нь татгалздаг байв).
- `ocspRevocationChecker`: «good» кэш min(5 мин, хариуны `nextUpdate`) — Go-той ижил (өмнө nextUpdate-ийг үл тоодог).
- `pades.complete`: `fetch` алга (тохиргоо) → `REQUEST_INVALID`, `retryable` false (өмнө `TSA_UNAVAILABLE` + retryable).
  `UNSUPPORTED_ENVIRONMENT`-ийг сонгоогүй: `PadesErrorCode` бүх платформд ижил union — шинэ код exhaustive switch-ийг эвдэнэ.
- RSASSA-PSS гарын үсэг `complete`-д `SIGNATURE_INVALID` хэвээр — Go v0.13.0 ч үүнд шилжсэн (5 SDK ижил).
- `TokenApi` тайлбар: олголтод зөвхөн `TOKEN_ISSUE` эрх.

**Хаана.** `src/session.ts`, `src/token.ts`, `src/sign.ts`, `src/pades.ts`, `src/ocsp.ts`, `src/index.ts`, README.

**Хэрхэн шалгасан.** Шинэ тест: `waitForResult` хугацаа (discovery / expiresAt / өнгөрсөн / maxWaitMs / хуучин CA / 500),
`registrationFromCompleted` medium + claimedRole, OCSP nextUpdate кэш, `fetch` алга → REQUEST_INVALID; `npm run lint`,
`npm test` (274 pass).
