### Added — pades: signature / organization-stamp images in the visible stamp (APPEARANCE_SPEC §6, golden v10)

- **Юу:** `PadesAppearance.signatureImage`, `stampImage` (`PdfImage { width, height, color, alpha (base64 zlib), sha256 }` —
  CA-ийн «PDF зураг»; zlib-ийг SDK байтаар нь /SMask болгон бичнэ, runtime шахалт үгүй). Зураг widget-ийн `/AP /N` form
  дотор (A2: гарын үсэг дээд зурваст голлуулсан; B1: гарын үсэг зүүн тийш, тамга баруун дээд буланд хайрцгаас дээш гарна).
  `width = height = 0` → анхдагч хэмжээ 220×64 / 220×110 / 240×147.5 (`prepare` ба `suggestPlacement`;
  `DEFAULT_STAMP_SIZE`, `DEFAULT_SIGNATURE_STAMP_SIZE`, `DEFAULT_ORG_STAMP_SIZE`). `stampImage` зөвхөн `claimedRole`-той.
  Оролтын шалгалт Go-той ижил `REQUEST_INVALID` (хэмжээ, өнгө, alpha ≤ 300 KiB, хатуу zlib — Adler-32, ард байтгүй, яг
  w·h байт; sha256 жижиг hex). `validatePdf` зургийн объектуудыг PDF-ээс уншсан өнгө/хэмжээ/alpha-аар дахин үүсгэж
  байт-түвшинд тулгана. `complete().images` → `registrationFromCompleted` → `POST /pdf/signatures` `images: [{kind, sha256}]`.
- **Яагаад:** Go SDK v0.16.0 (#44)-ийн порт — бүх SDK байт-ижил гаралт.
- **Хаана:** `src/pades/page/appearance.ts`, `src/pades/pdf/signature.ts`, `src/pades/pdf/inflate.ts`
  (`zlibInflateStrict(…, exact)`), `src/pades/validate/appearance.ts`, `src/pades/state.ts`, `src/pades.ts`, `src/sign.ts`,
  `src/contract.ts` (`images`), `scripts/sync-pades-golden.mjs` → Go v0.16.0 `81402d6` (`pades-golden-v10`),
  `test/fixtures/pades/golden/`, README.
- **Шалгасан:** `npm test` — golden v10-ийн 7 `img-*` кейс (5 гаралт + 2 `REQUEST_INVALID`) Go-той байт-ижил, v9-ийн бүх
  кейс хэвээр; `validatePdf` 5 `img-*` гаралт дээр Go `ValidatePDF`-тэй ижил тайлан; оролтын 14 алдааны тохиолдол;
  `npm run lint`, `golden:check`, `size:pades` (gzip 138.1 KB ≤ 300).
- **`IMAGE_MISMATCH`** (409) `PdfRegisterErrorCode` / `PDF_REGISTER_ERROR_CODES`-д — CA `images`-ийг одоогийн хадгалсан
  зурагтай тулгана (CA прод f604ed2b; discovery `registerErrorCodes`).
- **alpha FDICT** — FLG-ийн FDICT бит тавигдсан alpha (DICTID = 1 ч) `REQUEST_INVALID` (Go v0.16.0-тэй ижил; тест
  `alpha FDICT 1`).
- **Үлдсэн:** Adobe гар шалгалт.
