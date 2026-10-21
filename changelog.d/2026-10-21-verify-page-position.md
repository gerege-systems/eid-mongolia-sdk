### Added — pades `prepare` `verifyPagePosition: "last" | "first"` (golden v9)

- **Юу:** `verifyPagePosition: "first"` — баталгаажуулах (QR) хуудас үндсэн `/Pages /Kids`-ийн эхэнд орж баримтын 1-р хуудас
  болно; анхдагч `"last"` өмнөхтэй байт-ижил; бусад утга `REQUEST_INVALID`. `appearance.page`, `suggestPlacement`,
  `placement.page` оролтын PDF-ийн хуудсаар (нэмэгдсэн хуудсыг тоолохгүй — SDK дотроо +1 болгож зурна).
- **Яагаад:** портал/desktop-д «Баталгаажуулалтын хуудсыг эхэнд» сонголт (Go v0.15.0, PAGE_SPEC §8a, PLACEMENT_SPEC §1b).
- **Хаана:** `src/pades.ts` (`PadesPrepareOptions.verifyPagePosition`), `src/pades/page/page.ts` (`appendVerifyPage(…, first)`),
  `test/pades-golden.test.ts` (manifest-ийн түлхүүр), `scripts/sync-pades-golden.mjs` → Go `9e76888` (`pades-golden-v9`),
  `test/fixtures/pades/golden/`, README.
- **Шалгасан:** `npm run lint`; `npm test` — golden (v9-ийн 8 `vpfirst-*` кейс багтсан) Go-той байт-ижил.
