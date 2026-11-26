### Added — organisation e-Seal registration (CA V158, PR #78) and the QR seal stamp writer

- **What:** `eid.seal.registerSealedPdf(orgEtsi, input)` → `POST /seal/{orgEtsi}/registrations` (201 `created` / 200
  replay; result = `RegisterSignatureResult`, alias `SealRegisterResult`). Body `SealRegisterInput` / `buildSealRegisterBody`
  = CA `dto.SealRegisterRequest` (`SEAL_REGISTER_FIELDS`: `docID, revIndex, cms, fileName?, inSha256, sigRevSha256,
  outSha256, priorCmsSha256?, priorRevisionSha256?`), validated offline with the CA's `normalizeSealRegister` rules
  (`ValidationError`); 409 `PRIOR_MISMATCH` retry via `priorSignatures` (same combinations as `registerSignature`).
  `SEAL_REGISTER_ERROR_CODES` / `SealRegisterErrorCode` = discovery `seal.registerErrorCodes` (new: `SEAL_NOT_FOUND`,
  `SEAL_DOC_MISMATCH`, `DOC_ID_RESERVED`; errors stay `ApiError` / `ForbiddenError`). `eid.seal.sealForDocument(orgEtsi,
  digest, docId, revIndex)` — `POST /seal/{orgEtsi}` with the V158 reservation (`SEAL_RESERVATION_FIELDS`, SHA-256 only);
  `seal()` sends the old body unchanged.
- **pades:** `sealPdf` options `qr` (QR seal stamp, APPEARANCE_SPEC §6.5 — needs `PadesSealer.sealForDocument`, reserves
  docId/revIndex at seal time; `qr` + `invisible`, or a signed input without a resolvable docId → `REQUEST_INVALID` before
  any request; only an own `qr` property counts), `docId`, `fileName`; result `sealRegistration`
  (`PadesSealRegistration`) and `sealRegistration(done, { fileName })`. Default `sealPdf` output unchanged (QR-less, golden
  v12 byte-identical); `prepare` stays QR-less.
- **Why:** the CA registers seals since 2026-11-25; the CA and TS validators and the `/verify` bundle (0.49.0) already
  implement §6.5, the gate for a QR writer.
- **Golden:** no new bytes — `sealPdf({qr: true})` reproduces golden v13 `seal-qr-visible`, `citizen-then-seal-qr`,
  `seal-qr-then-seal-qr` byte for byte; fixtures stay at `pades-golden-v13`.
- **Where:** `src/seal.ts`, `src/contract.ts`, `src/errors.ts`, `src/index.ts`, `src/client.ts`, `src/sign.ts`
  (`priorSplits` shared, not exported from the entry), `src/pades.ts`, `src/pades/sealqr.ts`; tests
  `test/seal-register.test.ts`, `test/pades-seal-register.test.ts`, `test/contract.test.ts`; README (mn/en/zh-CN) §3i.
- **Verified:** `npm ci` + `npm test` on the macmini; PR CI.
