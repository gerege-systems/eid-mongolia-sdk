### Feat — certificate-choice device-link: linked signing буцах URL

- **Юу:** `CertChoiceOptions.callbackUrl` — `certificateChoiceDeviceLink()` нь `initialCallbackUrl` илгээнэ (trim, хоосон бол илгээхгүй), түүхий утгыг `DeviceLinkSession.initialCallbackUrl`-д хадгалж `deviceLinkInput` cert session-д дамжуулна → Web2App/App2App холбоос угсарна (QR authCode өөрчлөгдөхгүй). Шинэ `sessionSecretDigest(sessionSecret)` ба `verifySessionSecretDigest(digest, sessionSecret)` (timing-safe, буруу оролтод `false`). `certificateChoiceByEtsi` callback илгээхгүй.
- **Яагаад:** Smart-ID v3 linked signing — утсан дээр нэг session-оор cert-choice → linked SIGN → callback урсгал. CA (`POST /signature/certificate-choice/device-link/anonymous`) `initialCallbackUrl`-ийг RP-ийн callback_hosts жагсаалтаар шалгана; жагсаалтад байхгүй бол QR-only.
- **Хаана:** `src/sign.ts`, `src/devicelinkv3.ts`, `src/types.ts`, `src/crypto.ts`, `src/index.ts`, `README.md` (§3.1), `test/sign-gaps.test.ts`.
- **Шалгасан:** GitHub Actions CI (локалд ажиллуулаагүй); `sessionSecretDigest` тест вектор.
