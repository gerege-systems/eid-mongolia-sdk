### Added — `PersonCertificate.tokenSerial?`

- **Юу:** `eid.person.certificates()`-ийн `keyMedium: "TOKEN"` мөрөнд гэрчилгээ олгогдсон USB токены серийн дугаар
  (CA `GET /v3/certificates/etsi/{personEtsi}`, 2026-10-19). MOBILE/HSM мөрөнд болон хуучин CA-д `undefined`.
- **Яагаад:** нэг токены AUTH + SIGN-ийг байгууллага + олгосон цагаар таамаглахгүй, токеноор нь бүлэглэх.
- **Хаана:** `src/person.ts`, README §3b, `test/share.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`.
