### Fixed — `validatePdf`: `PDF_ENCRYPTED`, `UNSUPPORTED_ENVIRONMENT` (0.20.1)

- **Юу:** (1) `crypto.subtle` алга (http хуудас — secure context биш, хуучин хөтөч) үед `PDF_INVALID`-ийн оронд
  `UNSUPPORTED_ENVIRONMENT` («Web Crypto (crypto.subtle) алга — https хуудас эсвэл шинэ хөтөч шаардлагатай»).
  (2) `/Encrypt`-тэй баримт (RC4, AES-128, AES-256; хоосон хэрэглэгчийн нууц үгтэй ч) `PDF_INVALID`-ийн оронд
  `PDF_ENCRYPTED` («шифрлэгдсэн PDF-ийг шалгах боломжгүй — нууцлалыг арилгаад дахин оролдоно уу»).
- **Яагаад:** (1) RP шалтгааныг мэдэхгүй байв. (2) TS `not_pdf`, Go/CA (digitorus) RC4-д зөв гарын үсгийг
  `malformed_signature` гэж буруу хүчингүйд, AES-д `PDF_INVALID` — гурав зөрж байв. Одоо TS = Go v0.7.1 = CA (`encrypted`).
- **Хаана:** `src/validate.ts`, `src/pades/validate/extract.ts` (trailer `keys()` — resolve хийхгүй; уншигч нээгдэхгүй бол
  `/Encrypt n g R`), golden бэхэлгээ Go v0.7.1 (`scripts/sync-pades-golden.mjs`; +4 шифрлэгдсэн тохиолдол),
  `test/validate-env.test.ts`, README §3g.
- **Шалгасан:** `npm test` (222; validatePdf golden 29 тохиолдол Go-тэй deep-equal), `npm run lint`, `golden:check`,
  `size:validate` (245.8 KB); орчны тест засваргүй кодонд унадгийг (PDF_INVALID) баталсан.
