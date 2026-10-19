### Security — PRECHECKS #2b: ObjStm мөчлөг, `/Size`, `%%EOF`-гүй баримтын квадрат хайлт (0.21.0)

- **Юу:** задлахын өмнөх бүтцийн шалгалт (`prepare` / `validatePdf` — `PDF_INVALID`, `complete` — `STATE_INVALID`) нь Go SDK
  (chore/sdk-low-cleanup, `objstm.go`)-тэй ижил дүрмээр татгалзана: ObjStm доторх объектын агуулагч stream нь өөрөө
  ObjStm-д (өөрийгөө / харилцан агуулах); ObjStm-ийн толгойн лавлагаа (`/Length` г.м.) ObjStm доторх объект руу;
  `/Extends` мөчлөг / > 64; trailer эсвэл xref stream-ийн `/Size` > 2 097 152 (өмнө нь TS 2^24 хүртэл хүлээн авч
  хүснэгт хуваарилдаг байв). Уншигчийн `%%EOF` хайлт (digitorus-ийн 200 байтын өсөх цонх) O(n²) байсныг ижил үр дүнтэй
  шугаман болгосон — `%%EOF`-гүй 110 KB баримт 3 с, 10 MiB нь хөтчийг цагаар гацаадаг байв (одоо ~0.3 с).
- **Яагаад:** Go `FuzzValidatePDF`-ийн олсон DoS ангилал; TS-д ObjStm мөчлөг JS stack-ийн `RangeError`-оор санамсаргүй
  `PDF_INVALID` болдог байсныг тодорхой дүрэм болгож Go-той тааруулав. `%%EOF`-ийн квадрат хайлтыг TS mutation fuzz олсон.
- **Хаана:** `src/pades/pdf/nesting.ts` (`checkObjStmGraph`, `/Size`), `src/pades/pdf/reader.ts` (`findStartXref`);
  `test/pades-objstm.test.ts` (Go `TestCheckStructureObjStmGraph`-ийн оролтууд + fuzz crash seed
  `test/fixtures/pades/fuzz/objstm-cycle-c8b2f6dc9d5d37bf.pdf`), `test/validate-fuzz.test.ts` (детерминист mutation fuzz,
  `EID_FUZZ_ITER`).
- **Шалгасан:** `npm test` (258), fuzz 1500 давталт цэвэр; хуучин/шинэ `%%EOF` хайлтын differential (200 000 санамсаргүй
  оролт, зөрүү 0); validate golden 42/42 Go-той ижил (хөтөчид offline 39/39).
