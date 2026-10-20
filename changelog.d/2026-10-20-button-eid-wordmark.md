### Changed — `<eid-login-button>`: шинэ «e-ID» wordmark лого (inline SVG), `--eid-logo` токен

- **Юу:** товч болон QR цонхны толгойн хуучин 96×96 PNG лого (data URI) → шинэ «e-ID» wordmark, inline SVG (нэг path,
  гадны файл/сүлжээ үгүй). Өнгө — шинэ токен `--eid-logo` / `--eid-logo-dark` (анхдагч light `#1430FD`, dark `#fff`):
  outline товч (light цагаан / dark хар хөх дэвсгэр) хоёр theme-д тод. Хэмжээ: товчинд өндөр 16 px, `variant="icon"`-д
  12 px (44×44 дотор), цонхны толгойд 20 px. `part="icon"` хэвээр (одоо `<svg>`, өмнө нь `<img>`). API өөрчлөгдөөгүй.
- **Яагаад:** eID-ийн шинэ брэнд (developer.eidmongolia.mn лого, 2026-10-20). `dist/button.js` 61.2 → 51.2 KB.
- **Хаана:** `src/logo.ts`, `src/button.ts`, README (`icon`, токены хүснэгт), `test/button.test.ts`.
- **Шалгасан:** `npm run lint`, `npm test`, `size:pades`/`size:validate`; Playwright зураг (light/dark × default/en/icon/
  icon=none, цонхны толгой).
