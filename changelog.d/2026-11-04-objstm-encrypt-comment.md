### Security — `/pades`, `/validate`: ObjStm-ийн zip bomb / гүний хамгаалалтыг тойрох хоёр зам хаагдав

- **Юу:** `src/pades/pdf/nesting.ts` (`checkStructure`; `prepare`, `suggestPlacement`, `complete`, `validatePdf` дууддаг) —
  санах ойн DoS: уншигч (`pdf/reader.ts`) ObjStm-ийг хязгааргүй задалдаг тул RP-ийн процесс / хөтчийн tab OOM эсвэл
  `RangeError: Maximum call stack size exceeded` болох боломжтой. Go SDK v0.21.1 / CA !466-тай ижил алдаа.
  1. `checkStructure` шифрлэлтийг файлын БҮХ түүхий байтаас regex-ээр (`ENCRYPT_REF`, `/Encrypt <<` / `/Encrypt N G R`)
     тодорхойлж, таарвал ObjStm-ийн бүх шалгалтыг (32 MiB zip bomb, `/DecodeParms`, лавлагаатай толгой, гүн) алгасдаг
     байв — `% /Encrypt <<` тайлбар, мөр эсвэл stream өгөгдөл хангалттай (~33 KB → 33 MiB+).
  2. Scanner ба уншигч `/Filter`-ийг өөрөөр уншдаг байв: `[/FlateDecode /FlateDecode]` (уншигч гинжлэн задална),
     давхар түлхүүр `/Filter /FlateDecode /Filter null` эсвэл `[]` (уншигч сүүлийнхийг түүхийгээр уншина), массив
     доторх лавлагаа `/Filter [6 0 R]` (уншигч resolve хийж задална).
- **Засвар:** (1) алгасалтыг бүрэн хасав — ObjStm-ийг шифрлэлтээс үл хамааран шалгана; жинхэнэ шифрлэгдсэн баримтын
  ciphertext zlib болж задрахгүй тул хуурамч татгалзалт үүсэхгүй (`PDF_ENCRYPTED` хэвээр). (2) `/Filter`-ийг уншигч шиг
  (давхар түлхүүрийн сүүлийнх, null / `[]` = түүхий) уншиж, 2+ шүүлтүүр / массив доторх лавлагааг `PDF_INVALID` болгоно.
  `encrypted()` (`precheck.ts`) trailer-ийн түлхүүрээр (`keys()`, resolve хийхгүй — Go v0.21.1-тэй ижил): `/Encrypt null`
  эсвэл унжсан лавлагаатай баримт одоо `PDF_ENCRYPTED` (өмнө нь цааш үргэлжилдэг байв). TS уншигч шифр тайлдаггүй тул Go-ийн
  AES-128 `encrypted()` алдаа (тайлсан ObjStm) энд байгаагүй. API, golden гаралт өөрчлөгдөөгүй.
- **Хаана:** `src/pades/pdf/nesting.ts`, `src/pades/precheck.ts`; тест `test/pades-objstm-encrypt.test.ts` (Go
  `objstm_encrypt_test.go` / `encrypt_test.go`-ийн оролтууд), `test/validate-fuzz.test.ts` seed; fixture
  `test/fixtures/pades/encrypted-objstm/` (Go `pades/testdata/encrypted-objstm/`-тэй байт-ижил: qpdf 12.4.2 AES-256,
  AES-128, RC4-128, шахаагүй RC4 ObjStm).
- **Шалгасан:** CI (`npm run lint`, `golden:check`, `npm test`, Node 18/20/22 compat, e2e); бие даасан review (opus).
