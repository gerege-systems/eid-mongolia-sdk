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
