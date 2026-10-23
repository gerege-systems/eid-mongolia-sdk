### Added — `person.signatureImage()`, `Representation.stampImage` (RP-API зураг)

- **Юу:** `eid.person.signatureImage(personEtsi)` → `GET /person/etsi/{personEtsi}/signature-image` →
  `EidImage { png, sha256, width, height, updatedAt?, pdfImage? }`; 404 → `null`, 403 → `ForbiddenError`.
  `Representation.stampImageSet?`, `Representation.stampImage?: EidImage` (SIGN эрхтэй RP-д). `PdfImage` төрөл
  `types.ts`-д шилжиж үндсэн экспортоос ч гарна (`/pades`-ийн `PdfImage` ижил төрөл) — `pdfImage`-ийг
  `appearance.signatureImage` / `stampImage`-д хэвээр өгнө. `RP_ROUTES.personSignatureImage` (contract).
- **Яагаад:** demo/портал зургийг SDK-гүйгээр гараар татаж байсан (SDK gap); Go v0.17.0-тэй ижил.
- **Хаана:** `src/person.ts`, `src/types.ts`, `src/contract.ts`, `src/pades.ts`, `src/index.ts`,
  `test/portal-gaps.test.ts`, README.
- **Шалгасан:** `npm test` (289/289; stub 200/404/403/500, representations stampImage), `npm run lint`,
  `test:contract` (live discovery-д зам бий), `golden:check`, `size:pades` (gzip 138.2 KB).
