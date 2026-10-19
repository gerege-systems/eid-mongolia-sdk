### Changed — `appearance.page` 0 = eID verify хуудас БИШ сүүлийн хуудас (golden v6)

- **Юу:** `prepare`-ийн `appearance.page` 0 / байхгүй үед оролтын хуудсуудыг сүүлээс нь шалгаж, өмнөх гарын үсгүүдийн
  нэмсэн eID verify хуудсуудыг алгасна. Verify хуудас = `/Annots`-д `/Subtype /Link`,
  `/A << /S /URI /URI (https://ca.eidmongolia.mn/verify/<docId>) >>` (энэ баримтын docId-тай байт-ижил) annotation-тай
  хуудас; эргэлзээтэй бол агуулгын хуудас. Тодорхой дугаар (1…N) хэвээр. Go `core.DefaultStampPage`-ийн 1:1 порт
  (`defaultStampPage`).
- **Яагаад:** портал хоёр дахь гарын үсэгт `page: 0` дамжуулдаг — тэмдэг эхний гарын үсгийн verify хуудсан дээр бууж
  байв (0.25.0).
- **Хаана:** `src/pades/page/appearance.ts`, `src/pades.ts` (`visibleSpec`, `PadesAppearance.page` JSDoc), README;
  golden pin Go `874ae48` (#35, golden v6: +5 кейс); `test/pades-placement.test.ts` (`defaultStampPage`).
- **Шалгасан:** `npm run lint`, `npm test`, `node scripts/sync-pades-golden.mjs --check`; golden 28 кейс байт-ижил.
