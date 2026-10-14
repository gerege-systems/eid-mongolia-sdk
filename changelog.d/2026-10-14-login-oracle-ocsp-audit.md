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
