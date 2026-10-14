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
- Тэмдэглэл: `feat/pades-wasm` салбар ч 0.14.0-г зорьсон — merge дарааллаар хувилбар тогтоно.
