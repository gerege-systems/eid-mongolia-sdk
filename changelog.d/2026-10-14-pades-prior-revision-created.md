- **PAdES бүртгэл: горим A-ийн өмнөх гарын үсэгтэй баримт + `created`.**
  - Юу: горим A-аар (CA угсарсан) эхэлж зурагдсан баримтад хөтчөөр нэмж зурахад `registerSignature` 409
    `PRIOR_MISMATCH` авдаг байв — SDK `priorRevisionSha256`-ийг тооцдоггүй, бүх өмнөх мөрийг CMS-ээр илгээдэг. CA өмнөх мөр
    бүрийг өөрийнх нь түлхүүрээр таньдаг (клиент — `cms_sha256`, горим A — `sig_rev_sha256` = `sha256(doc[0 :
    ByteRange[2]+ByteRange[3]])`; CA `persistence/models.go` `PDFPrior.Covers`, `pades_finalize.go` `sha256(signed)`), файлаас
    аль нь болохыг ялгах боломжгүй (профайл 1:1).
  - Засвар: `pades.complete()` → `priorRevisionSha256[]` (`priorCmsSha256`-тай ижил дараалал); `registrationFromCompleted`
    → `priorSignatures` (SDK-д л, CA руу илгээхгүй); `registerSignature` эхлээд бүгдийг CMS-ээр, `PRIOR_MISMATCH` бол эхний k-г
    revision-оор (k = 1…n), n ≤ 4 бол бүх хослол. `priorRevisionSha256` гараар өгвөл хуучин зан.
  - `RegisterSignatureResult.created` — 201 → true, 200 (давталт) → false (`Http.postWithStatus`).
- Хаана: `src/pades.ts`, `src/pades/precheck.ts` (`signatureCMSList` → `{cms, end}`), `src/sign.ts`, `src/http.ts`,
  `src/index.ts` (`PriorSignature`), README.
- Шалгасан: golden `*-second` кейс — `priorRevisionSha256` = өмнөх кейсийн `sigRevSha256`; `pades-session.test.ts`
  (created true/false, PRIOR_MISMATCH → 2/4 оролдлого, өөр алдаа шууд, гараар ангилсан үед оролдохгүй); lint, test,
  test:contract, golden:check, size:pades.
- Үлдсэн: native SDK (Swift/Kotlin/.NET)-д ижил засвар тусдаа.
