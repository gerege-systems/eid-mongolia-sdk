### Fixed — `maskPath` linked, `baseUrl` https, `documentNumber` тайлбар (0.21.0)

- **Юу:** (1) `NetworkError.op` / алдааны зам `/signature/notification/linked/{documentNumber}`-ийг `…` болгоно (өмнө нь
  төхөөрөмжийн дугаар логт гардаг байв). (2) `EidClient` `baseUrl` нь `https://` байх ёстой; `http://` зөвхөн `localhost`,
  `127.0.0.1`, `[::1]` (тест/mock) — бусад нь `Error` (RP secret ба иргэний мэдээлэл шифргүй явахаас сэргийлнэ).
  (3) `EidLoginIdentity.documentNumber` — «иргэний баримтын дугаар `PNOMN-…-MOBILE-Q`» биш, RP-API-ийн төхөөрөмжийн
  (тунгалаг) таних тэмдэг (Go `eidlogin.Identity.DocumentNumber`-тэй ижил тайлбар).
- **Яагаад:** 10-15 SDK аудитын Low олдворууд (TS хэсэг).
- **Хаана:** `src/errors.ts`, `src/client.ts`, `src/login.ts`; `test/portal-gaps.test.ts`, `test/sdk.test.ts`.
- **Шалгасан:** `npm test`, `npm run lint`.
