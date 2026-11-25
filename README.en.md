[Монгол](README.md) · English · [中文](README.zh-CN.md)

# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia** (Mongolia's national electronic ID) Relying Party SDK — a Node.js/TypeScript library for
authenticating citizens with their phone and having them make legally valid electronic signatures (qualified signature).
RP-API v3, Smart-ID compatible. Full documentation: <https://developer.eidmongolia.mn/>.

> ⚠️ The SDK runs on the **backend**: every call is authenticated with the API secret (`rp_sk_…`), and the secret is
> never exposed to the browser or phone. The browser only sees the link/QR/button your backend provides — the
> "Log in with eID" button (`/button`) also only calls your backend (§1a). `@gerege-systems/eid-mongolia-sdk/browser` exports only
> `isMobileUserAgent` and the error classes (legacy `deviceLink`/`openOrShowQR` were removed in 0.16.0, §4). Exception: `@gerege-systems/eid-mongolia-sdk/pades` (client-side PDF
> signing, no secret) works in both browser and Node (§3d).

## Installation

```bash
npm install @gerege-systems/eid-mongolia-sdk
```

Node.js ≥ 18 (global `fetch`, `node:crypto`) — every entry (`.`, `/browser`, `/button`, `/pades`; `/convert` is browser-only, §3e), tested in CI on Node 18 / 20 / 22.
`/pades` also works in modern browsers (Web Crypto).

## 1. Registering an RP

An RP is registered by an eID Mongolia operator — submit your request to <eIDsupport@gerege.com> or call 7777-3773
(the public `POST /v3/rp-applications` has been under maintenance since 2026-10-14: `503 rp_applications_maintenance`). After the operator
approves it, you are issued a **relyingPartyUUID** and an **API secret** (`rp_sk_…`); the secret is shown **only once**.
Required information (organization, purpose `AUTH`/`SIGN`, `callbackHosts`…):
<https://developer.eidmongolia.mn/#registration>.

## 1a. "Log in with eID" — a single button

The pattern used by Smart-ID RPs: **one button** in the browser, all eID calls on your **backend** (with the API secret). The SDK provides two
parts — the ready-made backend flow `createEidLogin` and the browser button `@gerege-systems/eid-mongolia-sdk/button`.
It only uses the RP-API from §2/§4 (device link v3, push, `ResponseValidator`); it is not a separate protocol.

| Where | What happens |
|---|---|
| Desktop browser | Dialog: QR (refreshed every ~1–2 seconds — status long-poll ≤ 1 s + 1 s) + verification code + "Request expires in m:ss" (warning colour for the last 30 s) + a "Log in with registry number" button (a push section that expands downward in the same dialog), live status |
| Mobile browser | Button → `start?mode=web2app` → server 302 → eID app (Web2App). The app confirms and returns to `/auth/eid/callback` |
| Backend | start the session, assemble the QR (`sessionSecret` stays on the server), poll, `validateAuth` (chain + ACSP_V2 + `flowType` + `userChallengeVerifier` for Web2App) → your `onSuccess` |

**Endpoints** (under `/auth/eid` — the eID server always normalizes the Web2App return path to `/auth/eid/callback`):

| | Request | Response |
|---|---|---|
| `POST /auth/eid/start` | `{"mode":"qr"}` or `{"mode":"push","idCode":"УБ12345678"}` (JSON required) | `{mode, vc, qr?, expiresIn}` + `Set-Cookie: eid_login` |
| `GET /auth/eid/start?mode=web2app` | mobile browser (button navigation) | `302` → eID app |
| `GET /auth/eid/status` | cookie | `PENDING` (+ new `qr`, `expiresIn`) · `WAIT_CALLBACK` · `OK` (`redirect`, `data`) · `FAILED` (`error`) · `EXPIRED` |
| `GET /auth/eid/callback` | the app returns: `?sessionId&userChallengeVerifier` | `303` → `onSuccess`'s `redirect` / `successRedirect`, on error `failureRedirect?eid_error=<code>` |

**Backend** (one instance at module level):

```ts
import { EidClient, NATIONAL_ROOT_CA_PEM, createEidLogin } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  credentials: { rpUUID: process.env.EID_RP_UUID!, rpName: "Internet Bank", apiSecret: process.env.EID_SECRET! },
  // Root (01) is the trust anchor; the intermediates 02 → 03 → 04 are built into the SDK (CITIZEN_INTERMEDIATES_PEM, the default).
  trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] },
});

export const eidLogin = createEidLogin({
  client: eid,
  callbackUrl: "https://bank.example.mn/auth/eid/callback", // the host must be in the RP's callbackHosts; required for the phone flow
  async onSuccess(id) {
    // id.etsi (PNOMN-…) — identify the user BY THIS; id.givenName/surname (Latin), id.person (Cyrillic, if present)
    // id.sessionId, id.documentNumber, id.certificateDerB64 — for the next steps (signing, linking the certificate)
    const user = await users.findOrCreateByEtsi(id.etsi);
    const sid = await sessions.create(user.id); // a NEW session (session fixation)
    return {
      redirect: "/dashboard",
      headers: { "Set-Cookie": `app_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax` },
    };
  },
  // store: redisStore,            // for multiple instances / serverless (default — process memory)
  // rateLimit: { start: (key) => redisLimiter.allow(key) }, // merged with the defaults (push stays 3/min) — see "Rate limiting" below
  trustProxy: 1, // client IP for handle(Request): 1 if nginx/LB is a single hop (see "Client IP" below)
  onEvent: ({ kind, sessionId, meta }) => audit.record(`auth.eid_${kind}`, sessionId, meta), // your audit
  // auditKey: process.env.EID_AUDIT_KEY, // keep pushKey stable across instances/restarts
});
```

Next.js App Router — `app/auth/eid/[action]/route.ts`:

```ts
import { eidLogin } from "@/lib/eid";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => eidLogin.handle(req);
export const POST = (req: Request) => eidLogin.handle(req);
```

**Client IP** (the `start:<ip>` limit). A web-standard `Request` has no IP — if you use `handle(req)`, provide one of the following:

- `trustProxy: n` — behind trusted reverse proxies: the value **n-th from the right** in `X-Forwarded-For` (n = the number of your proxies),
  or `X-Real-IP` if there is no XFF. `true` = the leftmost XFF value (only when your proxy overwrites the client's XFF). Do not
  enable it without a proxy — the client can forge the header.
- `getClientIp: (req) => …` — the platform's IP (Bun `server.requestIP(req)?.address`, Deno `info.remoteAddr.hostname`,
  Vercel `req.headers.get("x-real-ip")`). Takes precedence over `trustProxy`.

If neither is set, no per-IP limiting is applied (a one-time warning goes to `onError` on the first request). With `handleRequest`, `req.ip` is used directly
(Express `req.ip`, with `app.set("trust proxy", …)`). Go: `eidlogin.Config.ClientIP` (`eidlogin.ForwardedClientIP(n)`) — same rules.

**Rate limiting** (`rateLimit`). Keys: `start:<ip>` (when the IP is known), `push:<idCode>`; when rejected: 429 + `Retry-After: 60`.
The default `defaultRateLimit` = `{ start: { limit: 20, windowMs: 60_000 }, push: { limit: 3, windowMs: 60_000 } }` — 20 starts per minute from one
IP (since 0.19.0; when the IP is known — `req.ip` / `trustProxy`), 3 notifications per minute to one number
(MFA fatigue). The in-memory limiter holds ≤ 10 000 keys per type: when full, it purges expired windows, and if it is still not empty
it rejects a **new** key with 429 (fail-closed) — existing counters are never evicted, so the limit cannot be bypassed by
filling it with many IPs/numbers. `memoryLoginStore(max = 10_000)` behaves the same way: when full, start returns 503 `{ error: "busy" }`
and does not delete logins already in progress. With multiple instances, use a Redis store/limiter.

- **Object** `{ start?, push? }` — **merged** with the defaults: a type you provide overrides the default, one you omit keeps its default.
  Values: `{ limit, windowMs }` (sliding window in process memory), `(key) => boolean | Promise<boolean>` (Redis etc.),
  or `false` (do not limit that type). Any other key → `createEidLogin` throws.
- **Function** `(key) => …` — called for every key and **added on top of** the default limits (both must allow).
  To relax/replace a default, pass an object for that type (`{ push: … }`).

```ts
import { defaultRateLimit } from "@gerege-systems/eid-mongolia-sdk";
rateLimit: { start: { limit: 60, windowMs: 60_000 } },             // when many users sit behind a NAT; push stays 3/min
rateLimit: { start: false },                                       // if you rate-limit start in your own layer (nginx/gateway)
rateLimit: { ...defaultRateLimit, start: (k) => redis.allow(k) },  // same — with the default written out explicitly
rateLimit: { push: (k) => redis.allow(k, 3, 60) },                 // multiple instances: replace push with Redis
```

Go: `eidlogin.Config.RateLimits` (`map[string]eidlogin.RateRule{"start": {Max: 20, Window: time.Minute}}`,
`eidlogin.DefaultRateLimit()`) — same merging; the `Config.RateLimit` function is also added on top of the defaults.

Express:

```ts
app.use("/auth/eid", express.json(), async (req, res) => {
  const r = await eidLogin.handleRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body, ip: req.ip });
  res.status(r.status).set(r.headers).send(r.body);
});
```

**Browser** — a Web Component (works with React/Vue/plain HTML alike):

```html
<script type="module">import "@gerege-systems/eid-mongolia-sdk/button";</script>
<eid-login-button start-url="/auth/eid/start" status-url="/auth/eid/status" lang="mn"></eid-login-button>
<script type="module">
  document.querySelector("eid-login-button").addEventListener("eid-login-success", (e) => {
    // e.detail = { state: "OK", redirect, data } — no redirect if you call preventDefault()
  });
</script>
```

or `mountEidLoginButton(el, { startUrl, statusUrl, lang: "en", theme: "auto", successUrl, label, icon, variant, onSuccess, onError })`.

