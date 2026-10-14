- **`<eid-login-button>` цонх: регистрийн дугаарын хэсэг нэг товч болж, ижил цонхонд дэлгэгдэнэ; VC том/тод, countdown VC-ийн доор.**
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
