### Fixed

- `ResponseValidator.validateAuth` / `validateSign` / `validateCertificateChoice` (and token auth verification): a
  session result whose `cert.value` is not an X.509 certificate now throws `ValidationError` («Гэрчилгээ
  задарсангүй») instead of the raw `node:crypto` error. Effect: `createEidLogin` answers such a COMPLETE/OK result with
  `FAILED` / `VALIDATION` (event `unverified`) instead of HTTP 500 `internal` — the same as the Go SDK. Found by the
  shared conformance corpus (`rp-validate` case `auth-certificate-garbage`, `eidlogin` scenario
  `qr-complete-ok-unverifiable`).

### Added (tests)

- RP SDK conformance corpus `rp-conformance/1` vendored from the Go reference (`test/fixtures/conformance/`, pinned
  commit in `scripts/sync-rp-conformance.mjs`; `npm run conformance:check` / CI step «rp conformance ↔ Go reference»
  fails when the copy differs). `test/conformance.test.ts` runs the whole corpus against the TS SDK: response
  validator (auth / sign / certificate-choice, fail-closed chain rule), RP-API request/response vectors,
  interactions encoding, ACSP_V2, OCSP checker scenarios, `createEidLogin` protocol scenarios, manifest hashes and the
  devicelink/myqr pins. Verified: `npm ci && npm test` on the macmini; CI on the PR.