| Attribute (`mount…` option) | Value | Default |
|---|---|---|
| `start-url` (`startUrl`), `status-url` (`statusUrl`) | backend endpoints | — (required) |
| `lang` | `mn` \| `en` \| `ru` \| `zh` \| `fr` \| `es` \| `ar` (the eID app's languages; `zh-CN` etc. → the base language; anything else → `mn`). `ar` → dialog `dir="rtl"` | `mn` |
| `mode` | `auto` (phone → Web2App, otherwise → QR dialog) \| `qr` \| `app` | `auto` |
| `theme` | `auto` \| `light` \| `dark` | `auto` |
| `success-url` (`successUrl`) | URL to navigate to when the backend gives no redirect | — |
| `label` | button text; `""` → logo only | i18n: "e-ID-ээр нэвтрэх" / "Log in with e-ID" |
| `icon` | `eid` (the "e-ID" wordmark, inline SVG `fill: currentColor` — follows light / dark through the button / heading text colour; 16px in a tall button, 12px when logo-only, 20px in the dialog header; with the default text the logo replaces "e-ID": [e-ID] нэвтрэх, the full name goes in `aria-label`) \| `none` (no logo, full text) | `eid` |
| `variant` | `default` (logo + text) \| `icon` (logo only, 44×44) | `default` |
| `aria-label` | the button's accessible name (screen readers) | when logo-only, `label` or the i18n text |

When `label`, `icon`, `variant`, `aria-label` or `lang` change, the button updates immediately. The combination `icon="none"` with no text
(`variant="icon"` or `label=""`) does not produce an empty button — the default text is shown and a one-time warning is logged to the console.
Events: `eid-login-success`, `eid-login-error` (below).

**`eid-login-error`** (0.20.0) — fired every time start fails or a login ends unsuccessfully (`bubbles: true`,
`composed: true` — passes out of the shadow DOM). `detail`:

| Field | Value |
|---|---|
| `error` | a code or kind (`EXPIRED`, `USER_REFUSED…`, `VALIDATION` …) — same as in earlier versions |
| `status` | the HTTP status of start; `0` for network errors; `null` for poll errors |
| `code` | the response's `error`/`code`, or `HTTP_<status>` / `NETWORK` |
| `retryAfter` | `Retry-After` (seconds) or `null` |

On 429 / 503 (`{"error":"busy"}`) the button shows "Систем завгүй — N сек дараа дахин оролдоно уу" / "Service busy — try again in N s",
counting down from `Retry-After` (default 30 s), and keeps "Дахин оролдох" ("Try again"; "Мэдэгдэл илгээх" in the push form) disabled until it ends.

```js
document.querySelector("eid-login-button").addEventListener("eid-login-error", (e) => {
  const { status, code, retryAfter } = e.detail;
  if (status === 429 || status === 503) console.warn(`eID busy (${code}), retry in ${retryAfter ?? 30}s`);
});
```

No external dependencies (the QR encoder is built in); the dialog has a focus trap, Esc, and an `aria-live` status.
The dialog uses the native `<dialog>` + `showModal()` (the browser top layer) — an ancestor element's `transform`/`filter`/`backdrop-filter`/`overflow` on the RP page does not affect it; in browsers without `showModal` it falls back to a `position: fixed` overlay.

**Design, theme.** The design is that of the eID login page (logo, colours). The font is inherited from the page (button, dialog and input alike).
With `theme="auto"` the order is: the page's `html[data-theme="dark|light"]` → `html.dark` / `html.light` → OS
(`prefers-color-scheme`); when the page switches theme (MutationObserver) it follows immediately. `theme="light|dark"` overrides the page.
Colours and radii are overridden with CSS variables. `--eid-*` are **inputs** only (they are not defined inside the shadow root), so a value set at
any level of the page (`:root`, a parent element, `eid-login-button`) is inherited and applies to **both light and dark**;
`--eid-<name>-dark` applies to dark only and takes precedence over `--eid-<name>`. If neither is set, eID's default (table below) — a fallback only.
Dark order: `--eid-<name>-dark` → `--eid-<name>` → the dark default.

```css
:root {                                   /* or eid-login-button { … } */
  --eid-accent: var(--brand);             /* for both themes */
  --eid-accent-dark: var(--brand-400);    /* dark only (falls back to --eid-accent if not set) */
  --eid-radius: 6px; --eid-radius-lg: 8px;
}
eid-login-button::part(button) { width: 100%; }  /* part: button, icon, label, dialog (backdrop — fallback only) */
eid-login-button::part(label) { font-weight: 600; }
eid-login-button::part(icon) { height: 18px; }
```

| Variable (has a `-dark` variant) | Used for | Light default | Dark default |
|---|---|---|---|
| `--eid-accent` | primary button | `oklch(0.534 0.2 259)` | `oklch(0.64 0.15 259)` |
| `--eid-logo` | **deprecated (0.38.0)** — no effect; since 0.40.0 the wordmark is `currentColor` (the button / heading text colour) | — | — |
| `--eid-accent-fg` | primary button text | `#fff` | `hsl(229 50% 6%)` |
| `--eid-accent-subtle` | step-number background | `oklch(0.97 0.03 259)` | `oklch(0.24 0.06 259)` |
| `--eid-accent-subtle-fg` | step number | `oklch(0.474 0.19 259)` | `oklch(0.82 0.1 259)` |
| `--eid-ring` | focus | `oklch(0.604 0.2 259)` | `oklch(0.68 0.15 259)` |
| `--eid-bg` | dialog, outline button, input | `hsl(0 0% 100%)` | `hsl(229 50% 6%)` |
| `--eid-bg-subtle` | — (reserve) | `hsl(210 40% 98%)` | `hsl(222 47% 9%)` |
| `--eid-bg-muted` | hover | `hsl(210 40% 96%)` | `hsl(217 33% 13%)` |
| `--eid-fg` | text | `hsl(222 47% 11%)` | `hsl(210 40% 98%)` |
| `--eid-fg-muted` | secondary text | `hsl(215 19% 35%)` | `hsl(213 27% 84%)` |
| `--eid-fg-subtle` | captions, placeholder | `hsl(215 16% 45%)` | `hsl(215 20% 65%)` |
| `--eid-border` | dialog, QR, separators | `hsl(214 32% 91%)` | `hsl(217 33% 17%)` |
| `--eid-border-strong` | outline button, input | `hsl(213 27% 84%)` | `hsl(215 20% 45%)` |
| `--eid-warning-bg` / `-border` / `-fg` | network warning | `hsl(48 100% 96%)` / `hsl(45 95% 78%)` / `hsl(23 75% 33%)` | `hsl(20 60% 10%)` / `hsl(22 70% 26%)` / `hsl(40 92% 65%)` |
| `--eid-danger-fg` | error | `hsl(0 74% 42%)` | `hsl(0 91% 71%)` |
| `--eid-radius` / `--eid-radius-lg` (no theme) | corners | `6px` / `8px` | — |

**Minimum eID app version.** The `flowType` binding (device link v3) and Web2App's `userChallengeVerifier` start from
**iOS 2.2.3 (build 59)** and **Android 2.2.3 (versionCode 60)**. The eID server fully removed legacy links on 2026-10-07
(for a session without v3 the phone returns `DEVICE_LINK_REQUIRED`) and forces a minimum version through `/mobile/app-config`:
Android ≥ 70 from 2026-10-07 (with device attestation), and as of 2026-10-20 iOS ≥ 2.2.8,
Android ≥ 91 (`curl https://ca.eidmongolia.mn/mobile/app-config`). Every app able to sign therefore supports these —
the RP side needs no extra check. Sources: the eID CA's `docs/DEVICE_LINK_V3.md` §5, §7; changelog
`2026-10-02-ios-min-version-2-2-3`, `2026-10-07-android-min-70`.

**Security.**

- `sessionToken`, `sessionSecret` and `rpChallenge` stay on the server (the store); the browser only gets an HttpOnly, Secure, SameSite=Lax cookie
  (`<sessionId>.<binding>`; the store keeps the SHA-256 of the binding). Status and callback respond only to the **browser that started the login** —
  a callback URL opened in a different browser (even with the verifier) is not accepted (login CSRF).
- The `start` POST requires JSON (so it is not a simple request → cross-origin preflight), and `Sec-Fetch-Site: cross-site` → 403.
- `OK` is returned only when `validateAuth` succeeds: QR → `flowType=QR`, push → `Notification`, phone → `Web2App` + the callback's
  `userChallengeVerifier`. A Web2App session is not finished by polling (`WAIT_CALLBACK`). `onSuccess` runs only once per session
  (the store's `delete` must be atomic — Redis `DEL`).
- The `data` from `onSuccess` goes to the browser — do not put secrets in it.
- **Registry-number oracle protection (decoy + minimum duration, on by default).** When eID rejects a push because of the number
  (eID's own JSON 4xx — unknown / unusable number), the response is **identical** to a real push: `{mode, vc (random
  5 digits — same shape as eID's), expiresIn}`, same cookie; `status` holds `PENDING` for `pollMs` without asking eID,
  then `EXPIRED` after the TTL — indistinguishable from a citizen who did not pick up their phone (a real push's CA `TIMEOUT` also becomes `EXPIRED`). Every push start response (real, decoy, 502)
  takes at least `pushFloorMs` (default 1000) — so the decoy cannot be told apart by timing (with `handle(Request)` it does not
  wait if the request is aborted; with `handleRequest` pass a `signal`). The limits (`push:<idCode>`, `start:<ip>`) also apply to the decoy; the limiter's 429 and 400
  (`invalid_id` — a format error, independent of registration) have no floor (eID's 429 and 503 `busy` do have it). eID's 5xx, connection errors, non-JSON 4xx (a proxy in front of
  eID, e.g. an mTLS rejection), 401/403 (the RP's secret/permission) and 429 are **not decoyed** — `502 eid_unavailable` / `429` (the eID
  portal's behaviour: hiding an outage behind a decoy would leave the citizen with an endless spinner; these do not depend on the number, so they are not
  an oracle). To disable: `decoy: false`, `pushFloorMs: 0` — **⚠️** then `/start` tells anyone, unauthenticated, "whether this registry number is registered in eID";
  internal/test environments only.
- **The lifetime (`ttlMs`, default 120 000) never exceeds the CA's session.** QR / Web2App: `expiresIn`, cookie `Max-Age`,
  and the store = min(`ttlMs`, the CA start response's `expiresAt` − now). Push (real and decoy **identical**): min(`ttlMs`, discovery
  `sessionTtl.auth`) — since a decoy has no CA response, it uses discovery (`client.auth.sessionTtl()`,
  10 min cache; on error `onError` + retry after 1 min) rather than the CA's `expiresAt` — so a timing difference cannot become an oracle.
  Older CA (no `sessionTtl` in discovery): the next decoy takes the value observed from a real push's `expiresAt` (±1 s); before the first
  real push, `ttlMs`.
- **Certificate revocation (OCSP, on by default).** After `validateAuth` and before `onSuccess`, the citizen's certificate is checked against
  the OCSP responder listed in its AIA (`revocation`, default `ocspRevocationChecker()`; the response must be signed by the issuer or
  its OCSPSigning responder, for this serial, thisUpdate ≤ 48 h, and a good result is cached for 5 min). `revoked`,
  and also `unknown` (the issuer did not issue this certificate) → `FAILED` / `VALIDATION` (not 500), and `onSuccess` is not called. With no response
  (2 s timeout, 5xx, no AIA, a failed check): `revocationMode` defaults to `"soft-fail"` — allow it and warn
  through `onError`, `identity.revocation = "unchecked"` (the eID portal's `EID_OCSP=soft`: if the CA's responder goes down not every citizen
  is locked out; and the CA could reach the phone seconds earlier when the session was confirmed); `"hard-fail"` → `FAILED` /
  `VALIDATION`. `revocation: false` — **⚠️** logins succeed with a revoked (stolen phone) certificate.
- **Audit — `onEvent({ kind, sessionId, meta })`** (awaited; errors go to `onError`): `push_sent` (meta `decoy` —
  only in your audit, never to the browser), `push_limited`, `refused` (the citizen declined), `expired` (TIMEOUT / not found in
  eID), `unverified` (`reason`: `validation` | `revoked` | `revocation_unavailable`), `flow_refused` (a Web2App callback in a
  different browser), `success` (`flow`, `revocation`), `failed` (other `endResult`). meta carries `mode`; tokens/secrets and registry numbers
  are never included — for push, `pushKey` = the 32 hex of HMAC-SHA256(`auditKey`, number) (random per process if `auditKey` is absent).
- On multiple instances / serverless (Vercel etc.) the default in-memory store does not work — back `EidLoginStore` (`get`/`set`/`delete`) with Redis.
- BEFORE `onSuccess` is called the tx is atomically deleted from the store (a one-time guarantee) — do not read from the store inside `onSuccess`;
  everything you need is in `identity` (`sessionId`, `documentNumber`, `certificateDerB64`, …).

**Redis store** (the SDK has no extra dependency — for example `ioredis`):

```ts
import { Redis } from "ioredis";
import type { EidLoginStore, EidLoginTx } from "@gerege-systems/eid-mongolia-sdk";

const redis = new Redis(process.env.REDIS_URL!);
const key = (sid: string) => `eid:login:${sid}`;

export const redisStore: EidLoginStore = {
  async get(sid) {
    const v = await redis.get(key(sid));
    return v ? (JSON.parse(v) as EidLoginTx) : undefined;
  },
  async set(sid, tx, ttlMs) {
    await redis.set(key(sid), JSON.stringify(tx), "PX", ttlMs);
  },
  async delete(sid) {
    return (await redis.del(key(sid))) === 1; // DEL is atomic — of two concurrent status calls only one invokes onSuccess
  },
};
```

The tx holds `sessionSecret` (the material for assembling the QR) — keep Redis closed off from the network, with TLS/AUTH.

## 2. Authentication (push)

```ts
import { EidClient, NATIONAL_ROOT_CA_PEM } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  // baseUrl defaults to https://rp.eidmongolia.mn (RP-API, no /v3) — an RP with mTLS uses this host too
  credentials: {
    rpUUID: process.env.EID_RP_UUID!,
    rpName: "Internet Bank", // subsystem name, ≤ 120 characters (the CA truncates anything longer)
    apiSecret: process.env.EID_SECRET!, // rp_sk_…
  },
  trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] }, // ← Mongolian National Root CA, REQUIRED in production (intermediates 02–04 are built into the SDK)
});

// ETSI (PNOMN-<civil ID number>) / registry number / civil ID number — any works (the server recognizes it)
const s = await eid.auth.notificationByEtsi("PNOMN-12345678", [
  { type: "displayTextAndPIN", displayText60: "Log in to Khan Bank" },
]);

showToUser(s.vc); // ← the verification code (VC) shown on the citizen's phone

// long-poll; waits until the session expires: expiresAt + 15 s (discovery sessionTtl if absent, otherwise 600 s).
// The CA turns an expired session into COMPLETE/TIMEOUT. If { maxWaitMs } is given, it cuts the wait off (RUNNING is returned).
const result = await eid.session.waitForResult(s.sessionId, { expiresAt: s.expiresAt });
const who = eid.validator.validateAuth(result, s.acsp!); // ← verifies the chain + ACSP_V2 cryptographically (ValidationError if RUNNING)

console.log(who.documentNumber, who.subject); // the verified citizen
const { name, serialNumber } = who.parsedSubject; // Latin "givenName surname", "PNOMN-12345678" (givenName/surname/commonName/country…)
```

The session's `person` block (from the CA's registry — the Cyrillic name, date of birth and sex, which are not in the certificate) is **not part of** the signature —
trust it only after matching it against the certificate's `SERIALNUMBER`:

```ts
import { personMatchesCertificate } from "@gerege-systems/eid-mongolia-sdk";
if (personMatchesCertificate(result.person, who.parsedSubject)) {
  const { firstName, lastName /* FATHER'S name */, familyName /* FAMILY name */, civilId, regNo, birthDate, gender, geID,
    nationality /* "MNG" — ISO 3166-1 alpha-3, not the certificate's country; undefined if unknown */ } = result.person!;
}
// result.raw — the server's raw JSON (for fields the SDK does not parse)
```

The subject fields (`parsedSubject`, also in `validateSign`) come from `parseSubject(cert)` — OIDs 2.5.4.42/4/3/5/6/10/97,
UTF8String/PrintableString/BMPString. `parseSubject` only parses: never trust the name of an unverified certificate.

> **Do not use push on the same phone.** A push (`notificationBy*`) request reaches the eID app as a notification / in the "pending"
> list; Smart-ID and eID have **no** Notification-type device link (CA `docs/DEVICE_LINK_V3.md` §3).
> If the citizen opened the RP on the same phone as the eID app, use the **device-link Web2App** flow instead of push
> (`auth.deviceLink*` / `signPdfDigest({ flow: "device-link" })` + `buildDeviceLink(…, "Web2App")`, §4) — the button opens the app
> directly and returns via the callback. For push, the text "Please open your eID app" is enough.

## 3. Signature (qualified signature)

```ts
import { sha256Base64 } from "@gerege-systems/eid-mongolia-sdk";

const digest = sha256Base64(pdfBytes); // SHA-256 of the document (base64)

const s = await eid.sign.digestByEtsi("PNOMN-12345678", digest, [
  { type: "displayTextAndPIN", displayText60: "Sign the loan agreement" },
]);
showToUser(s.vc);

const result = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(result, digest); // verified against the digest

console.log(sig.signatureValueB64, sig.subject);
```

`SignOptions.fileName` — the document name, shown on the CA's /verify page and in the citizen's history (optional).

For a sign session started via device-link / push, check the flow you started with `expectedFlowType` (same as `validateAuth`:
a mismatch throws `ValidationError`). The third parameter is a `hashAlgorithm` string (the old form) or an object:

```ts
eid.validator.validateSign(result, digest, { expectedFlowType: "QR" }); // or "Web2App" / "App2App" / "Notification"
eid.validator.validateSign(result, digest384, { hashAlgorithm: "SHA-384", expectedFlowType: "Web2App" });
```

With RAW_DIGEST_SIGNATURE, `flowType` is not part of the signature (only the digest is signed) — this is a check against the RP-API response.

**QR / Web2App / App2App** — `eid.sign.deviceLinkByEtsi` / `deviceLinkByDocument` (Web2App/App2App when `callbackUrl` is given);
build the link on the backend with `buildDeviceLink(deviceLinkInput(s, "QR", "mon"))` (also for auth/cert sessions). Store `s.sign`
(`SignContext`: digest, hash, algorithm, interactions, callback) on the server together with the session.

**`expiresAt`** (ms epoch) — the moment the session ends: the `expiresAt` (RFC 3339) in the CA's session start response (for auth / sign /
certificate-choice alike, since 2026-10-14). With an older CA (no field), for sign / certificate-choice the SDK computes it — the CA's
default 600 s (`DEFAULT_SIGN_SESSION_TTL_MS`; a CA admin can set 60–1800 s → `signSessionTtlMs`), and for auth it is undefined.
The final truth is `GET /session` (`TIMEOUT`). The live value of the CA's configuration: `client.auth.sessionTtl()` — discovery
`sessionTtl` (`{ authMs, signMs }`; 0 for an older CA).

**Session start errors** (subclasses of `ApiError`, with `.code`): `NoSigningCertificateError` — 409
`NO_SIGNING_CERTIFICATE` (sign / certificate-choice start: the citizen has no active device / valid
signing certificate; no session was created); `CertChoiceInvalidError` — 409 `CERT_CHOICE_INVALID` (the linked sign's
certificate-choice is invalid / stale / already used → start cert-choice again); `RequestInvalidError` — 400
`REQUEST_INVALID` (e.g. `linkedSessionID` missing in linked).

### 3.1. Knowing the certificate in advance (client-side PAdES / CMS)

Because the certificate goes into the DTBS (`signingCertificateV2`), do certificate-choice first, then have the digest signed **on exactly that device
(`documentNumber`)**. RP permissions: certificate-choice — `CERT`, digest sign — `SIGN`. For a citizen with several phones, starting by etsi makes a different phone sign, and the signature will not
match the certificate.

```ts
const cc = await eid.sign.certificateChoiceByEtsi("PNOMN-12345678"); // or certificateChoiceDeviceLink() (QR; also Web2App/App2App if callbackUrl is given)
const signer = eid.validator.validateCertificateChoice(await eid.session.waitForResult(cc.sessionId), cc.sessionId);
const dtbs = myCmsBuilder.dtbs(signer.certificate); // yours: SHA-256(signedAttrs), 32 bytes, standard base64 (for a PDF, /pades prepare)
const ix = [{ type: "displayTextAndPIN" as const, displayText60: "Sign the contract" }];
const s = await eid.sign.digestForSigner(signer, dtbs, ix, { fileName: "Contract.pdf" }); // linked/{documentNumber}
// QR / Web2App: eid.sign.deviceLinkForSigner(signer, dtbs, ix, { callbackUrl })
const r = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(r, s.sign!.digest, {
  hashAlgorithm: s.sign!.hashAlgorithm,
  expectedFlowType: "Notification",
  expectedAlgorithm: s.sign!.signatureAlgorithm, // sha256WithRSAEncryption — a PSS response is rejected
  expectedCertificate: signer.certificate,       // rejected if signed with a different certificate
});
```

`digestForSigner` / `deviceLinkForSigner` default to `sha256WithRSAEncryption` + `SHA-256` (the CA's SplitKey RSA signs with the requested
algorithm, PKCS#1 v1.5; the legacy threshold-ECDSA credential is always `ecdsa-with-SHA256` — `expectedAlgorithm` accepts it
only with an EC P-256 certificate). If the digest length does not match the hash, the request is not sent.

#### Linked signing on the phone (with a return URL)

`certificateChoiceDeviceLink({ callbackUrl })` — from one session, shows a QR on desktop and a Web2App button on the phone.
`callbackUrl` is an `https` URL that must be in the RP's `callback_hosts` list (the CA normalizes the path to `/auth/eid/callback`);
if it is not in the list the CA drops it and the session is QR-only. The phone opens the callback only after the linked SIGN completes:
with the RP's own query (e.g. `value=<random>`) unchanged + `sessionSecretDigest` + `sessionId` (of the certificate-choice).

```ts
// 1) start cert-choice with a callback; store `value` in the cookie of the browser that started it
const cc = await eid.sign.certificateChoiceDeviceLink({ callbackUrl: `${origin}/auth/eid/callback?value=${value}` });
const qr = buildDeviceLink(deviceLinkInput(cc, "QR", "mon"));        // desktop (refresh every second)
const w2a = buildDeviceLink(deviceLinkInput(cc, "Web2App", "mon"));  // button on the phone (same session)
// 2) validateCertificateChoice → 3) digestForSigner(signer, …) — the linked sign above
const signer = eid.validator.validateCertificateChoice(await eid.session.waitForResult(cc.sessionId), cc.sessionId);
const s = await eid.sign.digestForSigner(signer, dtbs, ix);

// 4) at /auth/eid/callback
const ok = q.value === cookieValue && verifySessionSecretDigest(q.sessionSecretDigest, cc.sessionSecret!);
// if ok, accept the session ONLY ONCE (never reuse it), then read the linked SIGN result:
const r = await eid.session.waitForResult(s.sessionId);
```

The linked SIGN session itself has no callback. `sessionSecretDigest` = BASE64URL(SHA-256(base64-decode(`sessionSecret`))),
and no `userChallengeVerifier` arrives. `sessionSecret`/`sessionToken` stay on the backend only.

## 3a. Signing on behalf of an organization (onBehalfOf)

The citizen signs **with their own PIN2 certificate**; eID checks **against its own registry** that they are authorized to represent the
organization at that moment (the Estonian model). This is a **personal qualified signature** — not an organizational certificate or a seal (e-Seal).
An e-Seal is only for documents of automated systems without a human. Prerequisites: the organization is `ACTIVE` in eID (the director
links it through the app via the state registry), the signer is an `ADMIN` or a `MANAGER` verified by PIN2, and the RP has the `SIGN` permission.
Details: [developer.eidmongolia.mn](https://developer.eidmongolia.mn/).

```ts
import { ForbiddenError, ApiError, ON_BEHALF_ERROR_CODES } from "@gerege-systems/eid-mongolia-sdk";

// 1. The citizen must have logged in through your RP within the last 24 hours.
const { representations } = await eid.organization.getRepresentations("PNOMN-12345678");
// → [{ orgEtsi: "NTRMN-6235972", orgName: "Gerege Systems LLC", role: "ceo", roleLabel: "Chief Executive Officer",
//      rightType: "ADMIN", rightTypeLabel: "Admin", source: "REGISTRY", sourceLabel: "State registry", … }]

// 2. PDF: §3d (client-side PAdES) — signPdfDigest({ …, onBehalfOf }) + prepare({ claimedRole: rep.claimedRole }).
// 3. Raw digest signature: eid.sign.digestByEtsi(id, digest, interactions, { onBehalfOf: "NTRMN-6235972" })
//    — since you assemble the CMS yourself, you add the claimed role (signer-attributes-v2) yourself.
try {
  /* … */
} catch (e) {
  if ((e instanceof ForbiddenError || e instanceof ApiError) && e.code) {
    // REPRESENTATION_DENIED | REPRESENTATION_PENDING | REPRESENTATION_EXPIRED | ORG_NOT_ACTIVE |
    // SIGNER_UNIDENTIFIED (403) · ORG_NOT_FOUND (404) · REPRESENTATION_REVOKED (403, at registration time)
  }
  throw e;
}
```

Transient errors — `ApiError.retryable` is true; retry after `retryAfterMs` (the CA's `Retry-After`, seconds or a date)
(`RETRYABLE_ERROR_CODES`). `headers` — the response headers. A JSON response over 4 MiB throws `ResponseTooLargeError` (it is not truncated).
`getRepresentations`'s `raw` — the server's raw JSON.

**When showing these to a person, use `roleLabel` / `rightTypeLabel` / `sourceLabel`** (in representations and in the session's
`onBehalfOf`; `onBehalfOf` has no `source`, so only `roleLabel` / `rightTypeLabel`) — `role` (`ceo` / `founder` /
`stakeholder`, or the text entered for a MANAGER), `rightType` (`ADMIN` | `MANAGER`) and `source` (`REGISTRY` | `MANUAL`) are
machine values; do not translate them yourself. Language: `new EidClient({ …, language: "en" })` → an `Accept-Language` on every call; by default
none is sent (the server uses mn). An older CA does not have these fields.

The session's `onBehalfOf` block (`role`/`roleLabel`/`rightType`/`rightTypeLabel`) is the record at the time the response was assembled.

## 3b. Citizen PKI dashboard (`PKI_READ` permission)

`eid.person.certificates(etsi)` · `devices` · `activity(etsi, { flow, limit, offset })` · `summary` · `children` — the citizen
must have logged in through your RP within the last 24 hours (otherwise `ForbiddenError`). Every response has a `raw`.

Every certificate (since 0.18.0) has `issuedAt` (issued), `revokedAt?` (revoked — REVOKED) and `revocationReason?` (the RFC 5280
name: `keyCompromise`, `superseded`, `cessationOfOperation` …). `status` is not changed: a row replaced by a renewal/re-registration
is `SUSPENDED` + `revocationReason: "superseded"` + `revokedAt` (the moment it was replaced, CA since 2026-10-16).

A `keyMedium: "TOKEN"` row has `organization?` (an organizational token) and `tokenSerial?` — the serial number of the USB token the
certificate was issued to. Do not guess one token's AUTH + SIGN by organization/date — group them by `tokenSerial` (a row
replaced through renewal also carries its own token's number). MOBILE/HSM rows and older CAs do not have the field.

```ts
const { certificates } = await eid.person.certificates(etsi);
const byToken = new Map<string, typeof certificates>(); // Map.groupBy requires Node ≥ 21 — it does not work on Node 18/20
for (const c of certificates) if (c.tokenSerial) byToken.set(c.tokenSerial, [...(byToken.get(c.tokenSerial) ?? []), c]);
```

## 3c. USB token

```ts
import { verifyTokenCertificates, tokenAuthDigest, tokenLimitOf } from "@gerege-systems/eid-mongolia-sdk";

// certificate issuance (TOKEN_ISSUE permission) — the citizen confirms with PIN2 on their phone
const input = { signerEtsi, csrAuth, csrSign, tokenSerial: "EP2003-0042A1" }; // no onBehalfOf = personal
// BEFORE the push: dryRun with the same input — no session/push is created, error codes are the same as for real
const pv = await eid.token.previewCertificate(input); // if pv.supersedes is set, warn the citizen and get their consent, then ↓
const st = await eid.token.issueCertificate(input);
// … eid.session.poll(st.sessionId) → result.tokenCertificate?.status === "ISSUED"
const res = await eid.token.certificateResult(st.sessionId);
verifyTokenCertificates(res, csrAuth, csrSign); // every certificate matches its CSR's key
// 409 TOKEN_LIMIT_REACHED → tokenLimitOf(err): { kind, limit, organization? }
// 409 TOKEN_IN_USE — the serial belongs to another citizen; 409 TOKEN_SCOPE_CHANGE — a renewal that would change scope (below)
// 400 APP_ATTESTATION_INVALID — an appTransaction was sent but is invalid (below)

// signing in with the token (AUTH permission)
const ch = await eid.token.authChallenge();
const digest = tokenAuthDigest(ch.rpUUID, ch.challenge); // the token's CKM_ECDSA → raw r||s
// since 0.19.0 pass the challenge whole (kept by the RP, or returned from the client — the CA matches it by challengeId):
// the SDK does not trust the CA's OK alone — it checks r||s against the certificate's key, the rpUUID against its own, and the certificate against trust
// (chain, issuer, purpose auth) and only then sends it to the CA.
const who = await eid.token.authVerify(ch, authCertDer, rs);

// PDF with a token: §3d — prepare() → token CKM_ECDSA(dtbs) → r||s → complete() → registerSignature() (no sessionID, medium "token")
```

**Renewal preserves the scope** (CA 2026-10-16, discovery `tokenCertificate.scopeLockedOnRenewal: true` —
`eid.token.certificateInfo()`): if the citizen has an ACTIVE record for the same `tokenSerial`, issuance = renewal; an organizational
token only for that organization (same `onBehalfOf`), a personal token only as personal. For a different scope, `POST` (or, after
confirmation, `certificateResult`) returns 409 `TOKEN_SCOPE_CHANGE`, and the session's `tokenCertificate.errorCode` is the same — there is no
override. Changing scope = the citizen revokes the token in the eID app (`/v3/mobile/tokens/{tokenSerial}/revoke`) and has it issued anew;
to the user: "To change the token type (personal/organizational), revoke the token in the eID app and have it issued again."

**Automatic replacement of a personal token** (CA 2026-10-19, discovery `tokenCertificate.personalAutoSupersede: true`): when the personal
limit is reached, a new personal token with a different `tokenSerial` is not a 409 — `st.supersedes` (`{ tokenSerial }[]`) comes back; once the
new issuance for the personal token succeeds (PIN2 + certificate), the previous personal token's AUTH + SIGN are revoked as superseded (4).
A rejected / expired issuance does not touch the previous one. Before PIN2: "The certificates of your previous USB token (EP2003-…)
will become invalid." 409 `TOKEN_LIMIT_REACHED` with `kind: "PERSONAL"` occurs only when `limit: 0` (personal issuance closed);
an organizational token remains a hard limit.

**dryRun — a check before the push** (CA 2026-10-19, discovery `tokenCertificate.dryRun: true` —
`certificateInfo().dryRun`): when `issueCertificate`'s response has `supersedes`, a PIN2 push has already gone to the phone —
even if you cancelled on desktop, if the citizen confirms on the phone the old token is replaced. So the flow is: CSR →
`eid.token.previewCertificate(input)` (the same body + `"dryRun": true`; all checks, the same error codes — including
`409 TOKEN_ISSUANCE_PENDING` for a pending issuance with a different CSR host; no session / push / state is created) → if there is `supersedes`, show a warning and
let the citizen agree → `issueCertificate(input)`. The rate limit (RP, citizen) is 20/min and 120/10 min for the RP in total — it does not
consume the push's 3/hour. If the response does not come back with `dryRun: true`, `ValidationError` (an older CA returns 400 for the unknown field).

**App attestation (`appTransaction`, optional)** (CA 2026-10-19, discovery `tokenCertificate.appTransaction:
"optional"` — `eid.token.certificateInfo().appTransaction`): the macOS App Store build passes the StoreKit 2 `AppTransaction` JWS
(compact) string from the desktop — `issueCertificate({ …, appTransaction: jws })`. The CA does not call Apple's servers; it checks
offline; if present it must be valid, otherwise 400 `APP_ATTESTATION_INVALID` (an SDK
constant; it does not say which step failed, and no push goes to the phone). Empty/absent (Windows) = issuance without attestation.
Above `MAX_APP_TRANSACTION_BYTES` (16 KiB) the SDK does not send and throws `AppTransactionTooLargeError`. Sending the field to an older CA
returns 400.

`/token/auth/*` is listed in `/.well-known/eid`'s `endpoints.token.auth_challenge` / `auth_verify` (AUTH permission) —
the contract test checks it like the other routes.

## 3d. PDF signing (PAdES, client side) — `@gerege-systems/eid-mongolia-sdk/pades`

**The PDF does NOT go to the eID server** (the Smart-ID / DigiDoc model). Your side (browser or Node) assembles the document in NATIVE
TypeScript (no WASM, Web Crypto); the CA only performs a signing session for the 32-byte DTBS (an ordinary
`RAW_DIGEST_SIGNATURE`) and the registration of the CMS. Output: PAdES-BASELINE-LT (timestamp tsa.timeserver.mn, OCSP/CRL
in the DSS), "LTV enabled" in Adobe / EU DSS, with a verification (QR) page (mn default / en). **Byte-identical** to the Go reference
(`eid-mongolia-sdk-go/pades`, profile `pades-client/1`) — checked in CI by the conformance golden.

| Function | Where | Description |
|---|---|---|
| `prepare(pdf, { signerCert, claimedRole?, verifyPage?, verifyPagePosition?, fileName?, lang?, docId?, appearance?, … })` | browser / Node | `{ dtbs, digest, docId, state, placement? }` — no network |
| `suggestPlacement(pdf, appearance)` | browser / Node | the stamp's placement + page sizes without signing (for preview, 0.29.0+) — no network |
| `eid.signPdfDigest({ dtbs, fileName, signer, flow?, onBehalfOf? })` | RP backend | a signing session for the DTBS (push or device-link) |
| `complete(state, signature)` | browser / Node | TSA + OCSP/CRL → `{ pdf, cms, docId, outSha256, inSha256, hasPage, pageSha256, … }` |
| `eid.registerSignature(registrationFromCompleted(done, { fileName, sessionID, onBehalfOf? }))` | RP backend | `POST /pdf/signatures` — registers `/verify/{docID}`. If `medium` is absent it is derived from `sessionID` (phone ⇔ sessionID); a conflict, or a signature with `claimedRole` without `onBehalfOf`, gives `ValidationError` |

The `/pades` browser bundle is ~136 KB gzip (with the Noto Sans font asset, ≤ 300 KB in CI); the main entry does not contain it. `/pades` (and the whole package) needs **Node ≥ 18** (CI: 18 / 20 / 22) or
a modern browser. Browser CSP: `connect-src https://tsa.timeserver.mn https://ocsp.eidmongolia.mn
https://crl.eidmongolia.mn`. In the browser, a certificate's `http://` AIA/CDP is rewritten to `https://` only for these hosts; the national
CA's CRL (`esign.gov.mn`) comes from the `crl.eidmongolia.mn` mirror (on every platform). The verifier is **not** in
`/pades` — full verification is in `@gerege-systems/eid-mongolia-sdk/validate` (`validatePdf`, §3g) or Go `pades.ValidatePDF`; `prepare` checks a previous signature only with a "light" test (structure,
CMS signature, eID issuer, timestamp, DSS).

**The signer's certificate.** `prepare` requires the citizen's SIGN certificate (`signingCertificateV2`), so it is needed BEFORE the session.
The main path is **certificate-choice** (§3.1; the RP needs the `CERT` permission): `validateCertificateChoice` → `signer.certificate`
+ `signer.documentNumber`, then have that device sign through `digestForSigner` / `deviceLinkForSigner`.
`eid.person.certificates(etsi)` (`PKI_READ`; the `certValue` + `documentNumber` of a row with `type: "SIGN"`, `status: "VALID"`, `keyMedium: "MOBILE"`)
is only for a trusted RP, when the citizen has successfully logged in to that RP within the last 24 hours (otherwise → 403).
Start the session with that `documentNumber` — if a different device signs, `complete` gives `SIGNATURE_INVALID`.

### Web RP (browser prepare/complete, backend session)

```ts
// ── browser ─────────────────────────────────────────────────────────────────────────────
import { prepare, complete } from "@gerege-systems/eid-mongolia-sdk/pades";

const { certB64, documentNumber } = await api("/sign/pdf/signer");             // backend: person.certificates
const signerCert = Uint8Array.from(atob(certB64), (ch) => ch.charCodeAt(0));     // prepare takes a DER Uint8Array
const p = await prepare(pdfBytes, {
  signerCert, verifyPage: true, fileName: "Contract No. 12.pdf",
  claimedRole, // if signing for an organization, getRepresentations()'s claimedRole EXACTLY AS IS
});
await idb.put("pades-state", p.state);                                           // the page may be reloaded
const s = await api("/sign/pdf/start", { dtbs: b64(p.dtbs), documentNumber, fileName: "Contract No. 12.pdf" });
showToUser(s.vc);                                                                // or the backend's QR (§4)
const { signature } = await api(`/sign/pdf/${s.sessionId}/result`);              // backend poll + validateSign
const done = await complete(p.state, signature);                                 // TSA + OCSP/CRL + DSS
const { pdf, signerCert: _c, ...meta } = done;                                     // the PDF does not go to the backend
await api(`/sign/pdf/${s.sessionId}/register`, { ...meta, cms: b64(done.cms) });
download(done.pdf, "Contract No. 12.pdf");
```

```ts
// ── RP backend (Node) ─────────────────────────────────────────────────────────────────────
import { registrationFromCompleted } from "@gerege-systems/eid-mongolia-sdk";

// /sign/pdf/start — sessionSecret (device-link) never leaves the backend; store s.digest in the session.
const s = await eid.signPdfDigest({
  dtbs: req.body.dtbs, fileName: req.body.fileName,
  signer: { documentNumber: req.body.documentNumber }, // or { etsi }
  onBehalfOf: "NTRMN-6235972",                         // optional
});
store(s.sessionId, { digest: s.digest, fileName: req.body.fileName });
// /sign/pdf/:id/result
const r = await eid.session.waitForResult(sessionId);
const sig = eid.validator.validateSign(r, store.get(sessionId).digest, { expectedFlowType: "Notification" });
reply({ signature: sig.signatureValueB64 });
// /sign/pdf/:id/register — the CA verifies the CMS itself (session digest = SHA-256(signedAttrs), cert, claimedRole)
// registrationFromCompleted: a body identical to the CA's dto (hasPage is not sent, pageSha256 only when there is a page); cms may also be base64.
const reg = await eid.registerSignature(registrationFromCompleted(req.body, {
  fileName: store.get(sessionId).fileName, sessionID: sessionId, onBehalfOf: "NTRMN-6235972" }));
reply({ verifyUrl: reg.verifyUrl });
```

- `reg.created` — `true` is 201 (new), `false` is 200 (a repeat of the same body). If the previous signature was assembled by the CA (mode A), pass
  `complete().priorRevisionSha256` (`sha256(doc[0 : ByteRange[2]+ByteRange[3]])`) as `registrationFromCompleted`'s
  `priorSignatures`; after a 409 `PRIOR_MISMATCH`, `registerSignature` reconciles by revision itself
  (it does not try if you gave `priorRevisionSha256` by hand). When passing it from the browser as JSON, send `priorRevisionSha256` too.
- `registerSignature` errors: `ApiError.code` / `ForbiddenError.code` ∈ `PdfRegisterErrorCode`
  (`PDF_REGISTER_ERROR_CODES`; Go: `eid.PDFRegisterErrorCodes`) — 400 `REQUEST_INVALID` / `CMS_INVALID` /
  `SIGNATURE_INVALID` / `TIMESTAMP_INVALID`; 403 `TOKEN_ORG_MISMATCH` / `REPRESENTATION_REVOKED`; 404 `DOC_NOT_FOUND`; 409
  `SIGNER_MISMATCH` / `SIGNER_CERT_INVALID` / `TOKEN_CERT_INVALID` / `SESSION_MISMATCH` / `SESSION_NOT_COMPLETE` /
  `SESSION_FAILED` / `CLAIMED_ROLE_MISMATCH` / `DOC_ID_CONFLICT` / `REGISTRY_CONFLICT` / `PRIOR_MISMATCH`; 413
  `REQUEST_TOO_LARGE`; 429 `RATE_LIMITED`, 503 `STATE_UNAVAILABLE` (`retryable`).

**Visible signature (optional).** If you pass `appearance: { page?, x, y, width, height, lang?, exact? }`, the signature is visible
on the page (QR + name, `claimedRole`, "eID Mongolia-аар зурсан" ("Signed with eID Mongolia"), date `YYYY-MM-DD HH:MM (+08)`); without it the signature is invisible
(byte-identical to before). Coordinates are in pt, from the bottom-left corner of the page's CropBox after `/Rotate` (as seen on screen);
`page` counts from 1 (absent/0 = the last page, NOT the input's eID verify page — the verify pages added by this prepare and by previous signatures are not
counted (0.26.0+); an explicit number stays as is even if it was a verify page). Height ≥ 45 pt; going off the page, text
not fitting, or no docId (a document with page-less signatures) gives `REQUEST_INVALID`. Each visible signature adds ~+90 KB. Rules: the Go repo's
`pades/APPEARANCE_SPEC.md`.

`x, y` is the **requested** position: if the page's content (text, table rules, images, a previous signature) is in that spot,
the stamp moves to free space — first the mirrored column (bottom-right → bottom-left), then up in 12 pt steps. The page is not
rendered; only the content stream is read (identical to Go box by box). The result: `p.placement` —
`{ page, x, y, width, height, status }` (pt), `status`: `requested` (at the requested place) | `moved` (moved) | `overlap` (no free
space — at the requested place, over content) | `unscanned` (the page could not be read within the limit — at the requested place). The
signature is valid in every case; it is advisable to tell the user about `overlap` / `unscanned`. Rules: the Go repo's
`pades/PLACEMENT_SPEC.md`.

```ts
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "Contract No. 12.pdf",
  appearance: { page: 1, x: 340, y: 36, width: 220, height: 64 } });
if (p.placement?.status === "overlap") notice("The signature is placed over the page content");
```

**Letting the citizen choose the position (0.29.0+).** `suggestPlacement(pdf, appearance)` runs `prepare`'s placement algorithm
(page 0 resolution, page reading, free-space search) without a certificate, a signature or the network:
`{ page, x, y, width, height, status, pageWidth, pageHeight, pageCount, pages: [{ width, height }] }` (pt; `pages[i]` —
the visible size of each page, `{0, 0}` for a page whose geometry cannot be read). `page, x, y, width, height, status` are the same as
`prepare().placement` for the same PDF + appearance (on a document with no signatures, page 0 skips nothing — it is the last page).
If the UI draws the page at `s` px/pt with a top-left origin: `left = x·s`, `top = (pageHeight − y − height)·s`; going back,
`x = left/s`, `y = pageHeight − top/s − height`, and then `appearance.exact: true` — the stamp is drawn exactly there and is never
moved (going off the page gives `REQUEST_INVALID`, it is not clipped). Because it still reads the page, `status` is: `requested` (free) |
`overlap` (over content) | `unscanned`; never `moved`. Without `exact`/false it is byte-identical to before. Order of checks:
`PDF_TOO_LARGE` → `PDF_INVALID` (header/structure) → `REQUEST_INVALID` (appearance values) → `PDF_ENCRYPTED` → `PDF_INVALID`
(reading signatures) → `REQUEST_INVALID` (page count, box, going off the page). It does not check previous signatures,
the signer, or whether the name fits (`prepare` does). Rules: `PLACEMENT_SPEC.md` §6a/§6b.

```ts
const s = await suggestPlacement(pdfBytes, { x: 340, y: 36, width: 220, height: 64 }); // default position
// … the citizen drags the stamp on the preview → { page, x, y } (pt, bottom-left origin) …
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "Contract No. 12.pdf",
  appearance: { page, x, y, width: s.width, height: s.height, exact: true } });
```

**The verification page at the start (0.30.0+).** `verifyPagePosition: "first"` — the QR page becomes page 1 of the document (the default
`"last"` — at the end, byte-identical to before; any other value is `REQUEST_INVALID`). It only has an effect when a page is added (a document with no signatures,
`verifyPage: true`). `appearance.page`, `suggestPlacement` and `placement.page` are always counted by the **input** PDF's pages —
the added page is not counted, so you pass the preview's page number directly. Rules: `PAGE_SPEC.md` §8a,
`PLACEMENT_SPEC.md` §1b.

```ts
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, verifyPagePosition: "first", fileName: "Contract No. 12.pdf",
  appearance: { page: 2, x: 340, y: 36, width: 220, height: 64, exact: true } }); // on page 3 of the output
```

### Node only (the backend does everything)

```ts
import { writeFileSync } from "node:fs";
import { registrationFromCompleted } from "@gerege-systems/eid-mongolia-sdk";
import { prepare, complete, PadesError } from "@gerege-systems/eid-mongolia-sdk/pades";

const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "Contract No. 12.pdf" });
const s = await eid.signPdfDigest({ dtbs: p.dtbs, fileName: "Contract No. 12.pdf", signer: { documentNumber } });
showToUser(s.vc);
const r = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(r, s.digest);
let done;
for (let i = 0; ; i++) {
  try {
    done = await complete(p.state, sig.signatureValueB64);
    break;
  } catch (e) {
    if (e instanceof PadesError && e.retryable && i < 3) continue; // TSA_UNAVAILABLE / LTV_UNAVAILABLE — same state + signature
    throw e;
  }
}
await eid.registerSignature(registrationFromCompleted(done, { fileName: "Contract No. 12.pdf", sessionID: s.sessionId }));
writeFileSync("signed.pdf", done.pdf);
```

**LTV retry (0.18.3+).** If gathering the OCSP/CRL (DSS) fails (e.g. a CRL mirror temporarily returns 404), `complete` retries itself **2 times** with the same state, signature and
TSA timestamp (3 attempts in total; waits of ~1 s, ~3 s + 0–25% jitter) — without asking for the PIN again.
`ltvRetries` (default 2, `0` — disable); if all fail, `LTV_UNAVAILABLE`. `signal` (an `AbortSignal`) aborts the TSA/OCSP/CRL downloads and
the waits — it throws `signal.reason` (by default a `DOMException` `AbortError`). The outer loop above is only needed for
`TSA_UNAVAILABLE` and long outages. If OCSP/CRL (signed by the issuer) says a chain certificate is
**revoked** (0.21.0), it immediately gives `LTV_UNAVAILABLE`, with `cause` a `CertificateRevokedError` and `retryable` false — it does not
retry (previously a revoked OCSP was skipped and the DSS was assembled from the CRL). OCSP/CRL also follow the CertID/issuer/freshness
rules (§ validate).

**OCSP/CRL ordering (0.46.1).** `complete` obtains revocation evidence for each chain certificate according to its role:
for the first chain certificate (citizen, TSA) — OCSP first (an ordinary 10 s timeout, the "later than the timestamp" rule), then the CRL
(if both are valid, both go into the DSS); for CA certificates (all the others) — the CRL first, and if a valid CRL was obtained it does **not
send** a request to that certificate's OCSP responder; only if there is no valid CRL, OCSP (10 s). If neither is valid → `LTV_UNAVAILABLE` (fail-closed),
and an issuer-signed "revoked" (OCSP or CRL) → `CertificateRevokedError`. Previously an OCSP responder that accepted a connection for a CA certificate
and never answered delayed every signature by ~20 s. In the DSS only the CRL goes in for CA certificates.
`validatePdf`'s online revocation is unchanged (only for certificates from eID's 04/05, OCSP → CRL).

`PadesError.code` (stable, the same on every platform): `PDF_INVALID`, `PDF_ENCRYPTED`, `PDF_LOCKED` (DocMDP P=1),
`PDF_TOO_LARGE`, `PDF_TOO_MANY_SIGNATURES`, `PDF_PRIOR_SIGNATURE_INVALID`, `PDF_FOREIGN_SIGNATURE`, `SIGNER_INVALID`,
`REQUEST_INVALID`, `SIGNATURE_INVALID` (the state is unchanged — it can be signed again), `TSA_UNAVAILABLE`, `LTV_UNAVAILABLE`
(`retryable`), `SELF_VALIDATION_FAILED`, `PLACEHOLDER_OVERFLOW`, `STATE_INVALID`, `INTERNAL` (TS only — not in Go).
The `state` contains the prepared PDF — store it with the same confidentiality as the PDF. The format is identical to the Go SDK (you can run `prepare` in the browser and
`complete` in a Go backend).

In 0.15.0, `eid.pdf` (`prepare`, `document`, `documentVerified`, `tokenPrepare`, `tokenFinalize`, `tokenDocument`) and
`pdfMaxBytes` were removed (`pdfTimeoutMs` was added back in 0.19.0 for `registerSignature` — below) — the PDF upload endpoints no longer exist on the CA (removed on 2026-10-14, 404).

**Timeouts.** `registerSignature` (`POST /pdf/signatures` — the CA verifies the CMS + TSA + LTV) has had its own
`pdfTimeoutMs` since 0.19.0, default **80 s** (`DEFAULT_PDF_TIMEOUT_MS`; the same as the Go SDK's `Config.PDFTimeout` / `DefaultPDFTimeout`);
other calls use `timeoutMs` (default 15 s). In 0.18.x the registration timed out at the ordinary 15 s.

## 3e. Word → PDF in the browser — `@gerege-systems/eid-mongolia-sdk/convert`

If the citizen picks a Word (.docx / .doc) document, the browser itself converts it to PDF — **the file does NOT go to the server** (the same principle as §3d).
The converter is a WebAssembly build of LibreOffice 24.8 (`@matbee/libreoffice-converter@2.7.2`, MPL-2.0), in a Web Worker.
The signature is made **on the converted PDF, not on the Word file** — you must show the citizen that PDF (exactly those bytes) BEFORE signing
and have them accept it as "reviewed"; the conversion may shift fonts, lines and pages (`warnings`).

```bash
npm install @gerege-systems/eid-mongolia-sdk @matbee/libreoffice-converter@2.7.2   # optional peer — only for /convert
npx eid-mongolia-convert-assets public/eid-convert                                 # at build time; do not commit to git (~190 MB + .br/.gz)
```

```ts
import { wordToPdf, converterStatus, isWordFile, ConvertError } from "@gerege-systems/eid-mongolia-sdk/convert";
import { prepare } from "@gerege-systems/eid-mongolia-sdk/pades";

if (isWordFile(file)) {
  const s = await converterStatus({ assetsBase: "/eid-convert/" });   // { cached, downloadBytes } — warn about mobile data
  const { pdf, pages, warnings } = await wordToPdf(file, {
    assetsBase: "/eid-convert/",
    signal: controller.signal,                                        // cancel → DOMException AbortError
    onProgress: ({ phase, percent, loaded, total }) => show(phase, percent), // download (first time only) → init → convert
  });
  preview(pdf);                       // the citizen reviews and accepts
  const p = await prepare(pdf, { signerCert, verifyPage: true, fileName: "Contract.pdf" });   // §3d
}
```

| Function | Description |
|---|---|
| `wordToPdf(file, { assetsBase, onProgress?, signal?, fileName?, verbose? })` | `{ pdf, pages, warnings }`. Reuses one worker; calls are queued. `verbose: true` — LibreOffice's diagnostic log to the console (silent by default; the worker restarts when the value changes) |
| `converterStatus({ assetsBase })` | `{ cached, downloadBytes }` — to tell the size before downloading (the brotli size; 0 if cached) |
| `isWordFile(file \| name)` | whether it is .docx / .doc (name, MIME). The content is checked by `wordToPdf` from the first bytes |
| `disposeConverter()` | stops the worker and frees memory (the cache remains) |

**On the host (required).**
- The conversion page is **crossOriginIsolated**: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` (SharedArrayBuffer). It can be set only on that route — then navigate to that page with a **hard navigation**
  (`<a href>`, not a client-side router). Otherwise `wordToPdf` immediately gives `NOT_ISOLATED` (it does not wait). Under COEP, external
  images and iframes without CORP/CORS will not load.
- The assets are on **your own host** (`assetsBase`): `manifest.json` — `Cache-Control: no-cache`; `<version>-<hash>/*` —
  long cache (`public, max-age=31536000, immutable`), `.wasm` → `application/wasm`. What is downloaded the first time, the SDK
  stores in Cache Storage (no re-download); when the folder changes the old one is deleted.
- **Compression.** `eid-mongolia-convert-assets` writes a `.br` (brotli 11) and a `.gz` (gzip 9) beside every file —
  serve them with `brotli_static` / `gzip_static` on the server (dynamic compression is far too slow for the 147 MB wasm). Sizes (2.7.2):

  | file | uncompressed | gzip | brotli |
  |---|---|---|---|
  | soffice.wasm | 147.4 MB | 48.5 MB | 33.8 MB |
  | soffice.data | 43.2 MB (upstream 99.7 MB) | 11.9 MB | 7.1 MB |
  | soffice.js + other JS | 0.5 MB | 0.1 MB | 0.1 MB |

  Total first download ≈ 41.0 MB brotli / 60.6 MB gzip (previously 77 MB gzip). brotli 11 is slow on soffice.wasm (~4 min on an M4 Pro)
  — to speed up the build use `EID_CONVERT_BROTLI_QUALITY=9` (wasm 39.2 MB, ~9 s). nginx (the ngx_brotli module):

  ```nginx
  location /eid-convert/ {
      brotli_static on;          # <file>.br, when Accept-Encoding: br
      gzip_static   on;          # <file>.gz, otherwise
      types { application/wasm wasm; application/octet-stream data; text/javascript js; application/json json; }
      add_header Cache-Control "public, max-age=31536000, immutable";   # + the worker CSP below (*.js)
      location = /eid-convert/manifest.json { add_header Cache-Control "no-cache"; }
  }
  ```

  The SDK counts decompressed bytes (`onProgress`'s `loaded`/`total`) and checks them against the manifest's `bytes`, so progress is correct whichever
  compression the server uses. Safari asks for brotli only over HTTPS.
- **soffice.data was trimmed** (99.7 → 43.2 MB): fonts not needed for Writer → PDF (Arabic, Hebrew, Armenian, Georgian,
  Libertine…), the UI configuration of Calc/Impress/Draw/Math, the icon libraries and the gallery are removed; NotoSans/NotoSerif (the Ө Ү
  substitute) and all `registry/*.xcd` (OMML formulas) remain. If the sha256 of the upstream `soffice.data` / `soffice.js` does not match,
  the copy fails. On 4 documents (table, image, chart, formula, Cyrillic in 11 fonts) the PDF is pixel-identical.
  **When updating the upstream version** (`@matbee/libreoffice-converter` 2.7.2 → …): regenerate `DATA_TRIM`'s sha256 and the removal list
  on the new build and confirm with `npm run test:convert-e2e` (Chromium + WebKit) — tables, Ө Ү, formulas.
- A **separate CSP** for the worker scripts (`<assetsBase><version>/*.js`): `default-src 'self'; script-src 'self'
  'wasm-unsafe-eval' 'unsafe-eval'` (Emscripten needs `eval` — only in the worker). The page's strict CSP (nonce +
  `'strict-dynamic'`) remains; `connect-src 'self'` is enough for the page.
- Console: with every conversion LibreOffice prints diagnostic lines such as "warn:vcl…" and "[LOK C++] …" (not errors).
  `eid-mongolia-convert-assets` (≥ 0.18.2) patches the upstream worker (only when verified by the sha256 of `@matbee/libreoffice-converter@2.7.2`)
  so that it does not emit these without `verbose: true`; `manifest.json` has `"patched": true`. If the hash
  does not match, it copies without the patch and warns — the conversion works, only the log appears. After updating the SDK, re-copy
  the assets (`rev` changes so the worker's immutable cache is refreshed; if soffice.js is unchanged, soffice.wasm/.data are not
  downloaded again).
- Slow CPUs (0.21.0): the upstream `soffice.js`'s `pthreadPoolSize=4` hangs (deadlocks) when loading a document on slow
  computers, so `eid-mongolia-convert-assets` sets it to 8 (`"pthreadPoolSize": 8` in `manifest.json`;
  JS only). If the sha256 of `soffice.js` does not match the known 2.7.2, the copy fails — re-copy the assets.
- The ~80 s slowdown of the first conversion (≥ 0.44.1; not included in 0.44.0): the upstream glue starts LibreOffice's `main()` together with LibreOfficeKit's init, so even with pool 8, in some
  cold starts the first conversion (or init) was slowed by ~80 s.
  `eid-mongolia-convert-assets` now makes `soffice.js` not start `main()` (`shouldRunNow=false` —
  the same as `Module.noInitialRun`; `"noInitialRun": true` in `manifest.json`; JS only; the PDF's text, layout and raster are identical). Pool 8
  stays — even without `main()`, pool 4 hangs when saving on devices with ≤ 2 cores. Upstream:
  [issue #19](https://github.com/matbeedotcom/libreoffice-document-converter/issues/19) (PR #20, #21) — once a release containing both
  is out, the two patches will be dropped. After updating the SDK, re-copy the assets (the folder name and `rev` change;
  even if the content of `soffice.wasm` / `.data` is unchanged, they are downloaded once more from the new folder).
- MPL-2.0: `<version>/NOTICE.txt` (source code, licence link) must be served together with the assets — mention LibreOffice in the user-facing
  interface (in the help/licence section).

`ConvertError.code`: `UNSUPPORTED_ENVIRONMENT`, `NOT_ISOLATED`, `UNSUPPORTED_FILE`, `INPUT_TOO_LARGE` (empty or > 50 MiB),
`ASSETS_UNAVAILABLE` (`retryable`), `CONVERT_FAILED` (a corrupt / password-protected document). `warnings[].code`:
`FONT_SUBSTITUTED` (`fonts` — fonts the converter does not have and for which there is no metric-compatible substitute; the Liberation / Carlito / Caladea substitutes for Times New Roman / Arial /
Calibri / Cambria / Courier New do not trigger a warning), `FONT_FALLBACK` (`fonts` —
some characters in another font, e.g. Noto because Caladea has no Cyrillic), `PDF_NEAR_LIMIT` / `PDF_TOO_LARGE` (`bytes`,
`limit` — §3d `prepare`'s 10 223 616 bytes). Font warnings are only for .docx (heuristic); not for .doc.

Tested: Chromium and WebKit (Playwright, `npm run test:convert-e2e`) — .docx and .doc → PDF → `prepare`, no download on a cached re-run,
cancellation, a page without COEP. The 147 MB WASM needs a lot of memory in mobile browsers — it may crash on a weak
phone.

## 3f. Emailing the signed file — `eid.share()` (`SIGN` permission)

Sends your signed PDF as an attachment to the next signer / recipient (`POST /share`). The CA does **not store** the file: it checks
that it has a valid eID signature, sends it, and discards it. A separate email goes to each recipient.

> Always on at the CA (no flag since 2026-10-16). Read the limits and quota from `await eid.shareInfo()`;
> if `enabled` is false, the email service is temporarily not configured (503).

```ts
import { ShareError } from "@gerege-systems/eid-mongolia-sdk";

const info = await eid.shareInfo(); // { enabled, maxFileBytes, maxRecipients, quota: { perRPHour, perRPDay, perRecipientDay }, … }
if (info.enabled) {
  try {
    const r = await eid.share({
      file: signedPdf,                 // Uint8Array | ArrayBuffer | Blob/File; ≤ 3 080 192 bytes
      filename: "contract.pdf",           // with a .pdf extension; defaults to the File's name or document.pdf
      to: ["next@example.mn"],         // 1–5, no duplicates
      subject: "Contract — signature",   // ≤ 150; the CA adds a "‹RP name›: …" prefix
      message: "Please add the second signature", // ≤ 1000
      lang: "mn",                      // mn | en
    });
    console.log(r.sent, r.sha256, r.signatures, r.docID); // docID — if registered at the CA (a verify link goes in the email)
  } catch (e) {
    if (e instanceof ShareError) {
      // e.code: ShareErrorCode; 422 → e.reason; 502 → e.sent / e.failed / e.recipients ("sent" | "failed", in the order of to)
    }
    throw e;
  }
}
```

| HTTP | `ShareError.code` | Description |
|---|---|---|
| 400 | `REQUEST_INVALID`, `FILE_EMPTY`, `RECIPIENT_REQUIRED`, `TOO_MANY_RECIPIENTS`, `RECIPIENT_INVALID`, `RECIPIENT_DUPLICATE` | field errors |
| 413 | `FILE_TOO_LARGE` | the file / email exceeds the limit |
| 415 | `FILE_TYPE_NOT_SUPPORTED` | not a PDF (the extension, Content-Type and `%PDF-` must all match), a PDF that cannot be parsed or is encrypted |
| 422 | `FILE_NOT_SIGNED` | `.reason`: `no_signature` \| `invalid` \| `untrusted` |
| 429 | `RATE_LIMITED` | quota; `.retryAfterMs`, `.retryable` |
| 502 | `MAIL_FAILED` | `.sent`, `.failed`, `.recipients` — resend only the `failed` ones |
| 503 | `MAIL_UNAVAILABLE`, `VALIDATOR_UNAVAILABLE`, `VALIDATOR_BUSY` (`SHARE_DISABLED` — older CA) | configuration / load (`VALIDATOR_*` — Retry-After) |

401 → `AuthenticationError`, 403 (no SIGN permission, IP/mTLS) → `ForbiddenError`. Quota: per RP 300 requests per hour / 3000 per day,
10 emails per day per recipient (take the actual values from `shareInfo().quota`). The timeout defaults to 150 s (`timeoutMs`).

## 3g. Verifying a signed PDF — `@gerege-systems/eid-mongolia-sdk/validate` (0.20.0)

Verifies the PDF **inside the browser or Node** — the file is not sent anywhere. The rules of the CA's public verifier (`/v3/validate/pdf`,
Go SDK `pades.ValidatePDF`), the same JSON report (snake_case); the conformance suite is one across all three.

```ts
import { validatePdf, ValidatePdfError } from "@gerege-systems/eid-mongolia-sdk/validate";

try {
  const rep = await validatePdf(new Uint8Array(await file.arrayBuffer())); // default: the national Root CA, online revocation
  rep.indication; // "valid" | "invalid" | "indeterminate"
  for (const s of rep.signatures) {
    s.signer_name; s.signing_time; s.signature_level; s.certificate_level; s.problems; s.visible; s.key_medium;
  }
} catch (e) {
  if (e instanceof ValidatePdfError) e.code; // PDF_NO_SIGNATURE | PDF_INVALID | PDF_ENCRYPTED | PDF_TOO_LARGE | PDF_TOO_MANY_SIGNATURES | UNSUPPORTED_ENVIRONMENT | REQUEST_INVALID (roots/intermediates/issuers)
}
```

- Error codes (0.20.1): `PDF_ENCRYPTED` — a document with `/Encrypt` (RC4, AES-128, AES-256; even with an empty user
  password) cannot be verified: "An encrypted PDF cannot be verified — remove the protection and try again" (Go `pades.ValidatePDF`,
  the same at the CA). `UNSUPPORTED_ENVIRONMENT` — `crypto.subtle` is missing (an http page — not a secure context — or an old browser):
  an https page or a newer browser is required (previously `PDF_INVALID`).

- Checks: ByteRange (the gap is exactly `/Contents`) and messageDigest, the CMS signature (WebCrypto), signingCertificateV2,
  the chain (national 01 → 02/03 → 04/05), KU/EKU, validity (at the timestamp's time), the RFC 3161 token, revisions AFTER the signature
  (any change other than eID's signature/LTV → `modified_after_signing`), the visible signature (APPEARANCE_SPEC §5), `ltv`,
  `certificate_level` (qcStatements: QUALIFIED/QSCD, otherwise ADVANCED).
- Revocation (for certificates issued by eID's 04/05): online — the AIA OCSP, otherwise the CDP CRL (`fetch` + AbortSignal; in the browser
  `http://ocsp.|crl.eidmongolia.mn` → https, CORS `*`); with no response, or with `offline: true`, the document's DSS. If neither →
  `revocation_unavailable`. Only the certificate's serial (the OCSP request) goes over the network.
- Revocation evidence rules (0.21.0, the same as Go v0.7.2, golden validate v4): the OCSP is for THIS certificate (CertID =
  hash of the chain issuer's name/key + serial), and the CRL is the issuer's (name, AKI, signature). A "good" must be fresh at the time of checking:
  thisUpdate not in the future (5 min tolerance), nextUpdate not passed, and either thisUpdate ≤ 24 hours ago or
  thisUpdate…nextUpdate covers the check time (check time = the trusted timestamp's time, otherwise `time`/now).
  Otherwise it is not counted → `revocation_unavailable`. An issuer-signed "revoked" (OCSP or CRL, online or DSS)
  always overrides a "good". **Some documents that were `valid` before are now `indeterminate` or `invalid`.**
- Untrusted PDF: before parsing, array/dictionary nesting > 256 → `PDF_INVALID` (`prepare` too; `complete` —
  `STATE_INVALID`). It is only one layer of defence — limit the size (≤ 10 MiB) and the time.
- Options: `roots`, `intermediates`, `issuers` (DER, for tests), `time`, `offline`, `fetch`, `signal`.
- `key_medium` — from the certificate only: a citizen SIGN with qcStatements → `phone`, otherwise `unknown`. The CA (`POST /v3/validate/pdf`)
  determines `token` from its own registry, and `server_software` / `server_hsm` for organizational seals issued by eID (the key is on
  the server side; this is not a claim of QSCD) — the type (`SignatureReport["key_medium"]`, 0.45.0) has five values. `session_id`, `doc_id`, `on_behalf_of_*` come from the CA's registry — they are not in the local report.
- Browser bundle (minified): ~253 KB, gzip ~137 KB (`npm run size:validate`, limit 300 KB).

## 3h. "My QR" — in-person verification (`eid.qr`, 0.37.0)

The citizen shows "My QR" in the eID app (`EIDMN-QR1:<token>`, 120 s, single-use). The RP (a till, POS, app) scans it →
on their phone the citizen approves, with PIN2 (the QUALIFIED signing key), the sentence "You are about to share all the information in the "My information" section with <RP>" → the RP receives the citizen's **own**
signed (PS256 JWS, `x5c` = [SIGN certificate, issuing CA]) "My information" (the keys/values stored in the app exactly as they are, plus the face JPEG image).
The RP needs only the `QR_PRESENT` permission. The CA does not store the data in the DB — it is deleted on the RP's first successful read.

```ts
import { QrError, QrTokenInvalidError, SessionFailedError } from "@gerege-systems/eid-mongolia-sdk";

const s = await eid.qr.start({ qr: scanned, nonce: orderId }); // if no nonce is given, base64url(16 bytes); no VC
// s ({ sessionId, nonce }) can be stored as JSON — result/check verify the nonce and the session.
try {
  const p = await eid.qr.result(s); // or for a polling UI: await eid.qr.check(s) → { complete: false } | { complete: true, result }
  p.data;          // { birth_date: "1990-01-01", given_name: "Bat", … } — in payload order, keys verbatim
  p.source;        // "dan" | "passport" | "citizenid" | "gsign" | "guardian" | "unknown" | …
  p.photo;         // Uint8Array (JPEG) | undefined
  p.signer;        // { certificate, etsi: "PNOMN-…", givenName, surname, commonName } — from the certificate
  p.signedAt;      // Date (iat)
  p.sha256;        // hex SHA-256(signingInput) = the CA's audit qrsha (to match in a dispute)
} catch (e) {
  if (e instanceof QrTokenInvalidError) {/* start: 404 — ask for a new QR */}
  else if (e instanceof SessionFailedError) {/* USER_REFUSED, TIMEOUT … */}
  else if (e instanceof QrError && e.code === "QR_PRESENTATION_GONE") {/* already read / expired — a new QR */}
  else if (e instanceof QrError && e.code === "QR_REVOCATION_UNKNOWN") {/* no OCSP response — temporary, verify again */}
  else if (e instanceof QrError) {/* a QR_* check failed — DO NOT TRUST */}
  else throw e;
}
```

Verification (`verifyQrPresentation(jws, expect, trust)`; the same as the Go / .NET SDKs, `test/fixtures/myqr_vectors.json`):
shape (≤ 512 KiB, 3 segments) → the header is exactly `alg` PS256 / `typ` `eidmn-myqr+jwt` / `x5c` of 2 certificates (`QR_HEADER_INVALID`)
→ chain: x5c[1] ∪ `trust.intermediatesPem` → `trust.trustAnchorsPem` (default `NATIONAL_ROOT_CA_PEM`), time ± 60 s, not a CA,
KeyUsage contentCommitment, QUALIFIED (qcStatements), the issuer allowlist (default `CITIZEN_ISSUING_CA_SKI`), RSA ≥ 2048
(`QR_CHAIN_INVALID`; x5c[1] is never an anchor) → revocation `trust.revocation` (if absent, the SDK's OCSP; `revocationMode`
defaults to hard-fail: `QR_CERT_REVOKED` / `QR_REVOCATION_UNKNOWN`) → PS256 (salt 32) over the received bytes
(`QR_SIGNATURE_INVALID`) → claims: `iss` = `https://ca.eidmongolia.mn`, `sub` = the certificate's serialNumber, `statement` exactly equal to the one
assembled from `rp_name` (`QR_CLAIMS_INVALID`), `aud` = the RP UUID (case-insensitive,
`QR_AUDIENCE_MISMATCH`), `sid` (`QR_SESSION_MISMATCH`), `nonce` (`QR_NONCE_MISMATCH`), `0 < exp − iat ≤ 300`,
`iat ≤ now+60` (`QR_NOT_YET_VALID`), `now < exp+60` (`QR_EXPIRED`) → data: `source` `^[a-z0-9_-]{1,32}$`, `fields`
≤ 128 keys (1–64 characters, no control characters), string values ≤ 2048 bytes, `photo` strict base64 JPEG ≤ 150 KiB,
no other members (`QR_DATA_INVALID`). `trust` = `ClientConfig.trust` (`allowUntrusted` and `checkKeyUsage: false` do not
apply here).

If the citizen has not answered when `result`'s `maxWaitMs` runs out, `QrError` `QR_PENDING` (you may call again). The CA's codes
(`code` of `ApiError` / `ForbiddenError`): 400 `REQUEST_INVALID` (nonce 16–128 bytes ASCII 0x21–0x7E), 403
`PERMISSION_DENIED` / `RP_REQUIRED`, 404 `QR_TOKEN_INVALID`, 409 `NO_SIGNING_CERTIFICATE`, 429 `RATE_LIMITED`; `GET /session`'s
410 → `QrError` `QR_PRESENTATION_GONE` (the presentation is given only once). The `qr.issuer` setting — for test environments only.

## 3i. Organizational electronic seal (e-Seal) — `eid.seal`, `sealPdf` (0.42.0)

A **human-free, automated** system seals documents on behalf of an organization (invoices, certificates, statements): the key stays on eID's
server, no citizen/PIN/app is involved, and the response is immediate (no session). The RP needs that organization's **`SEAL:<orgEtsi>`** permission —
the permission is **granted by the organization itself** (below, "Seal permission, key, validity"); without it, `ForbiddenError` 403.
For a citizen signing on behalf of an organization, see §3a (not a seal). Backend only (the RP secret).

```ts
import { sealPdf, PadesError } from "@gerege-systems/eid-mongolia-sdk/pades";

const done = await sealPdf(eid.seal, "NTRMN-6235972", pdfBytes, { reason: "Invoice" });
writeFileSync("sealed.pdf", done.pdf); // PAdES-BASELINE-LT, with the organization's seal
```

- Flow: `eid.seal.getCertificate(org)` (`GET /seal/certificate/{orgEtsi}`) → `prepare` (signerCert = the seal cert) →
  the 32-byte DTBS to `eid.seal.seal(org, dtbs, "SHA-256")` (`POST /seal/{orgEtsi}`, `{digest, hashType}`) → `complete`.
  The PDF does not go to eID.
- **An RFC 3161 timestamp is required** (the eID TSA, `complete.tsaUrl`): if the TSA is unreachable, `TSA_UNAVAILABLE`, and a file
  without a timestamp is never returned; OCSP/CRL + DSS → B-LT. There is no verification (QR) page — a seal does not enter the citizen signature
  registry (`registerSignature`), so no `/verify/{docId}` link is provided.
- The verifier (`validatePdf`, the CA's `/v3/validate/pdf`) classifies this signature as `certificate.usage: "seal"` — show it to users
  as an "Organization seal".
- **The visible seal stamp — `sealPdf`'s default CHANGED** (APPEARANCE_SPEC.md §6.4, the same as Go's `SealPDF`):
  by default `sealPdf` makes the stamp VISIBLE — in the bottom-right corner of the document's last (not the eID verify) page, 220 × 64 pt
  (`x = page width − 256`, `y = 36`; on a small page it fits as `w = min(220, pw − 8)`, `h = min(64, ph − 8)`),
  moving to free space if it overlaps content (PLACEMENT_SPEC.md); the final placement is in `result.placement`. If the stamp does not
  fit on the page or the output exceeds the size limit, the seal is invisible (no `placement`). To place it yourself, use
  `appearance: { x, y, width, height, page?, lang?, exact? }` (invalid/not fitting gives `REQUEST_INVALID`, too large gives
  `PDF_TOO_LARGE`). **`invisible: true` — an invisible seal byte-identical to the previous `sealPdf`.** When calling `prepare` directly:
  `prepare(pdf, { signerCert: <the seal cert>, appearance })` → `eid.seal.seal` → `complete`. The variant is chosen ONLY by the certificate (§6.1: not a CA, KeyUsage has nonRepudiation and
  no digitalSignature, no EKU purposes — extendedKeyUsage absent or empty): an e-Seal cert → a stamp without QR/link/role (name, "eID Mongolia-аар тамгалсан" /
  "Sealed with eID Mongolia", date), no `docId` required, no 45 pt minimum height (f = 11 at 220 × 64 pt); any other cert →
  the citizen stamp (unchanged). The placement and `suggestPlacement` are the same as for a citizen. From this version `validatePdf` regenerates the stamp
  from the certificate and compares — if the certificate/stamp disagree, the earlier signatures become `modified_after_signing`. **Note:**
  a verifier that has not implemented §6.3 (until the CA's `/v3/validate/pdf` is updated, and earlier versions of this SDK) treats a revision with a seal
  stamp as a modification of the earlier signature — until the CA validator ships §6.3, do not produce a visible seal for an RP
  (`invisible: true`).
- **A seal stamp with a QR (APPEARANCE_SPEC.md §6.5, golden v13) — verifier only.** From this version `validatePdf`
  also accepts a seal stamp with a QR: if the e-Seal certificate's form stream starts with `/EIDVerify`, it is regenerated and compared with the same
  structure as the citizen stamp (QR, the `/EIDVerify` BDC, the URL's rev/docId check) as a stamp with the "eID Mongolia-аар тамгалсан" ("Sealed with eID Mongolia") label and no role line;
  if it does not start with it, as a stamp without a QR. The marker decides the variant — the other one is not tried, and on a mismatch
  the earlier signatures become `modified_after_signing`. **Writers still emit the stamp without a QR:** `sealPdf`
  and `prepare` have no public option to produce a seal with a QR (`sealPdf`'s output is byte-identical to 0.48.x); a stamp without a QR
  stays valid forever. No writer will emit a seal with a QR until the CA validator and the `/verify` bundle ship §6.5.
- **`prepare`'s docId (APPEARANCE_SPEC.md §6.6):** if a signed document has no verify-page link, it takes the docId of the earliest-signed
  `/EIDVerify` stamp among the verified **e-Seal** signatures (the marker's rev = that signature's
  order, `/V` not indirect, a single widget per signature, `/Filter` absent or a direct `null`); a citizen stamp never becomes
  the source. Giving a `docId` different from the one found gives `REQUEST_INVALID` — **even for an invisible signature** (a behaviour change:
  for a document with a QR seal and no verify page, an invisible signature used to take `opts.docId` or "", and now
  takes the seal's docId). If nothing is found, `opts.docId`, otherwise "" — a random docId is never generated for a signed document
  (a stamp that draws a QR then gives `REQUEST_INVALID`, as before). If reading a seal stamp is corrupt, `PDF_INVALID`.
  `sealPdf`'s returned `docId` (not the output bytes) becomes the previous QR seal's docId for such a document.
- `eid.seal.seal` validates the response: the signature must match the digest under the response's certificate, and the certificate must be an e-Seal profile
  (`isSealCertificate`: KeyUsage = nonRepudiation only, no EKU purposes — extendedKeyUsage absent or empty) — otherwise `ValidationError`.
  `hashAlgorithm`: `SHA-256` (default) | `SHA-384` | `SHA-512`.
- Errors: `PadesError` `SIGNER_INVALID` (the cert is not an e-Seal, or it changed between sealing — try again),
  `SIGNATURE_INVALID`, `TSA_UNAVAILABLE` / `LTV_UNAVAILABLE` (`retryable`); RP-API errors remain: **429
  `RATE_LIMITED`** → `ApiError` (`retryable`, retry after `retryAfterMs`; 300 seals per minute per RP), 404 —
  organization not found, **409** — every code has its own error class (table below, 0.45.0), **503
  `SEAL_SERVICE_DISABLED`** → `SealServiceDisabledError` (below, "Service disabled").
- `eid.seal.getCertificate(org)` returns the organization's **current (issued, active)** seal certificate — it does not issue
  a new one; if not issued / revoked / outside the validity period, **409** (`SealNotIssuedError` | `SealCertRevokedError` |
  `SealCertExpiredError` | `SealCertNotYetValidError`) — an invalid certificate is never returned with 200. Go: `pades.SealPDF`; .NET:
  `EidPades.SealAsync`.

### Requesting seal permission — RP-initiated (0.47.0)

Without an operator: log the organization's **CEO** in through your system (an AUTHENTICATION session), and send the permission request with that
session. The CEO sees the RP's name and the organization in their eID app and approves with **PIN2**. No billing is
charged; the `SEAL:<orgEtsi>` permission is not required in advance.

```ts
import {
  ForbiddenError, AuthSessionTooOldError, AuthSessionAlreadyUsedError, SealGrantRequestError,
} from "@gerege-systems/eid-mongolia-sdk";
import { sealPdf } from "@gerege-systems/eid-mongolia-sdk/pades";

// 1. Log the CEO in (your RP's auth session, completed with OK) — keep the sessionId.
const session = await eid.auth.notificationByEtsi("PNOMN-12345678", [{ type: "displayTextAndPIN", displayText60: "Log in" }]);
const result = await eid.session.waitForResult(session.sessionId, { expiresAt: session.expiresAt });
eid.validator.validateAuth(result, session.acsp!); // the login must be OK

// 2. Send the request within 5 minutes of the login — the push goes only to that CEO.
try {
  const g = await eid.seal.requestGrant("NTRMN-6235972", session.sessionId); // 202 {grantId, status: "PENDING", expiresAt}
  // 3. Wait until the CEO approves with PIN2.
  await eid.seal.waitForGrant(g.grantId, { timeoutMs: 10 * 60_000 });
  // 4. Now /seal/{orgEtsi} works.
  const sealed = await sealPdf(eid.seal, "NTRMN-6235972", pdfBytes);
} catch (e) {
  if (e instanceof ForbiddenError && e.code === "NOT_ORG_CEO") {
    // the person who logged in is not the organization's CEO verified by the state registry
  } else if (e instanceof AuthSessionTooOldError || e instanceof AuthSessionAlreadyUsedError) {
    // log the CEO in again and request with the new session
  } else if (e instanceof SealGrantRequestError) {
    // e.outcome: "REJECTED" | "EXPIRED" | "FAILED" | "REVOKED" → a new login + request; "TIMEOUT" → you may wait again with the same grantId
  } else throw e;
}
```

- `requestGrant(orgEtsi, sessionId)` — `POST /seal/grants` `{orgEtsi, sessionId}` → `SealGrantRequest` (`grantId`,
  `status: "PENDING"`, `expiresAt`). `sessionId` — an AUTHENTICATION session started by your RP and completed with OK within the last **5 minutes**;
  the person must be the organization's **CEO** verified by the state registry, and the push goes only to them. **One session — one request**;
  calling again with the same session returns the same PENDING request.
- `grantStatus(grantId)` — `GET /seal/grants/{grantId}`: `status` = `PENDING` | `APPROVED` | `REJECTED` | `EXPIRED` |
  `FAILED` | `REVOKED`; `approvedAt`, `revokedAt`, `failure`. Only the RP that owns the request (others get `SealGrantNotFoundError`).
  The permission is **valid until revoked** (the CEO revokes it from the eID app, or an operator does → `REVOKED`; `expiresAt` is only the time
  allowed to approve a PENDING request).
- `waitForGrant(grantId, { timeoutMs = 15 min, intervalMs = 3 s, signal })` — polls until APPROVED and returns;
  REJECTED / EXPIRED / FAILED / REVOKED / timeout → `SealGrantRequestError` (`outcome`, `grantId`, `failure`).
  It waits out 429/503 + Retry-After the same way as `waitForCertificate`.
- `eid.organization.sealGrants(personEtsi)` — `GET /organization/seal-grants/etsi/{personEtsi}` (PKI_READ; the citizen has logged in through your RP
  within the last 24 hours): every organization where the citizen is CEO in the state registry
  (`orgEtsi`, `orgName`, `orgStatus`) and their permissions (`grants[]`: `grantId`, `rpName`, `rpDomain?`, `status`,
  `createdAt`, `decidedAt?`, `expiresAt?`, `approverName?`, `sealCount`, `sealCount30d`, `lastSealedAt`). An ordinary RP sees only
  its own permissions. Read-only.
- Errors (`requestGrant`): **400 `REQUEST_INVALID`** → `RequestInvalidError`; **403 `RP_NOT_REGISTERED` | `NOT_ORG_CEO`** →
  `ForbiddenError` (`e.code`); **404 `AUTH_SESSION_NOT_FOUND`** → `AuthSessionNotFoundError` (also for another RP's session),
  **404 `ORG_NOT_FOUND`** → `ApiError`; **409** `AUTH_SESSION_WRONG_FLOW` / `AUTH_SESSION_NOT_COMPLETED` /
  `AUTH_SESSION_TOO_OLD` / `AUTH_SESSION_ALREADY_USED` → `AuthSessionWrongFlowError` / `AuthSessionNotCompletedError` /
  `AuthSessionTooOldError` / `AuthSessionAlreadyUsedError`; `ORG_NOT_ACTIVE` → `OrgNotActiveError`; `RP_NOT_ACTIVE` →
  `RpNotActiveError`; `SEAL_GRANT_ALREADY_APPROVED` → `SealGrantAlreadyApprovedError`; `RP_PERMISSIONS_FULL` →
  `RpPermissionsFullError`; `SEAL_APPROVER_UNAVAILABLE` → `SealApproverUnavailableError`; **429 `RATE_LIMITED`** →
  `ApiError` (`retryAfterMs`). The code list: `SEAL_GRANT_ERROR_CODES`. Go: `Seal.RequestGrant` / `GrantStatus` /
  `Organization.SealGrants`.

### Seal permission, key, validity (0.45.0)

- **The permission (`SEAL:<orgEtsi>`) — with the organization's consent.** **Your RP can request the permission itself** (above, "Requesting seal permission",
  0.47.0), or an eID operator creates the request. On both paths the permission arises only after that organization's **state-registry-verified**
  CEO/ADMIN sees the RP's name, domain, the organization's name and registry number in their eID app and approves with **PIN2**. Until
  approved (even if rejected or expired), sealing and
  certificate requests (`seal`, `sealPdf`, `requestCertificate`, `getCertificateRequest`) give `ForbiddenError` 403
  (`getCertificate` needs no permission). If an operator removes the permission or the organization is revoked, the permission becomes invalid (403). While the
  permission exists, the RP's name, callback host and mTLS certificate subject cannot be changed (an operator-side rule — to change them,
  the permission must be obtained again).
- **The key.** The seal key is ECDSA P-256, a **software key** held on eID's server (wrapped by an HSM key) —
  **not a QSCD**. The certificate level is `QUALIFIED` (under Mongolian law; without QcSSCD) — not EU qualified.
- **Validity, renewal.** The certificate is valid for 3 years. Renewal = a new request (`requestCertificate`): a new key and a new
  certificate are issued, and the previous one is revoked (superseded). A document sealed with the previous certificate remains valid if it has a timestamp —
  `sealPdf`'s output (PAdES-BASELINE-LT) satisfies this.
- **Revocation.** After revocation, `seal` / `sealPdf` / `getCertificate` → `SealCertRevokedError`; a document sealed BEFORE the revocation
  is still valid in verification (`revoked_after_signing`).
- **Third-party verifiers.** The chain goes up to Mongolia's national Root CA; the OCSP / CRL addresses are in the certificate. Unless the national Root is
  trusted manually, Adobe and EU verifiers will not show the seal as trusted / qualified.

| HTTP `code` | Error | Where | What to do |
|---|---|---|---|
| 409 `ORG_NOT_ACTIVE` | `OrgNotActiveError` | `seal`, `sealPdf`, `requestCertificate` | the organization is not ACTIVE — do not retry until restored |
| 409 `SEAL_NOT_ISSUED` | `SealNotIssuedError` | `seal`, `sealPdf`, `getCertificate` | no certificate issued — `requestCertificate` |
| 409 `SEAL_CERT_REVOKED` | `SealCertRevokedError` | `seal`, `sealPdf`, `getCertificate` | revoked — request a new certificate |
| 409 `SEAL_CERT_EXPIRED` | `SealCertExpiredError` | `seal`, `sealPdf`, `getCertificate` | expired — request a new certificate |
| 409 `SEAL_CERT_NOT_YET_VALID` | `SealCertNotYetValidError` | `seal`, `sealPdf`, `getCertificate` | the validity period has not started |
| 409 `SEAL_KEY_UNAVAILABLE` | `SealKeyUnavailableError` | `seal`, `sealPdf` | the key is missing from the server configuration — contact eID support |
| 409 `SEAL_APPROVER_UNAVAILABLE` | `SealApproverUnavailableError` | `requestCertificate` | no ADMIN with an active eID |
| 404 `SEAL_REQUEST_NOT_FOUND` | `SealRequestNotFoundError` | `getCertificateRequest`, `waitForCertificate` | wrong request id |
| 503 `SEAL_SERVICE_DISABLED` | `SealServiceDisabledError` | `seal`, `sealPdf`, `requestCertificate` | disabled by an operator — do not retry |

All are subclasses of `ApiError` (`status`, `code`, `body` unchanged; `retryable` false) — existing `instanceof ApiError` /
`e.code` branching keeps working. The code list: `SEAL_ERROR_CODES` (`SealErrorCode`). 403 → `ForbiddenError`, 429
`RATE_LIMITED` → `ApiError` (`retryable`).

```ts
import { SealCertRevokedError, SealCertExpiredError, SealNotIssuedError, OrgNotActiveError } from "@gerege-systems/eid-mongolia-sdk";

try {
  await sealPdf(eid.seal, org, pdfBytes);
} catch (e) {
  if (e instanceof SealNotIssuedError || e instanceof SealCertRevokedError || e instanceof SealCertExpiredError) {
    // no active seal certificate → eid.seal.requestCertificate(org) (the organization's ADMIN confirms with PIN2)
  } else if (e instanceof OrgNotActiveError) {
    // the organization is suspended / revoked — do not retry
  } else throw e;
}
```

### Issuing a seal certificate (0.43.0)

Neither the RP nor an operator issues the certificate directly — a **request** is created. Every valid **ADMIN** representative of the organization (with an active
eID device, ≤ 5) receives a request in the eID app, "I approve the issuance of the electronic seal certificate of "<organization>"", and
confirms with **PIN2**. As soon as one ADMIN confirms, the certificate is issued (`ISSUED`); if they decline, `REJECTED`; if the approval period (the signing
session TTL + 2 min) ends, `EXPIRED`.

```ts
import { SealApproverUnavailableError, SealCertificateRequestError } from "@gerege-systems/eid-mongolia-sdk";

const req = await eid.seal.requestCertificate("NTRMN-6235972"); // 202 {requestId, status: "PENDING", expiresAt, approvers}
try {
  const cert = await eid.seal.waitForCertificate("NTRMN-6235972", req.requestId, { timeoutMs: 10 * 60_000 });
  // cert: {certificate (DER), serialNumber, notBefore, notAfter, certificateLevel, …} — same shape as getCertificate
} catch (e) {
  if (e instanceof SealCertificateRequestError) {
    // e.outcome: "REJECTED" | "EXPIRED" | "FAILED" → a new request; "TIMEOUT" → you may wait again with the same requestId
  } else if (e instanceof SealApproverUnavailableError) {
    // (requestCertificate) the organization has no ADMIN with an active eID
  } else throw e;
}
```

- `requestCertificate(org)` — `POST /seal/certificate/{orgEtsi}` → `SealCertificateRequest` (`requestId`, `status:
  "PENDING"`, `createdAt`, `expiresAt`, `approvers`). If the organization has a PENDING request, the CA returns it (no new push).
- `getCertificateRequest(org, requestId)` — `GET /seal/certificate/{orgEtsi}/requests/{requestId}`: `status` = `PENDING` |
  `APPROVED` (being issued) | `ISSUED` (`certificate` populated) | `REJECTED` | `EXPIRED` | `FAILED` (`failure`:
  `SEAL_ISSUANCE_FAILED` | `PUSH_FAILED` | `SEAL_SERVICE_DISABLED`). A one-off check (for your own UI poll).
- `waitForCertificate(org, requestId, { timeoutMs = 15 min, intervalMs = 3 s, signal })` — polls until ISSUED and returns the
  certificate; REJECTED / EXPIRED / FAILED / timeout → `SealCertificateRequestError` (`outcome`, `requestId`,
  `failure`). On 429/503 + Retry-After (`ApiError.retryable`) it waits out the Retry-After and continues; when `signal` aborts,
  `signal.reason`.
- Errors: **409 `SEAL_APPROVER_UNAVAILABLE`** → `SealApproverUnavailableError`; **409 `ORG_NOT_ACTIVE`** →
  `OrgNotActiveError` (0.45.0; previously a 409 without a code) — the organization is not ACTIVE;
  **404 `SEAL_REQUEST_NOT_FOUND`** → `SealRequestNotFoundError` (also for another organization's id); 403 → `ForbiddenError`
  (no `SEAL:<orgEtsi>` permission); **429 `RATE_LIMITED`** → `ApiError` (`retryAfterMs`) — 5 requests per hour per organization (protects against
  PIN2 push spam). Request-status polls do not count; **503 `SEAL_SERVICE_DISABLED`** →
  `SealServiceDisabledError` (below).

### Service disabled — `SealServiceDisabledError` (503 `SEAL_SERVICE_DISABLED`)

An eID operator can disable the two seal services platform-wide, separately. When disabled, the CA returns
`503 {"error", "code": "SEAL_SERVICE_DISABLED", "service"}` (without Retry-After) — and the SDK throws `SealServiceDisabledError`
(a subclass of `ApiError`; `status: 503`, `code`, `service`):

| `service` | Where | Meaning |
|---|---|---|
| `"issuance"` | `eid.seal.requestCertificate` | certificate issuance is disabled — new requests are not accepted |
| `"sealing"` | `eid.seal.seal`, `sealPdf` | sealing is disabled |

```ts
import { SealServiceDisabledError } from "@gerege-systems/eid-mongolia-sdk";

try {
  await sealPdf(eid.seal, "NTRMN-6235972", pdfBytes);
} catch (e) {
  if (e instanceof SealServiceDisabledError) {
    // e.service: "issuance" | "sealing" | undefined — show the user "the service is temporarily disabled"; do not retry automatically
  } else throw e;
}
```

- `retryable` is always `false`: since the CA does not say when it will be back on, the SDK (`sealPdf`, `waitForCertificate`) does not retry and
  throws immediately. Other 503s (e.g. `STATE_UNAVAILABLE` + Retry-After) remain an `ApiError` (`retryable`).
- If a pending request was approved by an ADMIN but issuance is disabled, the request becomes `FAILED`, `failure: "SEAL_SERVICE_DISABLED"`
  (no certificate is issued) — `waitForCertificate` → `SealCertificateRequestError` (`outcome: "FAILED"`, `failure`); once issuance
  is back on, create a new request.
- Never disabled: `getCertificate`, the polls of `getCertificateRequest` / `waitForCertificate`, verification
  (`validatePdf`, the CA's `/v3/validate/*`), OCSP/CRL — documents sealed earlier stay valid.
- Live status: the `seal` block of [`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid) — `{issuanceEnabled,
  sealingEnabled, disabledCode: "SEAL_SERVICE_DISABLED"}`.
- `certificateLevel` (in `getCertificate` and `seal`'s response) comes from the certificate itself: `QSCD` if it has QcSSCD, otherwise
  `QUALIFIED`.

## 4. QR and same-device — device link v3

The citizen scans the **QR** on another device's screen with their phone, or, if they opened the RP's site/app on the **same phone** as the eID app, a button
opens the app (**Web2App** — the phone browser, **App2App** — the RP's app). The link is built
ONLY by the RP backend with `buildDeviceLink` (Smart-ID RP-API v3 "dynamic link"):

```
QR:      {deviceLinkBase}?deviceLinkType=QR&elapsedSeconds={E}&sessionToken={T}&sessionType=auth&version=1.0&lang=mon&authCode={A}
Web2App: {deviceLinkBase}?deviceLinkType=Web2App&sessionToken={T}&sessionType=auth&version=1.0&lang=mon&authCode={A}
```

- `authCode = BASE64URL(HMAC-SHA256(sessionSecret, …))` — protects the link type, the session, the RP's challenge and the callback.
  The server binds the type to the session, and the signature's `flowType` = that type (it cannot be forged).
- **The QR refreshes every second** (`elapsedSeconds = floor(now − receivedAt)`); the server rejects a QR older than ~20 seconds
  → a link forwarded over SMS/messenger will not work.
- Keep `sessionToken` and **`sessionSecret` on the backend only** — NEVER send them to the browser/app.
  The browser fetches the ready-made QR link from a backend endpoint every second.
- To show both a QR and a button on one page, start ONE session (with `callbackUrl`) and build two links.
  Web2App/App2App are valid only for a session with `callbackUrl`.
- Contract: [developer.eidmongolia.mn](https://developer.eidmongolia.mn/) and ca-eidmongolia-mn `docs/DEVICE_LINK_V3.md`.

```ts
import { buildDeviceLink, type DeviceLinkSession } from "@gerege-systems/eid-mongolia-sdk";

// backend — start the session and store the whole response ON THE SERVER (sessionToken/sessionSecret/receivedAt/acsp)
const s = await eid.auth.deviceLinkAnonymous(
  [{ type: "displayTextAndPIN", displayText60: "Log in to Khan Bank" }],
  { callbackUrl: "https://bank.example.mn/auth/eid/callback?state=…" }, // if showing a button; the host must be in callbackHosts,
  // the path is always normalized to /auth/eid/callback (only the query is kept), https required
);
store.put(s.sessionId, s);
res.json({ sessionId: s.sessionId, vc: s.vc }); // ONLY these go to the browser

const link = (s: DeviceLinkSession, type: "QR" | "Web2App" | "App2App") =>
  buildDeviceLink({
    deviceLinkBase: s.deviceLinkBase!,
    deviceLinkType: type,
    sessionToken: s.sessionToken!,
    sessionSecret: s.sessionSecret!,
    sessionType: "auth",
    lang: "mon",
    receivedAt: s.receivedAt, // the SDK records the moment the response was received
    rpChallenge: s.acsp!.rpChallenge,
    relyingPartyName: s.acsp!.relyingPartyName,
    interactions: s.acsp!.interactions,
    initialCallbackUrl: s.acsp!.initialCallbackUrl, // not part of authCode for QR
  });

// GET /eid/qr?sessionId=…  → the browser calls this every second and redraws the QR (Cache-Control: no-store)
app.get("/eid/qr", (req, res) => {
  const s = store.get(String(req.query.sessionId)); // check that it belongs to the caller's own browser session
  if (!s) return res.sendStatus(404);
  res.set("Cache-Control", "no-store").json({ link: link(s, "QR") });
});
// on a phone: the button's href = link(s, "Web2App") (once, no refreshing)
```

To push over SSE/WebSocket, use `qrDeviceLinkTicker(input, (link) => send(link))` — it emits a link immediately, then every second,
and you stop it with the returned function (required when the session ends/the client disconnects).

**Always check the type you showed (relay protection).** `expectedFlowType` = the type of link the RP showed:

```ts
// QR page → a result completed via polling
eid.validator.validateAuth(result, s.acsp!, { expectedFlowType: "QR" });

// Web2App/App2App button → the app returns to the callback URL with `userChallengeVerifier` added
eid.validator.validateAuth(result, s.acsp!, {
  expectedFlowType: "Web2App", // "App2App" if the button is inside the RP's app
  userChallengeVerifier: callbackQuery.get("userChallengeVerifier") ?? undefined,
});
// push (notificationBy*) → "Notification"
```

On a page showing both a QR and a button: check a result that arrived via the callback as `Web2App`/`App2App`, and one that arrived by polling as
`QR` (a session opened with the button finishes only through the callback).

> ⚠️ **Legacy links removed.** The server removed the static `{deviceLinkBase}?sessionId=…&vc=…` link on 2026-10-07, and
> the SDK removed `deviceLink` / `openOrShowQR`, which built it, in 0.16.0 — only v3 (`buildDeviceLink`) works.
> v3 (`flowType`, `userChallengeVerifier`) is supported from iOS 2.2.3 (59) / Android 60; as of 2026-10-20 the minimum version the server enforces is iOS ≥ 2.2.8, Android ≥ 91
> (`/mobile/app-config`, §"Minimum eID app version").

## Security — why the `validator` is required

**Do not trust `endResult === "OK"` on its own.** If the RP-API is corrupted/proxied, a forged
OK could arrive. So the `ResponseValidator`:

1. `state === COMPLETE && endResult === OK`
2. Verifies the citizen's certificate by chain up to the **trust anchor (Mongolian National Root CA)**
   (Root → National Issuing CA → Gerege Issuing CA → eID Mongolia Issuing CA → citizen) — RFC 5280 path validation
   (the same rules as the Go SDK's `x509.Certificate.Verify`): issuer name + AKI/SKI + signature, CA basicConstraints +
   **pathLenConstraint** (04 is `pathlen:0`), the CA's keyUsage keyCertSign, the validity period of each CA, **EKU** (auth →
   clientAuth, sign → emailProtection — the CA's profile; if the CA has an EKU, it must fall within it), an unrecognized **critical
   extension** → rejected. If a CA with **name constraints** is in the chain, fail-closed (none in the CA's real chain).
   The response does not carry the chain — if `intermediatesPem` is not provided, the SDK's built-in 02, 03, 04 (`CITIZEN_INTERMEDIATES_PEM`,
   since 0.19.0). certificatePolicies in the chain are not checked (the level is — 3).
3. The certificate is within its validity period + the required `certificateLevel` (default `QUALIFIED`). **Since 0.19.0 the level is
   determined from the certificate** (`certificateLevelOf`): for a signing certificate, qcStatements QcCompliance → QUALIFIED
   (+ QcSSCD → QSCD; phone and USB tokens issued after 2026-11-06 are QUALIFIED), without qcStatements (tokens issued before that) → ADVANCED; for an authentication certificate the CA does not write qcStatements,
   so by profile → QUALIFIED: KeyUsage
   keyEncipherment (the phone's P-CITIZEN-AUTH), or EKU clientAuth + emailProtection with the national policy
   `2.16.496.1.101.1.2.8` (the token's P-CITIZEN-AUTH-TOKEN, since 0.40.3); anything else → ADVANCED. If the response's `certificateLevel`
   is higher than that, it is rejected; if lower, the response's is taken (the CA declares an old token's AUTH as ADVANCED). The returned
   `certificateLevel` = this value.
4. Verifies the signature with the citizen's public key:
   - **auth** → over the ACSP_V2 payload (`smart-id|ACSP_V2|serverRandom|rpChallenge|userChallenge|B64(rpName)|B64(brokeredRpName)|B64(SHA-256(interactions))|interactionTypeUsed|initialCallbackUrl|flowType`, hash = the request's `hashAlgorithm`) — it also checks `flowType`, `userChallenge`, `serverRandom` and algorithm downgrade;
     if `expectedFlowType` is given, `flowType` must EXACTLY match the flow that was started, and for Web2App/App2App `userChallengeVerifier` is required;
     `initialCallbackUrl` is taken from the response's `signature.initialCallbackUrl` (the CA decides by flow: QR/Notification →
     `""`, Web2App/App2App → your callback) — only when it is `""` or
     the callback you sent, and for Web2App/App2App it must be your callback; any other value → rejected
   - **sign** → over the digest the RP supplied; if `expectedFlowType` is given, the response's `flowType` must EXACTLY match (it is not part of the signature — a response check)
   - the algorithm is tied to the certificate's key: `ecdsa-with-SHA256` only for EC P-256 keys, the RSA algorithms only for
     RSA keys (alg-confusion protection). The hash always EXACTLY equals the requested one. The RP-API session's signature at the CA comes from
     SplitKey RSA (all current mobile certificates) or legacy threshold ECDSA P-256; the ECDSA credential
     signs only a SHA-256 digest (the server will not produce a signature for a session that requested another hash), so if a session that requested
     SHA-384/512 gets an `ecdsa-with-SHA256` response, it is rejected as forged.

5. Revocation — `trust.revocation` (an OCSP/CRL hook) → `checkRevocation`, or `checkRevocationStatus` (`"good"` /
   `"unchecked"` (soft-fail) / `"skipped"` (no hook)). The ready-made hook: `ocspRevocationChecker()` — the certificate's AIA OCSP
   (revoked/unknown → `"revoked"`; no response → `"unknown"`, the mode decides). For a one-off with a different checker/mode: `checkRevocationWith`.
6. **Issuer and purpose (defaults since 0.19.0):** `allowedIssuerSkis` defaults to `[CITIZEN_ISSUING_CA_SKI]` (when a trust anchor
   is configured) — only certificates from the citizen Issuing CA (04) (an organization's 05 etc. under the same root are blocked;
   to disable: `allowAnyIssuer: true`); `checkKeyUsage` defaults to `true` — auth → KU digitalSignature + EKU clientAuth,
   sign → KU nonRepudiation (the CA's profile) — a signature by an authentication (PIN1) key does not qualify for `validateSign`
   (to disable: `checkKeyUsage: false`, not recommended). `schemeName` — the CA's `acsp_scheme_name` (default `smart-id`).

If any step fails it throws `ValidationError` — **do not trust** the response. The error text never contains the citizen's name, PNOMN or registry number
(`NetworkError.op` rewrites the path to `/etsi/…`) — it can be written straight to logs.

## Error types

| Error | Meaning |
|---|---|
| `AuthenticationError` | 401 — API secret wrong/missing; for a CA JSON response `.serverMessage` (+ `.code`), absent for a proxy's (`.body`, `.headers`) |
| `ForbiddenError` | 403 — IP allowlist / mTLS / the RP's permission; if onBehalfOf is rejected, `.code` (`OnBehalfErrorCode`) |
| `SessionFailedError` | endResult ≠ OK (TIMEOUT, USER_REFUSED…) — distinguish by `.endResult` |
| `ValidationError` | cert chain/signature/level validation failed |
| `NoSigningCertificateError` | 409 `NO_SIGNING_CERTIFICATE` — no signing certificate / device (sign, cert-choice start); a subclass of `ApiError` |
| `CertChoiceInvalidError` | 409 `CERT_CHOICE_INVALID` — the linked sign's certificate-choice is invalid; a subclass of `ApiError` |
| `RequestInvalidError` | 400 `REQUEST_INVALID` — a bad request (e.g. `linkedSessionID` missing); a subclass of `ApiError` |
| `ShareError` | `share()`'s 4xx/5xx (other than 401/403) — `.code` (`ShareErrorCode`), `.reason` (422), `.sent`/`.failed`/`.recipients` (502); a subclass of `ApiError` |
| `ApiError` | other HTTP errors (`.status`, `.body`, the server's `.code`, `.retryAfterMs`, `.headers`, `.retryable` — e.g. 404 `ORG_NOT_FOUND`) |
| `ResponseTooLargeError` | the response exceeds the SDK's limit (JSON 4 MiB) — `.op`, `.limit` |
| `NetworkError` | timeout/network (`.op` — a path without identifiers, `.timeout`) |
| `PadesError` (`/pades`) | client-side PAdES — `.code` (§3d), `.retryable` |
| `DeviceLinkError` | a device-link link cannot be built (`deviceLinkBase` is not https, the shape of token/secret/lang, a field required for the type is missing) |

## mTLS (eIDAS qualified environment)

```ts
import { Agent } from "undici";
const eid = new EidClient({
  /* … */
  dispatcher: new Agent({ connect: { cert: clientCertPem, key: clientKeyPem } }),
});
```

## Development

```bash
npm install
npm run lint          # tsc --noEmit (main + tsconfig.button.json)
npm test              # build + node --test (pades golden — byte-identical to the Go reference)
npm run golden:check  # test/fixtures/pades/golden + src/pades/assets ↔ the pinned Go commit
npm run size:pades    # the /pades browser bundle gzip ≤ 300 KB
npm run test:convert-e2e   # /convert with real LibreOffice in Chromium (BROWSER=webkit — WebKit)
```

The `/pades` conformance fixtures (golden: the inputs, the test PKI's certificates, the fixed TSA/OCSP/CRL responses, the expected
sha256) and the font/chain assets are copied from the Go reference by `node scripts/sync-pades-golden.mjs` (`GO_SDK_COMMIT` —
tag `pades-golden-vN`, currently v7 — with the `placement/` scanner vectors, page 0 skips the verify page, `exact` +
`expect.suggestion`); CI checks it against the pinned commit with `--check`. Profile:
the Go repo's `pades/PROFILE.md`, `PAGE_SPEC.md`, `PRECHECKS.md`, `WIRE.md`, `APPEARANCE_SPEC.md`, `PLACEMENT_SPEC.md`.

### Contract check

Every RP-API route the SDK calls (`src/contract.ts`) must be in the live [`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid)'s
`endpoints`. Routes that are in discovery but not covered by the SDK are a WARN (not a failure). Because it needs the network, it is not part of `npm test`:

```bash
npm run test:contract
```

CI: `.github/workflows/contract.yml` — PRs, `main` pushes, daily at 00:00 UTC, manual.
