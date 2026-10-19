### Added — `TokenCertInput.appTransaction?`, `APP_ATTESTATION_INVALID`

- **Юу:** `token.issueCertificate`-д заавал биш `appTransaction` (StoreKit 2 AppTransaction JWS, ≤ 16 KiB; хоосон бол
  илгээхгүй). `MAX_APP_TRANSACTION_BYTES`-аас их бол илгээхгүй — `AppTransactionTooLargeError`. 400
  `APP_ATTESTATION_INVALID` тогтмол. Discovery `TokenCertInfo.appTransaction` (`"optional"`; хуучин CA-д `""`).
- **Яагаад:** CA (MR !390) macOS App Store build-ийн апп баталгааг токены олголтод нэмсэн; SDK-ийн хүсэлт талбаргүй
  байсан тул RP дамжуулж чадахгүй байв.
- **Хаана:** `src/token.ts`, `src/errors.ts`, `src/index.ts`, README §3c, `test/portal-gaps.test.ts`,
  `test/contract.test.ts` (live discovery-д `appTransaction: "optional"`).
- **Шалгасан:** `npm run lint`, `npm test` (259 pass), `npm run test:contract`.
