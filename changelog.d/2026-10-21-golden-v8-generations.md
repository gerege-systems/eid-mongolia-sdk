### Tests — pades golden v8 (verify page chain with non-zero object generations)

- **Юу:** golden-ийг Go #40 (`21f8434`, `pades-golden-v8`) руу бэхэлсэн: `input/verify-gen1.pdf` (verify хуудас `6 1 obj`,
  docId Link `7 1 obj`, URI action `8 2 obj`) ба кейс `verify-gen1`, `page0-verify-gen1`, `page-explicit-verify-gen1`.
- **Яагаад:** PLACEMENT_SPEC §1a «Object generations» — docId-ийг xref-ийн бодит generation-оор уншина (Swift port 0 гэж
  таамагладаг байсныг CA репод зассан). TS аль хэдийн зөв — кодын өөрчлөлтгүй.
- **Хаана:** `scripts/sync-pades-golden.mjs` (`GO_SDK_COMMIT`), `test/fixtures/pades/golden/`, `src/pades/assets/*.ts`
  (зөвхөн үүсгэсэн толгойн commit).
- **Шалгасан:** `npm run golden:check`; `test/pades-golden.test.ts` + `test/pades-placement.test.ts` — 36 кейс байт-ижил.
