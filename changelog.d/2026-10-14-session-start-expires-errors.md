- **0.14.2 — CA !357 (fd3acf14, прод 2026-10-14)-тэй нийцүүлэв.**
  - `expiresAt`: session start хариуны CA-ийн `expiresAt` (RFC 3339)-ийг авна — sign / certificate-choice (push,
    device-link, linked) ба auth (push, device-link). Талбаргүй (хуучин CA) үед sign/cert-choice-д өмнөх тооцоолол
    (`signSessionTtlMs`), auth-д undefined. `startExpiry`, `parseExpiresAt` export.
  - Typed алдаа (`ApiError`-ийн дэд анги — хуучин `instanceof ApiError` хэвээр): `NoSigningCertificateError` (409
    `NO_SIGNING_CERTIFICATE`), `CertChoiceInvalidError` (409 `CERT_CHOICE_INVALID`), `RequestInvalidError` (400
    `REQUEST_INVALID`).
- Хаана: `src/types.ts`, `src/sign.ts`, `src/auth.ts`, `src/errors.ts`, `src/http.ts`, `src/index.ts`, `README.md`.
- Шалгасан: `test/session-start.test.ts` (CA expiresAt / fallback / typed алдаа); `npm run lint`, `npm test`.
