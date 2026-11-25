### Feat — `validatePdf` accepts the seal stamp with QR; prepare's docId rule (APPEARANCE_SPEC.md §6.5/§6.6, golden v13)

- **Юу:** Validator (own-signer, §6.3): e-Seal гэрчилгээний form stream-ийн хадгалсан байт (`/Length`, тайлахгүй)
  `/EIDVerify`-ээр эхэлбэл **QR-тэй тамганы дардас** (§6.5: иргэний дардас §3 байт-ижил, label «eID Mongolia-аар
  тамгалсан» / "Sealed with eID Mongolia", үүргийн мөр хэзээ ч үгүй — CMS claimedRole үл тооно) гэж §5-ийн 6-р алхмыг
  бүтнээр (regex offset 0, rev = энэ гарын үсгийн дараалал, verify хуудастай бол docId тэнцүү) хийж дахин үүсгэнэ;
  эхлэхгүй бол QR-гүй дардас (v12) өмнөх шигээ. Тэмдэг шийднэ, нөгөө хувилбараар дахин оролдохгүй, аливаа зөрүү → өмнөх
  гарын үсгүүд `modified_after_signing`. Renderer (`appearanceContent`) seal + URL → QR-тэй тамга (зөвхөн дотоод
  golden/тестийн hook ашиглана). `prepare`-ийн docId (§6.6): гарын үсэгтэй баримтад verify хуудасны холбоос алга бол
  шалгасан **e-Seal** гарын үсгийн хамгийн эрт зурсан тэмдэгтэй дардасны docId (маркерын rev = дараалал, өөрийн `/FT
  /Sig` ба шууд бус `/V`, гарын үсэг бүрт ганц widget, `/Filter` байхгүй эсвэл шууд `null`; иргэний дардас хэзээ ч эх
  биш); олдсон docId ≠ `opts.docId` → `REQUEST_INVALID` (үл харагдах гарын үсэгт ч); зөвхөн ганц widget-тэй нэр
  дэвшигчийн өөрийн `/AP`, `/N`, `/Length` (`/DecodeParms`) ба stream-ийн уншилт эвдэрсэн бол `PDF_INVALID`, бусад
  уншигдахгүй объектыг алгасна; юу ч олдохгүй бол `opts.docId`, эс бөгөөс "" (гарын үсэгтэй баримтад санамсаргүй docId
  хэзээ ч үгүй). Эхлээд widget-ийг e-Seal гарын үсэг бүрт тоолно (`/V`-г түүхий лавлагаагаар — объектын дугаар ба
  үе нь xref-ийнхтэй тэнцүү, resolve хийхгүй; тоо + эхнийх л — олон мянган хуурамч widget-тэй PDF-д O(n)), дараа нь
  зөвхөн ганц widget-тэйг уншина (Go #69-тэй ижил).
- **Зан төлөвийн өөрчлөлт:** QR-тэй тамгатай, verify хуудасгүй баримтад үл харагдах гарын үсэг одоо тамганы docId-г
  авна (өмнө нь `opts.docId` эсвэл ""); зөрүүтэй `opts.docId` → `REQUEST_INVALID`. `sealPdf`-ийн буцаах `docId` (байт
  биш) ийм баримтад одоо өмнөх QR-тэй тамганы docId болно. Зөвхөн иргэний гарын үсэгтэй баримт 0.48.x-тэй яг ижил.
- **Нийтийн API QR-тэй тамга ГАРГАХГҮЙ:** `sealPdf` ба `prepare` QR-гүй дардсаа хэвээр (`sealPdf`-ийн гаралт 0.48.1-тэй
  байт-ижил — golden v12 `seal-visible` / `seal-visible-en` DTBS). Шилжүүлэгч нь `src/pades/sealqr.ts`-ийн
  module-private `WeakSet` — options объектын identity (`has(opts)`), шинж чанар биш: prepare дуудагчийн объект ба
  түүний prototype-оос энэ шийдвэрт юу ч уншихгүй (Proxy, symbol, `Object.prototype` бохирдуулалт нөлөөлөхгүй).
  Бүртгэх `withSealQr`-ийг ямар ч entry point экспортлохгүй; `sealPdf`, `complete`, `state` задлалт дууддаггүй; зөвхөн
  src bundle-аар тест/golden (`"sealQr": true`) асаана (Go-ийн экспортлогдоогүй `sealQR`-тэй ижил). QR-гүй дардас
  үүрд хүчинтэй.
- **Writers must not emit the QR seal stamp until the CA validator and /verify bundle ship §6.5.**
- **Яагаад:** Rollout-ийн 1-р алхам — дардас дахин үүсгэдэг шалгагч бүр шинэ хувилбарыг бичигч гаргахаас ӨМНӨ
  production-д хүлээн авна. Go SDK #68 (golden v13)-тай байт-ижил.
- **Хаана:** `src/pades/page/appearance.ts`, `src/pades/validate/appearance.ts`, `src/pades/precheck.ts`
  (`PrecheckedSignature`, `docIdFromStamps`), `src/pades.ts` (`resolveDocId`, `visibleSpec`), `src/pades/sealqr.ts`,
  `scripts/sync-pades-golden.mjs` (Go main `5fa0ac9` — #68 + #69 (docIDFromStamps-ийн Go/TS нийцэл, testdata өөрчлөлтгүй); tag гармагц дахин бэхэлнэ),
  `src/pades/assets/{fonts,chain}.ts` (зөвхөн толгойн мөр), `test/fixtures/pades/{golden,validate}` (v13),
  `test/pades-golden.test.ts`, `test/validate-golden.test.ts`, `test/pades-seal-qr.test.ts`, `README.md` (§3i).
- **Шалгасан:** GitHub Actions CI (локалд ажиллуулаагүй) — golden v13-ийн 7 бичигчийн тохиолдол байт-ижил, validate v13
  (2 эерэг хяналт, 11 сөрөг) Go-ийн тайлантай ижил, `golden:check`, §6.6-ийн салаа бүрийн unit тест.
