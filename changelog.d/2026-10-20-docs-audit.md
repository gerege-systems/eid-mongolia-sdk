### Docs — README/JSDoc ↔ код ↔ CA аудит (зөвхөн баримт)

**Юу.** README-ийн жишээ, хязгаар, алдааны код болон JSDoc-ийг 0.26.0-ийн код, CA (`origin/main`) ба амьд
`/.well-known/eid`, `/mobile/app-config`-той тулгаж зөрүүг засав. Кодын зан өөрчлөгдөөгүй.

- Share квот: цагт 300 / өдөрт 3000 (өмнө 30/200 гэж буруу); 415 нь задрахгүй/шифрлэгдсэн PDF-д ч; `SHARE_DISABLED`
  туг CA-д байхгүй — `enabled=false` → 503 `MAIL_UNAVAILABLE`/`VALIDATOR_UNAVAILABLE` (`share.ts`, `client.ts`).
- Жишээнүүд strict TS-д хөрвөнө: дутуу import (`NATIONAL_ROOT_CA_PEM`, `registrationFromCompleted`, `prepare`,
  `writeFileSync`), `s.acsp!`, `Map.groupBy` (Node ≥ 21) → Node 18-д ажиллах хэлбэр, `import { Redis } from "ioredis"`,
  §3d браузер/backend блокийг салгаж `signerCert`-ийг DER болгон задлав, байхгүй `buildDtbs`-ийг placeholder болгов.
- `waitForResult` анхдагч 150 с (CA auth TTL 300 с) гэж жишээнд тэмдэглэв; `rpName` ≤ 120 **байт** (CA байтаар таслана).
- superseded гэрчилгээнд `revokedAt` ирнэ; аппын доод хувилбар iOS ≥ 2.2.8 / Android ≥ 91 (10-20); QR ~1–2 с.
- `/pades` bundle ~136 KB gzip; шалгагч `/validate`-д байгаа (README «Go-д л» гэсэн нь хуучирсан); `INTERNAL` зөвхөн TS;
  `pdfTimeoutMs` 0.19.0-д буцаж нэмэгдсэн; `ValidatePdfError` `REQUEST_INVALID`; `INPUT_TOO_LARGE` хоосон файлд ч.
- JSDoc: `DeviceLinkError`, `CertChoiceInvalidError` (өөр RP → 404), `TokenConflictCode` (бусад 409), `signSessionTtlMs`
  (`expiresAt` ирдэг), `DeviceLinkSession.vc`, `pushFloorMs`, validator trust anchor, `EID_ACSP_SCHEME_NAME`, OCSP кэшийн Go ялгаа.
- golden одоо v6; `npm run lint` хоёр tsconfig.

**Хэрхэн шалгасан.** README-ийн ```ts блок бүрийг dist-ийн эсрэг `tsc --strict` (NodeNext) — үлдсэн алдаа нь зөвхөн
хэрэглэгчийн stub (`api`, `store`, `@/lib/eid` г.м.); `npm run lint`, `npm test`.

**Үлдсэн (код — энэ PR-д биш).** `waitForResult` 150 с < CA sign TTL 600 с; `TokenConflictCode`-д `TOKEN_ISSUANCE_PENDING`
алга; OCSP «good» кэш `nextUpdate`-ийг үл тоодог; `fetch`-гүй орчинд `TSA_UNAVAILABLE` retryable. CHANGELOG.md-ийн
хуучин «`test-compat`» (→ `npm run test:compat`) нэрийг нэгтгэлийн үед засна.
