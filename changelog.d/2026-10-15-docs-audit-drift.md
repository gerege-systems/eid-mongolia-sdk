- **Баримт/тайлбарын зөрүү (аудит 2026-10-15) + CHANGELOG нэгтгэл, guard.** Код үйлдэлгүй — зөвхөн `RETRYABLE_ERROR_CODES`
  ба `/token/auth/*`-ийн гэрээний байрлал өөрчлөгдсөн (доор).
  - README: upload туслахууд 0.15.0-д устсан (0.14.0 биш); `NO_SIGNING_CERTIFICATE` зөвхөн sign / certificate-choice start
    (`/pdf/sign/prepare` CA-д 2026-10-14-нөөс байхгүй); `/token/auth/*` live discovery-д
    (`endpoints.token.auth_challenge` / `auth_verify`) байгаа; зурагчийн гэрчилгээний үндсэн зам = certificate-choice
    (`CERT` эрх), `person.certificates` (`PKI_READ`) зөвхөн итгэмжлэгдсэн RP-д иргэн 24 цагт нэвтэрсэн үед; аппын доод
    хувилбар: v3 урсгал iOS 2.2.3 (59) / Android 60-аас, сервер албадах доод нь 2026-10-15-нд iOS 2.2.7 / Android 83
    (live `/mobile/app-config`).
  - `src/contract.ts`: `tokenAuthChallenge` / `tokenAuthVerify` → `RP_ROUTES` (гэрээний тест одоо fail-аар шалгана);
    `RP_ROUTES_UNDISCOVERED` хоосон.
  - `src/errors.ts`: `RetryableErrorCode` / `RETRYABLE_ERROR_CODES`-оос `PDF_PREPARE_BUSY`, `DOCUMENT_PENDING` (устсан
    горим A-ийн route), `TSA_UNAVAILABLE`, `LTV_UNAVAILABLE` (CA буцаадаггүй — зөвхөн клиент `PadesError.code`) хасагдсан;
    үлдсэн `RATE_LIMITED`, `STATE_UNAVAILABLE`, `ISSUANCE_PENDING` (CA `server/internal/service/memory`-д шалгасан).
    429/503 + Retry-After нь кодоос үл хамааран `retryable` хэвээр. `REPRESENTATION_REVOKED` = `POST /pdf/signatures`
    ба токены гэрчилгээ олголт; `pdfMaxBytes` дурдлага хасагдсан.
  - `src/sign.ts`: `registerSignature`-ийн алдааны жагсаалт CA `pades_register.go`-ийн бодит кодоор (`PDF_FOREIGN_SIGNATURE`
    CA-аас ирдэггүй — клиент `PadesError`); устсан `memory/pades.go`-ийн лавлагаа → `websign.go` `fileNameFromSession`.
    `src/types.ts` `SessionResult.expiresAt` = CA-ийн утга (0.14.2-оос, auth ч мөн); `src/button.ts` устсан
    `oidc_login.html` лавлагаа; `src/index.ts` багцын нэр.
  - `CHANGELOG.md`: 0.13.0 … 0.15.4 фрагментуудыг хувилбар бүрийн гарчгаар нэгтгэв (tag-ийн commit-оор тулгасан:
    sign-session-gaps → 0.14.1, pades-prior-revision-created → 0.15.2, button-push-disclosure → 0.15.3);
    sign-session-gaps-ийн «CA хугацаа буцаадаггүй» нь 0.14.2-оос (CA !357) хуучирсныг тэмдэглэв.
  - Guard: `scripts/changelog.mjs` (`assemble` / `check-release` / `check-pr`); CI `changelog` job PR-д фрагмент шаардана;
    Release workflow tag-д фрагмент үлдсэн эсвэл `## <version>` гарчиг алга бол publish хийхгүй.
  - Шалгасан: live `https://ca.eidmongolia.mn/.well-known/eid`, `/mobile/app-config` (2026-10-15), CA main `af939ab0`
    эх код; `npm run lint`, `npm test`, `npm run test:contract`.
