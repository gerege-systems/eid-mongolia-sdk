# Changelog
## 0.4.1 — 2026-09-29

- Баримтын холбоос: README ба `package.json` `homepage` → `https://developer.eidmongolia.mn/` (`#burtgel` хэвээр).
  `https://eidmongolia.mn/developers` хаагдана (404 болно). Кодын өөрчлөлтгүй.

## 0.4.0 — 2026-09-29

- Ижил төхөөрөмж (App2App / Web2App): `deviceLink(session)` → `${deviceLinkBase}?sessionId=<uuid>&vc=<5 орон>`
  (CA-ийн `/dl` гэрээ); `deviceLinkBase` байхгүй эсвэл sessionId/vc буруу бол `DeviceLinkError` (холбоос таахгүй).
- Браузерт: `openOrShowQR(session, { showQR, isMobile? })` — гар утсанд `location.assign(link)`, бусад үед `showQR(link)`;
  `isMobileUserAgent()` (Android/iOS, desktop UA-тай iPadOS, UA-CH). Шинэ `@gerege-systems/eid-mongolia-sdk/browser`
  entry — `node:*` импортгүй.
- `DeviceLinkSession.vc` — device-link хариуны 5 оронтой код (өмнө нь задлагддаггүй байв).

## 0.3.0 — 2026-09-28

- **Breaking:** RP-API нь `https://rp.eidmongolia.mn`-д `/v3`-гүй (CA ca !102). `baseUrl` одоо бүтэн суурь бөгөөд SDK `/v3`
  залгахаа больсон; заавал биш — анхдагч `DEFAULT_BASE_URL` = `https://rp.eidmongolia.mn`. Хуучин `https://ca.eidmongolia.mn`
  (эсвэл `e-id.mn`) өгвөл тодорхой алдаа шиднэ (ca. дээр RP-API /v3-гүй байхгүй — чимээгүй 404-өөс сэргийлнэ).
  Шилжилт: `baseUrl`-ийг хасах эсвэл `https://rp.eidmongolia.mn` болгох. Шилжилтийн хугацаанд `https://rp.eidmongolia.mn/v3` ч ажиллана.
- `resolveBaseUrl`, `DEFAULT_BASE_URL` export.

## 0.2.0 — 2026-09-28

- `RpCredentials.rpName` — ≤120 тэмдэгт (CA сервер таслана; өмнө «≤32 байт» гэж бичсэн нь Smart-ID-ийн хуучин хязгаар).
  Дэд системийн нэр гэдгийг тайлбарлав; README жишээ. Код өөрчлөгдөөгүй.

## 0.1.0 — 2026-09-27

- Анхны нийтийн хувилбар: `@gerege-systems/eid-mongolia-sdk` (өмнө нь ca-eidmongolia-mn репогийн `sdk/typescript`, нийтлэгдээгүй `@eid-mongolia/sdk`).
- `CertificateLevel`-д `QSCD` нэмэгдсэн; `requiredLevel: "QUALIFIED"` үед QSCD гэрчилгээг хүлээн авна.
- README: `validateAuth(result, session.acsp)` (rpChallenge биш), ACSP_V2-ийн бодит payload, trust anchor = Mongolian National Root CA, бүртгэл `POST /v3/rp-applications`.
- Node.js ≥ 22 (`node --test --experimental-strip-types`).
