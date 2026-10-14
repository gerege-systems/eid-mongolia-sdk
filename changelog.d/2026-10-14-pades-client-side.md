- **BREAKING (0.15.0): клиент талын PAdES — PDF eID-ийн сервер рүү очихгүй.** Шийдвэр (2026-10-14): CA зөвхөн hash-д
  гарын үсэг зуруулна; PDF-ийг RP тал угсарна (Smart-ID / DigiDoc загвар). PDF upload туслахууд шилжилтгүйгээр
  **устсан** (тэдгээрийг ашигладаг RP алга, CA endpoint-ууд мөн устна): `EidClient.pdf` / `PdfApi` (`prepare`, `document`,
  `documentVerified`, `tokenPrepare`, `tokenFinalize`, `tokenDocument`), `DEFAULT_PDF_TIMEOUT_MS`, `DEFAULT_PDF_MAX_BYTES`,
  `ClientConfig.pdfTimeoutMs` / `pdfMaxBytes`, `Pdf*Input` / `Pdf*Session` / `PdfSignerRef` төрлүүд, `SessionResult.pdf` +
  `PdfSessionBlock` / `PdfSigner` / `PdfDocumentStatus`, `Http.postMultipart` / `Http.getBytes`, `RP_ROUTES.pdfPrepare` /
  `pdfDocument`, `RP_ROUTES_UNDISCOVERED.pdfToken*`.
- **Шинэ subpath `@gerege-systems/eid-mongolia-sdk/pades` — НАТИВ TypeScript (WASM-гүй).** Хэрэглэгчийн шийдвэр
  (2026-10-14 ~22:00): Go core-ийн WASM (8 MB) татгалзсан → платформ бүр жижиг натив SDK, хатуу conformance suite-ээр
  нэгтгэнэ. `prepare(pdf, opts) → {dtbs, digest, docId, state}`, `complete(state, signature, opts) → {pdf, cms, docId,
  outSha256, inSha256, hasPage, pageSha256, revIndex, sigRevSha256, priorCmsSha256, signerCert}`, `PadesError` (тогтвортой
  `code`, `retryable`), `PROFILE_VERSION` / `profileVersion()`. Хэрэгжүүлэлт `src/pades/`: digitorus/pdf-тэй ижил
  зан төлөвтэй PDF уншигч (xref table/stream, object stream, /Prev, жижиг inflate), incremental бичигч (шахалтгүй xref
  stream), гарын үсгийн revision, DSS revision, verify хуудас (PAGE_SPEC — mn/en, өөрийн QR, Noto Sans asset), DER
  бичигч/уншигч, signedAttrs (+claimedRole), CMS угсралт, RFC 3161 TSA, OCSP/CRL (WIRE.md), PRECHECKS.md-ийн хөнгөн
  шалгуур. Бүрэн validator ба `verify` энд **байхгүй** (Go backend SDK-д). Хөтөчид AIA/CDP `http://` → `https://` зөвхөн
  eID allowlist-д; үндэсний CRL `crl.eidmongolia.mn` толин хуулбараас. Node ≥ 18 (global crypto-гүйд `node:crypto`) ба
  хөтөч; хөтчийн bundle 123 KB gzip.
- **Backend:** `eid.signPdfDigest` / `sign.pdfDigest({dtbs, fileName, signer, flow, onBehalfOf})` — CA-ийн одоогийн
  `/signature/{notification|device-link}/{etsi|document}` session (`RAW_DIGEST_SIGNATURE`, `sha256WithRSAEncryption`,
  «Баримтад гарын үсэг зурах: <fileName>»). `eid.registerSignature` / `sign.registerSignature` → `POST /pdf/signatures`
  (бие нь CA `dto.PDFSignatureRegisterRequest`-тэй яг ижил — `changelog.d/2026-10-14-pades-register-dto-engines.md`).
  `Representation.claimedRole`. `RP_ROUTES.signDeviceLinkEtsi` / `signDeviceLinkDocument`.
- Conformance: `scripts/sync-pades-golden.mjs` Go reference-ийн golden-ийг (tag `pades-golden-v2`, `6437f14`) ба фонт/гинжийн
  asset-ийг хуулна; CI `npm run golden:check` (бэхэлсэн commit-тэй байт-ижил), `npm run size:pades` (≤ 300 KB gzip),
  Node 18 job (golden 2 тохиолдол ESM+CJS).
- Шалгасан: `test/pades-golden.test.ts` — golden-ийн 12 тохиолдол бүгд (хуудастай mn/en, хуудасгүй, xref table / object
  stream / linearized, хоёр дахь гарын үсэг + claimedRole, PDF_FOREIGN_SIGNATURE, PDF_ENCRYPTED): digest, DTBS,
  signedAttrs, prepared/page sha256, ByteRange, docId ба complete-ийн БҮТЭН гаралт (outSha256, CMS, sigRev, priorCms) Go-той
  байт-ижил; `test/pades-unit.test.ts` (алдааны кодууд, хөтчийн https upgrade, үндсэн entry pades-гүй);
  `test/pades-session.test.ts`; Node 18.20.8 smoke; Chrome headless-д golden 12/12 (гараар, CI-д биш); `npm run lint`,
  `npm test`.
