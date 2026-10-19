### Fixed — `/Encrypt << … >>` шууд толь → `PDF_ENCRYPTED` (0.21.0)

- **Юу:** trailer-ийн `/Encrypt`-ийг зөвхөн `n g R` лавлагаагаар биш, шууд толиор (`/Encrypt <<`, `/Encrypt<<`) ч
  шифрлэгдсэн гэж танина — уншигч баримтыг нээж чадахгүй үеийн байтын шалгалтад (`prepare` precheck #4, `validatePdf`,
  гүн давхарлалтын шалгалтын ObjStm алгасалт). `/EncryptMetadata` encrypted биш хэвээр.
- **Яагаад:** CA !382-тэй ижил засвар (өмнө нь шууд тольтой эвдэрсэн баримт `PDF_INVALID` болдог байв).
- **Хаана:** `src/pades/precheck.ts`, `src/pades/validate/extract.ts`, `src/pades/pdf/nesting.ts`; `test/pades-encrypt.test.ts`.
- **Шалгасан:** `test/pades-encrypt.test.ts` (AES-256 / RC4 шууд толь, уншигч нээгдэх/нээгдэхгүй; `/EncryptMetadata`), `npm test`.
- **Үлдсэн:** Go SDK-д ижил засвар (өөр PR) орсны дараа golden-д тохиолдол нэмэх бол Go-той тулгана.
