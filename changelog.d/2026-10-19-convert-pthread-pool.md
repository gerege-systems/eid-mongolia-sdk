### Fixed — `/convert`: удаан CPU-тай компьютер дээр Word→PDF хөрвүүлэлт гацаж болзошгүй байсан (0.21.0)

- **Юу (хэрэглэгчид нөлөөлөх засвар):** `eid-mongolia-convert-assets` нь `@matbee/libreoffice-converter@2.7.2`-ийн
  `soffice.js`-д хатуу заасан `var pthreadPoolSize=4;`-ийг `8` болгоно (upstream файлын sha256-ийг тулгана; таарахгүй бол
  хуулалт exit 1-ээр унана — patch-гүй asset гацаж болзошгүй). `manifest.json`-д `"pthreadPoolSize": 8`; `rev` солигдож
  worker/JS-ийн immutable кэш шинэчлэгдэнэ. Зөвхөн JS — `soffice.wasm`/`.data` хөндөгдөхгүй, дахин татагдахгүй.
- **Яагаад:** 4 thread-ийн pool-д удаан CPU дээр (CI runner — ~4.5× удаан) documentLoad 9/9 удаа гацдаг: LibreOffice-ийн
  pthread-ийн MEMFS syscall LO worker руу sync proxy хийдэг, worker нь documentLoad-д pthread хүлээж хаагдсан (бүх thread
  futex_wait). Туршилт: pool 4 гацна, 5/6/8 ажиллана. CI-ийн `convert-e2e` санамсаргүй 10 минутын timeout-ийн шалтгаан.
- **Хаана:** `bin/convert-assets.mjs` (`POOL_PATCH`), `test/convert.test.ts`, README §3e.
- **Шалгасан:** `test/convert.test.ts` (patch хэрэглэгдсэн — хуулсан `soffice.js`-д `=8`, upstream-аас зөвхөн тэр солилт;
  manifest хэмжээ/`pthreadPoolSize`; hash таарахгүй → exit 1), `convert-e2e` Chromium + WebKit (локал).
- **Шинэчлэх:** RP-үүд SDK шинэчилсний дараа `eid-mongolia-convert-assets <хавтас>`-ийг дахин ажиллуулна.
