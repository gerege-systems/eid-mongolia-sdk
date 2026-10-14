- **PAdES: харагдах гарын үсэг (сонголттой) + golden v3.**
  - Юу: `PadesPrepareOptions.appearance` (`page`, `x`, `y`, `width`, `height`, `lang`) — сонгосон хуудсан дээр `/Rect`-тэй
    widget (`/F 4`, `/P`, `/Annots`-ийн төгсгөлд), `/AP /N` шахалтгүй form XObject (verify хуудасны Noto Sans фонт, өөрийн
    QR `https://ca.eidmongolia.mn/verify/<docID>/<revIndex>`, нэр/үүрэг/label/огноо, `/Rotate` 0/90/180/270-ийг content
    `cm`-ээр). Байхгүй бол үл харагдах — golden v2-тэй байт-ижил.
  - Яагаад: Go reference (`eid-mongolia-sdk-go` 55bcb0a, `pades/APPEARANCE_SPEC.md`)-тэй native SDK бүр байт-ижил.
  - Хаана: `src/pades/page/appearance.ts` (шинэ), `src/pades/pdf/signature.ts`, `src/pades/page/page.ts` (`fontBodies`,
    `wrapLimit`, `glyphHex` — verify хуудасны байт өөрчлөгдөөгүй), `src/pades.ts` (`PadesAppearance`, шалгалт, `visibleSpec`),
    `scripts/sync-pades-golden.mjs` → tag `pades-golden-v3`, README.
- Шалгасан: golden v3-ийн бүх 17 кейс (15 амжилттай + 2 алдааны) (харагдах 5: `quartz-pdf13-visible`, `-visible-en`, `-visible-second`,
  `-visible-twice`, `quartz-rotated90-visible`) — digest/DTBS/signedAttrs/prepared/output sha256 байт-ижил; appearance-ийн
  REQUEST_INVALID кейсүүд (Go `TestAppearanceRejects`-тэй ижил + docId-гүй гарын үсэгтэй баримт); lint, test, golden:check,
  size:pades (gzip 126.8 KB), test:compat.
