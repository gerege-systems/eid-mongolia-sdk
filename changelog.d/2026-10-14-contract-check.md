# Гэрээний шалгалт (contract) — CI

- **Юу:** `npm run test:contract` + `.github/workflows/contract.yml` (PR, main push, өдөр бүр 00:00 UTC, гараар).
  SDK-ийн RP-API зам бүр live `https://rp.eidmongolia.mn/.well-known/eid`-ийн `endpoints`-д; OIDC утгууд (issuer, ES256,
  S256, client_secret_basic, response_type code, scope openid, acr, `EidIdTokenClaims` талбарууд)
  `https://login.eidmongolia.mn/.well-known/openid-configuration`-тэй таарах. SDK хамраагүй discovery замууд — WARN.
- **Яагаад:** CA backend, SDK, developer сайт хоорондоо зөрөхийг өдөр бүр автоматаар барих.
- **Хаана:** `src/contract.ts` — RP-API зам ба OIDC хүлээлт нэг газар; `auth/sign/pdf/organization/session/oidc` эндээс
  уншина (зан төлөв ижил, public API өөрчлөгдөөгүй). `test/contract.test.ts`. `npm test` сүлжээгүй хэвээр.
- **Шалгасан:** `npm run lint`, `npm test`, `npm run test:contract` live ногоон; замыг түр эвдэхэд унасан.
