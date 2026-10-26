# Changelog
## 0.37.0 — 2026-10-26

### Changed (BREAKING) — «Миний QR»: иргэний PIN2 гарын үсэгтэй «Миний мэдээлэл» (CA гэрээ myqr-2026-10-26)

- **Юу:** `eid.qr` бүрэн солигдсон (хуучин API хэрэглэгчгүй байсан тул нийцлийн давхарга үгүй). `qr.start({ qr, nonce?,
  relyingPartyName? })` → `POST /authentication/qr` `{qr, relyingPartyUUID, relyingPartyName, nonce}` → `{ sessionId, nonce }`
  (nonce өгөөгүй бол base64url(16 байт); VC алга). `qr.result` / `qr.check` (`{ complete: false } | { complete: true, result }`)
  presentation-ийг `verifyQrPresentation(jws, expect, trust)`-аар шалгана: иргэний PS256 JWS (`typ` `eidmn-myqr+jwt`, `x5c`
  [SIGN гэрчилгээ, олгогч CA]) — гинж (`TrustConfig`, анхдагч National Root + 04 issuer allowlist), QUALIFIED + contentCommitment,
  цуцлалт (`trust.revocation`, алга бол SDK-ийн OCSP, hard-fail), гарын үсэг, claim, өгөгдлийн хязгаар (гэрээний §6.1, 13
  алхам). Үр дүн `QrPresentation`: `data` (апп дээр хадгалсан түлхүүр/утга verbatim), `source`, `photo` (JPEG), `signer`
  (гэрчилгээнээс ETSI, нэр), `signedAt`, `sha256` (= CA аудитын `qrsha`). Алдаа `QrError` (`QR_JWS_MALFORMED` …
  `QR_DATA_INVALID`, `QR_PRESENTATION_GONE` — `GET /session` 410, `QR_PENDING`); CA-ийн код `ApiError.code`-оор дамжина.
  `parseQr` → `{ token, qr }`, зөвхөн `EIDMN-QR1:<token>`. Хасагдсан: аттрибутын каталог (`QR_ATTRIBUTES`), CA-ийн ES256 /
  JWKS шалгалт (`QrConfig.jwksUrl` г.м.), `SessionPresentation.claims`. RP-д зөвхөн `QR_PRESENT` эрх.
- **Яагаад:** эзэмшигчийн шийдвэр (2026-10-26) — RP иргэний «Миний мэдээлэл»-ийг иргэний өөрийн QUALIFIED гарын үсэгтэйгээр
  авна; CA өгөгдөл хадгалахгүй, хувилбар (v1/v2) салгахгүй.
- **Хаана:** `src/myqr.ts` (дахин бичсэн), `src/validator.ts` (`verifyQrSigner` @internal; цагийг дамжуулдаг болсон),
  `src/client.ts`, `src/session.ts`, `src/types.ts`, `test/myqr.test.ts`, README §3h.
- **Шалгасан:** `npm run lint`, `npm test` (300; openssl тест PKI-аар гэрээний §7-ийн 39 verify кейс + нэмэлт, mock RP-API:
  start body/nonce 22 тэмдэгт, 400/403/404/409 код, USER_REFUSED, RUNNING/QR_PENDING, 410 → QR_PRESENTATION_GONE),
  `scripts/test-compat.mjs`, `golden:check`. CA-ийн `myqr_vectors.json` (902e0b4e) `test/fixtures`-д,
  SHA-256 `MYQR_VECTORS_SHA256`-д бэхлэгдсэн — бүх кейс давсан.

## 0.36.0 — 2026-10-24

### Added
- `<eid-login-button>` / `mountEidLoginButton`: `lang` нь eID аппын 7 хэлийг дэмжинэ — `mn`, `en`, `ru`, `zh`, `fr`, `es`,
  `ar` (өмнө нь зөвхөн mn/en, бусад нь mn). Цонхны бүх мөр (QR алхам, регистрийн дугаарын алхам, алдаа, товч) орчуулагдсан,
  нэр томьёо нь аппын (eid-mongolia-mobile `Strings*`) орчуулгыг дагана. `ar` → товч ба цонх `dir="rtl"` (регистрийн
  дугаарын оролт `ltr`); бусад хэлэнд `dir="ltr"`. `zh-CN`, `en_GB` г.м. үндсэн хэлээр; үл мэдэгдэх утга → `mn`.
  Start хүсэлт / Web2App URL-д хэвийн болгосон хэл (`lang=ru` г.м.) очно — backend (`createEidLogin`, Go `eidlogin`)
  өмнөх шигээ `en` → `eng`, бусад → `mon`. Шинэ export: `EID_LOGIN_LANGS`, `resolveEidLang`.
- Товчны CSS (shadow `<style>`) өөрчлөгдөөгүй; mn/en текст өөрчлөгдөөгүй.
- PAdES-ийн `lang` (харагдах тамга / баталгаажуулах хуудас) mn/en хэвээр — golden вектор, фонтын дэд олонлогт хамаарна.
- Шалгасан: `npm run lint`, `npm test` (7 хэл, rtl, хэл хэвийн болголт, start/Web2App-ийн lang).

## 0.35.0 — 2026-10-24

### Removed (BREAKING) — гарын үсгийн зураг / байгууллагын тамганы зураг

- **Юу:** 0.31.0–0.32.0-д нэмэгдсэн зургийн функц бүрэн хасагдав: `/pades`-ийн `appearance.signatureImage` /
  `stampImage`, `PdfImage`, `Completed.images` (бүртгэлийн `images`, 409 `IMAGE_MISMATCH` код), alpha/zlib FDICT
  шалгалт, зурагтай байрлал (220×110 / 240×147.5); RP-API-ийн `person.signatureImage()`, `Representation.stampImage` /
  `stampImageSet`. Харагдах тамга өмнөх QR тамга руу буцна — `prepare` / `complete`-ийн гаралт 0.30.1-тэй байт-ижил.
  Эдгээр талбар/функц ашиглаж буй код TypeScript-ээр compile хийгдэхгүй — устгана уу. «Миний QR» (`qr.*`) хэвээр.
- **Яагаад:** зургийн функцийг бүх системээс (CA, портал, апп, SDK) бүрэн хасах шийдвэр (2026-10-24).
- **Хаана:** #61, #63-ийг revert; golden v10 → `pades-golden-v9` (зурагтай 5 кейс хасагдсан).
- **Шалгасан:** `src/pades*`, `test/fixtures/pades` нь 0.30.1 (golden v9)-тэй `git diff` хоосон; `npm run golden:check`
  (Go reference v9 commit-тэй байт-ижил), `npm test`, lint.

## 0.34.0 — 2026-10-23

### Added — «Миний QR»: нэг удаагийн шалгалт `check`; `result`-ийн хүлээлт дуусахад `QR_PENDING`

- **Юу:** `eid.qr.check(session, { serverPollMs? })` → `{ state: "RUNNING" } | { state: "COMPLETE", presentation }` — нэг `GET /session/{id}` (анхдагч 1 с), COMPLETE+OK бол JWS/JWKS-ээр шалгасан presentation;
  татгалзсан / CA-ийн TIMEOUT бол SessionFailed. **Зан төлөвийн өөрчлөлт:** `result`-ийн өөрийн хүлээх хугацаа дуусахад
  (CA-ийн session идэвхтэй хэвээр) өмнө нь SessionFailed `TIMEOUT` байсан бол одоо `QrError` `QR_PENDING` — CA-ийн жинхэнэ `TIMEOUT`-оос
  ялгагдана.
- **Яагаад:** demo-ийн кассын хуудас polling хийхэд «иргэн хараахан зөвшөөрөөгүй» ба CA-ийн TIMEOUT ялгагдахгүй байсан
  (demo `session.poll` + `qr.verify`-ээр тойрсон) — SDK gap.
- **Хаана:** QR модуль, тест, README. Release 0.34.0.
- **Шалгасан:** stub CA: RUNNING → `check` RUNNING; COMPLETE → presentation; endResult TIMEOUT → SessionFailed (`result`, `check`);
  RUNNING + хүлээлт дууссан → `QR_PENDING`. Бүх тест, lint/format.

## 0.33.0 — 2026-10-23

### Added — «Миний QR» (биечлэн шалгах): `eid.qr.parse / start / result`

- **Юу:** `parseQr` (`EIDMN-QR1:<token>` эсвэл токен), `eid.qr.start` → `POST /authentication/qr` (`qr`, `attributes`,
  ACSP_V2 rpChallenge 32 байт, `nonce`?) → `QrSession{sessionId, vc, nonce, attributes, expiresAt?}` (JSON-оор хадгална),
  `eid.qr.result` → long-poll + CA-ийн presentation JWS (ES256) шалгалт: JWKS (`qr.jwksUrl`, анхдагч
  `https://ca.eidmongolia.mn/.well-known/eid-jwks.json`, 1 ц кэш, танихгүй kid → ≥30 с-ийн зайтай дахин татна, RP secret
  илгээхгүй), iss / aud (RP UUID) / sid / nonce / iat (+60 с, −10 мин) / exp, attrs ∪ unavailable = хүссэн яг, аттрибут
  бүрийн төрөл → `QrPresentation{sub, attrs (typed), unavailable}`. `verifyQrPresentation` (сүлжээгүй), `eid.qr.verify`.
  Алдаа: `QrError` (`QR_FORMAT_INVALID`, `QR_ATTRIBUTES_INVALID`, `QR_PRESENTATION_INVALID`, `QR_JWKS_UNAVAILABLE`),
  404 → `QrTokenInvalidError` (`ApiError`, `code === "QR_TOKEN_INVALID"`), татгалзал `SessionFailedError`.
  `SessionResult.presentation`. `RP_ROUTES.authQr` (live discovery-д бий, CA !419).
- **Яагаад:** CA гэрээ «Миний QR» v1 (2026-10-23) — RP SDK тал.
- **Хаана:** `src/myqr.ts`, `src/client.ts`, `src/session.ts`, `src/types.ts`, `src/errors.ts`, `src/http.ts`,
  `src/contract.ts`, `src/index.ts`, `test/myqr.test.ts`, `test/fixtures/qr_vectors.json` (Go / .NET-д ижил), README §3h.
- **Шалгасан:** `npm test` (296 pass), `npm run lint`; vector 11 parse + 30 verify Go/TS/.NET гурвуулаа давсан; stub CA:
  body, nonce=rpChallenge, JWKS кэш + kid rotation, 404, USER_REFUSED, aud/attr/nonce зөрөх, TIMEOUT, JWKS алга/http.

## 0.32.0 — 2026-10-23

### Added — `person.signatureImage()`, `Representation.stampImage` (RP-API зураг)

- **Юу:** `eid.person.signatureImage(personEtsi)` → `GET /person/etsi/{personEtsi}/signature-image` →
  `EidImage { png, sha256, width, height, updatedAt?, pdfImage? }`; 404 → `null`, 403 → `ForbiddenError`.
  `Representation.stampImageSet?`, `Representation.stampImage?: EidImage` (SIGN эрхтэй RP-д). `PdfImage` төрөл
  `types.ts`-д шилжиж үндсэн экспортоос ч гарна (`/pades`-ийн `PdfImage` ижил төрөл) — `pdfImage`-ийг
  `appearance.signatureImage` / `stampImage`-д хэвээр өгнө. `RP_ROUTES.personSignatureImage` (contract).
- **Яагаад:** demo/портал зургийг SDK-гүйгээр гараар татаж байсан (SDK gap); Go v0.17.0-тэй ижил.
- **Хаана:** `src/person.ts`, `src/types.ts`, `src/contract.ts`, `src/pades.ts`, `src/index.ts`,
  `test/portal-gaps.test.ts`, README.
- **Шалгасан:** `npm test` (289/289; stub 200/404/403/500, representations stampImage), `npm run lint`,
  `test:contract` (live discovery-д зам бий), `golden:check`, `size:pades` (gzip 138.2 KB).

## 0.31.0 — 2026-10-23

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

## 0.30.1 — 2026-10-21

### Security — pades/validate: PDF lexer-ийн хаагдаагүй массив/мөр дээрх ахихгүй давталт

- **Юу:** `src/pades/pdf/reader.ts` (digitorus lex.go-ийн порт): массив дотор `endobj`, ObjStm-ийн төгсгөлд хаагдаагүй hex
  ба literal мөр → `PdfError` (`prepare`/`validatePdf`-д `PDF_INVALID`). ObjStm-ийн толгой `/N`-ээс богино бол мөр
  дууссан даруй зогсоно. Өмнө нь hex мөр мөнхийн давталтад орж, бусад нь санах ой дүүртэл (секунд) ажилладаг байв.
- **Яагаад:** хортой PDF нь хөтөч / Node процессыг гацааж болох байв (Go: `craftzbay/pdf v0.1.3-eid.1`).
- **Хаана:** `src/pades/pdf/reader.ts`; тест `test/pades-lexer-loop.test.ts` (worker thread + 750 мс хязгаар).
- **Шалгасан:** шинэ тест засваргүй кодонд hex кейс гацаж унасан (бусад 0.9–3 с), засвартай бүгд ~20 мс `PDF_INVALID`;
  `npm run lint`, `npm test` (288, fail 0), `npm run golden:check` (162 файл Go-той ижил).

## 0.30.0 — 2026-10-21

### Tests — pades golden v8 (verify page chain with non-zero object generations)

- **Юу:** golden-ийг Go #40 (`21f8434`, `pades-golden-v8`) руу бэхэлсэн: `input/verify-gen1.pdf` (verify хуудас `6 1 obj`,
  docId Link `7 1 obj`, URI action `8 2 obj`) ба кейс `verify-gen1`, `page0-verify-gen1`, `page-explicit-verify-gen1`.
- **Яагаад:** PLACEMENT_SPEC §1a «Object generations» — docId-ийг xref-ийн бодит generation-оор уншина (Swift port 0 гэж
  таамагладаг байсныг CA репод зассан). TS аль хэдийн зөв — кодын өөрчлөлтгүй.
- **Хаана:** `scripts/sync-pades-golden.mjs` (`GO_SDK_COMMIT`), `test/fixtures/pades/golden/`, `src/pades/assets/*.ts`
  (зөвхөн үүсгэсэн толгойн commit).
- **Шалгасан:** `npm run golden:check`; `test/pades-golden.test.ts` + `test/pades-placement.test.ts` — 36 кейс байт-ижил.
### Added — pades `prepare` `verifyPagePosition: "last" | "first"` (golden v9)

- **Юу:** `verifyPagePosition: "first"` — баталгаажуулах (QR) хуудас үндсэн `/Pages /Kids`-ийн эхэнд орж баримтын 1-р хуудас
  болно; анхдагч `"last"` өмнөхтэй байт-ижил; бусад утга `REQUEST_INVALID`. `appearance.page`, `suggestPlacement`,
  `placement.page` оролтын PDF-ийн хуудсаар (нэмэгдсэн хуудсыг тоолохгүй — SDK дотроо +1 болгож зурна).
- **Яагаад:** портал/desktop-д «Баталгаажуулалтын хуудсыг эхэнд» сонголт (Go v0.15.0, PAGE_SPEC §8a, PLACEMENT_SPEC §1b).
- **Хаана:** `src/pades.ts` (`PadesPrepareOptions.verifyPagePosition`), `src/pades/page/page.ts` (`appendVerifyPage(…, first)`),
  `test/pades-golden.test.ts` (manifest-ийн түлхүүр), `scripts/sync-pades-golden.mjs` → Go `9e76888` (`pades-golden-v9`),
  `test/fixtures/pades/golden/`, README.
- **Шалгасан:** `npm run lint`; `npm test` — golden (v9-ийн 8 `vpfirst-*` кейс багтсан) Go-той байт-ижил.

## 0.29.2 — 2026-10-21

### Changed
- `<eid-login-button>`: лого «e-ID» өөрөө зураастай тул ард нь «-ээр» гэж дахин зураас тавихаа больсон — товч
  болон цонхны гарчиг `[лого] нэвтрэх`. Уншигчийн нэр хэвээр («eID-ээр нэвтрэх», aria-label); en хэвээр
  (`Log in with [лого]`). Хаана: `src/button.ts`. Шалгасан: `npm test`, Chromium screenshot + ariaSnapshot.

## 0.29.1 — 2026-10-21

