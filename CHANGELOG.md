# Changelog
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
