- **`<eid-login-button>`: `label`, `icon`, `variant="icon"` тохиргоо, `part="icon"` / `part="label"` (0.15.4).**
  - Юу: `label` атрибут — товчны текст (байхгүй бол i18n «eID-ээр нэвтрэх» / «Log in with eID»); `icon="eid|none"` —
    лого харуулах эсэх; `variant="icon"` (эсвэл `label=""`) — зөвхөн лого, 44×44 дөрвөлжин, `aria-label` = `label` /
    i18n текст, хост `aria-label` өгсөн бол түүнийг. Бүгд observed — өөрчлөгдөхөд шууд шинэчлэгдэнэ. Shadow part:
    `button` хэвээр, шинээр `icon` (img), `label` (span). `mountEidLoginButton`-д `label`, `icon`, `variant` сонголт.
  - Хамгаалалт: `icon="none"` + текстгүй хослол хоосон товч үүсгэхгүй — анхдагч текст харагдаж, `console.warn` нэг удаа.
  - Анхдагч харагдах байдал өөрчлөгдөөгүй; шинэ хамаарал үгүй.
- Яагаад: RP-ууд товчны текст, зөвхөн-лого хувилбар, part-аар загварчлах боломж хүссэн.
- Хаана: `src/button.ts`, `test/button.test.ts`, `README.md` §1a (атрибутын хүснэгт, `::part` жишээ).
- Шалгасан: `npm run lint`, `npm test` (151; шинэ 5: label шууд шинэчлэл/lang-аас давуу, icon=none, variant=icon +
  aria-label (i18n / label / хост), icon=none+текстгүй fallback + нэг warn, mount сонголт).
