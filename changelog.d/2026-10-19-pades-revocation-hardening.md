### Security — `validatePdf` / `complete`: цуцлалтын нотолгооны тохирол, шинэлэг байдал, revoked = хатуу алдаа, гүн давхарласан PDF (0.21.0)

- **Юу (зан төлөвийн өөрчлөлт — аюулгүй байдлын засвар, Go SDK v0.7.2 / #28-ийн порт):**
  - `validatePdf` (DSS ба онлайн): OCSP нь ЭНЭ гэрчилгээнийх байх ёстой — CertID = гинжийн олгогчийн нэр/түлхүүрийн hash +
    serial (өмнө нь зөвхөн serial, аль ч eID олгогчийн гарын үсэгтэй хариу тооцогддог байв). CRL нь гэрчилгээний олгогчийнх
    (нэр = олгогчийн subject, AKI = SKI, гарын үсэг). «good» нотолгоо шалгах цагт (цагийн тэмдгийн цаг, эс бөгөөс `time`/одоо)
    шинэлэг: thisUpdate ≤ одоо+5 мин, nextUpdate ≥ шалгах цаг−5 мин, thisUpdate ≥ шалгах цаг−24 ц эсвэл thisUpdate…nextUpdate
    нь шалгах цагийг хамарна (`freshAt`). Олгогчийн гарын үсэгтэй «revoked» (OCSP/CRL, онлайн/DSS) нь «good»-ийг үргэлж
    давна (өмнө нь DSS-д good OCSP + revoked CRL → `valid`; онлайн good нь DSS-ийн revoked-ийг дардаг байв).
    **Өмнө `valid` байсан зарим баримт одоо `indeterminate` (`revocation_unavailable`) эсвэл `invalid` (`revoked`).**
  - `complete`: OCSP «revoked» эсвэл гэрчилгээг агуулсан CRL → тэр дор нь `LTV_UNAVAILABLE`, `cause` =
    `CertificateRevokedError` (шинэ export, `/pades`), `retryable` false, дахин оролдохгүй (өмнө нь revoked OCSP-г
    алгасаад цэвэр CRL-ээр DSS угсарч амжилттай дуусдаг байв). OCSP/CRL-д мөн CertID/олгогч/шинэлэг байдлын дүрэм.
  - `prepare` / `validatePdf`: задлахын өмнө массив/толийн давхарлалт > 256 → `PDF_INVALID` (`complete` — `STATE_INVALID`);
    Go `CheckStructure`-ийн порт (`obj`/`trailer`-ийн дараах, FlateDecode ObjStm-ийн объект бүр; уншилт/inflate төсөв).
  - LTV/цуцлалтын алдааны мессежээс гэрчилгээний CN (иргэний нэр — PII) хасагдсан.
- **Яагаад:** 10-15 SDK аудитын олдвор 1–5 (fail-open цуцлалт, гүн рекурс) — `ca.eidmongolia.mn/verify` (хөтчийн
  `validatePdf`) ба порталын client-side PAdES (`complete`) энэ кодыг ашигладаг.
- **Хаана:** `src/pades/revocation.ts` (шинэ: `freshAt`, `ocspCertIDMatches`, `parseCRL`/`crlFor`/`crlListed`,
  `CertificateRevokedError`), `src/pades/pdf/nesting.ts` (шинэ: `checkStructure`), `src/pades/validate/evaluate.ts`
  (`StatusSource.certStatus(cert, issuer, at)`, `DSSStatus`, `OnlineStatus`, `ltvCoverage`), `src/pades/ltv.ts`
  (`fetchOCSP`, `crlCovers`, `collectLTV`), `src/pades/validate/extract.ts`, `src/pades.ts`, `src/validate.ts`,
  `src/pades/pdf/inflate.ts` (`InflateLimitError`); golden бэхэлгээ Go `083434a` (`scripts/sync-pades-golden.mjs`; validate v4
  +13 тохиолдол, `pki/05.pem`); `test/pades-revocation.test.ts`; README §3d/§3g.
- **Шалгасан:** `npm test` (243; validatePdf golden 42 тохиолдол Go-тэй deep-equal, v4-ийн 13 бүгд), `npm run lint`,
  `golden:check`, `test-compat`; засваргүй кодонд v4-ийн 8 тохиолдол унадгийг баталсан (Go-той ижил 8). Хөтөчид (Playwright
  Chromium + WebKit) validate golden-ийн offline 39 тохиолдол (v4 бүгд) ижил. `size:validate` 245.8 → 252.0 KB (gzip
  134.3 → 136.7 KB), `size:pades` 225.1 → 234.6 KB (gzip 126.2 → 129.6 KB).
- **Үлдсэн:** CA-ийн `validate` хуулбарт ижил дүрэм (Go #28-ийн «үлдсэн»); CA `vendor-sdk-validate`-ийг шинэ хувилбараар.
