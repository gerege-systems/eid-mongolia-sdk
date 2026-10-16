### Нэмэгдсэн — `share()`: гарын үсэгтэй файлыг имэйлээр (CA `POST /share`)

- **Юу:** `EidClient.share({ file, filename?, to, subject?, message?, lang?, timeoutMs? })` — `POST /share`
  multipart (FormData/Blob — Node ≥ 18 ба хөтөч). `ShareResult { sent, sha256, signatures, docID?, raw }`.
  `EidClient.shareInfo()` — discovery-ийн `share` блок (`enabled`, формат, хязгаар, `quota`). Алдаа: `ShareError`
  (`ApiError`-ийн дэд анги; `code: ShareErrorCode`, 422-д `reason`, 502 MAIL_FAILED-д `sent`/`failed`/`recipients`);
  `SHARE_ERROR_CODES`, `SHARE_FORM_FIELDS`, `DEFAULT_SHARE_TIMEOUT_MS` (150 с). `Http.postForm`.
- **Нэмэгдсэн:** `PersonCertificate.issuedAt`, `revokedAt?`, `revocationReason?` (RFC 5280 нэр).
- **Яагаад:** CA main 0329ef95 (!371) — `rp./share` (туг `EID_SHARE_ENABLED`, одоогоор унтраалттай) ба
  `/certificates`-ийн шинэ талбарууд. Портал/RP-ууд SDK-аар дуудна.
- **Хаана:** `src/share.ts`, `src/contract.ts` (`RP_ROUTES.share`, `SHARE_FORM_FIELDS`), `src/http.ts`,
  `src/client.ts`, `src/person.ts`, `test/share.test.ts`, `test/contract.test.ts`, README §3b/§3f.
- **Шалгасан:** `npm run lint`, `npm test` (171), Node 18 `test-compat`, `npm run test:contract` live discovery-тэй
  (share зам, multipart талбар, `share` блок).
