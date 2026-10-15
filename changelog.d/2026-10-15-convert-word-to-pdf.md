- **Шинэ entry `@gerege-systems/eid-mongolia-sdk/convert` — Word (.docx / .doc) → PDF хөтөч дотор (0.17.0).**
  - Юу: `wordToPdf(file, { assetsBase, onProgress?, signal?, fileName? })` → `{ pdf, pages, warnings }`;
    `converterStatus({ assetsBase })` → `{ cached, downloadBytes }`; `isWordFile`, `disposeConverter`, `ConvertError`
    (`UNSUPPORTED_ENVIRONMENT`, `NOT_ISOLATED`, `UNSUPPORTED_FILE`, `INPUT_TOO_LARGE`, `ASSETS_UNAVAILABLE`, `CONVERT_FAILED`);
    `warnings[]` = `{ code, …, message }` (`FONT_SUBSTITUTED`, `FONT_FALLBACK`, `PDF_NEAR_LIMIT`, `PDF_TOO_LARGE` — `/pades`
    `prepare`-ийн хязгаартай). Bin `eid-mongolia-convert-assets <хавтас>` — asset-уудыг (manifest.json + `<хувилбар>/`,
    MPL NOTICE, SDK-ийн worker shim) RP-ийн build үед хуулна.
  - Яагаад: иргэн Word баримтад гарын үсэг зурах — файл сервер рүү очихгүй (/pades-ийн зарчим).
  - Хэрхэн: `@matbee/libreoffice-converter@2.7.2` (MPL-2.0, LibreOffice 24.8 WASM) — **optional peerDependency**, зөвхөн
    `/convert` dynamic import хийдэг (Node backend-ийн хэрэглэгчдэд 250 MB нэмэгдэхгүй; ESM-only, хөтчийн entry).
    Том asset (wasm 147 MB, data 100 MB) progress-той Cache Storage-д урьдчилж татагдана; worker (`eid-convert.worker.js`)
    тэднийг `fetch` shim-ээр кэшээс авна — blob URL биш (WebKit 147 MB blob-ийг worker-т уншдаггүй), HTTP кэш биш
    (Firefox 50 MB хязгаар). Нэг worker дахин ашиглагдана; `signal` → worker terminate (`AbortError`), дараагийнх нь кэшээс.
    crossOriginIsolated биш бол шууд `NOT_ISOLATED` (багцын 120 с timeout-ийг хүлээхгүй). Хуудас тоолох нь `/pades`-ийн PDF
    parser-аар (гаралт `prepare`-д уншигдахыг ч баталгаажуулна). Хуваалцсан хязгаар `src/pades/limits.ts` (код үйлдэл өөрчлөгдөөгүй).
  - Хаана: `src/convert.ts`, `bin/convert-assets.mjs`, `bin/eid-convert.worker.js`, `src/pades/limits.ts`, `package.json`
    (exports `./convert`, `bin`, peer), `tsconfig*.json`, `test/convert.test.ts` (хуурамч Worker + Cache Storage),
    `scripts/convert-e2e.mjs` + CI `convert-e2e` (Chromium, WebKit), `test/fixtures/convert/`, README §3e.
- Шалгасан: lint, test (162), test:compat, size:pades (126.8 KB), golden:check; `npm run test:convert-e2e` Chromium ба
  WebKit — хуудасны CSP nonce + `'strict-dynamic'`, worker CSP `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`
  (`'unsafe-eval'`-гүй бол EvalError), sample.docx/.doc → 3 хуудас PDF → `pades.prepare` OK, дахин ажиллуулахад wasm/data
  сүлжээнээс авахгүй, цуцлалт, COEP-гүй хуудас `NOT_ISOLATED`. Firefox шалгаагүй.
