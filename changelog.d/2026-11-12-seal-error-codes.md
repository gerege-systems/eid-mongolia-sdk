### Added — тамганы 409-ийн typed алдаанууд, `SEAL_ERROR_CODES`; `key_medium`-д `server_software` / `server_hsm`

- **Юу:** `ApiError`-ийн шинэ дэд ангиуд (серверийн `code`-оор, `src/http.ts`): `OrgNotActiveError` (409
  `ORG_NOT_ACTIVE`), `SealNotIssuedError` (`SEAL_NOT_ISSUED`), `SealCertRevokedError` (`SEAL_CERT_REVOKED`),
  `SealKeyUnavailableError` (`SEAL_KEY_UNAVAILABLE`), `SealCertExpiredError` (`SEAL_CERT_EXPIRED`),
  `SealCertNotYetValidError` (`SEAL_CERT_NOT_YET_VALID`); `SEAL_ERROR_CODES` / `SealErrorCode` (тамганы замуудын есөн
  код). `status`, `code`, `body` хэвээр — өмнөх `instanceof ApiError` / `e.code` салаалалт эвдрэхгүй; `error.name` нь
  дэд ангийн нэр болно. 403 `ORG_NOT_ACTIVE` (`onBehalfOf`) хэвээр `ForbiddenError`. `SignatureReport["key_medium"]`
  төрөлд `"server_software" | "server_hsm"` нэмэгдсэн (CA `POST /v3/validate/pdf`-ийн хариунд; локал `validatePdf`
  `phone` | `unknown` хэвээр — golden өөрчлөгдөөгүй). `code` → анги буулгалт нэг хүснэгт (`TYPED_API_ERRORS`) болсон.
- **Яагаад:** CA (2026-11-12, прод) тамганы 409 бүрд тогтвортой `code` нэмсэн (HTTP статус хэвээр), `GET
  /seal/certificate/{orgEtsi}` цуцлагдсан / хугацааны гадна / олгогдоогүй гэрчилгээнд 200 биш 409 буцаадаг болсон,
  `key_medium` нь eID-ийн тамганд `unknown` биш `server_software` / `server_hsm`. RP-ийн `SEAL:<orgEtsi>` эрхийг одоо
  байгууллагын улсын бүртгэлээр баталгаажсан ADMIN PIN2-оор зөвшөөрнө (зөвшөөрөх хүртэл 403) — README-д тусгасан.
- **Хаана:** `src/errors.ts`, `src/http.ts`, `src/index.ts`, `src/seal.ts` / `src/pades.ts` / `src/validate.ts` (тайлбар),
  `src/pades/validate/evaluate.ts` (төрөл); тест `test/seal.test.ts` (код бүр `seal` / `getCertificate` /
  `requestCertificate` / `sealPdf`-д, 403 хэвээр, танигдаагүй code), `test/contract.test.ts` (discovery-ийн
  `endpoints.seal.*`-д нэрлэсэн code бүр `SEAL_ERROR_CODES`-д; шинэ code-ууд тайлбарт бий); README §3i («Тамганы эрх,
  түлхүүр, хүчинтэй хугацаа», кодын хүснэгт), §3g (`key_medium`).
- **Шалгасан:** GitHub Actions CI (`test`, `node-compat`, `contract`, e2e) — локалд ажиллуулаагүй. Амьд discovery
  (`/.well-known/eid`)-ийн `endpoints.seal.*` тайлбарыг гараар тулгасан.
