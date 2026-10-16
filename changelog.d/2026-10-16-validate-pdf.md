### Нэмэгдсэн — `validatePdf` (`@gerege-systems/eid-mongolia-sdk/validate`, 0.20.0)

- **Юу:** гарын үсэгтэй PDF-ийг хөтөч/Node дотор (файл серверт очихгүй) CA-ийн нийтийн шалгагчийн (`/v3/validate/pdf`,
  Go SDK v0.7.0 `pades.ValidatePDF`) дүрмээр шалгаж ижил JSON тайлан гаргана: ByteRange/messageDigest, CMS, гинж, KU/EKU,
  TSA, гарын үсгийн дараах revision (Go classifier-ийн порт — own/broad/DSS-only, харагдах гарын үсгийг дахин үүсгэж тулгана),
  LTV, онлайн OCSP/CRL (DSS fallback, `offline`), `certificate_level`, `key_medium` (CA !377). Шинэ entry `./validate`,
  `npm run size:validate` (gzip ~134 KB / хязгаар 300 KB).
- **Засвар:** `ocspRevocationChecker` — олгогч өөрөө зурж ӨӨРИЙН гэрчилгээг шигтгэсэн OCSP хариуг (RFC 6960 §4.2.2.2) татгалздаг
  байсан (Go v0.6.0-д засагдсантай ижил асуудал) → хүлээн авна (`parseOCSPFrom`). ECDSA-SHA1 CMS гарын үсэг (Go-той ижил) шалгагдана.
- **Товч (`<eid-login-button>`):** `eid-login-error`-д `{status, code, retryAfter}` (bubbles, composed); 429/503 busy →
  «Систем завгүй — N сек…» countdown, товч түр идэвхгүй (mn/en).
- **Бусад (CA !377):** `TokenConflictCode` += `ACCOUNT_DELETE_PENDING`; contract тест `pdfSigning.registerErrorCodes` заавал;
  `PKICertificate.revokedAt` SUPERSEDED мөрд ч ирнэ (doc).
- **Хаана:** `src/validate.ts`, `src/pades/validate/{extract,evaluate,gofmt,pdfobj,revisions,appearance}.ts`, `src/pades/ltv.ts`
  (`parseOCSP`, `parseOCSPFrom`), `src/ocsp.ts`, `src/pades/x509.ts`, `src/button.ts`, `src/token.ts`, `src/person.ts`,
  `scripts/sync-pades-golden.mjs` (Go `pades/testdata/validate` + golden output), `test/validate-*.test.ts`.
- **Шалгасан:** `test/validate-golden.test.ts` — Go conformance багцын 25 тохиолдол deep-equal; differential corpus (Go
  тестийн 121 PDF, `EID_VALIDATE_CORPUS`) — extract 163/163, revisions 161/161, бүтэн тайлан 121/121; `npm test` (217),
  `npm run lint`, button тест 22/22, OCSP шигтгэсэн олгогчийн тест.
