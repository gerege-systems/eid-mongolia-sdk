- **0.16.0 (BREAKING): `@deprecated` legacy device-link туслахууд хасагдсан.**
  - Юу: `deviceLink`, `openOrShowQR` функц ба `DeviceLinkInput`, `OpenOrShowQROptions` төрлийг `.` болон `/browser`
    entry-ээс хассан. `isMobileUserAgent` / `NavigatorLike` (товч ашигладаг) хэвээр.
  - Яагаад: статик `{deviceLinkBase}?sessionId=…&vc=…` холбоосыг сервер 2026-10-07-нд хассан (`DEVICE_LINK_REQUIRED`) —
    эдгээр туслахаар нээгдсэн session ажиллахгүй. Шилжилтийн хугацаа үлдээхгүй; ямар ч RP хуучин API ашиглахгүй.
  - Шилжих: backend-д `buildDeviceLink` (v3, `deviceLinkInput` / `qrDeviceLinkTicker`), утсан дээр Web2App холбоосыг
    энгийн `<a href>`-ээр.
  - Хаана: `src/devicelink.ts`, `src/index.ts`, `src/browser.ts`, `test/sdk.test.ts`, README.
- Шалгасан: lint, test (browser entry-д `deviceLink`/`openOrShowQR` байхгүйг шалгах тест), test:contract.
