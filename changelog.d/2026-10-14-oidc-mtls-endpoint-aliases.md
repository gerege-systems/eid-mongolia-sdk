- **OIDC: `mtls_endpoint_aliases` (RFC 8705 §5)** — 0.13.0. `login.` хост mTLS хийдэггүй тул `require_mtls`-тэй RP
  code солиход `login.eidmongolia.mn/oauth2/token` дээр `401 invalid_client` авдаг байв. CA !347 discovery-д
  `mtls_endpoint_aliases.token_endpoint` (`https://rp.eidmongolia.mn/oauth2/token`, RP client cert шаардана) нэмсэн.
  `EidOidcDiscovery.mtls_endpoint_aliases?: Record<string, string>`; `EidOidcClientConfig.useMtlsEndpointAliases`
  (анхдагч `false`) — `true` + alias байвал token хүсэлт alias руу; alias алга бол `token_endpoint` руу буцна; alias
  https биш бол `discovery_failed`. `EidOidcClientConfig.dispatcher` (undici `Agent`, RP-API client-ийнхтэй ижил) —
  OIDC-ийн бүх fetch-д. README: «mTLS-тэй RP». Хаана: `src/oidc.ts`, `test/oidc.test.ts`.
- Шалгасан: `test/oidc.test.ts` — флагтай → alias, флаггүй → `token_endpoint`, alias алга → fallback, `http://` alias →
  `discovery_failed` (token хүсэлт явахгүй), `dispatcher` fetch-д дамжина. `npm run lint`, `npm test`.
