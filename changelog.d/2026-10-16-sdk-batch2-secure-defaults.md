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
