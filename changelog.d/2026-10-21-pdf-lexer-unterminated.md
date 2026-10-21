### Security — pades/validate: PDF lexer-ийн хаагдаагүй массив/мөр дээрх ахихгүй давталт

- **Юу:** `src/pades/pdf/reader.ts` (digitorus lex.go-ийн порт): массив дотор `endobj`, ObjStm-ийн төгсгөлд хаагдаагүй hex
  ба literal мөр → `PdfError` (`prepare`/`validatePdf`-д `PDF_INVALID`). ObjStm-ийн толгой `/N`-ээс богино бол мөр
  дууссан даруй зогсоно. Өмнө нь hex мөр мөнхийн давталтад орж, бусад нь санах ой дүүртэл (секунд) ажилладаг байв.
- **Яагаад:** хортой PDF нь хөтөч / Node процессыг гацааж болох байв (Go: `craftzbay/pdf v0.1.3-eid.1`).
- **Хаана:** `src/pades/pdf/reader.ts`; тест `test/pades-lexer-loop.test.ts` (worker thread + 750 мс хязгаар).
- **Шалгасан:** шинэ тест засваргүй кодонд hex кейс гацаж унасан (бусад 0.9–3 с), засвартай бүгд ~20 мс `PDF_INVALID`;
  `npm run lint`, `npm test` (288, fail 0), `npm run golden:check` (162 файл Go-той ижил).
