### /convert: LibreOffice-ийн консол лог анхдагчаар чимээгүй (`verbose`)

- **Юу/яагаад:** Word → PDF хувиргалт бүрд хөтчийн консолд ~28 улаан мөр («warn:vcl…», «[LOK C++] lok_documentLoad…»)
  ба ~1300 `[FS OPEN CALL]`/`[Worker]` мөр гардаг байв — алдаа биш ч хэрэглэгч алдаа гэж ойлгодог. Шалтгаан:
  `@matbee/libreoffice-converter@2.7.2` `dist/browser.worker.global.js` нь Emscripten `print`/`printErr`-ийг үргэлж
  `console.log`/`console.error` руу, `SAL_LOG="+ALL"`, олон `console.log`-тэй; worker замд verbose сонголтгүй. 2.7.2 нь
  npm-ийн хамгийн сүүлийн хувилбар (2026-10-16) тул upstream шинэчлэлээр засах боломжгүй.
- **Хаана:** `bin/convert-assets.mjs` — upstream worker-ийн sha256 мэдэгдэж буй утгатай таарвал л `print`/`printErr`-ийг
  `self.EID_CONVERT_VERBOSE`-ээр нөхцөлдүүлж, `"+ALL"`-ийг `"-WARN-INFO"` болгоно (таарахгүй бол patch-гүй хуулж
  анхааруулна, exit 0). `manifest.json`-д `rev` (worker скриптүүдийн hash) ба `patched`. `bin/eid-convert.worker.js` —
  `?verbose=1`-гүй бол `console.log/info/debug` no-op (error/warn үлдэнэ), `?v=<rev>`-ийг upstream worker-т дамжуулна.
  `src/convert.ts` — `WordToPdfOptions.verbose`; worker URL `?cache=…&v=<rev>[&verbose=1]`; verbose солигдвол worker дахин асна.
  `SAL_LOG`-ийг энд бичих нь LibreOffice-д хүрдэггүй (soffice.js preRun-ийн "+WARN" үйлчилнэ) — хэмжсэн; чимээгүй
  болгох нь `printErr`-ээр.
- **Шалгасан:** `npm test` (172 → 176: patch-тай файлд «+ALL» үгүй, manifest хэмжээ = patch-тай файл, hash таарахгүй
  → fallback + анхааруулга, worker wrapper verbose/quiet, URL-ийн rev/verbose); `npm run test:convert-e2e` (Chromium):
  verbose-гүй хувиргагчийн консол лог 0, `verbose: true` — 1354 мөр, .docx/.doc → PDF → `prepare` хэвээр.
- **RP-д:** SDK шинэчилсний дараа `npx eid-mongolia-convert-assets <хавтас>`-ийг дахин ажиллуул (build-д аль хэдийн бол
  автомат). Хуучин asset-тай шинэ SDK ажиллана — лог л гарсаар.
