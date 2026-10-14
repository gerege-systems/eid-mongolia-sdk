- **`registerSignature` бие = CA `dto.PDFSignatureRegisterRequest`** (CA main `d948fdd4`, !355; docs/PADES_CLIENT_SIDE.md
  §4.3/§4.3.1). CA `DisallowUnknownFields` хэрэглэдэг тул `hasPage` хасагдсан; талбарууд яг `docID, revIndex, medium,
  sessionID?, cms, fileName, inSha256, pageSha256?, sigRevSha256, outSha256, priorCmsSha256?, priorRevisionSha256?,
  onBehalfOf?, signerEtsi?` (DTO-ийн дарааллаар). `RegisterSignatureInput` нь DTO-ийн нэртэй (`sessionID`, `signerEtsi`,
  `priorRevisionSha256` нэмэгдсэн; `inSha256` заавал, `pageSha256` revIndex 1-д заавал; `cms` — DER эсвэл base64, ≤ 28 672 байт;
  prior-уудын тоо = revIndex − 1). Шинэ: `registrationFromCompleted(done, {fileName, sessionID?, …})` (`pades.complete()`-ээс),
  `buildRegisterBody`, `PDF_SIGNATURE_REGISTER_FIELDS`; хариунд `registeredAt`. `/pdf/signatures` discovery-д орсон тул
  `RP_ROUTES.pdfSignatures`.
- **`engines.node` ≥ 18** — бүх entry (`.`, `/browser`, `/button`, `/pades`) Node 18 / 20 / 22-д ажиллана. CI `node-compat`
  матриц: `npm test`-ийн тестүүдийг type stripping-гүй хувилбараар (`scripts/test-compat.mjs`, `npm run test:compat`) ба
  `/pades` ESM/CJS smoke. README-д хамгийн бага хувилбар.
- Шалгасан: `test/pades-session.test.ts` (бие ↔ CA DTO-ийн JSON tag/omitempty, `registrationFromCompleted`, алдаа),
  `npm run test:contract` (live discovery: `pdfSigning.clientSide.register`, `endpoints.pdf.signatures`-ийн талбарын жагсаалт
  ↔ `PDF_SIGNATURE_REGISTER_FIELDS`), Node 18.20.8 / 20.20.2 / 22.23.3 дээр 127/127, `npm run lint`, `npm test`.
