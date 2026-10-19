### /convert: soffice.data 99.7 → 43.2 MB, урьдчилж шахсан .br/.gz (эхний татал 77 → 41 MB)

- **Юу.** `eid-mongolia-convert-assets` нь `soffice.data`-аас Writer → PDF-д хэрэггүй файлуудыг хасна (ер бусын бичгийн
  фонт, Libertine/Biolinum, Calc/Impress/Draw/Math-ийн UI тохиргоо, `images_colibre.zip`, gallery, нүүр зураг):
  1904 → 961 файл, 99 735 918 → 43 164 000 байт. `soffice.js`-ийн file_packager хүснэгтийг (`loadPackage({files:[…]`,
  `remote_package_size`) POOL_PATCH-тай нэг файлд дахин бичнэ. NotoSans/NotoSerif (Ө Ү-ийн орлуулагч) ба бүх
  `registry/*.xcd` (math.xcd — OMML томьёо) үлдэнэ. Upstream 2.7.2-ийн `soffice.data` ба `soffice.js`-ийн sha256-аар
  хамгаалсан — таарахгүй бол build унана.
- Файл бүрийн хажууд `.br` (brotli 11) ба `.gz` (gzip 9) — nginx `brotli_static` / `gzip_static`. `manifest.json`-д
  `br` хэмжээ; `converterStatus().downloadBytes` нь brotli хэмжээ. `EID_CONVERT_BROTLI_QUALITY` (анхдагч 11; wasm-д
  ~4 мин M4 Pro).
- Asset-ийн хавтас `<хувилбар>/` → `<хувилбар>-<soffice.js hash>/`, Cache Storage-ийн нэр түүнээс: хуучин data + шинэ
  хүснэгт холилдохгүй (immutable кэш), хуучин кэш/хавтас устна.
- **Хэмжээ.** wasm 147.4 MB (gzip 48.5, br 33.8), data 43.2 MB (gzip 11.9, br 7.1); нийт br 41.0 MB, gzip 60.6 MB
  (өмнө нь gzip 77 MB).
- **Шалгасан.** sample.docx, sample.doc, бодит гэрээ, стресс docx — хасаагүй asset-тай PDF-ийн растер (150 dpi) байт-ижил,
  фонт ижил. `scripts/convert-e2e.mjs` (Chromium + WebKit): хүснэгт тасралтгүй / нийлбэр = remote_package_size / хассан
  нэр үлдээгүй / үлдсэн нь upstream-тэй байт-ижил, .br/.gz задлахад ижил, `test/fixtures/convert/rich.docx` → 2 хуудас,
  Ө ө Ү ү + Noto, томьёо (√, OpenSymbol); серверийг brotli_static/gzip_static шиг.
