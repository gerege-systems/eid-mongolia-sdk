### /pades: харагдах дүрслэл хуудасны агуулгаас зайлна (PLACEMENT_SPEC.md, golden v5)

- **Юу.** `appearance.x/y` нь хүссэн байрлал болов: widget бичихээс өмнө хуудсыг (content stream-ийн бичвэр, зураас,
  зураг, form XObject, inline зураг, annotation `/Rect`; рендергүй, фонт файлгүй) уншиж, хүссэн тэгш өнцөгт (+4 pt)
  ямар нэг зүйлтэй давхцвал эхний чөлөөт байрлал руу шилжүүлнэ: толин тусгал багана ижил өндөрт (баруун доод → зүүн доод),
  дараа нь хүссэн багана 12 pt-ээр дээш, дараа нь толин багана дээш. Чөлөөт зай алга → хүссэн газраа. Шинэ
  `PadesPrepared.placement` (`page, x, y, width, height, status`: `requested | moved | overlap | unscanned`) — Go
  `Prepared.Placement`-тэй ижил.
- **Яагаад.** Прод 2026-10-19 — LibreOffice-оор хөрвүүлсэн Word гэрээний сүүлийн хуудасны footer-ийг дүрслэл дарсан.
- **Хаана.** `src/pades/page/occupancy.ts` (scanner + candidate, Go `occupancy.go`/`placement.go`-ийн 1:1 порт),
  `src/pades/pdf/signature.ts`, `src/pades.ts` (`PadesPlacement`), `src/pades/pdf/inflate.ts`
  (`zlibInflateStrict` — Go compress/zlib шиг header (FDICT нь зөвхөн DICTID 1) + Huffman бүрэн байдал + Adler-32; `adler32`-ийг validate-тэй
  хуваалцана). Golden pin Go `4e87dc1` (#34: #33 + PLACEMENT_SPEC port traps, 29 vector), sync-д `placement/` нэмэгдсэн.
- **Шалгасан.** `placement/vectors.json`-ийн 21 оролт хайрцаг бүрээр ижил; golden v5-ийн 6 шинэ тохиолдол
  (`libreoffice-contract-visible`, `…-second`, `table-bottom-visible`, `rotated90-footer-visible`,
  `quartz-pdf13-visible-third`, `full-page-visible`) prepare + complete байт-ижил (`output/*.pdf`-тэй тулгасан), хуучин
  бүх golden өөрчлөгдөөгүй, харагдах тохиолдол бүрд `expect.placement`. Fuzz маягийн тест
  (`test/pades-placement.test.ts`): санамсаргүй/эвдэрсэн content 4500 удаа — «unscanned»-аас өөр алдаа гарахгүй, §5-ын
  хязгаар бүр хил дээрээ шалгагдсан; Go reference-ээр гаргасан cross-check: тасархай/буруу Adler-32, FDICT, нэг объект доторх
  шууд фонтуудын cache, хэт том /FirstChar · /W (saturating int). `npm run lint`, `npm test`, `test:contract`, `golden:check`, `test-compat`.
