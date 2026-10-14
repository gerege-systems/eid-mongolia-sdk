- **Sign session-ий дутуу хэсгүүд (client-side PAdES)** — зориулсан хувилбар 0.14.x (package.json-ийн version-ийг
  координатор release-ээр өсгөнө; энэ PR-д үгүй). Портал HASH sign (RAW_DIGEST_SIGNATURE, digest = 32 байт DTBS)-д
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
  - **`expiresAt`** (ms epoch) — CA session start хариунд хугацаа буцаадаггүй тул sign / cert-choice session-д хүсэлтээс
    өмнөх цаг + `signSessionTtlMs` (анхдагч `DEFAULT_SIGN_SESSION_TTL_MS` = 600000 = CA `EID_SIGN_SESSION_TTL_SECONDS`;
    CA админ 60–1800с болгож болно). `sessionExpiry` туслах.
  - 5 шинэ зам `RP_ROUTES`-д (live `/.well-known/eid`-д бүгд бий).
  - Хаана: `src/sign.ts`, `src/validator.ts` (precheck → `sessionDone` + `leafOf`), `src/devicelinkv3.ts`, `src/types.ts`,
    `src/contract.ts`, `src/client.ts`, `src/index.ts`, README §3.
- Шалгасан: `test/sign-gaps.test.ts` (device-link body/зам/deviceLinkInput байт-ижил, expiresAt, cert choice body
  түлхүүрүүд, validateCertificateChoice, digestForSigner linked/document/device-link + буруу оролтод хүсэлт явахгүй,
  expectedAlgorithm/expectedCertificate). `npm run lint`, `npm test` (104/104), `npm run test:contract` — RP-API зам
  ✔. OIDC шалгалт улаан: live `login.eidmongolia.mn/.well-known/openid-configuration` 2026-10-14 ~13:30 UTC-аас 404
  (CA талын төлөв — main-ийн 11:48 UTC-ийн run ногоон байсан; энэ PR OIDC-д хүрээгүй).
