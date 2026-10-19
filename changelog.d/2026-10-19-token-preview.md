### Added — `token.previewCertificate()` (dryRun), `TokenCertInfo.dryRun`

- **Юу:** `eid.token.previewCertificate(input)` — `POST /token/certificate` ижил бие + `"dryRun": true` →
  `TokenCertPreview { supersedes? }`; алдаа `issueCertificate`-тэй ижил (`ApiError`, `tokenLimitOf` …); хариунд
  `dryRun: true` алга бол `ValidationError`. Оролтын шалгалт/бие угсралт нэг `certBody`-д. Discovery `TokenCertInfo.dryRun`.
- **Яагаад:** `supersedes` бодит эхлэлийн хариунд ирэх үед PIN2 push явсан байдаг; RP push-ээс өмнө иргэнд анхааруулах
  хэрэгтэй (CA MR feat/token-cert-dryrun). Go `Token.PreviewCertificate`-тэй ижил.
- **Хаана:** `src/token.ts`, `src/index.ts`, README §3c, `test/portal-gaps.test.ts`, `test/contract.test.ts` (`dryRun`
  CA deploy болтол лог, дараа нь шаардлага).
- **Шалгасан:** `npm run lint`, `npm test` (260 pass), `npm run test:contract`.
