# Токены сунгалтын scope түгжээ — TOKEN_SCOPE_CHANGE (CA !373)

- **Юу:** `TokenConflictCode` (`TOKEN_LIMIT_REACHED` · `TOKEN_IN_USE` · `TOKEN_SCOPE_CHANGE`) + `TOKEN_CONFLICT_CODES`;
  `eid.token.certificateInfo()` → discovery-ийн `tokenCertificate` блок (`TokenCertInfo`, `scopeLockedOnRenewal`);
  `issueCertificate` / `certificateResult`-ийн JSDoc, `TokenCertSessionBlock.errorCode`-ийн жагсаалт, README §3c-д дүрэм.
- **Яагаад:** CA main 0d1f3f63 (!373): ижил `tokenSerial` дээр ACTIVE бүртгэлтэй үед сунгалт scope-ийг (хувийн ↔
  байгууллага, өөр `onBehalfOf`) солих гэвэл `POST /token/certificate`, `GET /token/certificate/{id}` 409
  `TOKEN_SCOPE_CHANGE`, session-ий `tokenCertificate.errorCode` мөн; override үгүй — иргэн eID апп-аас токеноо
  цуцлаад шинээр олгуулна. Discovery: `tokenCertificate.scopeLockedOnRenewal: true`.
- **Хаана:** `src/token.ts`, `src/types.ts`, `src/index.ts`, `README.md`, `test/portal-gaps.test.ts`, `test/contract.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`, `npm run test:contract` (live discovery-д `scopeLockedOnRenewal: true`).
