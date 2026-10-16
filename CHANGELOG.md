# Changelog
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
