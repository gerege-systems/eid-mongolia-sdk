### Changed — `createEidLogin`: хугацаа CA-ийн session-оос урт байхгүй; `auth.sessionTtl()` (discovery `sessionTtl`)

- **Юу:** `client.auth.sessionTtl()` — discovery `/.well-known/eid`-ийн `sessionTtl` (`{ authMs, signMs }`; хуучин CA-д 0).
  `createEidLogin`: start-ийн `expiresIn`, cookie `Max-Age`, store-ийн хугацаа = QR/Web2App-д min(`ttlMs`, CA-ийн
  `expiresAt` − одоо); push-д (бодит ба decoy ижил) min(`ttlMs`, discovery `sessionTtl.auth`, 10 мин кэш). Хуучин CA-д
  бодит push-ийн `expiresAt`-аас ажигласан утгыг decoy авна. `ttlMs` анхдагч (120 000) хэвээр.
- **Яагаад:** RP `ttlMs`-ийг CA-ийнхаас урт тохируулбал иргэн CA дууссан session-ийг хүлээж үлддэг; decoy-д CA хариу
  байхгүй тул CA-ийн `expiresAt`-аар таслах нь бодит/decoy push-ийн хугацааг ялгаж (бүртгэлтэй эсэхийн oracle) болох байв.
  Go `eidlogin`-тэй ижил.
- **Хаана:** `src/auth.ts` (`sessionTtl`, `SessionTtl`), `src/login.ts`, `src/index.ts`, README (eid-login §хугацаа,
  `expiresAt`), `test/login.test.ts` (3 шинэ тест; fake discovery).
- **Шалгасан:** `npm run lint`, `npm test` (261 pass).
- **Үлдсэн:** CA discovery-д `sessionTtl` (CA MR) deploy болтол push нь ажигласан утгаар (±1 с) ажиллана.
