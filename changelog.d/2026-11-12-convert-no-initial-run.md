### Fixed — `/convert`: эхний Word→PDF хувиргалт ~1 минут удааширдаг байсан (LibreOffice-ийн `main()`-ийг эхлүүлэхгүй)

- **Юу (хэрэглэгчид нөлөөлөх засвар):** `eid-mongolia-convert-assets` нь `@matbee/libreoffice-converter@2.7.2`-ийн
  `soffice.js`-д `var shouldRunNow=true;…`-ийг `false` болгоно (`MAIN_PATCH` — `Module.noInitialRun = true`-тай ижил:
  Emscripten LibreOffice-ийн C `main()`-ийг дуудахгүй). `POOL_PATCH` (pool 8)-тай нэг файл, нэг sha256; солилт тус бүр яг
  нэг удаа таарахгүй бол хуулалт exit 1-ээр унана. `manifest.json`-д `"noInitialRun": true`; хавтасны нэр
  (`2.7.2-<soffice.js hash>/`) ба `rev` солигдоно. Зөвхөн JS — `soffice.wasm` / `.data`-ийн агуулга хэвээр (шинэ хавтсаас
  хэрэглэгч нэг удаа дахин татна).
- **Яагаад:** upstream glue `main()`-ийг pthread дээр эхлүүлж, тэр нь LibreOfficeKit-ийн init-тэй нэг түгжээний төлөө
  уралддаг. 0.21.0-ийн pool 8 гацалтыг (deadlock) арилгасан ч удаашрал үлдсэн: хүйтэн асаалтын ихэнхэд эхний хувиргалт
  (CPU хомс үед init) ~65–80 с болдог. `main()` (splash, AutoRecovery, event loop) толгойгүй хувиргалтад хэрэггүй — LOK
  өөрөө бүрэн init хийдэг. Pool 8 хэвээр: `main()`-гүй ч pool 4 нь ≤ 2 цөмд хадгалах үед гацдаг (хэмжсэн). Upstream:
  https://github.com/matbeedotcom/libreoffice-document-converter/issues/19 (PR #20 pool, PR #21 noInitialRun) — хоёулаа
  орсон release гармагц `POOL_PATCH`, `MAIN_PATCH` хоёрыг хасаж sha256-уудыг дахин бэхэлнэ.
- **Хаана:** `bin/convert-assets.mjs` (`MAIN_PATCH`, `patchGlue`), `test/convert.test.ts`, README §3e.
- **Шалгасан:** 8 vCPU Xeon Gold 6138 VM, headless Chromium (Playwright 1.63), хүйтэн асаалт бүрд шинэ хөтөч,
  `test/fixtures/convert/sample.docx`, энэ скриптийн гаралт + `wordToPdf`, өмнөх (main) ба шинэ asset ээлжлэн, 150 с
  watchdog. Хязгааргүй: өмнө 5-аас 4 нь удааширсан (init + хувиргалт ~65 с, documentLoad ~63 с), шинэ 5/5 хэвийн
  (3.4–3.9 с). 1 CPU (cgroup quota): өмнө 5/5 удааширсан (~75 с, init ~68 с), шинэ 5/5 хэвийн (~13 с). Гацалт 0.
  Гарсан 21 PDF: хуудас, хэмжээ, фонт, текст + байрлал, растер (pdf.js) бүгд ижил. Мөн upstream asset дээр
  (`WorkerBrowserConverter`, 10 асаалт): pool 8 + `main()` — 7 нь ~80 с, pool 8 + `main()`-гүй — 10/10 ~4 с.
  `npm run lint`, `npm test` (343 тест, 0 унасан), CI `convert-e2e` (Chromium, WebKit).
- **Шинэчлэх:** RP-үүд SDK шинэчилсний дараа `eid-mongolia-convert-assets <хавтас>`-ийг дахин ажиллуулна (build-д аль
  хэдийн байгаа бол дахин build хийхэд хангалттай).
