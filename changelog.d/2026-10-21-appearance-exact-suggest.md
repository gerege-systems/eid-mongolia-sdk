### Added — `appearance.exact` ба `suggestPlacement` (golden v7)

- **Юу:** `PadesAppearance.exact?: boolean` (анхдагч false) — тэмдэг яг `page/x/y/width/height` дээр зурагдана, хэзээ ч
  шилжихгүй (хуудаснаас гарвал `REQUEST_INVALID`); хуудсыг уншсаар байгаа тул `placement.status` = `requested` /
  `overlap` / `unscanned`, `moved` хэзээ ч биш (PLACEMENT_SPEC §6a). Шинэ `suggestPlacement(pdf, appearance)` —
  prepare-ийн байршлыг гарын үсэггүй, сүлжээгүй ажиллуулж `{ page, x, y, width, height, status, pageWidth, pageHeight,
  pageCount, pages }` буцаана (§6b). `exact` false/байхгүй бол өмнөхтэй байт-ижил. Go v0.14.0-ийн
  (`Appearance.Exact`, `SuggestPlacement`) 1:1 порт.
- **Яагаад:** портал (eidmongolia.mn) ба eid-desktop иргэнд PDF-ийг урьдчилан харуулж тэмдгийн байршлыг сонгуулна.
- **Хаана:** `src/pades.ts` (`suggestPlacement`, `PlacementSuggestion`, `PadesAppearance.exact`),
  `src/pades/page/suggest.ts` (`suggestVisible`), `src/pades/page/occupancy.ts` (`placeOnPage` — prepare ба suggest
  нэг зам), `src/pades/page/appearance.ts` (`pageList`), README; golden pin Go `247c964` (#39, `pades-golden-v7`: +5
  `exact-*` кейс, `expect.suggestion` / `suggestionError`).
- **Шалгасан:** `npm run lint`, `npm test` (golden 33 кейс байт-ижил + suggestion талбар бүрээр), `npm run golden:check`,
  `npm run test:contract`, `npm run size:pades`.
