# Changelog
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
