### Added — `TokenCertStart.supersedes?`, `TokenCertInfo.personalAutoSupersede`

- **Юу:** `token.issueCertificate`-ийн хариунд `supersedes?: { tokenSerial }[]` — хувийн хязгаар хүрсэн үед олголт
  амжилттай болоход superseded (4)-оор цуцлагдах өмнөх хувийн токенууд. Discovery `personalAutoSupersede` (хуучин CA-д
  false). 409 `TOKEN_LIMIT_REACHED` `kind: "PERSONAL"` одоо зөвхөн `limit: 0`.
- **Яагаад:** CA !392 (прод b09b755e) хувийн токены автомат солилт; RP PIN2-оос өмнө иргэнд анхааруулах ёстой.
- **Хаана:** `src/token.ts`, README §3c, `test/portal-gaps.test.ts`, `test/contract.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`, `npm run test:contract` (live discovery).