### Fixed
- `<eid-login-button>` 0.28.1-ийн регресс: лого + богино текст flex item болсон тул Chrome accessible name-д зай
  оруулж «eID -ээр нэвтрэх» гэж уншдаг байв (портал e2e `getByRole('button', {name: 'eID-ээр нэвтрэх'})` унасан).
  Одоо логотой анхдагч үед товч болон цонхны `h2`-д бүтэн `aria-label` («eID-ээр нэвтрэх» / «Log in with eID»),
  sr-only span хасагдсан. Харагдах байдал өөрчлөгдөөгүй. Хаана: `src/button.ts`. Шалгасан: `npm test`, Chromium
  Playwright `ariaSnapshot`.

## 0.29.0 — 2026-10-21

### Added — `appearance.exact` ба `suggestPlacement` (golden v7)

- **Юу:** `PadesAppearance.exact?: boolean` (анхдагч false) — тэмдэг яг `page/x/y/width/height` дээр зурагдана, хэзээ ч
  шилжихгүй (хуудаснаас гарвал `REQUEST_INVALID`); хуудсыг уншсаар байгаа тул `placement.status` = `requested` /
  `overlap` / `unscanned`, `moved` хэзээ ч биш (PLACEMENT_SPEC §6a). Шинэ `suggestPlacement(pdf, appearance)` —
  prepare-ийн байршлыг гарын үсэггүй, сүлжээгүй ажиллуулж `{ page, x, y, width, height, status, pageWidth, pageHeight,
  pageCount, pages }` буцаана (§6b). `exact` false/байхгүй бол өмнөхтэй байт-ижил. Go v0.14.0-ийн
  (`Appearance.Exact`, `SuggestPlacement`) 1:1 порт.
- **Яагаад:** портал (eidmongolia.mn) ба eid-desktop иргэнд PDF-ийг урьдчилан харуулж тэмдгийн байршлыг сонгуулна.
- **Хаана:** `src/pades.ts` (`suggestPlacement`, `PlacementSuggestion`, `PadesAppearance.exact`),
  `src/pades/page/suggest.ts` (`suggestVisible`), `src/pades/page/occupancy.ts` (`placeOnPage` — prepare ба suggest
  нэг зам), `src/pades/page/appearance.ts` (`pageList`), README; golden pin Go `247c964` (#39, `pades-golden-v7`: +5
  `exact-*` кейс, `expect.suggestion` / `suggestionError`).
- **Шалгасан:** `npm run lint`, `npm test` (golden 33 кейс байт-ижил + suggestion талбар бүрээр), `npm run golden:check`,
  `npm run test:contract`, `npm run size:pades`.

## 0.28.1 — 2026-10-21

### Changed
- `<eid-login-button>`: лого «e-ID» гэж бичигддэг тул анхдагч текст лого + «eID» гэж давхардахгүй — товч болон
  цонхны гарчиг `[лого]-ээр нэвтрэх` (en: `Log in with [лого]`). Уншигчид sr-only «eID»-ээр нэр бүтэн хэвээр
  («eID-ээр нэвтрэх»), `textContent`/`getByRole` нэр өөрчлөгдөөгүй. `label` атрибут өгсөн эсвэл `icon="none"` үед
  хуучнаараа. Хаана: `src/button.ts`. Шалгасан: `npm test` (274 pass), Chromium screenshot (mn/en товч, цонх).

## 0.28.0 — 2026-10-20

### Changed — `<eid-login-button>`: шинэ «e-ID» wordmark лого (inline SVG), `--eid-logo` токен

- **Юу:** товч болон QR цонхны толгойн хуучин 96×96 PNG лого (data URI) → шинэ «e-ID» wordmark, inline SVG (нэг path,
  гадны файл/сүлжээ үгүй). Өнгө — шинэ токен `--eid-logo` / `--eid-logo-dark` (анхдагч light `#1430FD`, dark `#fff`):
  outline товч (light цагаан / dark хар хөх дэвсгэр) хоёр theme-д тод. Хэмжээ: товчинд өндөр 16 px, `variant="icon"`-д
  12 px (44×44 дотор), цонхны толгойд 20 px. `part="icon"` хэвээр (одоо `<svg>`, өмнө нь `<img>`). API өөрчлөгдөөгүй.
- **Яагаад:** eID-ийн шинэ брэнд (developer.eidmongolia.mn лого, 2026-10-20). `dist/button.js` 61.2 → 51.2 KB.
- **Хаана:** `src/logo.ts`, `src/button.ts`, README (`icon`, токены хүснэгт), `test/button.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`, `size:pades`/`size:validate`; Playwright зураг (light/dark × default/en/icon/
  icon=none, цонхны толгой).
### Docs — CA !403 (b040b463) нийцэл

- **Юу:** токен олголт / dryRun — RP-д зөвхөн `TOKEN_ISSUE` эрх (SIGN биш); `ACCOUNT_DELETE_PENDING` эхлэл ба preview-д
  push-ээс өмнө 409 (өмнө зөвхөн үр дүнгийн шатанд) — token start/preview-ийн алдааны жагсаалтад нэмэв; `claimedRole`
  mn ба en хоёуланг CA хүлээн авна; RP нэр ≤ 120 **тэмдэгт** (байт биш, CA тэмдэгтээр таслана).
- **Яагаад:** CA !403 прод дээр (`ca.eidmongolia.mn`) — бодлого өөрчлөгдсөн. Кодын зан өөрчлөгдөөгүй (SDK-д discovery
  `registration` блокийн төрөл байхгүй тул `registration.paused` нэмэх зүйлгүй).
- **Шалгасан:** CA `origin/main` b040b463-ийн `tokencert.go`, `store.go` (`displayNameMaxRunes`), `pades_register.go`.

## 0.27.0 — 2026-10-20

### Fixed — SDK аудитын кодын алдаанууд (Go / .NET / Swift / Kotlin-той нийцүүлэв)

**Юу ба яагаад.**
- `session.waitForResult` 150 с-т таслахаа болив (CA auth 300 с, sign 600 с — иргэн 150 с-ээс хойш баталбал RUNNING
  буцаж validator унадаг байв). `maxWaitMs` өгөөгүй бол: `expiresAt` (шинэ опц; start хариуны `expiresAt`) +
  `WAIT_GRACE_MS` (15 с) → discovery `sessionTtl` (max(auth, sign)) + 15 с → `DEFAULT_MAX_WAIT_MS` (600 с). `maxWaitMs`
  өгвөл түүнийг л дагана; long-poll хэвээр. Хугацаа өнгөрсөн `expiresAt`-д ч нэг poll хийнэ (CA-ийн TIMEOUT-ийг авна).
- Токены кодууд: тусдаа тогтмол `TOKEN_ISSUANCE_PENDING`, `KYC_INCOMPLETE`, `NO_ACTIVE_DEVICE`, `CSR_KEY_REUSED` ба шинэ
  `TokenErrorCode` / `TOKEN_ERROR_CODES` (CA `tokencert.go`, `token_auth.go`-ийн бүх код). `TokenConflictCode` өөрчлөгдөөгүй —
  exhaustive `switch` эвдрэхгүй (`APP_ATTESTATION_INVALID`-ийн загвар).
- `registrationFromCompleted`: `medium` алга бол `sessionID`-аас (phone ⇔ sessionID) тодорхойлж биед тавина; phone +
  sessionID алга, token + sessionID, үл мэдэгдэх medium → `ValidationError` (`buildRegisterBody` ч token + sessionID-ийг
  татгалзана). `PadesCompleted.claimedRole` (шинэ); claimedRole-той гарын үсэгт `onBehalfOf` алга бол `ValidationError`
  (өмнө CA дараа нь татгалздаг байв).
- `ocspRevocationChecker`: «good» кэш min(5 мин, хариуны `nextUpdate`) — Go-той ижил (өмнө nextUpdate-ийг үл тоодог).
- `pades.complete`: `fetch` алга (тохиргоо) → `REQUEST_INVALID`, `retryable` false (өмнө `TSA_UNAVAILABLE` + retryable).
  `UNSUPPORTED_ENVIRONMENT`-ийг сонгоогүй: `PadesErrorCode` бүх платформд ижил union — шинэ код exhaustive switch-ийг эвдэнэ.
- RSASSA-PSS гарын үсэг `complete`-д `SIGNATURE_INVALID` хэвээр — Go v0.13.0 ч үүнд шилжсэн (5 SDK ижил).
- `TokenApi` тайлбар: олголтод зөвхөн `TOKEN_ISSUE` эрх.

**Хаана.** `src/session.ts`, `src/token.ts`, `src/sign.ts`, `src/pades.ts`, `src/ocsp.ts`, `src/index.ts`, README.

**Хэрхэн шалгасан.** Шинэ тест: `waitForResult` хугацаа (discovery / expiresAt / өнгөрсөн / maxWaitMs / хуучин CA / 500),
`registrationFromCompleted` medium + claimedRole, OCSP nextUpdate кэш, `fetch` алга → REQUEST_INVALID; `npm run lint`,
`npm test` (274 pass).
### Docs — README/JSDoc ↔ код ↔ CA аудит (зөвхөн баримт)

**Юу.** README-ийн жишээ, хязгаар, алдааны код болон JSDoc-ийг 0.26.0-ийн код, CA (`origin/main`) ба амьд
`/.well-known/eid`, `/mobile/app-config`-той тулгаж зөрүүг засав. Кодын зан өөрчлөгдөөгүй.

- Share квот: цагт 300 / өдөрт 3000 (өмнө 30/200 гэж буруу); 415 нь задрахгүй/шифрлэгдсэн PDF-д ч; `SHARE_DISABLED`
  туг CA-д байхгүй — `enabled=false` → 503 `MAIL_UNAVAILABLE`/`VALIDATOR_UNAVAILABLE` (`share.ts`, `client.ts`).
- Жишээнүүд strict TS-д хөрвөнө: дутуу import (`NATIONAL_ROOT_CA_PEM`, `registrationFromCompleted`, `prepare`,
  `writeFileSync`), `s.acsp!`, `Map.groupBy` (Node ≥ 21) → Node 18-д ажиллах хэлбэр, `import { Redis } from "ioredis"`,
  §3d браузер/backend блокийг салгаж `signerCert`-ийг DER болгон задлав, байхгүй `buildDtbs`-ийг placeholder болгов.
- `waitForResult` анхдагч 150 с (CA auth TTL 300 с) гэж жишээнд тэмдэглэв; `rpName` ≤ 120 **байт** (CA байтаар таслана).
- superseded гэрчилгээнд `revokedAt` ирнэ; аппын доод хувилбар iOS ≥ 2.2.8 / Android ≥ 91 (10-20); QR ~1–2 с.
- `/pades` bundle ~136 KB gzip; шалгагч `/validate`-д байгаа (README «Go-д л» гэсэн нь хуучирсан); `INTERNAL` зөвхөн TS;
  `pdfTimeoutMs` 0.19.0-д буцаж нэмэгдсэн; `ValidatePdfError` `REQUEST_INVALID`; `INPUT_TOO_LARGE` хоосон файлд ч.
- JSDoc: `DeviceLinkError`, `CertChoiceInvalidError` (өөр RP → 404), `TokenConflictCode` (бусад 409), `signSessionTtlMs`
  (`expiresAt` ирдэг), `DeviceLinkSession.vc`, `pushFloorMs`, validator trust anchor, `EID_ACSP_SCHEME_NAME`, OCSP кэшийн Go ялгаа.
- golden одоо v6; `npm run lint` хоёр tsconfig.

