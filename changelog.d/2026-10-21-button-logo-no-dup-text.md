### Changed
- `<eid-login-button>`: лого «e-ID» гэж бичигддэг тул анхдагч текст лого + «eID» гэж давхардахгүй — товч болон
  цонхны гарчиг `[лого]-ээр нэвтрэх` (en: `Log in with [лого]`). Уншигчид sr-only «eID»-ээр нэр бүтэн хэвээр
  («eID-ээр нэвтрэх»), `textContent`/`getByRole` нэр өөрчлөгдөөгүй. `label` атрибут өгсөн эсвэл `icon="none"` үед
  хуучнаараа. Хаана: `src/button.ts`. Шалгасан: `npm test` (274 pass), Chromium screenshot (mn/en товч, цонх).
