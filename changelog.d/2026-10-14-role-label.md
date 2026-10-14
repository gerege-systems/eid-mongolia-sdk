- **`roleLabel`** (CA !339, additive) — `Representation.roleLabel?: string` (`getRepresentations`) ба session-ий
  `OrgResult.roleLabel?: string` (`onBehalfOf`): албан тушаалын хүнд харуулах нэр, CA нэг газраас (`server/internal/orgrole`,
  CA `docs/ORG_LOGIN.md` §4а) өгнө. `role` нь машин утга (`ceo` / `founder` / `stakeholder` эсвэл MANUAL текст) —
  клиент өөрөө орчуулахгүй, `roleLabel`-ийг харуулна. Хуучин CA-д талбар байхгүй (`undefined`).
- **`ClientConfig.language`** — дуудлага бүрд `Accept-Language` (`"mn"` | `"en"`); анхдагч илгээхгүй (сервер mn).
- Шалгасан: `test/portal-gaps.test.ts` — representations / session `onBehalfOf`-ийн `roleLabel` decode, хуучин хариунд
  байхгүй; `language` → `Accept-Language`, анхдагч/хоосон үед header алга. `npm run lint`, `npm test`, `npm run test:contract` (live).