**Хэрхэн шалгасан.** README-ийн ```ts блок бүрийг dist-ийн эсрэг `tsc --strict` (NodeNext) — үлдсэн алдаа нь зөвхөн
хэрэглэгчийн stub (`api`, `store`, `@/lib/eid` г.м.); `npm run lint`, `npm test`.

**Үлдсэн (код — энэ PR-д биш).** `waitForResult` 150 с < CA sign TTL 600 с; `TokenConflictCode`-д `TOKEN_ISSUANCE_PENDING`
алга; OCSP «good» кэш `nextUpdate`-ийг үл тоодог; `fetch`-гүй орчинд `TSA_UNAVAILABLE` retryable. CHANGELOG.md-ийн
хуучин «`test-compat`» (→ `npm run test:compat`) нэрийг нэгтгэлийн үед засна.

## 0.26.0 — 2026-10-19

### Changed — `appearance.page` 0 = eID verify хуудас БИШ сүүлийн хуудас (golden v6)

- **Юу:** `prepare`-ийн `appearance.page` 0 / байхгүй үед оролтын хуудсуудыг сүүлээс нь шалгаж, өмнөх гарын үсгүүдийн
  нэмсэн eID verify хуудсуудыг алгасна. Verify хуудас = `/Annots`-д `/Subtype /Link`,
  `/A << /S /URI /URI (https://ca.eidmongolia.mn/verify/<docId>) >>` (энэ баримтын docId-тай байт-ижил) annotation-тай
  хуудас; эргэлзээтэй бол агуулгын хуудас. Тодорхой дугаар (1…N) хэвээр. Go `core.DefaultStampPage`-ийн 1:1 порт
  (`defaultStampPage`).
- **Яагаад:** портал хоёр дахь гарын үсэгт `page: 0` дамжуулдаг — тэмдэг эхний гарын үсгийн verify хуудсан дээр бууж
  байв (0.25.0).
- **Хаана:** `src/pades/page/appearance.ts`, `src/pades.ts` (`visibleSpec`, `PadesAppearance.page` JSDoc), README;
  golden pin Go `874ae48` (#35, golden v6: +5 кейс); `test/pades-placement.test.ts` (`defaultStampPage`).
- **Шалгасан:** `npm run lint`, `npm test`, `node scripts/sync-pades-golden.mjs --check`; golden 28 кейс байт-ижил.

## 0.25.0 — 2026-10-19

### /pades: харагдах дүрслэл хуудасны агуулгаас зайлна (PLACEMENT_SPEC.md, golden v5)

- **Юу.** `appearance.x/y` нь хүссэн байрлал болов: widget бичихээс өмнө хуудсыг (content stream-ийн бичвэр, зураас,
  зураг, form XObject, inline зураг, annotation `/Rect`; рендергүй, фонт файлгүй) уншиж, хүссэн тэгш өнцөгт (+4 pt)
  ямар нэг зүйлтэй давхцвал эхний чөлөөт байрлал руу шилжүүлнэ: толин тусгал багана ижил өндөрт (баруун доод → зүүн доод),
  дараа нь хүссэн багана 12 pt-ээр дээш, дараа нь толин багана дээш. Чөлөөт зай алга → хүссэн газраа. Шинэ
  `PadesPrepared.placement` (`page, x, y, width, height, status`: `requested | moved | overlap | unscanned`) — Go
  `Prepared.Placement`-тэй ижил.
- **Яагаад.** Прод 2026-10-19 — LibreOffice-оор хөрвүүлсэн Word гэрээний сүүлийн хуудасны footer-ийг дүрслэл дарсан.
- **Хаана.** `src/pades/page/occupancy.ts` (scanner + candidate, Go `occupancy.go`/`placement.go`-ийн 1:1 порт),
  `src/pades/pdf/signature.ts`, `src/pades.ts` (`PadesPlacement`), `src/pades/pdf/inflate.ts`
  (`zlibInflateStrict` — Go compress/zlib шиг header (FDICT нь зөвхөн DICTID 1) + Huffman бүрэн байдал + Adler-32; `adler32`-ийг validate-тэй
  хуваалцана). Golden pin Go `4e87dc1` (#34: #33 + PLACEMENT_SPEC port traps, 29 vector), sync-д `placement/` нэмэгдсэн.
- **Шалгасан.** `placement/vectors.json`-ийн 21 оролт хайрцаг бүрээр ижил; golden v5-ийн 6 шинэ тохиолдол
  (`libreoffice-contract-visible`, `…-second`, `table-bottom-visible`, `rotated90-footer-visible`,
  `quartz-pdf13-visible-third`, `full-page-visible`) prepare + complete байт-ижил (`output/*.pdf`-тэй тулгасан), хуучин
  бүх golden өөрчлөгдөөгүй, харагдах тохиолдол бүрд `expect.placement`. Fuzz маягийн тест
  (`test/pades-placement.test.ts`): санамсаргүй/эвдэрсэн content 4500 удаа — «unscanned»-аас өөр алдаа гарахгүй, §5-ын
  хязгаар бүр хил дээрээ шалгагдсан; Go reference-ээр гаргасан cross-check: тасархай/буруу Adler-32, FDICT, нэг объект доторх
  шууд фонтуудын cache, хэт том /FirstChar · /W (saturating int). `npm run lint`, `npm test`, `test:contract`, `golden:check`, `test-compat`.

## 0.24.0 — 2026-10-19

### /convert: soffice.data 99.7 → 43.2 MB, урьдчилж шахсан .br/.gz (эхний татал 77 → 41 MB)

- **Юу.** `eid-mongolia-convert-assets` нь `soffice.data`-аас Writer → PDF-д хэрэггүй файлуудыг хасна (ер бусын бичгийн
  фонт, Libertine/Biolinum, Calc/Impress/Draw/Math-ийн UI тохиргоо, `images_colibre.zip`, gallery, нүүр зураг):
  1904 → 961 файл, 99 735 918 → 43 164 000 байт. `soffice.js`-ийн file_packager хүснэгтийг (`loadPackage({files:[…]`,
  `remote_package_size`) POOL_PATCH-тай нэг файлд дахин бичнэ. NotoSans/NotoSerif (Ө Ү-ийн орлуулагч) ба бүх
  `registry/*.xcd` (math.xcd — OMML томьёо) үлдэнэ. Upstream 2.7.2-ийн `soffice.data` ба `soffice.js`-ийн sha256-аар
  хамгаалсан — таарахгүй бол build унана.
- Файл бүрийн хажууд `.br` (brotli 11) ба `.gz` (gzip 9) — nginx `brotli_static` / `gzip_static`. `manifest.json`-д
  `br` хэмжээ; `converterStatus().downloadBytes` нь brotli хэмжээ. `EID_CONVERT_BROTLI_QUALITY` (анхдагч 11; wasm-д
  ~4 мин M4 Pro).
- Asset-ийн хавтас `<хувилбар>/` → `<хувилбар>-<soffice.js hash>/`, Cache Storage-ийн нэр түүнээс: хуучин data + шинэ
  хүснэгт холилдохгүй (immutable кэш), хуучин кэш/хавтас устна.
- **Хэмжээ.** wasm 147.4 MB (gzip 48.5, br 33.8), data 43.2 MB (gzip 11.9, br 7.1); нийт br 41.0 MB, gzip 60.6 MB
  (өмнө нь gzip 77 MB).
- **Шалгасан.** sample.docx, sample.doc, бодит гэрээ, стресс docx — хасаагүй asset-тай PDF-ийн растер (150 dpi) байт-ижил,
  фонт ижил. `scripts/convert-e2e.mjs` (Chromium + WebKit): хүснэгт тасралтгүй / нийлбэр = remote_package_size / хассан
  нэр үлдээгүй / үлдсэн нь upstream-тэй байт-ижил, .br/.gz задлахад ижил, `test/fixtures/convert/rich.docx` → 2 хуудас,
  Ө ө Ү ү + Noto, томьёо (√, OpenSymbol); серверийг brotli_static/gzip_static шиг.

## 0.23.0 — 2026-10-19

### Changed — `createEidLogin`: хугацаа CA-ийн session-оос урт байхгүй; `auth.sessionTtl()` (discovery `sessionTtl`)

- **Юу:** `client.auth.sessionTtl()` — discovery `/.well-known/eid`-ийн `sessionTtl` (`{ authMs, signMs }`; хуучин CA-д 0).
  `createEidLogin`: start-ийн `expiresIn`, cookie `Max-Age`, store-ийн хугацаа = QR/Web2App-д min(`ttlMs`, CA-ийн
  `expiresAt` − одоо); push-д (бодит ба decoy ижил) min(`ttlMs`, discovery `sessionTtl.auth`, 10 мин кэш). Хуучин CA-д
  бодит push-ийн `expiresAt`-аас ажигласан утгыг decoy авна. `ttlMs` анхдагч (120 000) хэвээр.
- **Яагаад:** RP `ttlMs`-ийг CA-ийнхаас урт тохируулбал иргэн CA дууссан session-ийг хүлээж үлддэг; decoy-д CA хариу
  байхгүй тул CA-ийн `expiresAt`-аар таслах нь бодит/decoy push-ийн хугацааг ялгаж (бүртгэлтэй эсэхийн oracle) болох байв.
  Go `eidlogin`-тэй ижил.
- **Хаана:** `src/auth.ts` (`sessionTtl`, `SessionTtl`), `src/login.ts`, `src/index.ts`, README (eid-login §хугацаа,
  `expiresAt`), `test/login.test.ts` (3 шинэ тест; fake discovery).
- **Шалгасан:** `npm run lint`, `npm test` (261 pass).
- **Үлдсэн:** CA discovery-д `sessionTtl` (CA MR) deploy болтол push нь ажигласан утгаар (±1 с) ажиллана.
### Added — `TokenCertInput.appTransaction?`, `APP_ATTESTATION_INVALID`

- **Юу:** `token.issueCertificate`-д заавал биш `appTransaction` (StoreKit 2 AppTransaction JWS, ≤ 16 KiB; хоосон бол
  илгээхгүй). `MAX_APP_TRANSACTION_BYTES`-аас их бол илгээхгүй — `AppTransactionTooLargeError`. 400
  `APP_ATTESTATION_INVALID` тогтмол. Discovery `TokenCertInfo.appTransaction` (`"optional"`; хуучин CA-д `""`).
- **Яагаад:** CA (MR !390) macOS App Store build-ийн апп баталгааг токены олголтод нэмсэн; SDK-ийн хүсэлт талбаргүй
  байсан тул RP дамжуулж чадахгүй байв.
- **Хаана:** `src/token.ts`, `src/errors.ts`, `src/index.ts`, README §3c, `test/portal-gaps.test.ts`,
  `test/contract.test.ts` (live discovery-д `appTransaction: "optional"`).
- **Шалгасан:** `npm run lint`, `npm test` (259 pass), `npm run test:contract`.
### Added — `token.previewCertificate()` (dryRun), `TokenCertInfo.dryRun`

- **Юу:** `eid.token.previewCertificate(input)` — `POST /token/certificate` ижил бие + `"dryRun": true` →
  `TokenCertPreview { supersedes? }`; алдаа `issueCertificate`-тэй ижил (`ApiError`, `tokenLimitOf` …); хариунд
  `dryRun: true` алга бол `ValidationError`. Оролтын шалгалт/бие угсралт нэг `certBody`-д. Discovery `TokenCertInfo.dryRun`.
- **Яагаад:** `supersedes` бодит эхлэлийн хариунд ирэх үед PIN2 push явсан байдаг; RP push-ээс өмнө иргэнд анхааруулах
  хэрэгтэй (CA MR feat/token-cert-dryrun). Go `Token.PreviewCertificate`-тэй ижил.
- **Хаана:** `src/token.ts`, `src/index.ts`, README §3c, `test/portal-gaps.test.ts`, `test/contract.test.ts` (live
  discovery-д `dryRun: true` — CA d3e071f7 прод).
- **Шалгасан:** `npm run lint`, `npm test` (260 pass), `npm run test:contract`.
### Added — `TokenCertStart.supersedes?`, `TokenCertInfo.personalAutoSupersede`

- **Юу:** `token.issueCertificate`-ийн хариунд `supersedes?: { tokenSerial }[]` — хувийн хязгаар хүрсэн үед олголт
  амжилттай болоход superseded (4)-оор цуцлагдах өмнөх хувийн токенууд. Discovery `personalAutoSupersede` (хуучин CA-д
  false). 409 `TOKEN_LIMIT_REACHED` `kind: "PERSONAL"` одоо зөвхөн `limit: 0`.
- **Яагаад:** CA !392 (прод b09b755e) хувийн токены автомат солилт; RP PIN2-оос өмнө иргэнд анхааруулах ёстой.
- **Хаана:** `src/token.ts`, README §3c, `test/portal-gaps.test.ts`, `test/contract.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`, `npm run test:contract` (live discovery).

## 0.22.0 — 2026-10-19

### Tests — `convert-e2e`: Linux WebKit-д цуцалсны дараах дахин хувиргалтыг алгасахаа болив

- **Юу:** `scripts/convert-e2e.mjs`-ийн Linux WebKit-ийн алгасалт (2026-10-15-наас — terminate хийсэн worker-ийн дараа шинэ
  worker-ийн LibreOffice init дуусдаггүй гэж) хасагдсан; цуцлалт → дахин хувиргалт (кэшээс) + verbose лог бүх хөтөчид шалгагдана.
- **Яагаад:** шалтгаан нь 0.21.0-ийн `pthreadPoolSize` 4 → 8 засвартай ижил deadlock байсан.
- **Шалгасан:** PR #43-ийн CI `convert-e2e (webkit)` — «цуцалсны дараа: download үе шатгүй (кэш), 2507 ms», wasm/data дахин татаагүй.
### Added — `PersonCertificate.tokenSerial?`

- **Юу:** `eid.person.certificates()`-ийн `keyMedium: "TOKEN"` мөрөнд гэрчилгээ олгогдсон USB токены серийн дугаар
  (CA `GET /v3/certificates/etsi/{personEtsi}`, 2026-10-19). MOBILE/HSM мөрөнд болон хуучин CA-д `undefined`.
- **Яагаад:** нэг токены AUTH + SIGN-ийг байгууллага + олгосон цагаар таамаглахгүй, токеноор нь бүлэглэх.
- **Хаана:** `src/person.ts`, README §3b, `test/share.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`.

## 0.21.0 — 2026-10-19

### Fixed — `/convert`: удаан CPU-тай компьютер дээр Word→PDF хөрвүүлэлт гацаж болзошгүй байсан (0.21.0)

- **Юу (хэрэглэгчид нөлөөлөх засвар):** `eid-mongolia-convert-assets` нь `@matbee/libreoffice-converter@2.7.2`-ийн
  `soffice.js`-д хатуу заасан `var pthreadPoolSize=4;`-ийг `8` болгоно (upstream файлын sha256-ийг тулгана; таарахгүй бол
  хуулалт exit 1-ээр унана — patch-гүй asset гацаж болзошгүй). `manifest.json`-д `"pthreadPoolSize": 8`; `rev` солигдож
  worker/JS-ийн immutable кэш шинэчлэгдэнэ. Зөвхөн JS — `soffice.wasm`/`.data` хөндөгдөхгүй, дахин татагдахгүй.
- **Яагаад:** 4 thread-ийн pool-д удаан CPU дээр (CI runner — ~4.5× удаан) documentLoad 9/9 удаа гацдаг: LibreOffice-ийн
  pthread-ийн MEMFS syscall LO worker руу sync proxy хийдэг, worker нь documentLoad-д pthread хүлээж хаагдсан (бүх thread
  futex_wait). Туршилт: pool 4 гацна, 5/6/8 ажиллана. CI-ийн `convert-e2e` санамсаргүй 10 минутын timeout-ийн шалтгаан. Upstream: https://github.com/matbeedotcom/libreoffice-document-converter/issues/19
- **Хаана:** `bin/convert-assets.mjs` (`POOL_PATCH`), `test/convert.test.ts`, README §3e.
- **Шалгасан:** `test/convert.test.ts` (patch хэрэглэгдсэн — хуулсан `soffice.js`-д `=8`, upstream-аас зөвхөн тэр солилт;
  manifest хэмжээ/`pthreadPoolSize`; hash таарахгүй → exit 1), `convert-e2e` Chromium + WebKit (локал).
- **Шинэчлэх:** RP-үүд SDK шинэчилсний дараа `eid-mongolia-convert-assets <хавтас>`-ийг дахин ажиллуулна.
### Fixed — `/Encrypt << … >>` шууд толь → `PDF_ENCRYPTED` (0.21.0)

- **Юу:** trailer-ийн `/Encrypt`-ийг зөвхөн `n g R` лавлагаагаар биш, шууд толиор (`/Encrypt <<`, `/Encrypt<<`) ч
  шифрлэгдсэн гэж танина — уншигч баримтыг нээж чадахгүй үеийн байтын шалгалтад (`prepare` precheck #4, `validatePdf`,
  гүн давхарлалтын шалгалтын ObjStm алгасалт). `/EncryptMetadata` encrypted биш хэвээр.
- **Яагаад:** CA !382-тэй ижил засвар (өмнө нь шууд тольтой эвдэрсэн баримт `PDF_INVALID` болдог байв).
- **Хаана:** `src/pades/precheck.ts`, `src/pades/validate/extract.ts`, `src/pades/pdf/nesting.ts`; `test/pades-encrypt.test.ts`.
- **Шалгасан:** `test/pades-encrypt.test.ts` (AES-256 / RC4 шууд толь, уншигч нээгдэх/нээгдэхгүй; `/EncryptMetadata`), `npm test`.
- **Үлдсэн:** Go SDK-д ижил засвар (өөр PR) орсны дараа golden-д тохиолдол нэмэх бол Go-той тулгана.
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
### Security — PRECHECKS #2b: ObjStm мөчлөг, `/Size`, `%%EOF`-гүй баримтын квадрат хайлт (0.21.0)

- **Юу:** задлахын өмнөх бүтцийн шалгалт (`prepare` / `validatePdf` — `PDF_INVALID`, `complete` — `STATE_INVALID`) нь Go SDK
  (chore/sdk-low-cleanup, `objstm.go`)-тэй ижил дүрмээр татгалзана: ObjStm доторх объектын агуулагч stream нь өөрөө
  ObjStm-д (өөрийгөө / харилцан агуулах); ObjStm-ийн толгойн лавлагаа (`/Length` г.м.) ObjStm доторх объект руу;
  `/Extends` мөчлөг / > 64; trailer эсвэл xref stream-ийн `/Size` > 2 097 152 (өмнө нь TS 2^24 хүртэл хүлээн авч
  хүснэгт хуваарилдаг байв). Уншигчийн `%%EOF` хайлт (digitorus-ийн 200 байтын өсөх цонх) O(n²) байсныг ижил үр дүнтэй
  шугаман болгосон — `%%EOF`-гүй 110 KB баримт 3 с, 10 MiB нь хөтчийг цагаар гацаадаг байв (одоо ~0.3 с).
- **Яагаад:** Go `FuzzValidatePDF`-ийн олсон DoS ангилал; TS-д ObjStm мөчлөг JS stack-ийн `RangeError`-оор санамсаргүй
  `PDF_INVALID` болдог байсныг тодорхой дүрэм болгож Go-той тааруулав. `%%EOF`-ийн квадрат хайлтыг TS mutation fuzz олсон.
- **Хаана:** `src/pades/pdf/nesting.ts` (`checkObjStmGraph`, `/Size`), `src/pades/pdf/reader.ts` (`findStartXref`);
  `test/pades-objstm.test.ts` (Go `TestCheckStructureObjStmGraph`-ийн оролтууд + fuzz crash seed
  `test/fixtures/pades/fuzz/objstm-cycle-c8b2f6dc9d5d37bf.pdf`), `test/validate-fuzz.test.ts` (детерминист mutation fuzz,
  `EID_FUZZ_ITER`).
- **Шалгасан:** `npm test` (258), fuzz 1500 давталт цэвэр; хуучин/шинэ `%%EOF` хайлтын differential (200 000 санамсаргүй
  оролт, зөрүү 0); validate golden 42/42 Go-той ижил (хөтөчид offline 39/39).
### Fixed — `maskPath` linked, `baseUrl` https, `documentNumber` тайлбар (0.21.0)

- **Юу:** (1) `NetworkError.op` / алдааны зам `/signature/notification/linked/{documentNumber}`-ийг `…` болгоно (өмнө нь
  төхөөрөмжийн дугаар логт гардаг байв). (2) `EidClient` `baseUrl` нь `https://` байх ёстой; `http://` зөвхөн `localhost`,
  `127.0.0.1`, `[::1]` (тест/mock) — бусад нь `Error` (RP secret ба иргэний мэдээлэл шифргүй явахаас сэргийлнэ).
  (3) `EidLoginIdentity.documentNumber` — «иргэний баримтын дугаар `PNOMN-…-MOBILE-Q`» биш, RP-API-ийн төхөөрөмжийн
  (тунгалаг) таних тэмдэг (Go `eidlogin.Identity.DocumentNumber`-тэй ижил тайлбар).
- **Яагаад:** 10-15 SDK аудитын Low олдворууд (TS хэсэг).
- **Хаана:** `src/errors.ts`, `src/client.ts`, `src/login.ts`; `test/portal-gaps.test.ts`, `test/sdk.test.ts`.
- **Шалгасан:** `npm test`, `npm run lint`.

## 0.20.1 — 2026-10-17

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

## 0.20.0 — 2026-10-17

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

## 0.19.0 — 2026-10-16

### ⚠️ BREAKING — аюулгүй анхдагч (SDK Багц 2, Go v0.6.0-тэй 1:1)

- **`checkKeyUsage` анхдагч `true`** (өмнө `false`). Нэвтрэлтийн (PIN1, P-CITIZEN-AUTH) түлхүүрийн гарын үсэг
  `validateSign`-д тэнцдэг байсан (AUTH гэрчилгээнд EKU emailProtection бий тул гинжийн EKU-гаар өнгөрдөг байв) — одоо
  KU nonRepudiation алга гэж татгалзана. Хуучин зан: `trust: { checkKeyUsage: false }` (зөвлөхгүй).
- **`allowedIssuerSkis` анхдагч `[CITIZEN_ISSUING_CA_SKI]`** (trust anchor тохируулсан үед; өмнө хоосон = дурын CA).
  Ижил root-ийн доорх өөр CA (байгууллагын 05 г.м.)-ийн гэрчилгээ иргэнийх гэж тэнцэхгүй. Унтраах: `allowAnyIssuer: true`
  (шинэ); өөр жагсаалт өгвөл түүгээр шалгана. `allowUntrusted` (anchor-гүй dev) горимд анхдагч жагсаалт үйлчлэхгүй.
- **`certificateLevel` гэрчилгээнээс** (`certificateLevelOf`, шинэ экспорт): SIGN-д qcStatements QcCompliance →
  QUALIFIED (+ QcSSCD → QSCD), qcStatements-гүй → ADVANCED; AUTH-д (CA qcStatements бичдэггүй) KeyUsage keyEncipherment
  (утасны профайл) → QUALIFIED, үгүй (токен) → ADVANCED. Хариуны утга гэрчилгээнийхээс өндөр бол `ValidationError`, бага
  бол хариуных. `VerifiedIdentity` / `Signer` / `VerifiedSignature` (шинэ талбар)-ийн `certificateLevel` = энэ утга.
  Хариунд түвшин алга бол гэрчилгээнийх (өмнө татгалздаг байв).
- **`token.authVerify(challenge, certDer, signature)`** — эхний аргумент `TokenAuthChallenge` объект (өмнө
  `challengeId` мөр). SDK CA-ийн OK-д дангаар итгэхгүй: `challenge.rpUUID` = энэ RP, r||s нь
  `tokenAuthDigest(rpUUID, challenge)` дээр гэрчилгээний түлхүүрээр таарах, гэрчилгээ trust-аар (хугацаа, KU/EKU auth,
  гинж, issuer) хүчинтэйг CA руу илгээхээс өмнө шалгана. `trust`-д anchor заавал (эсвэл `allowUntrusted`).
- **`createEidLogin`: `start` анхдагч хязгаар** нэг IP-ээс 60 с-д 20 (`defaultRateLimit.start`; IP мэдэгдэж байвал).
  Унтраах: `rateLimit: { start: false }`.

### Засвар / нэмэлт

- Санах ойн хязгаарлагч: 10 000 түлхүүрээс хэтэрвэл бүгдийг цэвэрлэдэг байсныг (олон түлхүүрээр дүүргэж тухайн дугаарын
  push хязгаарыг тойрох боломжтой) — цонх нь өнгөрсөнийг цэвэрлээд, дүүрэн хэвээр бол шинэ түлхүүрийг татгалзана.
- `memoryLoginStore(max = 10_000)` — дүүрвэл `LoginStoreFullError`, start 503 `{ error: "busy" }`; эхэлсэн нэвтрэлтийг
  устгахгүй. Экспорт: `MEMORY_LOGIN_STORE_MAX`, `LoginStoreFullError`.
- `NATIONAL_ROOT_CA_PEM`, `CITIZEN_INTERMEDIATES_PEM` (02 → 03 → 04) экспорт; `intermediatesPem` өгөөгүй бол сүүлийнх
  нь анхдагч — README-ийн `trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] }` жишээ шууд ажиллана (өмнө завсрын CA-гүй
  тул ValidationError).
- `registerSignature`-ийн хугацаа анхдагч 80 с (`pdfTimeoutMs`, `DEFAULT_PDF_TIMEOUT_MS`) — Go `DefaultPDFTimeout`-тэй
  ижил; өмнө ердийн 15 с.
- Contract тест: discovery-ийн `pdfSigning.registerErrorCodes` == `PDF_REGISTER_ERROR_CODES` (олонлогоор); CA-д талбар
  гарахаас өмнө skip + WARN.

Шилжих: `authVerify(ch.challengeId, …)` → `authVerify(ch, …)`; тест/dev-ийн өөр CA-тай орчин → `allowAnyIssuer: true`;
`checkKeyUsage: true`, `allowedIssuerSkis: [CITIZEN_ISSUING_CA_SKI]` гэж илэрхий бичсэн бол өөрчлөлт хэрэггүй.

Хаана: `src/validator.ts`, `src/token.ts`, `src/login.ts`, `src/client.ts`, `src/sign.ts`, `src/index.ts`, README.
Шалгасан: `npm run lint`, `npm test` (187/187; шинэ: PIN1 гарын үсэг validateSign-д унах, анхдагч issuer, гэрчилгээнээс
түвшин (SIGN qc/токен/QSCD, AUTH KE/токен), бодит 01–04 гинж + 04 SKI, token auth-ийн локал шалгалт (CA руу явахгүй),
start 20/мин, 10 000 түлхүүрээр тойрох оролдлого, store cap, PDF timeout), `npm run test:contract` (4 pass, 1 skip).
Прод DB (read-only, 2026-10-16): идэвхтэй утасны SIGN 66/66 qcStatements-тэй, AUTH 67 qc-гүй (KU KE), токен 3+3 —
бүгд «eID Mongolia Issuing CA»-аас; анхдагч солигдсоноор одоогийн иргэд унахгүй.

## 0.18.3 — 2026-10-16

### Нэмэгдсэн

- **`/pades` `complete`: LTV retry.** OCSP/CRL (DSS) цуглуулалт унавал ижил state, гарын үсэг, TSA timestamp-аар SDK
  өөрөө 2 удаа дахин оролдоно (нийт 3; хүлээлт ~1 с, ~3 с + 0–25% jitter) — PIN дахин асуухгүй. `ltvRetries` (анхдагч 2,
  `0` — унтраах, 0–10); бүгд унавал `LTV_UNAVAILABLE` (өмнөхтэй ижил). `signal` (`AbortSignal`) — TSA/OCSP/CRL таталт ба
  хүлээлтийг тасалж `signal.reason` (анхдагч `AbortError`) шиднэ.
  Яагаад: 2026-10-16 03:46Z-д үндэсний CRL толь түр 404 байхад иргэний гарын үсэг PIN2-ийн дараа унасан; портал өөрөө
  retry хийдэг (!161), SDK-ийн бусад хэрэглэгч ч хамгаалагдана. Хаана: `src/pades.ts`, `src/pades/fetch.ts`.
- **`PdfRegisterErrorCode` / `PDF_REGISTER_ERROR_CODES`** — `POST /pdf/signatures`-ийн CA кодууд (CA main
  `pades_register.go`, `handlers_pdf.go`, 2026-10-16): REQUEST_INVALID, REQUEST_TOO_LARGE, CMS_INVALID, SIGNATURE_INVALID,
  TIMESTAMP_INVALID, SIGNER_MISMATCH, SIGNER_CERT_INVALID, TOKEN_CERT_INVALID, TOKEN_ORG_MISMATCH, SESSION_MISMATCH,
  SESSION_NOT_COMPLETE, SESSION_FAILED, CLAIMED_ROLE_MISMATCH, REPRESENTATION_REVOKED, DOC_ID_CONFLICT, REGISTRY_CONFLICT,
  DOC_NOT_FOUND, PRIOR_MISMATCH, RATE_LIMITED, STATE_UNAVAILABLE. Go SDK v0.5.2-ийн `eid.PDFRegisterErrorCodes`-тэй ижил.

Шалгасан: `npm run lint`, `npm test` (180/180; шинэ: 2 унаад 3 дахь нь амжвал golden-той байт-ижил, 3-уулаа унавал
LTV_UNAVAILABLE, `ltvRetries: 0`, abort — хүлээлтэд ба урьдчилан).

## 0.18.2 — 2026-10-16

### /convert: LibreOffice-ийн консол лог анхдагчаар чимээгүй (`verbose`)

- **Юу/яагаад:** Word → PDF хувиргалт бүрд хөтчийн консолд ~28 улаан мөр («warn:vcl…», «[LOK C++] lok_documentLoad…»)
  ба ~1300 `[FS OPEN CALL]`/`[Worker]` мөр гардаг байв — алдаа биш ч хэрэглэгч алдаа гэж ойлгодог. Шалтгаан:
  `@matbee/libreoffice-converter@2.7.2` `dist/browser.worker.global.js` нь Emscripten `print`/`printErr`-ийг үргэлж
  `console.log`/`console.error` руу, `SAL_LOG="+ALL"`, олон `console.log`-тэй; worker замд verbose сонголтгүй. 2.7.2 нь
  npm-ийн хамгийн сүүлийн хувилбар (2026-10-16) тул upstream шинэчлэлээр засах боломжгүй.
- **Хаана:** `bin/convert-assets.mjs` — upstream worker-ийн sha256 мэдэгдэж буй утгатай таарвал л `print`/`printErr`-ийг
  `self.EID_CONVERT_VERBOSE`-ээр нөхцөлдүүлж, `"+ALL"`-ийг `"-WARN-INFO"` болгоно (таарахгүй бол patch-гүй хуулж
  анхааруулна, exit 0). `manifest.json`-д `rev` (worker скриптүүдийн hash) ба `patched`. `bin/eid-convert.worker.js` —
  `?verbose=1`-гүй бол `console.log/info/debug` no-op (error/warn үлдэнэ), `?v=<rev>`-ийг upstream worker-т дамжуулна.
  `src/convert.ts` — `WordToPdfOptions.verbose`; worker URL `?cache=…&v=<rev>[&verbose=1]`; verbose солигдвол worker дахин асна.
  `SAL_LOG`-ийг энд бичих нь LibreOffice-д хүрдэггүй (soffice.js preRun-ийн "+WARN" үйлчилнэ) — хэмжсэн; чимээгүй
  болгох нь `printErr`-ээр.
- **Шалгасан:** `npm test` (172 → 176: patch-тай файлд «+ALL» үгүй, manifest хэмжээ = patch-тай файл, hash таарахгүй
  → fallback + анхааруулга, worker wrapper verbose/quiet, URL-ийн rev/verbose); `npm run test:convert-e2e` (Chromium):
  verbose-гүй хувиргагчийн консол лог 0, `verbose: true` — 1354 мөр, .docx/.doc → PDF → `prepare` хэвээр.
- **RP-д:** SDK шинэчилсний дараа `npx eid-mongolia-convert-assets <хавтас>`-ийг дахин ажиллуул (build-д аль хэдийн бол
  автомат). Хуучин asset-тай шинэ SDK ажиллана — лог л гарсаар.
### README: share «туг унтраалттай» тэмдэглэл хасав

- **Юу/яагаад:** CA (ca-eidmongolia-mn !374) `rp./share`-ийн туг хасагдаж үргэлж асаалттай; README-ийн callout ба 503
  мөрийг шинэчлэв. Код өөрчлөгдөөгүй — `SHARE_DISABLED` код хуучин CA-д нийцүүлж хэвээр.
- **Шалгасан:** зөвхөн README; `grep -n "унтраалттай" README.md` — 0.

## 0.18.1 — 2026-10-16

### Нэмэгдсэн — токены сунгалтын scope түгжээ: TOKEN_SCOPE_CHANGE (CA !373)

- **Юу:** `TokenConflictCode` (`TOKEN_LIMIT_REACHED` · `TOKEN_IN_USE` · `TOKEN_SCOPE_CHANGE`) + `TOKEN_CONFLICT_CODES`;
  `eid.token.certificateInfo()` → discovery-ийн `tokenCertificate` блок (`TokenCertInfo`, `scopeLockedOnRenewal`);
  `issueCertificate` / `certificateResult`-ийн JSDoc, `TokenCertSessionBlock.errorCode`-ийн жагсаалт, README §3c-д дүрэм.
- **Яагаад:** CA main 0d1f3f63 (!373): ижил `tokenSerial` дээр ACTIVE бүртгэлтэй үед сунгалт scope-ийг (хувийн ↔
  байгууллага, өөр `onBehalfOf`) солих гэвэл `POST /token/certificate`, `GET /token/certificate/{id}` 409
  `TOKEN_SCOPE_CHANGE`, session-ий `tokenCertificate.errorCode` мөн; override үгүй — иргэн eID апп-аас токеноо
  цуцлаад шинээр олгуулна. Discovery: `tokenCertificate.scopeLockedOnRenewal: true`.
- **Хаана:** `src/token.ts`, `src/types.ts`, `src/index.ts`, `README.md`, `test/portal-gaps.test.ts`, `test/contract.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`, `npm run test:contract` (live discovery-д `scopeLockedOnRenewal: true`).

## 0.18.0 — 2026-10-16

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

## 0.17.0 — 2026-10-15

- **Шинэ entry `@gerege-systems/eid-mongolia-sdk/convert` — Word (.docx / .doc) → PDF хөтөч дотор (0.17.0).**
  - Юу: `wordToPdf(file, { assetsBase, onProgress?, signal?, fileName? })` → `{ pdf, pages, warnings }`;
    `converterStatus({ assetsBase })` → `{ cached, downloadBytes }`; `isWordFile`, `disposeConverter`, `ConvertError`
    (`UNSUPPORTED_ENVIRONMENT`, `NOT_ISOLATED`, `UNSUPPORTED_FILE`, `INPUT_TOO_LARGE`, `ASSETS_UNAVAILABLE`, `CONVERT_FAILED`);
    `warnings[]` = `{ code, …, message }` (`FONT_SUBSTITUTED`, `FONT_FALLBACK`, `PDF_NEAR_LIMIT`, `PDF_TOO_LARGE` — `/pades`
    `prepare`-ийн хязгаартай). Bin `eid-mongolia-convert-assets <хавтас>` — asset-уудыг (manifest.json + `<хувилбар>/`,
    MPL NOTICE, SDK-ийн worker shim) RP-ийн build үед хуулна.
  - Яагаад: иргэн Word баримтад гарын үсэг зурах — файл сервер рүү очихгүй (/pades-ийн зарчим).
  - Хэрхэн: `@matbee/libreoffice-converter@2.7.2` (MPL-2.0, LibreOffice 24.8 WASM) — **optional peerDependency**, зөвхөн
    `/convert` dynamic import хийдэг (Node backend-ийн хэрэглэгчдэд 250 MB нэмэгдэхгүй; ESM-only, хөтчийн entry).
    Том asset (wasm 147 MB, data 100 MB) progress-той Cache Storage-д урьдчилж татагдана; worker (`eid-convert.worker.js`)
    тэднийг `fetch` shim-ээр кэшээс авна — blob URL биш (WebKit 147 MB blob-ийг worker-т уншдаггүй), HTTP кэш биш
    (Firefox 50 MB хязгаар). Нэг worker дахин ашиглагдана; `signal` → worker terminate (`AbortError`), дараагийнх нь кэшээс.
    crossOriginIsolated биш бол шууд `NOT_ISOLATED` (багцын 120 с timeout-ийг хүлээхгүй). Хуудас тоолох нь `/pades`-ийн PDF
    parser-аар (гаралт `prepare`-д уншигдахыг ч баталгаажуулна). Хуваалцсан хязгаар `src/pades/limits.ts` (код үйлдэл өөрчлөгдөөгүй).
  - Хаана: `src/convert.ts`, `bin/convert-assets.mjs`, `bin/eid-convert.worker.js`, `src/pades/limits.ts`, `package.json`
    (exports `./convert`, `bin`, peer), `tsconfig*.json`, `test/convert.test.ts` (хуурамч Worker + Cache Storage),
    `scripts/convert-e2e.mjs` + CI `convert-e2e` (Chromium, WebKit), `test/fixtures/convert/`, README §3e.
- Шалгасан: lint, test (162), test:compat, size:pades (126.8 KB), golden:check; `npm run test:convert-e2e` Chromium ба
  WebKit — хуудасны CSP nonce + `'strict-dynamic'`, worker CSP `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`
  (`'unsafe-eval'`-гүй бол EvalError), sample.docx/.doc → 3 хуудас PDF → `pades.prepare` OK, дахин ажиллуулахад wasm/data
  сүлжээнээс авахгүй, цуцлалт, COEP-гүй хуудас `NOT_ISOLATED`. Firefox шалгаагүй. Linux WebKit (CI) — цуцалсны дараа шинэ worker-ийн init дуусдаггүй тул тэр алхмыг алгасна (macOS WebKit-д болно).

## 0.16.0 — 2026-10-15

- **Баримт/тайлбарын зөрүү (аудит 2026-10-15) + CHANGELOG нэгтгэл, guard.** Код үйлдэлгүй — зөвхөн `RETRYABLE_ERROR_CODES`
  ба `/token/auth/*`-ийн гэрээний байрлал өөрчлөгдсөн (доор).
  - README: upload туслахууд 0.15.0-д устсан (0.14.0 биш); `NO_SIGNING_CERTIFICATE` зөвхөн sign / certificate-choice start
    (`/pdf/sign/prepare` CA-д 2026-10-14-нөөс байхгүй); `/token/auth/*` live discovery-д
    (`endpoints.token.auth_challenge` / `auth_verify`) байгаа; зурагчийн гэрчилгээний үндсэн зам = certificate-choice
    (`CERT` эрх), `person.certificates` (`PKI_READ`) зөвхөн итгэмжлэгдсэн RP-д иргэн 24 цагт нэвтэрсэн үед; аппын доод
    хувилбар: v3 урсгал iOS 2.2.3 (59) / Android 60-аас, сервер албадах доод нь 2026-10-15-нд iOS 2.2.7 / Android 83
    (live `/mobile/app-config`).
  - `src/contract.ts`: `tokenAuthChallenge` / `tokenAuthVerify` → `RP_ROUTES` (гэрээний тест одоо fail-аар шалгана);
    `RP_ROUTES_UNDISCOVERED` хоосон.
  - `src/errors.ts`: `RetryableErrorCode` / `RETRYABLE_ERROR_CODES`-оос `PDF_PREPARE_BUSY`, `DOCUMENT_PENDING` (устсан
    горим A-ийн route), `TSA_UNAVAILABLE`, `LTV_UNAVAILABLE` (CA буцаадаггүй — зөвхөн клиент `PadesError.code`) хасагдсан;
    үлдсэн `RATE_LIMITED`, `STATE_UNAVAILABLE`, `ISSUANCE_PENDING` (CA `server/internal/service/memory`-д шалгасан).
    429/503 + Retry-After нь кодоос үл хамааран `retryable` хэвээр. `REPRESENTATION_REVOKED` = `POST /pdf/signatures`
    ба токены гэрчилгээ олголт; `pdfMaxBytes` дурдлага хасагдсан.
  - `src/sign.ts`: `registerSignature`-ийн алдааны жагсаалт CA `pades_register.go`-ийн бодит кодоор (`PDF_FOREIGN_SIGNATURE`
    CA-аас ирдэггүй — клиент `PadesError`); устсан `memory/pades.go`-ийн лавлагаа → `websign.go` `fileNameFromSession`.
    `src/types.ts` `SessionResult.expiresAt` = CA-ийн утга (0.14.2-оос, auth ч мөн); `src/button.ts` устсан
    `oidc_login.html` лавлагаа; `src/index.ts` багцын нэр.
  - `CHANGELOG.md`: 0.13.0 … 0.15.4 фрагментуудыг хувилбар бүрийн гарчгаар нэгтгэв (tag-ийн commit-оор тулгасан:
    sign-session-gaps → 0.14.1, pades-prior-revision-created → 0.15.2, button-push-disclosure → 0.15.3);
    sign-session-gaps-ийн «CA хугацаа буцаадаггүй» нь 0.14.2-оос (CA !357) хуучирсныг тэмдэглэв.
  - Guard: `scripts/changelog.mjs` (`assemble` / `check-release` / `check-pr`); CI `changelog` job PR-д фрагмент шаардана;
    Release workflow tag-д фрагмент үлдсэн эсвэл `## <version>` гарчиг алга бол publish хийхгүй.
  - Шалгасан: live `https://ca.eidmongolia.mn/.well-known/eid`, `/mobile/app-config` (2026-10-15), CA main `af939ab0`
    эх код; `npm run lint`, `npm test`, `npm run test:contract`.
- **PAdES: харагдах гарын үсэг (сонголттой) + golden v3.**
  - Юу: `PadesPrepareOptions.appearance` (`page`, `x`, `y`, `width`, `height`, `lang`) — сонгосон хуудсан дээр `/Rect`-тэй
    widget (`/F 4`, `/P`, `/Annots`-ийн төгсгөлд), `/AP /N` шахалтгүй form XObject (verify хуудасны Noto Sans фонт, өөрийн
    QR `https://ca.eidmongolia.mn/verify/<docID>/<revIndex>`, нэр/үүрэг/label/огноо, `/Rotate` 0/90/180/270-ийг content
    `cm`-ээр). Байхгүй бол үл харагдах — golden v2-тэй байт-ижил.
  - Яагаад: Go reference (`eid-mongolia-sdk-go` 55bcb0a, `pades/APPEARANCE_SPEC.md`)-тэй native SDK бүр байт-ижил.
  - Хаана: `src/pades/page/appearance.ts` (шинэ), `src/pades/pdf/signature.ts`, `src/pades/page/page.ts` (`fontBodies`,
    `wrapLimit`, `glyphHex` — verify хуудасны байт өөрчлөгдөөгүй), `src/pades.ts` (`PadesAppearance`, шалгалт, `visibleSpec`),
    `scripts/sync-pades-golden.mjs` → tag `pades-golden-v3`, README.
- Шалгасан: golden v3-ийн бүх 17 кейс (15 амжилттай + 2 алдааны) (харагдах 5: `quartz-pdf13-visible`, `-visible-en`, `-visible-second`,
  `-visible-twice`, `quartz-rotated90-visible`) — digest/DTBS/signedAttrs/prepared/output sha256 байт-ижил; appearance-ийн
  REQUEST_INVALID кейсүүд (Go `TestAppearanceRejects`-тэй ижил + docId-гүй гарын үсэгтэй баримт); lint, test, golden:check,
  size:pades (gzip 126.8 KB), test:compat.
- **0.16.0 (BREAKING): `@deprecated` legacy device-link туслахууд хасагдсан.**
  - Юу: `deviceLink`, `openOrShowQR` функц ба `DeviceLinkInput`, `OpenOrShowQROptions` төрлийг `.` болон `/browser`
    entry-ээс хассан. `isMobileUserAgent` / `NavigatorLike` (товч ашигладаг) хэвээр.
  - Яагаад: статик `{deviceLinkBase}?sessionId=…&vc=…` холбоосыг сервер 2026-10-07-нд хассан (`DEVICE_LINK_REQUIRED`) —
    эдгээр туслахаар нээгдсэн session ажиллахгүй. Шилжилтийн хугацаа үлдээхгүй; ямар ч RP хуучин API ашиглахгүй.
  - Шилжих: backend-д `buildDeviceLink` (v3, `deviceLinkInput` / `qrDeviceLinkTicker`), утсан дээр Web2App холбоосыг
    энгийн `<a href>`-ээр.
  - Хаана: `src/devicelink.ts`, `src/index.ts`, `src/browser.ts`, `test/sdk.test.ts`, README.
- Шалгасан: lint, test (browser entry-д `deviceLink`/`openOrShowQR` байхгүйг шалгах тест), test:contract.

## 0.15.4 — 2026-10-15

- **`<eid-login-button>`: `label`, `icon`, `variant="icon"` тохиргоо, `part="icon"` / `part="label"` (0.15.4).**
  - Юу: `label` атрибут — товчны текст (байхгүй бол i18n «eID-ээр нэвтрэх» / «Log in with eID»); `icon="eid|none"` —
    лого харуулах эсэх; `variant="icon"` (эсвэл `label=""`) — зөвхөн лого, 44×44 дөрвөлжин, `aria-label` = `label` /
    i18n текст, хост `aria-label` өгсөн бол түүнийг. Бүгд observed — өөрчлөгдөхөд шууд шинэчлэгдэнэ. Shadow part:
    `button` хэвээр, шинээр `icon` (img), `label` (span). `mountEidLoginButton`-д `label`, `icon`, `variant` сонголт.
  - Хамгаалалт: `icon="none"` + текстгүй хослол хоосон товч үүсгэхгүй — анхдагч текст харагдаж, `console.warn` нэг удаа.
  - Анхдагч харагдах байдал өөрчлөгдөөгүй; шинэ хамаарал үгүй.
- Яагаад: RP-ууд товчны текст, зөвхөн-лого хувилбар, part-аар загварчлах боломж хүссэн.
- Хаана: `src/button.ts`, `test/button.test.ts`, `README.md` §1a (атрибутын хүснэгт, `::part` жишээ).
- Шалгасан: `npm run lint`, `npm test` (151; шинэ 5: label шууд шинэчлэл/lang-аас давуу, icon=none, variant=icon +
  aria-label (i18n / label / хост), icon=none+текстгүй fallback + нэг warn, mount сонголт).

## 0.15.3 — 2026-10-14

- **`<eid-login-button>` цонх: регистрийн дугаарын хэсэг нэг товч болж, ижил цонхонд дэлгэгдэнэ; VC том/тод, countdown VC-ийн доор (0.15.3).**
  - Юу: QR цонхонд ил байсан регистрийн input + «Мэдэгдэл илгээх» маягтыг «Регистрийн дугаараар нэвтрэх» outlined товч
    (chevron) болгов. Дарахад ижил цонхонд доошоо дэлгэгдэнэ (`aria-expanded`/`aria-controls`, input руу focus), дахин
    дарахад хураагдана; хураасан үед `inert` + `visibility: hidden` (Tab очихгүй). Өндрийн анимэйшн `grid-template-rows`
    200ms, `prefers-reduced-motion` үед үгүй. QR, код, poll дэлгэгдсэн үед ч хэвээр. Push илгээсний дараах төлөв ижил цонхонд.
  - VC: «Баталгаажуулах код» шошгын доор 2rem, 700, monospace tabular цифр, `--eid-fg` (QR ба push төлөвт ижил).
  - Countdown: VC-ийн шууд доор «Хүсэлтийн хугацаа: m:ss» (en: «Request expires in:»), сүүлийн 30с `--eid-warning-fg`,
    0 → хугацаа дууссан төлөв (дахин оролдох). Дэлгэц уншигчид минут тутам л зарлана (`N минут үлдлээ`).
  - Дизайн, токен, лого, dark mode, trigger товч, мобайл Web2App — өөрчлөгдөөгүй. Шинэ токен үгүй, шинэ хамаарал үгүй.
- Яагаад: RP-ийн нэвтрэх цонх (Nexus) дээрх урсгалтай нийцүүлэх — нэг цонх, push сонголт нэг товч.
- Хаана: `src/button.ts`, `test/button.test.ts`, `README.md` §1a хүснэгт.
- Шалгасан: `npm run lint`, `npm test` (136; шинэ: disclosure aria/focus/inert/reduced-motion, countdown байрлал/формат/минутын
  зарлал/≤30с өнгө, en мөр); headless Chromium screenshot — desktop 1440 + mobile 390, light/dark, QR/дэлгэгдсэн/push төлөв,
  en ≤30с. `dist/button.js` gzip 22.7 → 23.4 KB (CI-д /button-ийн хязгаар байхгүй; /pades 300 KB хязгаарт хамааралгүй).

## 0.15.2 — 2026-10-14

- **0.15.2 — `createEidLogin`: регистрийн oracle хаалт (decoy + pushFloorMs), OCSP цуцлалт, аудитын hook (Go v0.3.2-тэй ижил).**
  - **G1 (Critical) — бүртгэлийн oracle.** Push start eID-ийн татгалзалд (танихгүй дугаар) 502, бүртгэлтэйд 200 өгдөг,
    хугацааны доод хязгааргүй байсан — нэвтрээгүй хэн ч регистр eID-д бүртгэлтэй эсэхийг шалгаж болох байв. Одоо eID-ийн
    өөрийн JSON 4xx (`ApiError`, 429-ээс бусад; 401/403 нь тусдаа алдаа) → decoy session: бодит хариутай ижил
    `{mode, vc (5 оронтой), expiresIn}`, ижил cookie, `status` нь eID-ээс асуулгүй `pollMs`-ийн хугацаанд барьж PENDING →
    TTL-ийн дараа EXPIRED. Push start-ийн хариу бүр (бодит, decoy, 502) ≥ `pushFloorMs` (анхдагч 1000; `signal` тасарвал
    зогсоно — `EidLoginRequest.signal`, `handle(Request)` автоматаар). 5xx / холболт / JSON бус 4xx (proxy) / 401 / 403 →
    502, 429 → 429 (eID порталын `HandleEIDStartByNationalID`-тэй ижил). Хязгаар decoy-д ч үйлчилнэ. Push-ийн CA `TIMEOUT` → `EXPIRED` (decoy-той ижил төгсгөл). Унтраах:
    `decoy: false`, `pushFloorMs: 0` (анхааруулгатай).
  - **G2 (High) — цуцлалт.** `finish` нь `validateAuth`-ийн дараа гэрчилгээг AIA OCSP-оор шалгана (`revocation`, анхдагч
    шинэ `ocspRevocationChecker()`). revoked / unknown → FAILED `VALIDATION` (500 биш); хариугүй → soft-fail (порталын
    `EID_OCSP=soft`: зөвшөөрч onError-оор анхааруулна, `identity.revocation = "unchecked"`), `revocationMode: "hard-fail"`
    → FAILED. `revocation: false` — унтраана. Шинэ: `ocspRevocationChecker` (pades/ltv-ийн OCSP задлагч; олгогч/
    OCSPSigning responder, serial, thisUpdate [−48ц, +5мин], nextUpdate, 2 с timeout, redirect-гүй, 16 KiB, good 5 мин
    кэш), `ResponseValidator.checkRevocationWith`, `EidLoginIdentity.revocation`.
  - **G3 (Medium) — аудит.** `onEvent({kind, sessionId, meta})`: `push_sent` (meta `decoy`), `push_limited`, `refused`,
    `expired`, `unverified` (`reason`), `flow_refused`, `success` (`flow`, `revocation`), `failed` (`endResult`).
    Регистрийн дугаар биш `pushKey` = HMAC-SHA256(`auditKey`, дугаар); токен/нууц орохгүй. Hook-ийн алдаа onError руу.
    Шинэ төрөл: `EidLoginEvent`, `EidLoginEventKind`.
- Хаана: `src/login.ts`, `src/ocsp.ts`, `src/validator.ts`, `src/index.ts`, `test/login.test.ts`,
  `test/fixtures/ocsp.json` (Go x/crypto/ocsp-оор үүсгэсэн CA/leaf/хариу, тогтмол цагтай), `README.md` §1a, §Аюулгүй байдал,
  `package.json` 0.15.2.
- Шалгасан: decoy хэлбэр/cookie/UUID v4/vc, status PENDING eID-ээс асуулгүй → EXPIRED, event-д decoy, meta-д регистр алга;
  floor 1000 мс `mock.timers`-ээр (999 мс-д хариугүй, 1000-д хариутай; бодит, decoy, 502); тасалдал → 502; `decoy: false`;
  хязгаар decoy-д; revoked / checker алдаа / hard-fail → FAILED VALIDATION; анхдагч → unchecked; good; false → skipped;
  `ocspRevocationChecker` good / revoked / unknown→revoked / хуучин ба ирээдүйн thisUpdate / 5xx / issuer алга / буруу
  issuer / кэш; refused / failed / expired / unverified / flow_refused; hook алдаа. `npm run lint`, `npm test` (141),
  `test:compat`, `test:contract`, `golden:check`, `size:pades`.
- **PAdES бүртгэл: горим A-ийн өмнөх гарын үсэгтэй баримт + `created` (0.15.2).**
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

## 0.15.1 — 2026-10-14

- **0.15.1 — «eID-ээр нэвтрэх»: rateLimit анхдагч алдагддаг байсан, dark accent хатуу байсан (demo интеграцаас).**
  - **rateLimit:** өөрийн `rateLimit` өгөхөд анхдагч push хязгаар (нэг дугаарт 3/мин, MFA fatigue) чимээгүй унтардаг байв.
    Одоо объект `{ start?, push? }` анхдагчтай нэгтгэгдэнэ (өгсөн төрөл дарна, өгөөгүй нь анхдагчаараа; утга
    `{ limit, windowMs }` | функц | `false`); функц хэлбэр анхдагч ДЭЭР нэмэгдэнэ. `defaultRateLimit` export.
    Буруу түлхүүр/утга → `createEidLogin` throw. Go v0.3.1-тэй ижил утга.
  - **Dark токен:** `<eid-login-button>`-ий dark palette `:host`-д хатуу (`--eid-accent: oklch(0.64 0.15 259)` г.м.)
    тодорхойлогддог тул хуудасны `:root`/эцгийн `--eid-*` үйлчилдэггүй байв. Нийтийн `--eid-*` одоо зөвхөн оролт
    (дотоод `--_eid-*`): хоёр theme-д үйлчилнэ, `--eid-<нэр>-dark` dark-д давуу, анхдагч нь fallback. README-д light/dark
    бүрэн хүснэгт.
- Хаана: `src/login.ts`, `src/index.ts`, `src/button.ts`, `README.md` §1a, `package.json` 0.15.1.
- Шалгасан: `test/login.test.ts` (зөвхөн start өгөхөд push 3/мин идэвхтэй; функц хэлбэр анхдагчийг унтраахгүй; push
  дарах {limit}/функц/false; start window; defaultRateLimit frozen; буруу тохиргоо throw), `test/button.test.ts`
  (shadow-д нийтийн `--eid-*` тодорхойлолтгүй, 17 токен light/dark fallback гинж); `npm run lint`, `npm test` (132).

## 0.15.0 — 2026-10-14

- **BREAKING (0.15.0): клиент талын PAdES — PDF eID-ийн сервер рүү очихгүй.** Шийдвэр (2026-10-14): CA зөвхөн hash-д
  гарын үсэг зуруулна; PDF-ийг RP тал угсарна (Smart-ID / DigiDoc загвар). PDF upload туслахууд шилжилтгүйгээр
  **устсан** (тэдгээрийг ашигладаг RP алга, CA endpoint-ууд мөн устна): `EidClient.pdf` / `PdfApi` (`prepare`, `document`,
  `documentVerified`, `tokenPrepare`, `tokenFinalize`, `tokenDocument`), `DEFAULT_PDF_TIMEOUT_MS`, `DEFAULT_PDF_MAX_BYTES`,
  `ClientConfig.pdfTimeoutMs` / `pdfMaxBytes`, `Pdf*Input` / `Pdf*Session` / `PdfSignerRef` төрлүүд, `SessionResult.pdf` +
  `PdfSessionBlock` / `PdfSigner` / `PdfDocumentStatus`, `Http.postMultipart` / `Http.getBytes`, `RP_ROUTES.pdfPrepare` /
  `pdfDocument`, `RP_ROUTES_UNDISCOVERED.pdfToken*`.
- **Шинэ subpath `@gerege-systems/eid-mongolia-sdk/pades` — НАТИВ TypeScript (WASM-гүй).** Хэрэглэгчийн шийдвэр
  (2026-10-14 ~22:00): Go core-ийн WASM (8 MB) татгалзсан → платформ бүр жижиг натив SDK, хатуу conformance suite-ээр
  нэгтгэнэ. `prepare(pdf, opts) → {dtbs, digest, docId, state}`, `complete(state, signature, opts) → {pdf, cms, docId,
  outSha256, inSha256, hasPage, pageSha256, revIndex, sigRevSha256, priorCmsSha256, signerCert}`, `PadesError` (тогтвортой
  `code`, `retryable`), `PROFILE_VERSION` / `profileVersion()`. Хэрэгжүүлэлт `src/pades/`: digitorus/pdf-тэй ижил
  зан төлөвтэй PDF уншигч (xref table/stream, object stream, /Prev, жижиг inflate), incremental бичигч (шахалтгүй xref
  stream), гарын үсгийн revision, DSS revision, verify хуудас (PAGE_SPEC — mn/en, өөрийн QR, Noto Sans asset), DER
  бичигч/уншигч, signedAttrs (+claimedRole), CMS угсралт, RFC 3161 TSA, OCSP/CRL (WIRE.md), PRECHECKS.md-ийн хөнгөн
  шалгуур. Бүрэн validator ба `verify` энд **байхгүй** (Go backend SDK-д). Хөтөчид AIA/CDP `http://` → `https://` зөвхөн
  eID allowlist-д; үндэсний CRL `crl.eidmongolia.mn` толин хуулбараас. Node ≥ 18 (global crypto-гүйд `node:crypto`) ба
  хөтөч; хөтчийн bundle 123 KB gzip.
- **Backend:** `eid.signPdfDigest` / `sign.pdfDigest({dtbs, fileName, signer, flow, onBehalfOf})` — CA-ийн одоогийн
  `/signature/{notification|device-link}/{etsi|document}` session (`RAW_DIGEST_SIGNATURE`, `sha256WithRSAEncryption`,
  «Баримтад гарын үсэг зурах: <fileName>»). `eid.registerSignature` / `sign.registerSignature` → `POST /pdf/signatures`
  (бие нь CA `dto.PDFSignatureRegisterRequest`-тэй яг ижил — `changelog.d/2026-10-14-pades-register-dto-engines.md`).
  `Representation.claimedRole`. `RP_ROUTES.signDeviceLinkEtsi` / `signDeviceLinkDocument`.
- Conformance: `scripts/sync-pades-golden.mjs` Go reference-ийн golden-ийг (tag `pades-golden-v2`, `6437f14`) ба фонт/гинжийн
  asset-ийг хуулна; CI `npm run golden:check` (бэхэлсэн commit-тэй байт-ижил), `npm run size:pades` (≤ 300 KB gzip),
  Node 18 job (golden 2 тохиолдол ESM+CJS).
- Шалгасан: `test/pades-golden.test.ts` — golden-ийн 12 тохиолдол бүгд (хуудастай mn/en, хуудасгүй, xref table / object
  stream / linearized, хоёр дахь гарын үсэг + claimedRole, PDF_FOREIGN_SIGNATURE, PDF_ENCRYPTED): digest, DTBS,
  signedAttrs, prepared/page sha256, ByteRange, docId ба complete-ийн БҮТЭН гаралт (outSha256, CMS, sigRev, priorCms) Go-той
  байт-ижил; `test/pades-unit.test.ts` (алдааны кодууд, хөтчийн https upgrade, үндсэн entry pades-гүй);
  `test/pades-session.test.ts`; Node 18.20.8 smoke; Chrome headless-д golden 12/12 (гараар, CI-д биш); `npm run lint`,
  `npm test`.
- **`registerSignature` бие = CA `dto.PDFSignatureRegisterRequest`** (CA main `d948fdd4`, !355; docs/PADES_CLIENT_SIDE.md
  §4.3/§4.3.1). CA `DisallowUnknownFields` хэрэглэдэг тул `hasPage` хасагдсан; талбарууд яг `docID, revIndex, medium,
  sessionID?, cms, fileName, inSha256, pageSha256?, sigRevSha256, outSha256, priorCmsSha256?, priorRevisionSha256?,
  onBehalfOf?, signerEtsi?` (DTO-ийн дарааллаар). `RegisterSignatureInput` нь DTO-ийн нэртэй (`sessionID`, `signerEtsi`,
  `priorRevisionSha256` нэмэгдсэн; `inSha256` заавал, `pageSha256` revIndex 1-д заавал; `cms` — DER эсвэл base64, ≤ 28 672 байт;
  prior-уудын тоо = revIndex − 1). Шинэ: `registrationFromCompleted(done, {fileName, sessionID?, …})` (`pades.complete()`-ээс),
  `buildRegisterBody`, `PDF_SIGNATURE_REGISTER_FIELDS`; хариунд `registeredAt`. `/pdf/signatures` discovery-д орсон тул
  `RP_ROUTES.pdfSignatures`.
- **`engines.node` ≥ 18** — бүх entry (`.`, `/browser`, `/button`, `/pades`) Node 18 / 20 / 22-д ажиллана. CI `node-compat`
  матриц: `npm test`-ийн тестүүдийг type stripping-гүй хувилбараар (`scripts/test-compat.mjs`, `npm run test:compat`) ба
  `/pades` ESM/CJS smoke. README-д хамгийн бага хувилбар.
- Шалгасан: `test/pades-session.test.ts` (бие ↔ CA DTO-ийн JSON tag/omitempty, `registrationFromCompleted`, алдаа),
  `npm run test:contract` (live discovery: `pdfSigning.clientSide.register`, `endpoints.pdf.signatures`-ийн талбарын жагсаалт
  ↔ `PDF_SIGNATURE_REGISTER_FIELDS`), Node 18.20.8 / 20.20.2 / 22.23.3 дээр 127/127, `npm run lint`, `npm test`.

## 0.14.2 — 2026-10-14

- **0.14.2 — CA !357 (fd3acf14, прод 2026-10-14)-тэй нийцүүлэв.**
  - `expiresAt`: session start хариуны CA-ийн `expiresAt` (RFC 3339)-ийг авна — sign / certificate-choice (push,
    device-link, linked) ба auth (push, device-link). Талбаргүй (хуучин CA) үед sign/cert-choice-д өмнөх тооцоолол
    (`signSessionTtlMs`), auth-д undefined. `startExpiry`, `parseExpiresAt` export.
  - Typed алдаа (`ApiError`-ийн дэд анги — хуучин `instanceof ApiError` хэвээр): `NoSigningCertificateError` (409
    `NO_SIGNING_CERTIFICATE`), `CertChoiceInvalidError` (409 `CERT_CHOICE_INVALID`), `RequestInvalidError` (400
    `REQUEST_INVALID`).
- Хаана: `src/types.ts`, `src/sign.ts`, `src/auth.ts`, `src/errors.ts`, `src/http.ts`, `src/index.ts`, `README.md`.
- Шалгасан: `test/session-start.test.ts` (CA expiresAt / fallback / typed алдаа); `npm run lint`, `npm test`.

## 0.14.1 — 2026-10-14

- **0.14.1 — «eID-ээр нэвтрэх» товч/backend-ийн засвар (demo интеграцаас ирсэн 6 асуудал).**
  - **Фонт:** shadow CSS-ийн `font: 500 1rem/1.25 inherit` / `font: 1rem/1.5rem inherit` хүчингүй shorthand байсан тул
    мөр бүхэлдээ хаягдаж товч/input UA-ийн анхдагч фонтоор харагддаг байв → `font-family: inherit` + тодорхой
    `font-size`/`line-height`; `button, input { font-family: inherit }`.
  - **Theme:** `theme="auto|light|dark"` (`mountEidLoginButton({ theme })`); auto = `html[data-theme]` → `html.dark/.light`
    → `prefers-color-scheme`, MutationObserver + matchMedia-аар шууд дагана, салгахад зогсоно. `resolveEidTheme` export.
    `--eid-*` хувьсагчдыг README-д бүрэн жагсаав.
  - **Клиент IP:** `handle(Request)` IP авдаггүй тул `start:<ip>` хязгаар ажилладаггүй байв → `trustProxy` (true | hop тоо;
    XFF баруунаас n, эсвэл X-Real-IP) ба `getClientIp(req)`; аль нь ч үгүй бол `onError`-оор нэг удаа анхааруулна.
    `forwardedClientIp` export.
  - **onSuccess:** `EidLoginIdentity.sessionId` нэмэв (documentNumber, certificateDerB64 байсан) — RP дараагийн алхамд
    (гарын үсэг, гэрчилгээ холбох) ашиглана. Tx нь onSuccess-оос өмнө атомар устгагдах (нэг удаа) хэвээр — баримтжуулав.
  - **Docs:** eID аппын доод хувилбар (iOS 2.2.3 (59), Android 2.2.3 (60); сервер legacy-г 10-07-нд хассан, app-config
    min iOS 2.2.7 / Android 83 — 10-14 шалгасан), Redis store жишээ (`ioredis`, SDK хамааралгүй).
- Хаана: `src/login.ts`, `src/button.ts`, `src/index.ts`, `README.md` §1a, `package.json` 0.14.1.
- Шалгасан: `test/login.test.ts` (sessionId/documentNumber/cert, onSuccess үед store хоосон, forwardedClientIp,
  handle + trustProxy/getClientIp/анхааруулга), `test/button.test.ts` (фонтын дүрэм, theme атрибут/auto/observer,
  mount theme); `npm run lint`, `npm test`.
- **Sign session-ий дутуу хэсгүүд (client-side PAdES)** — 0.14.1-д гарсан (PR #22 version өсгөөгүй; 0.14.1
  release-д орсон). Портал HASH sign (RAW_DIGEST_SIGNATURE, digest = 32 байт DTBS)-д
  олсон дутуу — Go SDK `feat/sign-session-gaps`-тэй ижил:
  - **Device-link sign:** `sign.deviceLinkByEtsi` / `deviceLinkByDocument` (`POST /signature/device-link/{etsi|document}/…`)
    — `initialCallbackUrl`, `interactions`, `fileName`, `onBehalfOf`, RAW_DIGEST параметрүүд. `deviceLinkInput(s, type,
    lang)` — auth/sign/cert холбоосын `buildDeviceLink` оролтыг session-оос угсарна. `SignContext`
    (`NotificationSession.sign`, `DeviceLinkSession.sign`).
  - **Certificate-choice:** `sign.certificateChoiceByEtsi`, `sign.certificateChoiceDeviceLink` (зөвхөн QR — CA-ийн хүсэлт
    callback авдаггүй), `validator.validateCertificateChoice` → `Signer{certificate, documentNumber, certChoiceSessionId}`.
  - **Signer-ээр зурах:** `sign.digestForSigner` (`/signature/notification/linked/{documentNumber}` + `linkedSessionID`,
    cert choice-гүй бол `/notification/document/…`), `sign.deviceLinkForSigner` (`/signature/device-link/document/…`).
    Олон утастай иргэнд etsi-ээр эхлүүлбэл өөр утас зурж CMS эвдэрдэг тул documentNumber-аар л. Анхдагч
    `sha256WithRSAEncryption` + SHA-256; digest-ийн уртыг хүсэлтээс өмнө шалгана.
  - **`ValidateSignOptions.expectedAlgorithm`** — хүссэн RSA алгоритмаас өөр хариу (ж: PKCS#1 хүссэнд rsassa-pss) →
    `ValidationError`; хуучин threshold-ECDSA-ийн `ecdsa-with-SHA256` зөвхөн EC P-256 + SHA-256 үед.
    **`expectedCertificate`** — certificate-choice-ийн гэрчилгээнээс өөрөөр зурсан бол татгалзана.
  - **`expiresAt`** (ms epoch) — тухайн үед CA session start хариунд хугацаа буцаадаггүй байсан тул sign / cert-choice
    session-д хүсэлтээс өмнөх цаг + `signSessionTtlMs` (анхдагч `DEFAULT_SIGN_SESSION_TTL_MS` = 600000 = CA `EID_SIGN_SESSION_TTL_SECONDS`;
    CA админ 60–1800с болгож болно). `sessionExpiry` туслах. 0.14.2-оос CA (!357) `expiresAt` буцаадаг болсон тул
    SDK түүнийг авна; энэ тооцоолол зөвхөн талбаргүй (хуучин) CA-д.
  - 5 шинэ зам `RP_ROUTES`-д (live `/.well-known/eid`-д бүгд бий).
  - Хаана: `src/sign.ts`, `src/validator.ts` (precheck → `sessionDone` + `leafOf`), `src/devicelinkv3.ts`, `src/types.ts`,
    `src/contract.ts`, `src/client.ts`, `src/index.ts`, README §3.
- Шалгасан: `test/sign-gaps.test.ts` (device-link body/зам/deviceLinkInput байт-ижил, expiresAt, cert choice body
  түлхүүрүүд, validateCertificateChoice, digestForSigner linked/document/device-link + буруу оролтод хүсэлт явахгүй,
  expectedAlgorithm/expectedCertificate). `npm run lint`, `npm test` (104/104), `npm run test:contract` — RP-API зам
  ✔. OIDC шалгалт улаан: live `login.eidmongolia.mn/.well-known/openid-configuration` 2026-10-14 ~13:30 UTC-аас 404
  (CA талын төлөв — main-ийн 11:48 UTC-ийн run ногоон байсан; энэ PR OIDC-д хүрээгүй).

## 0.14.0 — 2026-10-14

- **BREAKING (0.14.0): OIDC client хасагдсан; «eID-ээр нэвтрэх» = нэг товч + backend урсгал RP-API дээр.** eID-ийн
  OIDC provider (`login.eidmongolia.mn`) хасагдсан (2026-10-14 шийдвэр) тул `EidOidcClient`, `EidOidcError`,
  `EID_OIDC_ISSUER`, `EID_ACR_*`, `pkceChallenge` ба OIDC төрлүүд, `src/oidc.ts`, `test/oidc.test.ts`, contract-ийн
  openid-configuration шалгалт (`OIDC_EXPECT`, `ID_TOKEN_CLAIMS`) хасагдсан — прод дээр 404 болж `contract` job улаан
  байсан. Оронд нь Smart-ID RP-үүдийн хэв маяг:
  - `createEidLogin({ client, onSuccess, callbackUrl, store?, rateLimit?, … })` — `POST /auth/eid/start` (qr | push),
    `GET /auth/eid/start?mode=web2app` (302 → eID апп, буцах хөтчийн `retScheme`/`retPkg` hint UA-аас), `GET
    /auth/eid/status` (PENDING + секунд тутмын QR / WAIT_CALLBACK / OK / FAILED / EXPIRED), `GET /auth/eid/callback`
    (Web2App, `userChallengeVerifier`). `handle(Request)` (Next.js/Web-standard) ба `handleRequest` (Express г.м.).
    Төлөв серверт (`EidLoginStore`, анхдагч санах ой), хөтчид HttpOnly cookie (`<sessionId>.<binding>`); callback зөвхөн
    эхлүүлсэн хөтчид (login CSRF); JSON-only POST + `Sec-Fetch-Site`; push-д анхдагч 3/мин нэг дугаарт; иргэн зөвхөн
    `validateAuth` (QR / Notification / Web2App+verifier)-ийн дараа `onSuccess`-д (`EidLoginIdentity`).
  - `@gerege-systems/eid-mongolia-sdk/button` — `<eid-login-button start-url status-url lang mode success-url>` ба
    `mountEidLoginButton`: desktop → цонх (QR + регистрээр push, хугацаа, сүлжээ тасрах/QR хуучрах), утас → Web2App
    навигаци; `eid-login-success` / `eid-login-error`; mn/en; focus trap, Esc, aria-live. eID нэвтрэх хуудасны
    дизайн (лого, токен, light/dark). Гадны хамааралгүй — `src/qr.ts` (byte, ECC M, v1–40).
  - `EidClient.rpName` (нэмэлт). `tsconfig.button.json` (DOM lib зөвхөн товчинд).
- Хаана: `src/login.ts`, `src/button.ts`, `src/qr.ts`, `src/logo.ts`, `src/index.ts`, `src/contract.ts`, `README.md` §1a.
- Шалгасан: `test/login.test.ts` (eID-г fetchImpl-ээр дуурайж: QR/push/Web2App, cookie binding, CSRF, rate limit,
  FAILED/VALIDATION, нэг удаагийн onSuccess), `test/button.test.ts` (jsdom: төлөв бүр, event, Esc/Tab, утасны навигаци),
  `test/qr.test.ts` (jsQR-аар буцааж уншина). `npm run lint`, `npm test` (106/106), `npm run test:contract` (live) ногоон.

## 0.13.0 — 2026-10-14

- **OIDC: `mtls_endpoint_aliases` (RFC 8705 §5)** — 0.13.0. `login.` хост mTLS хийдэггүй тул `require_mtls`-тэй RP
  code солиход `login.eidmongolia.mn/oauth2/token` дээр `401 invalid_client` авдаг байв. CA !347 discovery-д
  `mtls_endpoint_aliases.token_endpoint` (`https://rp.eidmongolia.mn/oauth2/token`, RP client cert шаардана) нэмсэн.
  `EidOidcDiscovery.mtls_endpoint_aliases?: Record<string, string>`; `EidOidcClientConfig.useMtlsEndpointAliases`
  (анхдагч `false`) — `true` + alias байвал token хүсэлт alias руу; alias алга бол `token_endpoint` руу буцна; alias
  https биш бол `discovery_failed`. `EidOidcClientConfig.dispatcher` (undici `Agent`, RP-API client-ийнхтэй ижил) —
  OIDC-ийн бүх fetch-д. README: «mTLS-тэй RP». Хаана: `src/oidc.ts`, `test/oidc.test.ts`.
- Шалгасан: `test/oidc.test.ts` — флагтай → alias, флаггүй → `token_endpoint`, alias алга → fallback, `http://` alias →
  `discovery_failed` (token хүсэлт явахгүй), `dispatcher` fetch-д дамжина. `npm run lint`, `npm test`.

## 0.12.1 — 2026-10-14

Эрхийн төрөл ба эх үүсвэрийн нэр (`rightTypeLabel`, `sourceLabel`, CA !344) — Go SDK 0.1.5-тай ижил, additive:

- **`rightTypeLabel` / `sourceLabel`** (CA !344, additive) — `Representation.rightTypeLabel?: string`,
  `Representation.sourceLabel?: string` (`getRepresentations`) ба session-ий `OrgResult.rightTypeLabel?: string`
  (`onBehalfOf`; тэнд `source` байхгүй). Эрхийн төрөл (ADMIN → «Админ» / Administrator, MANAGER → «Гарын үсэг зурагч» /
  Signatory) ба эх үүсвэрийн (REGISTRY → «Улсын бүртгэл» / State registry, MANUAL → «Захирал нэмсэн» / Added by the
  director) хүнд харуулах нэр, CA нэг газраас (`orgrole.RightTypeLabel` / `SourceLabel`, CA `docs/ORG_LOGIN.md` §4а);
  хэл нь `roleLabel`-тэй ижил (`language` → `Accept-Language`). Клиент `rightType`/`source` кодыг өөрөө орчуулахгүй.
  Хуучин CA-д талбар байхгүй (`undefined`). README: «roleLabel / rightTypeLabel / sourceLabel». Go SDK 0.1.5-тай ижил.
- Шалгасан: `test/portal-gaps.test.ts` — representations / session `onBehalfOf` decode, хуучин хариунд байхгүй.
  `npm run lint`, `npm test`.
- **Тест:** `qrDeviceLinkTicker` тест тогтмол 30 мс хүлээгээд ≥ 3 tick шаарддаг байсан тул GitHub runner дээр 2 tick-ээр
  тогтвортой унаж байв (PR #16-ийн CI 3 удаа, кодын өөрчлөлттэй холбоогүй). Одоо 3 tick хүртэл (≤ 2 с) хүлээнэ;
  SDK-ийн код өөрчлөгдөөгүй. Шалгасан: `npm run lint`, `npm test`.

## 0.12.0 — 2026-10-14

Албан тушаалын нэр (`roleLabel`, CA !339) — Go SDK 0.1.4-тэй ижил, additive:

- **`roleLabel`** (CA !339, additive) — `Representation.roleLabel?: string` (`getRepresentations`) ба session-ий
  `OrgResult.roleLabel?: string` (`onBehalfOf`): албан тушаалын хүнд харуулах нэр, CA нэг газраас (`server/internal/orgrole`,
  CA `docs/ORG_LOGIN.md` §4а) өгнө. `role` нь машин утга (`ceo` / `founder` / `stakeholder` эсвэл MANUAL текст) —
  клиент өөрөө орчуулахгүй, `roleLabel`-ийг харуулна. Хуучин CA-д талбар байхгүй (`undefined`).
- **`ClientConfig.language`** — дуудлага бүрд `Accept-Language` (`"mn"` | `"en"`); анхдагч илгээхгүй (сервер mn).
- Шалгасан: `test/portal-gaps.test.ts` — representations / session `onBehalfOf`-ийн `roleLabel` decode, хуучин хариунд
  байхгүй; `language` → `Accept-Language`, анхдагч/хоосон үед header алга. `npm run lint`, `npm test`, `npm run test:contract` (live).

## 0.11.0 — 2026-10-14

Порталын (eid-mongolia-mn !140) SDK шилжилтийн үлдэгдэл — Go SDK 0.1.3-тэй ижил:

- **Validator гинж — RFC 5280 замын шалгалт** (аюулгүй байдал, High; Go SDK 0.1.3-ийн `x509.Certificate.Verify`-тэй
  ижил дүрэм). Өмнө нь гинж зөвхөн нэр + гарын үсэг + `CA:TRUE`-г шалгадаг байсан: pathLenConstraint, CA-ийн
  keyCertSign, CA-ийн хугацаа, EKU (завсрын CA-ийн EKU), үл таних critical extension шалгагддаггүй байв. Одоо замыг
  backtracking-тай угсарч issuer нэр + AKI/SKI + гарын үсэг, `CA:TRUE`, KeyUsage тавьсан бол keyCertSign, pathLen,
  хугацаа (leaf-ийн хугацаанд хавчсан мөч, `clockSkewMs`), EKU (auth → clientAuth, sign → emailProtection — CA
  `ca_profile.go`; CA-д EKU байвал түүнд багтах), critical extension шалгана. **Name constraints**-ийг Node-оор
  найдвартай үнэлэх боломжгүй тул гинжинд байвал fail-closed (CA-ийн бодит 01–04-т алга). `allowedIssuerSkis`,
  `checkKeyUsage`, revocation hook — хэвээр, гинжийн дараа. **Зан төлөвийн өөрчлөлт:** EKU-г `checkKeyUsage`-ээс үл
  хамааран шалгана — гарын үсгийн (emailProtection-only) гэрчилгээ `validateAuth`-д татгалзагдана.
  Шинэ хамааралгүй (`node:crypto` + DER задлагч).
- **`ClientConfig.pdfMaxBytes`** (`DEFAULT_PDF_MAX_BYTES` = 64 MiB) — `pdf.document` / `pdf.tokenDocument` (өмнө нь
  хязгааргүй); хэтэрвэл **`ResponseTooLargeError`** (`op`, `limit`). JSON хариу 4 MiB-ээс хэтэрвэл мөн
  `ResponseTooLargeError` (өмнө нь хязгааргүй). `Http.getBytes(path, timeoutMs?, maxBytes?)` — нэмэлт параметр.
- **`RepresentationsResponse.raw`** — `getRepresentations`-ийн түүхий JSON.
- **USB токены PAdES:** `pdf.tokenPrepare` (multipart, токены SIGN гэрчилгээ + `onBehalfOf`), `pdf.tokenFinalize`
  (түүхий r||s 64 байт), `pdf.tokenDocument` — CA `docs/PADES_SIGNING.md` §16.5, `TOKEN_CERT.md`. Замууд CA-д бий ч
  `/.well-known/eid`-д алга тул `RP_ROUTES_UNDISCOVERED` (гэрээний тест WARN).
- Шалгасан: CA-ийн бодит гинж (01→02→03→04) ба бодит иргэний AUTH/SIGN (RSA + токены EC) гэрчилгээнүүд энэ гинжийн
  логикоор амжив, serverAuth-аар татгалзав (репод оруулаагүй — хувийн мэдээлэлтэй); `test/chain.test.ts`: бодит профайлын
  хуулбар гинж амжина; pathLen / завсрын EKU / CA:false / keyCertSign-гүй / хугацаа дууссан завсрын / буруу root / MDDC
  дутуу / name constraints / үл таних critical extension → татгалзана; бодит нийтийн 04 ← 03. `npm run lint`,
  `npm test`, `npm run test:contract` (live).

## 0.10.0 — 2026-10-14

Порталыг (eid-mongolia-mn) Go SDK руу шилжүүлэхэд илэрсэн дутагдлууд — бүгд additive (Go SDK 0.1.2-той ижил):

- **`SessionResult.person`** (CA `person` блок: `firstName` / `lastName` (эцгийн) / `familyName` (ургийн овог), `…En`,
  `civilId`, `regNo`, `birthDate`, `gender`, `geID`), **`.tokenCertificate`**, **`.raw`** (түүхий JSON);
  `personMatchesCertificate(person, subject)` — person блок гарын үсэгт ордоггүй тул `PNOMN-<civilId>` тулгалт.
- **`ApiError` / `ForbiddenError`: `retryAfterMs`** (Retry-After секунд эсвэл HTTP-огноо) **+ `headers`**;
  `ApiError.retryable`, `RETRYABLE_ERROR_CODES` (`PDF_PREPARE_BUSY`, `DOCUMENT_PENDING`, `TSA_UNAVAILABLE`,
  `LTV_UNAVAILABLE`, `RATE_LIMITED`, `STATE_UNAVAILABLE`, `ISSUANCE_PENDING`), `parseRetryAfter`.
  **`ClientConfig.pdfTimeoutMs`** (анхдагч `DEFAULT_PDF_TIMEOUT_MS` = 80000; өмнө нь тогтмол 60000).
- **`SignOptions.fileName`** → хүсэлтийн `fileName` (CA `NotificationSignRequest.FileName`).
- **`client.person`** (PKI_READ): `certificates`, `devices`, `activity({ flow, limit, offset })`, `summary`, `children`.
  **`client.token`**: `issueCertificate` (CA-ийн CSR hash тулгалттай), `certificateResult`, `authChallenge`,
  `authVerify` (endResult + identity.etsi = гэрчилгээний SERIALNUMBER); `verifyTokenCertificates`, `tokenAuthDigest`
  (TOKEN_AUTH тест вектор), `tokenLimitOf`.
- **ResponseValidator**: `trust.allowedIssuerSkis` (+ `CITIZEN_ISSUING_CA_SKI`), `checkKeyUsage` (auth → clientAuth,
  sign → nonRepudiation), `schemeName`; `checkRevocationStatus` → `"good"` / `"unchecked"` / `"skipped"`.
- **PII**: `NetworkError`-ийн мессеж ба шинэ `.op`-д замын `/etsi/…`, `/document/…` (PNOMN / РД / documentNumber)
  орохгүй; `.timeout`.
- **`AuthenticationError`**: `.serverMessage` (CA-ийн `{"error"}`), `.code`, `.body`, `.headers` (CA-ийн 401 vs proxy-ийн 401).
- Гэрээ: `src/contract.ts`-д person ×5, token/certificate ×2; `/token/auth/*` CA-д (код + docs/TOKEN_AUTH.md) байгаа ч
  `/.well-known/eid`-д алга тул `RP_ROUTES_UNDISCOVERED` (гэрээний тест WARN).
- **Гэрээний шалгалт** (`npm run test:contract`, `.github/workflows/contract.yml` — PR / main / өдөр бүр): SDK-ийн RP-API
  зам бүр live `/.well-known/eid`-д, OIDC утгууд `openid-configuration`-д таарахыг шалгана; SDK хамраагүй discovery
  замууд WARN. RP-API замууд ба OIDC хүлээлт `src/contract.ts`-д төвлөрсөн (зан төлөв өөрчлөгдөөгүй).
- Шалгасан: `npm run lint`, `npm test` (87 тест; шинэ 17), `npm run test:contract` (live ногоон).

## 0.9.1 — 2026-10-14

demo PDF device-link/push урсгалаас илэрсэн дутагдал — additive:

- **`validateSign(result, digest, opts?)` — `expectedFlowType`** (`ValidateSignOptions { hashAlgorithm?, expectedFlowType? }`).
  Гуравдах параметр нь `hashAlgorithm` мөр (хуучин хэлбэр, хэвээр) эсвэл объект. Өгвөл хариуны `flowType` ЯГ таарах ёстой,
  эс бөгөөс `validateAuth`-тай ижил `ValidationError` (`flowType X ≠ эхлүүлсэн урсгал Y (relay байж болзошгүй)`).
  Сонголтгүй бол одоогийн зан. Яагаад: demo PDF device-link/push урсгалд flowType-ийг гараар тулгаж байсан.
  RAW_DIGEST_SIGNATURE-д `flowType` гарын үсэгт ордоггүй — хариуны тулгалт, криптограф баталгаа биш.
- Шалгасан: `npm run lint`, `npm test` (69 тест; шинэ 1).

## 0.9.0 — 2026-10-14

demo-г SDK руу бүрэн шилжүүлэхэд (rp-eidmongolia-demo MR !41) илэрсэн дутагдлууд — бүгд additive:

- **`parseSubject(cert)`** (`X509Certificate` / DER / base64) → `CertSubject` `{ givenName, surname, commonName,
  serialNumber, country, organization, organizationIdentifier, name, attributes }` — OID 2.5.4.42/4/3/5/6/10/97;
  UTF8String / PrintableString / IA5String / BMPString; хил шалгасан DER уншигч, гэмтсэн DER → `ValidationError`.
  `validateAuth` / `validateSign`-ийн хариунд `parsedSubject` нэмэгдэв. Шинэ хамааралгүй.
- **ResponseValidator — алгоритм нь түлхүүртэй уягдана** (alg confusion хаалт): `ecdsa-with-SHA256` зөвхөн EC P-256
  гэрчилгээнд, `rsassa-pss` / `shaNNNWithRSAEncryption` зөвхөн RSA-д. Өмнө нь RSA гэрчилгээтэй хариуг
  `ecdsa-with-SHA256` гэж мэдүүлбэл node `verify` түүнийг PKCS#1 v1.5 SHA-256-аар шалгаж зөвшөөрдөг байсан (хүссэн
  `rsassa-pss`-ийн downgrade). `rsassa-pss`-ийн `hashAlgorithm` SHA-256/384/512-оор хязгаарлагдсан.
  Hash тулгалт хатуу хэвээр: CA-ийн legacy threshold ECDSA credential зөвхөн SHA-256 digest зурдаг
  (`service/memory/crypto_wired.go` `messageHash`) тул SHA-384/512 хүссэн session-д `ecdsa-with-SHA256` хариу
  серверээс гарахгүй — ирвэл тодорхой мессежтэй `ValidationError`.
- **`PdfPrepareSession.digest`** — DTBS (base64), push ба device-link хоёуланд (CA `fix/pades-signer-resolver`-ийн
  дээд түвшний `digest`, эс бөгөөс `deviceLink.digest`); талбаргүй хуучин CA → `undefined`.
- **`pdf.documentVerified(sessionId, pdfBlock | sha256Hex)`** — `document()` + `READY` ба `outSha256` тулгалт;
  зөрвөл `ValidationError`.
- README: `parsedSubject`, ижил утсан дээр push биш device-link Web2App (CA `docs/DEVICE_LINK_V3.md` §3 — Notification
  төрлийн device link байхгүй, SDK-д push-ийн «аппыг нээх» туслах нэмэхгүй), PDF `digest` / `documentVerified`,
  алгоритм-түлхүүрийн уялт.
- Шалгасан: `npm run lint`, `npm test` (68 тест; шинэ 9 — openssl-ээр кирилл subject-тэй RSA/EC cert).

## 0.8.1 — 2026-10-14

README / JSDoc шинэчлэл (кодын зан өөрчлөгдөөгүй; #9):

- §1 RP бүртгэл: нийтийн `POST /v3/rp-applications` засвартай (503) — оператор (eIDsupport@gerege.com, 7777-3773).
- §1a OIDC: товч = браузерт энгийн холбоос, `code` → `id_token` = backend; eID одоогоор зөвхөн confidential client
  (`client_secret_basic`). Товчны жишээ: «eID Mongolia-аар нэвтрэх» + лого, саармаг (цагаан, хүрээтэй) загвар.
- §4: legacy device-link 2026-10-07-нд серверээс хасагдсан (`DEVICE_LINK_REQUIRED`) — шилжилтийн хуучирсан тэмдэглэл
  солигдсон; `callbackUrl` жишээний зам `/auth/eid/callback` (сервер нормчилдог). Үсгийн алдаа «таьна».
- JSDoc: `deviceLink`, `openOrShowQR` (`@deprecated`), `ValidateAuthOptions.expectedFlowType`, `initialCallbackUrl`-ийн
  legacy шилжилтийн тайлбар.
- Шалгасан: `npm run lint`, `npm test`.

## 0.8.0 — 2026-10-14

- **«eID-ээр нэвтрэх» — OpenID Connect client** (ca-eidmongolia-mn `docs/OIDC.md`; issuer `https://login.eidmongolia.mn`):
  `new EidOidcClient({ clientId, clientSecret, redirectUri, issuer?, scope?, timeoutMs?, fetchImpl? })`.
  - `discover()` — discovery (1 цаг cache, `issuer` яг тулгалт, endpoint-ууд https).
  - `createAuthorization({ scope?, display? })` → `{ url, state, nonce, codeVerifier }` (crypto-random base64url,
    PKCE `S256`).
  - `handleCallback(url | URLSearchParams, { state, nonce, codeVerifier })` → `{ claims, idToken }`: state timing-safe
    тулгалт (таарахгүй бол code солихгүй), RFC 9207 `iss` (байвал), `error` → `EidOidcError`, token солих
    (`client_secret_basic`, RFC 6749 §2.3.1 form-urlencode), id_token шалгах.
  - `verifyIdToken(idToken, { nonce })` — JWKS (`kid`, 1 цаг cache, танихгүй `kid` → нэг удаа дахин татна), ES256
    WebCrypto (JOSE r||s), `iss`, `aud` (олон aud → `azp`), `exp`/`iat` ±60 сек, `nonce`, `sub`.
  - `EidOidcError.code` (`EidOidcErrorCode`): authorize/token-ий стандарт кодууд + `state_mismatch`,
    `invalid_callback`, `invalid_id_token`, `discovery_failed`; `.description` = `error_description`.
  - `EidIdTokenClaims`, `pkceChallenge`, `EID_OIDC_ISSUER`, `EID_ACR_QUALIFIED`, `EID_ACR_ADVANCED`.
  - Шинэ хамааралгүй (global `fetch` + `globalThis.crypto.subtle`).
- README: «eID-ээр нэвтрэх (OpenID Connect)» — бүртгэл, Express login/callback жишээ, `<a href>` товч, аюулгүй
  байдал (state ↔ session, native апп RFC 8252); developer сайтын зангуу `#burtgel` → `#registration`.
- Тест: PKCE RFC 7636 вектор, authorize URL, discovery issuer, state буруу, `access_denied`/`invalid_grant`, Basic
  urlencode, id_token зөв / aud / azp / exp / iat / nonce / iss / буруу гарын үсэг / alg none / танихгүй kid → refetch.

## 0.7.0 — 2026-10-09

- **Байгууллагын нэрийн өмнөөс PDF гарын үсэг (onBehalfOf)** (ca-eidmongolia-mn !283 / 0a997bf9; `docs/RP_INTEGRATION.md`
  §4.1–4.2): шинэ `eid.pdf.prepare({ pdf, fileName, signer, flow?, certificateLevel?, initialCallbackUrl?, docID?,
  onBehalfOf? })` — `POST /pdf/sign/prepare` multipart (`request` JSON + `pdf`) → `PdfPrepareSession`
  (`sessionId`, `docId`, `vc`, `deviceLink`, `receivedAt`); `eid.pdf.document(sessionId)` → гарын үсэгтэй PDF байт.
- `eid.organization.getRepresentations(personEtsi)` → `RepresentationsResponse` (иргэний төлөөлж чадах байгууллагууд).
- `SessionResult.pdf?: PdfSessionBlock | null` — `documentStatus`, `errorCode`, `outSha256`, `signer.onBehalfOf`,
  `signer.claimedRole`, `validation`.
- Алдаа: `ForbiddenError.code` ба `ApiError.code` — серверийн `{"error","code"}`-ийн код (өмнө нь 403-ийн мессеж
  тогтмол байв; JSON биш бол хуучин мессеж). `OnBehalfErrorCode` төрөл + `ON_BEHALF_ERROR_CODES`:
  `REPRESENTATION_DENIED`, `REPRESENTATION_PENDING`, `REPRESENTATION_EXPIRED`, `ORG_NOT_ACTIVE`, `SIGNER_UNIDENTIFIED`,
  `ORG_NOT_FOUND`, `REPRESENTATION_REVOKED`.
- `Http.postMultipart`, `Http.getBytes`. Raw digest/auth-ийн `SignOptions.onBehalfOf`/`AuthOptions.onBehalfOf` (0.1.0-ээс) хэвээр.
- Тест: multipart request (onBehalfOf), document татах + REVOKED, representations, error code, pdf блок задлах.

## 0.6.1 — 2026-09-30

- **ACSP_V2 `initialCallbackUrl` урсгалаар** (ca-eidmongolia-mn !191 / f59d14ee; `docs/RP_INTEGRATION.md` §2/§5,
  `docs/DEVICE_LINK_V3.md` §8): CA одоо payload-ийн `initialCallbackUrl`-ийг Smart-ID-ийн дагуу урсгалаар шийднэ —
  v3 QR → `""`, Web2App/App2App → RP-ийн callback, push → `""` (`EID_DEVICE_LINK_LEGACY=false` үед; legacy үед RP-ийн
  callback), legacy `/dl?sessionId` → RP-ийн callback. 0.6.0 хүртэл `validateAuth` урсгалаас үл хамааран RP-ийн
  callback-аар сэргээдэг байсан тул callback-тай session-ийг QR-аар нээх, эсвэл legacy унтарсны дараах push →
  «гарын үсэг таарсангүй».
- `validateAuth` хариуны `signature.initialCallbackUrl`-аар payload-оо сэргээнэ, гэхдээ зөвхөн `""` эсвэл session
  start-д илгээсэн callback-тай байт-ижил үед; `Web2App`/`App2App` үед заавал илгээсэн callback. Өөр утга →
  `ValidationError`. Талбар алга (хуучин CA) → өмнөх зан (RP-ийн callback).
- `SessionResult.initialCallbackUrl?: string | null` (`parseSessionResult` бөглөнө; `""` ба алга хоёрыг ялгана).
- Тест: v3 QR `""`, Web2App/App2App callback, push legacy callback, push шинэ `""`, солигдсон утга татгалзах,
  Web2App-д `""` татгалзах, талбар алга → fallback.

## 0.6.0 — 2026-09-30

- **Device link v3** (Smart-ID RP-API v3 dynamic link; ca-eidmongolia-mn `docs/DEVICE_LINK_V3.md`):
  `buildDeviceLink({ deviceLinkBase, deviceLinkType, sessionToken, sessionSecret, sessionType, lang, receivedAt, now?,
  rpChallenge | digest, relyingPartyName, interactions, initialCallbackUrl })` — QR / Web2App / App2App холбоос
  `authCode = BASE64URL(HMAC-SHA256(sessionSecret, payload))`-тэй. QR-д `elapsedSeconds = floor(now − receivedAt)`;
  Web2App/App2App нь callback-тай session-д л. Зөвхөн backend entry-д (`/browser`-д ОРОХГҮЙ — sessionSecret).
- `qrDeviceLinkTicker(input, onLink, { intervalMs? })` — Node сервер (SSE/WebSocket)-т QR-ийг секунд тутам гаргаж,
  буцаасан функцээр зогсооно.
- `DeviceLinkSession.receivedAt` — SDK хариу хүлээн авсан мөч (ms epoch), QR-ийн `receivedAt`.
- `validateAuth` баримт: `expectedFlowType` = RP-ийн ХАРУУЛСАН холбоосын төрөл (QR хуудас → `QR`, товч → `Web2App`/
  `App2App`, push → `Notification`); QR+товч хуудасны дүрэм.
- Legacy `deviceLink()` / `openOrShowQR()` (`/dl?sessionId&vc`) **deprecated** — eID апп build 59 гармагц сервер
  унтраана. Build 59-өөс өмнөх апп v3 холбоосыг танихгүй тул RP шилжилтийг унтраалгаар (анхдагч legacy) хий.
- Тест: ca-eidmongolia-mn golden векторууд (`test/fixtures/devicelink_golden.json`, эх commit 88834efa; SK баримтын 9 +
  eID 6) байт-ижил; invalid холбоос гарахгүй; floor/сөрөг elapsed; буруу оролт; ticker.

## 0.5.0 — 2026-09-30

- Device-link relay хаалт: `validateAuth(result, acsp, { expectedFlowType, userChallengeVerifier })`.
  `expectedFlowType` (`"QR" | "Web2App" | "App2App" | "Notification"`) өгвөл гарын үсэг зурагдсан ACSP_V2 `flowType`
  ЯГ таарах ёстой; `"Web2App"`/`"App2App"` үед callback-ийн `userChallengeVerifier` ЗААВАЛ бөгөөд
  `BASE64URL(SHA-256(verifier)) === userChallenge` шалгана. Өгөөгүй бол хуучин зан хэвээр (opt-in, breaking биш).
- `userChallengeOf(verifier)` export; `ValidateAuthOptions` төрөл.
- ⚠️ Апп нь бодит сувгийг 2.2.3 (build 58)-аас мэдээлнэ; түүнээс өмнөх build серверийн хүлээлтийг хуулдаг тул
  серверт min_version тавигдтал энэ нь relay-ээс бүрэн хамгаалалт биш.
- Тест: гарын үсэггүй OK татгалзагдахыг (өмнө нь кодод байсан, тестгүй байв) ба flowType/verifier тохиолдлуудыг бодит
  RSA-PSS гарын үсгээр шалгана.

## 0.4.1 — 2026-09-29

- Баримтын холбоос: README ба `package.json` `homepage` → `https://developer.eidmongolia.mn/` (`#burtgel` хэвээр).
  `https://eidmongolia.mn/developers` хаагдана (404 болно). Кодын өөрчлөлтгүй.

## 0.4.0 — 2026-09-29

- Ижил төхөөрөмж (App2App / Web2App): `deviceLink(session)` → `${deviceLinkBase}?sessionId=<uuid>&vc=<5 орон>`
  (CA-ийн `/dl` гэрээ); `deviceLinkBase` байхгүй эсвэл sessionId/vc буруу бол `DeviceLinkError` (холбоос таахгүй).
- Браузерт: `openOrShowQR(session, { showQR, isMobile? })` — гар утсанд `location.assign(link)`, бусад үед `showQR(link)`;
  `isMobileUserAgent()` (Android/iOS, desktop UA-тай iPadOS, UA-CH). Шинэ `@gerege-systems/eid-mongolia-sdk/browser`
  entry — `node:*` импортгүй.
- `DeviceLinkSession.vc` — device-link хариуны 5 оронтой код (өмнө нь задлагддаггүй байв).

## 0.3.0 — 2026-09-28

- **Breaking:** RP-API нь `https://rp.eidmongolia.mn`-д `/v3`-гүй (CA ca !102). `baseUrl` одоо бүтэн суурь бөгөөд SDK `/v3`
  залгахаа больсон; заавал биш — анхдагч `DEFAULT_BASE_URL` = `https://rp.eidmongolia.mn`. Хуучин `https://ca.eidmongolia.mn`
  (эсвэл `e-id.mn`) өгвөл тодорхой алдаа шиднэ (ca. дээр RP-API /v3-гүй байхгүй — чимээгүй 404-өөс сэргийлнэ).
  Шилжилт: `baseUrl`-ийг хасах эсвэл `https://rp.eidmongolia.mn` болгох. Шилжилтийн хугацаанд `https://rp.eidmongolia.mn/v3` ч ажиллана.
- `resolveBaseUrl`, `DEFAULT_BASE_URL` export.

## 0.2.0 — 2026-09-28

- `RpCredentials.rpName` — ≤120 тэмдэгт (CA сервер таслана; өмнө «≤32 байт» гэж бичсэн нь Smart-ID-ийн хуучин хязгаар).
  Дэд системийн нэр гэдгийг тайлбарлав; README жишээ. Код өөрчлөгдөөгүй.

## 0.1.0 — 2026-09-27

- Анхны нийтийн хувилбар: `@gerege-systems/eid-mongolia-sdk` (өмнө нь ca-eidmongolia-mn репогийн `sdk/typescript`, нийтлэгдээгүй `@eid-mongolia/sdk`).
- `CertificateLevel`-д `QSCD` нэмэгдсэн; `requiredLevel: "QUALIFIED"` үед QSCD гэрчилгээг хүлээн авна.
- README: `validateAuth(result, session.acsp)` (rpChallenge биш), ACSP_V2-ийн бодит payload, trust anchor = Mongolian National Root CA, бүртгэл `POST /v3/rp-applications`.
- Node.js ≥ 22 (`node --test --experimental-strip-types`).
