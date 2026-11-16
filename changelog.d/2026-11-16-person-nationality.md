### Added — `person.nationality` (session) ба `PersonSummary.nationality`

- **Юу:** `PersonBlock.nationality?: string` (`parseSessionResult` / `session.poll`-ийн `person`) ба
  `PersonSummary.nationality?: string` (`person.summary`). Иргэний харьяалал — гурван том латин үсэг (ISO 3166-1
  alpha-3, ICAO 9303; `MNG`, `USA`, `DEU`; `XXA` мэт тусгай код тохиолдож болно). Гэрчилгээний `country`-той ӨӨР.
  Мэдэгдэхгүй бол талбар алга. SDK утгыг шалгахгүй, хувиргахгүй — бусад string талбартай адил (хоосон / string биш
  утгыг `person` блок орхино).
- **Яагаад:** CA `GET /v3/session/{sessionID}` (`person.nationality`) ба `GET /v3/person/summary/etsi/{personEtsi}`
  (`nationality`)-ийн хариунд нэмэлт, заавал биш талбар нэмсэн; өмнө нь `PERSON_STRINGS`-ийн жагсаалтаас болж session-ий
  typed үр дүнд орохгүй, `PersonSummary`-д төрөлгүй (зөвхөн `raw`-аар) байсан. Нэмэлт өөрчлөлт — эвдэрхий өөрчлөлтгүй.
- **Хаана:** `src/session.ts` (`PERSON_STRINGS`), `src/types.ts` (`PersonBlock`), `src/person.ts` (`PersonSummary`);
  тест `test/portal-gaps.test.ts` (байвал / алга / string биш); README §person блок.
- **Шалгасан:** GitHub Actions CI — локалд ажиллуулаагүй.
