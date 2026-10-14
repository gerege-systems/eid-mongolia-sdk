- **BREAKING (0.14.0): клиент талын PAdES — PDF eID-ийн сервер рүү очихгүй.** Шийдвэр (2026-10-14): CA зөвхөн hash-д
  гарын үсэг зуруулна; PDF-ийг RP тал Go core-ийн WebAssembly-аар угсарна (Smart-ID / DigiDoc загвар). PDF upload
  туслахууд шилжилтгүйгээр **устсан** (тэдгээрийг ашигладаг RP алга, CA endpoint-ууд мөн устна):
  `EidClient.pdf` / `PdfApi` (`prepare`, `document`, `documentVerified`, `tokenPrepare`, `tokenFinalize`, `tokenDocument`),
  `DEFAULT_PDF_TIMEOUT_MS`, `DEFAULT_PDF_MAX_BYTES`, `ClientConfig.pdfTimeoutMs` / `pdfMaxBytes`, `Pdf*Input` /
  `Pdf*Session` / `PdfSignerRef` төрлүүд, `SessionResult.pdf` + `PdfSessionBlock` / `PdfSigner` / `PdfDocumentStatus`,
  `Http.postMultipart` / `Http.getBytes`, `RP_ROUTES.pdfPrepare` / `pdfDocument`, `RP_ROUTES_UNDISCOVERED.pdfToken*`.
- **Шинэ subpath `@gerege-systems/eid-mongolia-sdk/pades`** — `prepare(pdf, opts) → {dtbs, digest, docId, state}`,
  `complete(state, signature) → {pdf, cms, docId, outSha256, inSha256, hasPage, pageSha256, revIndex, sigRevSha256,
  priorCmsSha256, signerCert}`, `verify(pdf)`, `loadPades({wasm})`, `profileVersion()`, `PadesError` (тогтвортой `code`,
  `retryable`). Go SDK `feat/pades-core` `5947ebb` (`wasm/`)-ийг `scripts/build-pades-wasm.sh`-ээр (commit + Go 1.25.5 бэхэлсэн)
  `dist/eid-pades.wasm` болгоно, `src/pades/wasm_exec.js` тэр Go-оос. Node ≥ 18 (global crypto-гүйд polyfill) ба хөтөч;
  үндсэн entry WASM-гүй.
- **Backend:** `eid.signPdfDigest` / `sign.pdfDigest({dtbs, fileName, signer, flow, onBehalfOf})` — CA-ийн одоогийн
  `/signature/{notification|device-link}/{etsi|document}` session (`RAW_DIGEST_SIGNATURE`, `sha256WithRSAEncryption`,
  «Баримтад гарын үсэг зурах: <fileName>» — CA-ийн өөрийн PAdES session-тэй ижил). `eid.registerSignature` /
  `sign.registerSignature` → `POST /pdf/signatures` (CA docs/PADES_CLIENT_SIDE.md §4.3; discovery-д хараахан алга →
  гэрээний тест WARN). `Representation.claimedRole`. `RP_ROUTES.signDeviceLinkEtsi` / `signDeviceLinkDocument`.
- CI: Go 1.25.5-аар WASM build, `wasm_exec.js` бэхэлгээний шалгалт, Node 18 smoke (`test/pades-node18.mjs`); release ч
  WASM build хийнэ. README §3d — вэб RP ба зөвхөн Node урсгал.
- Шалгасан: `test/pades-session.test.ts` (mock fetch — push/device-link бие, interactions, оролтын шалгалт,
  registerSignature бие/алдаа, claimedRole); `test/pades-wasm.test.ts` — WASM-ын prepare (dtbs/digest/docId) Go core-ийн албан golden
  manifest-тэй (`pades/testdata/golden`, PDF_FOREIGN_SIGNATURE / PDF_ENCRYPTED ч мөн) ба verify тайлан НАТИВ Go-ийн
  vector-той (`scripts/pades-vectors/main.go`) байт-ижил, SIGNATURE_INVALID / STATE_INVALID /
  SIGNER_INVALID / REQUEST_INVALID; `npm run lint`, `npm test`.
