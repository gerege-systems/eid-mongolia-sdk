### Fixed
- `<eid-login-button>` 0.28.1-ийн регресс: лого + богино текст flex item болсон тул Chrome accessible name-д зай
  оруулж «eID -ээр нэвтрэх» гэж уншдаг байв (портал e2e `getByRole('button', {name: 'eID-ээр нэвтрэх'})` унасан).
  Одоо логотой анхдагч үед товч болон цонхны `h2`-д бүтэн `aria-label` («eID-ээр нэвтрэх» / «Log in with eID»),
  sr-only span хасагдсан. Харагдах байдал өөрчлөгдөөгүй. Хаана: `src/button.ts`. Шалгасан: `npm test`, Chromium
  Playwright `ariaSnapshot`.
