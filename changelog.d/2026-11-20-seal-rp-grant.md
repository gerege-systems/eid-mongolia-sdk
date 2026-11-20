### Added — RP-ийн санаачилсан тамганы эрх: `seal.requestGrant` / `grantStatus` / `waitForGrant`, `organization.sealGrants`

- **Юу:** `eid.seal.requestGrant(orgEtsi, sessionId)` (`POST /seal/grants` → 202 PENDING), `eid.seal.grantStatus(grantId)`
  (`GET /seal/grants/{grantId}`), `eid.seal.waitForGrant(grantId, {timeoutMs, intervalMs, signal})` (APPROVED хүртэл;
  REJECTED / EXPIRED / FAILED / REVOKED / TIMEOUT → `SealGrantRequestError`), `eid.organization.sealGrants(personEtsi)`
  (`GET /organization/seal-grants/etsi/{personEtsi}`, PKI_READ). Typed алдаа: `AuthSessionNotFoundError`,
  `AuthSessionWrongFlowError`, `AuthSessionNotCompletedError`, `AuthSessionTooOldError`, `AuthSessionAlreadyUsedError`,
  `SealGrantAlreadyApprovedError`, `SealGrantNotFoundError`, `RpNotActiveError`, `RpPermissionsFullError`;
  403 `RP_NOT_REGISTERED` | `NOT_ORG_CEO` нь `ForbiddenError.code`. `SEAL_GRANT_ERROR_CODES`, `SEAL_GRANT_REQUEST_FIELDS`,
  төрлүүд `SealGrantRequest`, `PersonSealGrantsResponse`. `RP_ROUTES`-д гурван зам нэмэгдсэн. Нэр Go SDK-тэй ижил
  (`Seal.RequestGrant` / `GrantStatus`, `Organization.SealGrants`).
- **Яагаад:** CA V156 (PR #62) — RP эрхийг операторгүйгээр өөрөө хүсч болно: захирлыг нэвтрүүлсэн session (≤5 мин, нэг
  session — нэг хүсэлт) → push зөвхөн байгууллагын улсын бүртгэлийн Гүйцэтгэх захирал руу, PIN2-оор зөвшөөрнө. Эрх
  цуцлагдтал хүчинтэй; биллинг тооцохгүй.
- **Хаана:** `src/seal.ts`, `src/organization.ts`, `src/errors.ts`, `src/http.ts`, `src/contract.ts`, `src/types.ts`;
  тест `test/seal-grant.test.ts`, `test/contract.test.ts` (live discovery `grant_request` / `grant_status`); README §3i.
- **Шалгасан:** GitHub Actions CI — локалд ажиллуулаагүй.
