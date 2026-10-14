- **`rightTypeLabel` / `sourceLabel`** (CA !344, additive) — `Representation.rightTypeLabel?: string`,
  `Representation.sourceLabel?: string` (`getRepresentations`) ба session-ий `OrgResult.rightTypeLabel?: string`
  (`onBehalfOf`; тэнд `source` байхгүй). Эрхийн төрөл (ADMIN → «Админ» / Administrator, MANAGER → «Гарын үсэг зурагч» /
  Signatory) ба эх үүсвэрийн (REGISTRY → «Улсын бүртгэл» / State registry, MANUAL → «Захирал нэмсэн» / Added by the
  director) хүнд харуулах нэр, CA нэг газраас (`orgrole.RightTypeLabel` / `SourceLabel`, CA `docs/ORG_LOGIN.md` §4а);
  хэл нь `roleLabel`-тэй ижил (`language` → `Accept-Language`). Клиент `rightType`/`source` кодыг өөрөө орчуулахгүй.
  Хуучин CA-д талбар байхгүй (`undefined`). README: «roleLabel / rightTypeLabel / sourceLabel». Go SDK 0.1.5-тай ижил.
- Шалгасан: `test/portal-gaps.test.ts` — representations / session `onBehalfOf` decode, хуучин хариунд байхгүй.
  `npm run lint`, `npm test`.
