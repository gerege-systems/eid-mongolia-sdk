### README / JSDoc шинэчлэл (кодын зан өөрчлөгдөөгүй)

- §1 RP бүртгэл: нийтийн `POST /v3/rp-applications` засвартай (503) — оператор (eIDsupport@gerege.com, 7777-3773).
- §1a OIDC: товч = браузерт энгийн холбоос, `code` → `id_token` = backend; eID одоогоор зөвхөн confidential client
  (`client_secret_basic`). Товчны жишээ: «eID Mongolia-аар нэвтрэх» + лого, саармаг (цагаан, хүрээтэй) загвар.
- §4: legacy device-link 2026-10-07-нд серверээс хасагдсан (`DEVICE_LINK_REQUIRED`) — шилжилтийн хуучирсан тэмдэглэл
  солигдсон; `callbackUrl` жишээний зам `/auth/eid/callback` (сервер нормчилдог). Үсгийн алдаа «таьна».
- JSDoc: `deviceLink`, `openOrShowQR` (`@deprecated`), `ValidateAuthOptions.expectedFlowType`, `initialCallbackUrl`-ийн
  legacy шилжилтийн тайлбар.
- Шалгасан: `npm run lint`, `npm test`.
