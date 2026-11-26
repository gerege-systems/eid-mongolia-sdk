### Security — cross-SDK hardening (behaviour changes; conformance corpus `rp-conformance/2`)

Independent reviews of the .NET (0.17.0) and Java (0.2.0) ports found gaps that were identical in every SDK. They are
closed here together with the Go reference SDK (PR gerege-systems/eid-mongolia-sdk-go 75); the vendored corpus is
`rp-conformance/2` (`test/fixtures/conformance/README.md` §Changes).

- **`ResponseValidator`** (`validateAuth`, `validateSign`, `validateCertificateChoice`, token auth, My QR):
  - a citizen certificate with a weak RSA key — modulus < 2048 bits, or public exponent even or < 3 — throws
    `ValidationError` («Гэрчилгээний RSA түлхүүр сул…», corpus key `cert.weak_key`); the constructor throws when a trust
    anchor or intermediate has such a key;
  - a subject with more than one SERIALNUMBER or more than one CN is rejected (`subject.duplicate_identity`; My QR:
    `QR_CHAIN_INVALID`) — the TS parser took the first value, Go the last;
  - issuer allowlist (`allowedIssuerSkis`, default `CITIZEN_ISSUING_CA_SKI`): when the issuer is found in the trust
    pool only ITS key identifier counts — the SKI, or the RFC 5280 method-1 identifier when the CA has no SKI extension.
    A leaf under an SKI-less CA could previously name the allowed CA in its own AKI and pass. The leaf AKI is used only
    when no issuer is found (`allowUntrusted`);
  - chain signatures with SHA-1 or MD5 (and any algorithm outside SHA-256/384/512 RSA / RSA-PSS / ECDSA, Ed25519) no
    longer verify (`chain.untrusted`) — Go already behaved this way;
  - an unknown `requiredLevel` throws in the constructor (it was treated as QUALIFIED).
- **`ocspRevocationChecker`**: the given issuer must have issued the certificate (name, AKI/SKI, signature, CA, RSA
  ≥ 2048) before any cache lookup or network call — else `"unknown"`; a response whose CertID
  (issuerNameHash/issuerKeyHash, SHA-1/256/384/512) belongs to another issuer, or whose delegated responder has a weak
  RSA key, is not accepted.
- **RP-API paths** (`routePath`, every service incl. seal registration): an empty, `.` or `..` path parameter throws
  before any request.
- **`createEidLogin`**:
  - the default login cookie name is `__Host-eid_login` when the cookie is secure, has no domain and path is `/`
    (otherwise `eid_login`; an explicit `cookie.name` is kept). **Logins in flight during the upgrade restart once.**
    A request with more than one cookie of that name is treated as unbound (status `EXPIRED`, callback
    `eid_error=expired`). The browser component (`button`) is unaffected — the cookie is HttpOnly;
  - rate-limit keys never contain the citizen's id: `push:<pushKey>` (the audit HMAC) in the built-in limiter and in
    `rateLimit` functions — **a custom limiter that parsed `push:<idCode>` must be updated**;
  - with `trustProxy` or `getClientIp` configured, a request without a client IP shares the `start:unknown` bucket
    instead of skipping the limit; IPv6 clients are keyed by their /64 prefix; with no IP source at all the start limit
    is off and `onError` warns once (also for `handleRequest`);
  - the in-memory limiter, when its table is full, counts new keys in one shared overflow bucket instead of refusing
    them (existing counters are never evicted); new rule option `maxKeys` (default 10 000).
- Where: `src/validator.ts`, `src/myqr.ts`, `src/ocsp.ts`, `src/contract.ts`, `src/login.ts`; tests
  `test/conformance.test.ts` (v2 harness: reason keys, cookie/IP/limiter config), `test/hardening.test.ts`; corpus pin
  `scripts/sync-rp-conformance.mjs`.
