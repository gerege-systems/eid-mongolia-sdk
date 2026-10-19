# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia** (Монгол Улсын иргэний цахим үнэмлэх) Relying Party SDK — иргэнээр утсаар нь нэвтрэлт
(authentication) ба хууль ёсны цахим гарын үсэг (qualified signature) хийлгэх Node.js/TypeScript сан.
RP-API v3, Smart-ID нийцтэй. Бүрэн баримт: <https://developer.eidmongolia.mn/>.

> ⚠️ SDK **backend**-д ажиллана: бүх дуудлага API secret (`rp_sk_…`)-ээр баталгаажна, secret-ийг браузер/гар утсанд
> хэзээ ч задлахгүй. Браузерт зөвхөн таны backend-ийн өгсөн холбоос/QR/товч харагдана — «eID-ээр нэвтрэх» товч
> (`/button`) ч таны backend-ийг л дуудна (§1a). `@gerege-systems/eid-mongolia-sdk/browser` нь зөвхөн
> `isMobileUserAgent` ба алдааны классуудыг гаргана (legacy `deviceLink`/`openOrShowQR` 0.16.0-д хасагдсан, §4). Үл хамаарах: `@gerege-systems/eid-mongolia-sdk/pades` (клиент талын PDF
> гарын үсэг, secret-гүй) хөтөч болон Node-д ажиллана (§3d).

## Суулгах

```bash
npm install @gerege-systems/eid-mongolia-sdk
```

Node.js ≥ 18 (global `fetch`, `node:crypto`) — бүх entry (`.`, `/browser`, `/button`, `/pades`; `/convert` зөвхөн хөтөч, §3e), CI-д Node 18 / 20 / 22-оор шалгагдана.
`/pades` мөн орчин үеийн хөтөчид (Web Crypto) ажиллана.

## 1. RP бүртгүүлэх

RP-г eID Mongolia-гийн оператор бүртгэнэ — хүсэлтээ <eIDsupport@gerege.com> эсвэл 7777-3773-аар гаргана
(нийтийн `POST /v3/rp-applications` 2026-10-14-нөөс засвартай: `503 rp_applications_maintenance`). Оператор
баталсны дараа **relyingPartyUUID** ба **API secret** (`rp_sk_…`) олгогдоно; secret **зөвхөн нэг удаа** харагдана.
Шаардлагатай мэдээлэл (байгууллага, зорилго `AUTH`/`SIGN`, `callbackHosts`…):
<https://developer.eidmongolia.mn/#registration>.

## 1a. «eID-ээр нэвтрэх» — нэг товч

Smart-ID-тэй RP-үүдийн хэв маяг: хөтөчид **нэг товч**, бүх eID дуудлага таны **backend**-д (API secret-ээр). SDK хоёр
хэсэг өгнө — backend-ийн бэлэн урсгал `createEidLogin` ба хөтчийн товч `@gerege-systems/eid-mongolia-sdk/button`.
Доорх нь §2/§4-ийн RP-API (device link v3, push, `ResponseValidator`)-ийг л ашиглана; тусдаа протокол биш.

| Хаана | Юу болно |
|---|---|
| Desktop хөтөч | Цонх: QR (секунд тутам шинэчлэгдэнэ) + баталгаажуулах код + «Хүсэлтийн хугацаа m:ss» (сүүлийн 30с анхааруулах өнгө) + «Регистрийн дугаараар нэвтрэх» товч (ижил цонхонд доош дэлгэгдэх push хэсэг), шууд төлөв |
| Утасны хөтөч | Товч → `start?mode=web2app` → сервер 302 → eID апп (Web2App). Апп баталгаажуулаад `/auth/eid/callback` руу буцаана |
| Backend | session эхлүүлэх, QR угсрах (`sessionSecret` серверт), poll, `validateAuth` (гинж + ACSP_V2 + `flowType` + Web2App-д `userChallengeVerifier`) → таны `onSuccess` |

**Endpoint-ууд** (`/auth/eid` дор — eID сервер Web2App буцах замыг үргэлж `/auth/eid/callback` болгож нормчилдог):

| | Хүсэлт | Хариу |
|---|---|---|
| `POST /auth/eid/start` | `{"mode":"qr"}` эсвэл `{"mode":"push","idCode":"УБ12345678"}` (JSON заавал) | `{mode, vc, qr?, expiresIn}` + `Set-Cookie: eid_login` |
| `GET /auth/eid/start?mode=web2app` | утасны хөтөч (товчны навигаци) | `302` → eID апп |
| `GET /auth/eid/status` | cookie | `PENDING` (+шинэ `qr`, `expiresIn`) · `WAIT_CALLBACK` · `OK` (`redirect`, `data`) · `FAILED` (`error`) · `EXPIRED` |
| `GET /auth/eid/callback` | апп буцаана: `?sessionId&userChallengeVerifier` | `303` → `onSuccess`-ийн `redirect` / `successRedirect`, алдаа бол `failureRedirect?eid_error=<код>` |

**Backend** (нэг instance-ийг модулийн түвшинд):

```ts
import { EidClient, NATIONAL_ROOT_CA_PEM, createEidLogin } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  credentials: { rpUUID: process.env.EID_RP_UUID!, rpName: "Интернэт банк", apiSecret: process.env.EID_SECRET! },
  // Root (01) — итгэлийн тулгуур; завсрын 02 → 03 → 04 нь SDK-д суусан (CITIZEN_INTERMEDIATES_PEM, анхдагч).
  trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] },
});

export const eidLogin = createEidLogin({
  client: eid,
  callbackUrl: "https://bank.example.mn/auth/eid/callback", // host нь RP-ийн callbackHosts-д; утасны урсгалд заавал
  async onSuccess(id) {
    // id.etsi (PNOMN-…) — хэрэглэгчийг ҮҮГЭЭР таньна; id.givenName/surname (латин), id.person (кирилл, байвал)
    // id.sessionId, id.documentNumber, id.certificateDerB64 — дараагийн алхамд (гарын үсэг, гэрчилгээ холбох)
    const user = await users.findOrCreateByEtsi(id.etsi);
    const sid = await sessions.create(user.id); // ШИНЭ session (session fixation)
    return {
      redirect: "/dashboard",
      headers: { "Set-Cookie": `app_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax` },
    };
  },
  // store: redisStore,            // олон instance / serverless бол (анхдагч — процессын санах ой)
  // rateLimit: { start: (key) => redisLimiter.allow(key) }, // анхдагчтай нэгтгэгдэнэ (push 3/мин хэвээр) — доор «Хязгаарлалт»
  trustProxy: 1, // handle(Request)-д клиент IP: nginx/LB нэг hop бол 1 (доор «Клиент IP»)
  onEvent: ({ kind, sessionId, meta }) => audit.record(`auth.eid_${kind}`, sessionId, meta), // таны аудит
  // auditKey: process.env.EID_AUDIT_KEY, // pushKey-ийг instance/restart хооронд тогтвортой болгох
});
```

Next.js App Router — `app/auth/eid/[action]/route.ts`:

```ts
import { eidLogin } from "@/lib/eid";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => eidLogin.handle(req);
export const POST = (req: Request) => eidLogin.handle(req);
```

**Клиент IP** (`start:<ip>` хязгаар). Web-standard `Request`-д IP байдаггүй — `handle(req)` ашиглаж байвал аль нэгийг өг:

- `trustProxy: n` — итгэмжит reverse proxy-ийн ард: `X-Forwarded-For`-ийн **баруунаас n** дахь утга (n = таны proxy-ийн тоо),
  XFF байхгүй бол `X-Real-IP`. `true` = XFF-ийн зүүн утга (proxy нь клиентийн XFF-ийг дарж бичдэг үед л). Proxy-гүй
  үед бүү асаа — header-ийг клиент хуурамчаар илгээнэ.
- `getClientIp: (req) => …` — платформын IP (Bun `server.requestIP(req)?.address`, Deno `info.remoteAddr.hostname`,
  Vercel `req.headers.get("x-real-ip")`). `trustProxy`-оос давуу.

Аль нь ч үгүй бол IP-ээр хязгаарлахгүй (эхний хүсэлтэд `onError`-оор нэг удаа анхааруулна). `handleRequest`-д `req.ip`
(Express `req.ip`, `app.set("trust proxy", …)`-тэй) шууд хэрэглэгдэнэ. Go: `eidlogin.Config.ClientIP` (`eidlogin.ForwardedClientIP(n)`) — ижил дүрэм.

**Хязгаарлалт** (`rateLimit`). Түлхүүр: `start:<ip>` (IP мэдэгдэж байвал), `push:<idCode>`; татгалзвал 429 + `Retry-After: 60`.
Анхдагч `defaultRateLimit` = `{ start: { limit: 20, windowMs: 60_000 }, push: { limit: 3, windowMs: 60_000 } }` — нэг
IP-ээс минутад 20 эхлэл (0.19.0-аас; IP мэдэгдэж байвал — `req.ip` / `trustProxy`), нэг дугаарт минутад 3 мэдэгдэл
(MFA fatigue). Санах ойн хязгаарлагч төрөл тус бүрд ≤ 10 000 түлхүүр: дүүрвэл цонх нь өнгөрсөнийг цэвэрлэж, хоосроогүй
бол **шинэ** түлхүүрийг 429-өөр татгалзана (fail-closed) — байгаа тоолуурыг хэзээ ч арилгахгүй тул олон IP/дугаараар
дүүргэж хязгаарыг тойрох боломжгүй. `memoryLoginStore(max = 10_000)` ч мөн адил: дүүрвэл start 503 `{ error: "busy" }`,
эхэлсэн нэвтрэлтийг устгахгүй. Олон instance бол Redis store/limiter.

- **Объект** `{ start?, push? }` — анхдагчтай **нэгтгэгдэнэ**: өгсөн төрөл анхдагчийг дарна, өгөөгүй нь анхдагчаараа үлдэнэ.
  Утга: `{ limit, windowMs }` (процессын санах ойн гулсах цонх), `(key) => boolean | Promise<boolean>` (Redis г.м.),
  эсвэл `false` (тухайн төрлийг хязгаарлахгүй). Өөр түлхүүр → `createEidLogin` throw.
- **Функц** `(key) => …` — бүх түлхүүрт дуудагдана, анхдагч хязгаар **дээр нэмэгдэнэ** (хоёулаа зөвшөөрөх ёстой).
  Анхдагчийг сулруулах/солих бол объектоор тухайн төрлийг өг (`{ push: … }`).

```ts
import { defaultRateLimit } from "@gerege-systems/eid-mongolia-sdk";
rateLimit: { start: { limit: 60, windowMs: 60_000 } },             // NAT-ын ард олон хэрэглэгчтэй бол; push 3/мин хэвээр
rateLimit: { start: false },                                       // start-ийг өөрийн давхаргад (nginx/gateway) хязгаарладаг бол
rateLimit: { ...defaultRateLimit, start: (k) => redis.allow(k) },  // ижил — анхдагчийг илэрхий бичсэн
rateLimit: { push: (k) => redis.allow(k, 3, 60) },                 // олон instance: push-ийг Redis-ээр солино
```

Go: `eidlogin.Config.RateLimits` (`map[string]eidlogin.RateRule{"start": {Max: 20, Window: time.Minute}}`,
`eidlogin.DefaultRateLimit()`) — ижил нэгтгэл; `Config.RateLimit` функц мөн анхдагч дээр нэмэгдэнэ.

Express:

```ts
app.use("/auth/eid", express.json(), async (req, res) => {
  const r = await eidLogin.handleRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body, ip: req.ip });
  res.status(r.status).set(r.headers).send(r.body);
});
```

**Хөтөч** — Web Component (React/Vue/энгийн HTML аль нь ч):

```html
<script type="module">import "@gerege-systems/eid-mongolia-sdk/button";</script>
<eid-login-button start-url="/auth/eid/start" status-url="/auth/eid/status" lang="mn"></eid-login-button>
<script type="module">
  document.querySelector("eid-login-button").addEventListener("eid-login-success", (e) => {
    // e.detail = { state: "OK", redirect, data } — preventDefault() хийвэл redirect хийхгүй
  });
</script>
```

эсвэл `mountEidLoginButton(el, { startUrl, statusUrl, lang: "en", theme: "auto", successUrl, label, icon, variant, onSuccess, onError })`.

| Атрибут (`mount…` сонголт) | Утга | Анхдагч |
|---|---|---|
| `start-url` (`startUrl`), `status-url` (`statusUrl`) | backend endpoint | — (заавал) |
| `lang` | `mn` \| `en` | `mn` |
| `mode` | `auto` (утас → Web2App, бусад → QR цонх) \| `qr` \| `app` | `auto` |
| `theme` | `auto` \| `light` \| `dark` | `auto` |
| `success-url` (`successUrl`) | backend redirect өгөөгүй үед шилжих URL | — |
| `label` | товчны текст; `""` → зөвхөн лого | i18n: «eID-ээр нэвтрэх» / «Log in with eID» |
| `icon` | `eid` (eID лого) \| `none` (логогүй) | `eid` |
| `variant` | `default` (лого + текст) \| `icon` (зөвхөн лого, 44×44) | `default` |
| `aria-label` | товчны хүртээмжийн нэр (дэлгэц уншигч) | зөвхөн-лого үед `label` эсвэл i18n текст |

`label`, `icon`, `variant`, `aria-label`, `lang` өөрчлөгдөхөд товч шууд шинэчлэгдэнэ. `icon="none"` ба текстгүй
(`variant="icon"` эсвэл `label=""`) хослол нь хоосон товч болохгүй — анхдагч текст харагдаж, console-д нэг удаа анхааруулна.
Үйл явдал: `eid-login-success`, `eid-login-error` (доор).

**`eid-login-error`** (0.20.0) — start амжилтгүй болох эсвэл нэвтрэлт амжилтгүй дуусах бүрд (`bubbles: true`,
`composed: true` — shadow DOM-оос гадагш). `detail`:

| Талбар | Утга |
|---|---|
| `error` | код эсвэл төрөл (`EXPIRED`, `USER_REFUSED…`, `VALIDATION` …) — өмнөх хувилбартай ижил |
| `status` | start-ийн HTTP статус; сүлжээний алдаанд `0`; poll-ийн алдаанд `null` |
| `code` | хариуны `error`/`code`, эсвэл `HTTP_<статус>` / `NETWORK` |
| `retryAfter` | `Retry-After` (секунд) эсвэл `null` |

429 / 503 (`{"error":"busy"}`) үед товч «Систем завгүй — N сек дараа дахин оролдоно уу» / "Service busy — try again in N s"
гэж `Retry-After`-оор (анхдагч 30 с) тоолж, дуустал «Дахин оролдох» (push маягтад «Мэдэгдэл илгээх») идэвхгүй байна.

```js
document.querySelector("eid-login-button").addEventListener("eid-login-error", (e) => {
  const { status, code, retryAfter } = e.detail;
  if (status === 429 || status === 503) console.warn(`eID busy (${code}), retry in ${retryAfter ?? 30}s`);
});
```

Гадны хамааралгүй (QR encoder дотроо), цонх нь focus trap, Esc, `aria-live` төлөвтэй.

**Дизайн, theme.** Дизайн нь eID нэвтрэх хуудсынх (лого, өнгө). Фонт нь хуудаснаас өвлөгдөнө (товч, цонх, input бүгд).
`theme="auto"` үед дараалал: хуудасны `html[data-theme="dark|light"]` → `html.dark` / `html.light` → OS
(`prefers-color-scheme`); хуудас theme солиход (MutationObserver) шууд дагана. `theme="light|dark"` нь хуудсыг давна.
Өнгө, радиусыг CSS хувьсагчаар дарна. `--eid-*` нь зөвхөн **оролт** (shadow дотор тодорхойлогддоггүй) тул хуудасны
аль ч түвшинд (`:root`, эцэг элемент, `eid-login-button`) өгсөн утга өвлөгдөж **light ба dark хоёуланд** үйлчилнэ;
`--eid-<нэр>-dark` нь зөвхөн dark-д, `--eid-<нэр>`-ээс давуу. Аль нь ч үгүй бол eID-ийн анхдагч (доорх хүснэгт) — fallback л.
Dark-ийн дараалал: `--eid-<нэр>-dark` → `--eid-<нэр>` → dark анхдагч.

```css
:root {                                   /* эсвэл eid-login-button { … } */
  --eid-accent: var(--brand);             /* хоёр theme-д */
  --eid-accent-dark: var(--brand-400);    /* зөвхөн dark-д (өгөхгүй бол --eid-accent) */
  --eid-radius: 6px; --eid-radius-lg: 8px;
}
eid-login-button::part(button) { width: 100%; }  /* part: button, icon, label, backdrop, dialog */
eid-login-button::part(label) { font-weight: 600; }
eid-login-button::part(icon) { width: 24px; height: 24px; }
```

| Хувьсагч (`-dark` хувилбартай) | Юунд | Light анхдагч | Dark анхдагч |
|---|---|---|---|
| `--eid-accent` | үндсэн товч | `oklch(0.534 0.2 259)` | `oklch(0.64 0.15 259)` |
| `--eid-accent-fg` | үндсэн товчны текст | `#fff` | `hsl(229 50% 6%)` |
| `--eid-accent-subtle` | алхмын дугаарын дэвсгэр | `oklch(0.97 0.03 259)` | `oklch(0.24 0.06 259)` |
| `--eid-accent-subtle-fg` | алхмын дугаар | `oklch(0.474 0.19 259)` | `oklch(0.82 0.1 259)` |
| `--eid-ring` | focus | `oklch(0.604 0.2 259)` | `oklch(0.68 0.15 259)` |
| `--eid-bg` | цонх, outline товч, input | `hsl(0 0% 100%)` | `hsl(229 50% 6%)` |
| `--eid-bg-subtle` | — (нөөц) | `hsl(210 40% 98%)` | `hsl(222 47% 9%)` |
| `--eid-bg-muted` | hover | `hsl(210 40% 96%)` | `hsl(217 33% 13%)` |
| `--eid-fg` | текст | `hsl(222 47% 11%)` | `hsl(210 40% 98%)` |
| `--eid-fg-muted` | хоёрдогч текст | `hsl(215 19% 35%)` | `hsl(213 27% 84%)` |
| `--eid-fg-subtle` | тайлбар, placeholder | `hsl(215 16% 45%)` | `hsl(215 20% 65%)` |
| `--eid-border` | цонх, QR, тусгаарлагч | `hsl(214 32% 91%)` | `hsl(217 33% 17%)` |
| `--eid-border-strong` | outline товч, input | `hsl(213 27% 84%)` | `hsl(215 25% 27%)` |
| `--eid-warning-bg` / `-border` / `-fg` | сүлжээний анхааруулга | `hsl(48 100% 96%)` / `hsl(45 95% 78%)` / `hsl(23 75% 33%)` | `hsl(20 60% 10%)` / `hsl(22 70% 26%)` / `hsl(40 92% 65%)` |
| `--eid-danger-fg` | алдаа | `hsl(0 74% 42%)` | `hsl(0 91% 71%)` |
| `--eid-radius` / `--eid-radius-lg` (theme-гүй) | булан | `6px` / `8px` | — |

**eID аппын доод хувилбар.** `flowType` бэхлэлт (device link v3) ба Web2App-ийн `userChallengeVerifier` нь
**iOS 2.2.3 (build 59)**, **Android 2.2.3 (versionCode 60)**-аас эхэлсэн. eID сервер 2026-10-07-оос legacy холбоосыг
бүрэн хассан (v3-гүй session-д утас `DEVICE_LINK_REQUIRED`) бөгөөд доод хувилбарыг `/mobile/app-config`-оор албадан
шинэчлүүлдэг: Android 2026-10-07-оос ≥ 70 (төхөөрөмжийн баталгаатай), 2026-10-15-ны байдлаар iOS ≥ 2.2.7,
Android ≥ 83 (`curl https://ca.eidmongolia.mn/mobile/app-config`). Иймд гарын үсэг зурж чадах бүх апп эдгээрийг дэмжинэ —
RP талд нэмэлт шалгалт хэрэггүй. Эх сурвалж: eID CA-ийн `docs/DEVICE_LINK_V3.md` §5, §7; changelog
`2026-10-02-ios-min-version-2-2-3`, `2026-10-07-android-min-70`.

**Аюулгүй байдал.**

- `sessionToken`, `sessionSecret`, `rpChallenge` серверт (store) үлдэнэ; хөтөчид зөвхөн HttpOnly, Secure, SameSite=Lax cookie
  (`<sessionId>.<binding>`, store-д binding-ийн SHA-256). Status ба callback зөвхөн нэвтрэлтийг **эхлүүлсэн хөтөчид** хариулна —
  өөр хөтчид нээгдсэн callback URL (verifier-тэй ч) хүлээн авагдахгүй (login CSRF).
- `start` POST нь JSON заавал (simple request биш → cross-origin preflight), `Sec-Fetch-Site: cross-site` → 403.
- `OK` нь зөвхөн `validateAuth` амжилттай үед: QR → `flowType=QR`, push → `Notification`, утас → `Web2App` + callback-ийн
  `userChallengeVerifier`. Web2App session-ийг poll дуусгахгүй (`WAIT_CALLBACK`). `onSuccess` нэг session-д нэг л удаа
  (store-ийн `delete` атомар байх ёстой — Redis `DEL`).
- `onSuccess`-ийн `data` хөтөчид очно — нууц бүү оруул.
- **Регистрийн oracle хаалт (decoy + доод хугацаа, анхдагчаар асаалттай).** eID push-ийг дугаарын шалтгаанаар татгалзвал
  (eID-ийн өөрийн JSON 4xx — танихгүй / ашиглах боломжгүй дугаар) бодит push-тэй **ижил** хариу: `{mode, vc (санамсаргүй
  5 оронтой — eID-тэй ижил хэлбэр), expiresIn}`, ижил cookie; `status` нь eID-ээс асуулгүй `pollMs`-ийн хугацаанд барьж
  `PENDING`, TTL-ийн дараа `EXPIRED` — утсаа аваагүй иргэнтэй ялгаагүй (бодит push-ийн CA `TIMEOUT` ч `EXPIRED` болно). Push start-ийн хариу бүр (бодит, decoy, 502)
  `pushFloorMs`-оос (анхдагч 1000) хурдан гарахгүй — decoy-г цагаар ялгахгүйн тулд (`handle(Request)`-д хүсэлт тасарвал
  хүлээхгүй; `handleRequest`-д `signal` өг). Хязгаар (`push:<idCode>`, `start:<ip>`) decoy-д ч үйлчилнэ; 429 ба 400
  (`invalid_id` — хэлбэрийн алдаа, бүртгэлээс хамааралгүй) нь floor-гүй. eID-ийн 5xx, холболтын алдаа, JSON бус 4xx (eID-ийн
  өмнөх proxy, ж: mTLS татгалзал), 401/403 (RP-ийн нууц/эрх) ба 429 нь **decoy биш** — `502 eid_unavailable` / `429` (eID
  порталын зан: тасалдлыг decoy-оор нуувал иргэн дуусахгүй spinner харна; эдгээр нь дугаараас хамаардаггүй тул oracle
  биш). Унтраах: `decoy: false`, `pushFloorMs: 0` — **⚠️** тэгвэл `/start` нь «энэ регистр eID-д бүртгэлтэй эсэх»-ийг
  нэвтрээгүй хэнд ч хэлнэ; зөвхөн дотоод/тестийн орчинд.
- **Хугацаа (`ttlMs`, анхдагч 120 000) CA-ийн session-оос урт байхгүй.** QR / Web2App: `expiresIn`, cookie `Max-Age`,
  store = min(`ttlMs`, CA-ийн start хариуны `expiresAt` − одоо). Push (бодит ба decoy **ижил**): min(`ttlMs`, discovery
  `sessionTtl.auth`) — decoy-д CA хариу байхгүй тул CA-ийн `expiresAt`-аас бус discovery-оос (`client.auth.sessionTtl()`,
  10 мин кэш, алдаа бол `onError` + 1 мин-ийн дараа дахин) — хугацааны зөрүү oracle болохгүй. Хуучин CA (discovery-д
  `sessionTtl` алга): бодит push-ийн `expiresAt`-аас ажигласан утгыг дараагийн decoy авна (±1 с); анхны бодит push-ээс
  өмнө `ttlMs`.
- **Гэрчилгээний цуцлалт (OCSP, анхдагчаар асаалттай).** `validateAuth`-ийн дараа, `onSuccess`-ийн өмнө иргэний гэрчилгээг
  түүний AIA-д бичигдсэн OCSP responder-оос асууна (`revocation`, анхдагч `ocspRevocationChecker()`; хариу олгогч эсвэл
  түүний OCSPSigning responder-ийн гарын үсэгтэй, энэ serial-ийн, thisUpdate ≤ 48 цаг, good-ийг 5 мин кэшлэнэ). `revoked`,
  мөн `unknown` (олгогч энэ гэрчилгээг олгоогүй) → `FAILED` / `VALIDATION` (500 биш), `onSuccess` дуудагдахгүй. Хариугүй
  (timeout 2 с, 5xx, AIA алга, шалгалт унасан хариу): `revocationMode` анхдагч `"soft-fail"` — зөвшөөрч `onError`-оор
  анхааруулна, `identity.revocation = "unchecked"` (eID порталын `EID_OCSP=soft`: CA-ийн responder унавал бүх иргэн
  түгжигдэхгүй; утас session-ийг батлахад CA секундын өмнө хүрэх боломжтой байсан); `"hard-fail"` → `FAILED` /
  `VALIDATION`. `revocation: false` — **⚠️** цуцалсан (хулгайлагдсан утасны) гэрчилгээгээр нэвтэрнэ.
- **Аудит — `onEvent({ kind, sessionId, meta })`** (await хийгдэнэ, алдаа нь `onError` руу): `push_sent` (meta `decoy` —
  зөвхөн таны аудитад, хөтөч рүү хэзээ ч), `push_limited`, `refused` (иргэн татгалзсан), `expired` (TIMEOUT / eID-д
  олдохгүй), `unverified` (`reason`: `validation` | `revoked` | `revocation_unavailable`), `flow_refused` (Web2App callback
  өөр хөтчид), `success` (`flow`, `revocation`), `failed` (бусад `endResult`). meta-д `mode`; токен/нууц, регистрийн дугаар
  орохгүй — push-д `pushKey` = HMAC-SHA256(`auditKey`, дугаар)-ын 32 hex (`auditKey` алга бол процесс бүрт санамсаргүй).
- Олон instance / serverless (Vercel г.м.) дээр анхдагч санах ойн store ажиллахгүй — `EidLoginStore` (`get`/`set`/`delete`)-ийг Redis-ээр.
- `onSuccess` дуудагдахаас ӨМНӨ tx store-оос атомар устгагдана (нэг удаагийн баталгаа) — `onSuccess` дотор store-оос бүү
  унш; хэрэгтэй бүхэн `identity`-д (`sessionId`, `documentNumber`, `certificateDerB64`, …).

**Redis store** (SDK нэмэлт хамааралгүй — жишээ нь `ioredis`):

```ts
import Redis from "ioredis";
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
    return (await redis.del(key(sid))) === 1; // DEL атомар — зэрэг хоёр status-ийн зөвхөн нэг нь onSuccess дуудна
  },
};
```

Tx-д `sessionSecret` (QR угсрах материал) байдаг — Redis-ийг сүлжээнээс хаалттай, TLS/AUTH-тай ашигла.

## 2. Нэвтрэлт (push)

```ts
import { EidClient } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  // baseUrl анхдагч https://rp.eidmongolia.mn (RP-API, /v3-гүй) — mTLS-тэй RP ч мөн энэ хост
  credentials: {
    rpUUID: process.env.EID_RP_UUID!,
    rpName: "Интернэт банк", // дэд системийн нэр, ≤120 тэмдэгт
    apiSecret: process.env.EID_SECRET!, // rp_sk_…
  },
  trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] }, // ← Mongolian National Root CA, production-д ЗААВАЛ (завсрын 02–04 SDK-д суусан)
});

// ETSI (PNOMN-<иргэний дугаар>) / регистр / иргэний дугаар — аль нь ч болно (сервер танина)
const s = await eid.auth.notificationByEtsi("PNOMN-12345678", [
  { type: "displayTextAndPIN", displayText60: "Хаан Банк-д нэвтрэх" },
]);

showToUser(s.vc); // ← иргэний утсан дээр харагдах баталгаажуулах код (VC)

const result = await eid.session.waitForResult(s.sessionId); // long-poll
const who = eid.validator.validateAuth(result, s.acsp); // ← гинж + ACSP_V2 крипто-баталгаажуулна

console.log(who.documentNumber, who.subject); // баталгаажсан иргэн
const { name, serialNumber } = who.parsedSubject; // "Болд Бат", "PNOMN-12345678" (givenName/surname/commonName/country…)
```

Session-ий `person` блок (CA бүртгэлээс — гэрчилгээнд байдаггүй кирилл нэр, төрсөн огноо, хүйс) гарын үсэгт **ордоггүй** —
гэрчилгээний `SERIALNUMBER`-тэй тулгаж байж итгэнэ:

```ts
import { personMatchesCertificate } from "@gerege-systems/eid-mongolia-sdk";
if (personMatchesCertificate(result.person, who.parsedSubject)) {
  const { firstName, lastName /* ЭЦГИЙН нэр */, familyName /* УРГИЙН овог */, civilId, regNo, birthDate, gender, geID } = result.person!;
}
// result.raw — серверийн түүхий JSON (SDK задлаагүй талбарт)
```

Subject-ийн талбарууд (`parsedSubject`, `validateSign`-д ч мөн) нь `parseSubject(cert)`-ээс — OID 2.5.4.42/4/3/5/6/10/97,
UTF8String/PrintableString/BMPString. `parseSubject` нь зөвхөн задлалт: баталгаажаагүй гэрчилгээний нэрэнд бүү итгэ.

> **Ижил утсан дээр push хэрэглэхгүй.** Push (`notificationBy*`)-ийн хүсэлт eID аппад мэдэгдэл / «хүлээгдэж буй»
> жагсаалтаар ирдэг; Smart-ID ба eID-д Notification төрлийн device link **байхгүй** (CA `docs/DEVICE_LINK_V3.md` §3).
> Иргэн RP-ийг eID апптай ижил утсан дээр нээсэн бол push-ийн оронд **device-link Web2App** урсгал хэрэглэ
> (`auth.deviceLink*` / `signPdfDigest({ flow: "device-link" })` + `buildDeviceLink(…, "Web2App")`, §4) — товч аппыг шууд
> нээж, callback-аар буцна. Push-д «eID аппаа нээнэ үү» гэсэн текст л хангалттай.

## 3. Гарын үсэг (qualified signature)

```ts
import { sha256Base64 } from "@gerege-systems/eid-mongolia-sdk";

const digest = sha256Base64(pdfBytes); // баримтын SHA-256 (base64)

const s = await eid.sign.digestByEtsi("PNOMN-12345678", digest, [
  { type: "displayTextAndPIN", displayText60: "Зээлийн гэрээнд гарын үсэг зурах" },
]);
showToUser(s.vc);

const result = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(result, digest); // digest-ийн эсрэг баталгаажна

console.log(sig.signatureValueB64, sig.subject);
```

`SignOptions.fileName` — баримтын нэр CA-ийн /verify хуудас, иргэний түүхэнд харагдана (заавал биш).

Device-link / push-оор эхлүүлсэн sign session-д эхлүүлсэн урсгалаа `expectedFlowType`-оор тулга (`validateAuth`-тай
ижил: зөрвөл `ValidationError`). Гуравдах параметр нь `hashAlgorithm` мөр (хуучин хэлбэр) эсвэл объект:

```ts
eid.validator.validateSign(result, digest, { expectedFlowType: "QR" }); // эсвэл "Web2App" / "App2App" / "Notification"
eid.validator.validateSign(result, digest384, { hashAlgorithm: "SHA-384", expectedFlowType: "Web2App" });
```

RAW_DIGEST_SIGNATURE-д `flowType` гарын үсэгт ордоггүй (зөвхөн digest зурагдана) — энэ нь RP-API хариуны тулгалт.

**QR / Web2App / App2App** — `eid.sign.deviceLinkByEtsi` / `deviceLinkByDocument` (`callbackUrl`-тай бол Web2App/App2App);
холбоосыг backend-д `buildDeviceLink(deviceLinkInput(s, "QR", "mon"))` (auth/cert session-д ч мөн). `s.sign`
(`SignContext`: digest, hash, алгоритм, interactions, callback)-ийг session-тэй хамт серверт хадгал.

**`expiresAt`** (ms epoch) — session дуусах мөч: CA-ийн session start хариуны `expiresAt` (RFC 3339; auth / sign /
certificate-choice бүгдэд, 2026-10-14-өөс). Хуучин CA (талбаргүй) үед sign / certificate-choice-д SDK тооцоолно — CA-ийн
анхдагч 600с (`DEFAULT_SIGN_SESSION_TTL_MS`; CA админ 60–1800с болгож болно → `signSessionTtlMs`), auth-д undefined.
Эцсийн үнэн нь `GET /session` (`TIMEOUT`). CA-ийн тохиргооны амьд утга: `client.auth.sessionTtl()` — discovery
`sessionTtl` (`{ authMs, signMs }`; хуучин CA-д 0).

**Session эхлэх алдаа** (`ApiError`-ийн дэд анги, `.code`-той): `NoSigningCertificateError` — 409
`NO_SIGNING_CERTIFICATE` (sign / certificate-choice start: иргэнд идэвхтэй төхөөрөмж / хүчинтэй
гарын үсгийн гэрчилгээ алга, session үүсээгүй); `CertChoiceInvalidError` — 409 `CERT_CHOICE_INVALID` (linked sign-ийн
certificate-choice хүчингүй / хуучирсан / ашиглагдсан → cert-choice-ийг дахин эхлүүл); `RequestInvalidError` — 400
`REQUEST_INVALID` (ж: linked-д `linkedSessionID` дутуу).

### 3.1. Гэрчилгээг урьдчилж мэдэх (client-side PAdES / CMS)

Гэрчилгээ DTBS-д (`signingCertificateV2`) ордог тул эхлээд certificate-choice, дараа нь digest-ийг **яг тэр төхөөрөмж
рүү (`documentNumber`)** зуруулна. RP-д эрх: certificate-choice — `CERT`, digest sign — `SIGN`. Олон утастай иргэнд etsi-ээр эхлүүлбэл өөр утас зурж, гарын үсэг гэрчилгээтэйгээ
таарахгүй.

```ts
const cc = await eid.sign.certificateChoiceByEtsi("PNOMN-12345678"); // эсвэл certificateChoiceDeviceLink() (зөвхөн QR)
const signer = eid.validator.validateCertificateChoice(await eid.session.waitForResult(cc.sessionId), cc.sessionId);
const dtbs = buildDtbs(signer.certificate); // 32 байт SHA-256, стандарт base64
const s = await eid.sign.digestForSigner(signer, dtbs, ix, { fileName: "Гэрээ.pdf" }); // linked/{documentNumber}
// QR / Web2App: eid.sign.deviceLinkForSigner(signer, dtbs, ix, { callbackUrl })
const r = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(r, s.sign!.digest, {
  hashAlgorithm: s.sign!.hashAlgorithm,
  expectedFlowType: "Notification",
  expectedAlgorithm: s.sign!.signatureAlgorithm, // sha256WithRSAEncryption — PSS хариуг татгалзана
  expectedCertificate: signer.certificate,       // өөр гэрчилгээгээр зурсан бол татгалзана
});
```

`digestForSigner` / `deviceLinkForSigner`-ийн анхдагч: `sha256WithRSAEncryption` + `SHA-256` (CA SplitKey RSA нь хүссэн
алгоритмаар, PKCS#1 v1.5; хуучин threshold-ECDSA credential нь үргэлж `ecdsa-with-SHA256` — `expectedAlgorithm` үүнийг
зөвхөн EC P-256 гэрчилгээтэй үед зөвшөөрнө). Digest-ийн урт hash-тай таарахгүй бол хүсэлт явахгүй.

## 3a. Байгууллагын нэрийн өмнөөс гарын үсэг (onBehalfOf)

Иргэн **өөрийн PIN2 гэрчилгээгээр** зурна; тухайн мөчид байгууллагыг төлөөлөх эрхтэйг eID **өөрийн бүртгэлээр**
шалгана (Эстонийн загвар). Энэ нь **хувь хүний квалификацтай гарын үсэг** — байгууллагын гэрчилгээ, тамга (e-Seal) биш.
e-Seal нь зөвхөн хүнгүй, автомат системийн баримтад. Урьдчилсан нөхцөл: байгууллага eID-д `ACTIVE` (захирал
аппаараа ХУР-аар холбоно), зурагч нь `ADMIN` эсвэл PIN2-оор баталгаажуулсан `MANAGER`, RP-д `SIGN` эрх.
Дэлгэрэнгүй: [developer.eidmongolia.mn](https://developer.eidmongolia.mn/).

```ts
import { ForbiddenError, ApiError, ON_BEHALF_ERROR_CODES } from "@gerege-systems/eid-mongolia-sdk";

// 1. Иргэн сүүлийн 24 цагт танай RP-ээр нэвтэрсэн байх ёстой.
const { representations } = await eid.organization.getRepresentations("PNOMN-12345678");
// → [{ orgEtsi: "NTRMN-6235972", orgName: "Гэрэгэ Системс ХХК", role: "ceo", roleLabel: "Гүйцэтгэх захирал",
//      rightType: "ADMIN", rightTypeLabel: "Админ", source: "REGISTRY", sourceLabel: "Улсын бүртгэл", … }]

// 2. PDF: §3d (клиент талын PAdES) — signPdfDigest({ …, onBehalfOf }) + prepare({ claimedRole: rep.claimedRole }).
// 3. Raw digest гарын үсэг: eid.sign.digestByEtsi(id, digest, interactions, { onBehalfOf: "NTRMN-6235972" })
//    — CMS-ийг та угсардаг тул мэдүүлсэн үүргийг (signer-attributes-v2) өөрөө нэмнэ.
try {
  /* … */
} catch (e) {
  if ((e instanceof ForbiddenError || e instanceof ApiError) && e.code) {
    // REPRESENTATION_DENIED | REPRESENTATION_PENDING | REPRESENTATION_EXPIRED | ORG_NOT_ACTIVE |
    // SIGNER_UNIDENTIFIED (403) · ORG_NOT_FOUND (404) · REPRESENTATION_REVOKED (403, бүртгэлийн үед)
  }
  throw e;
}
```

Түр алдаа — `ApiError.retryable` үнэн, `retryAfterMs`-ийн (CA-ийн `Retry-After`, секунд эсвэл огноо) дараа давтана
(`RETRYABLE_ERROR_CODES`). `headers` — хариуны header. JSON хариу 4 MiB-ээс хэтэрвэл `ResponseTooLargeError` (таслахгүй).
`getRepresentations`-ийн `raw` — серверийн түүхий JSON.

**Хүнд харуулахдаа `roleLabel` / `rightTypeLabel` / `sourceLabel` ашигла** (representations болон session-ий
`onBehalfOf`; `onBehalfOf`-д `source` байхгүй тул зөвхөн `roleLabel` / `rightTypeLabel`) — `role` (`ceo` / `founder` /
`stakeholder` эсвэл MANAGER-т бичсэн текст), `rightType` (`ADMIN` | `MANAGER`), `source` (`REGISTRY` | `MANUAL`) нь
машин утга, өөрөө орчуулахгүй. Хэл: `new EidClient({ …, language: "en" })` → дуудлага бүрд `Accept-Language`; анхдагч
илгээхгүй (сервер mn). Хуучин CA-д эдгээр талбар байхгүй.

Session-ий `onBehalfOf` блок (`role`/`roleLabel`/`rightType`/`rightTypeLabel`) нь хариу угсрах үеийн бүртгэл.

## 3b. Иргэний PKI самбар (`PKI_READ` эрх)

`eid.person.certificates(etsi)` · `devices` · `activity(etsi, { flow, limit, offset })` · `summary` · `children` — иргэн
сүүлийн 24 цагт танай RP-ээр нэвтэрсэн байх ёстой (эс бөгөөс `ForbiddenError`). Хариу бүрт `raw`.

Гэрчилгээ бүрт (0.18.0-аас) `issuedAt` (олгосон), `revokedAt?` (цуцалсан — REVOKED), `revocationReason?` (RFC 5280
нэр: `keyCompromise`, `superseded`, `cessationOfOperation` …). `status` өөрчлөгдөхгүй: сунгалт/дахин бүртгэлээр
солигдсон мөр `SUSPENDED` + `revocationReason: "superseded"`, `revokedAt`-гүй.

`keyMedium: "TOKEN"` мөрөнд `organization?` (байгууллагын токен) ба `tokenSerial?` — гэрчилгээ олгогдсон USB токены
серийн дугаар. Нэг токены AUTH + SIGN-ийг байгууллага/огноогоор таамаглахгүй, `tokenSerial`-аар бүлэглэ (сунгалтаар
солигдсон мөр ч өөрийн токены дугаартай). MOBILE/HSM мөрөнд болон хуучин CA-д талбар байхгүй.

```ts
const { certificates } = await eid.person.certificates(etsi);
const byToken = Map.groupBy(certificates.filter((c) => c.tokenSerial), (c) => c.tokenSerial!);
```

## 3c. USB токен

```ts
import { verifyTokenCertificates, tokenAuthDigest, tokenLimitOf } from "@gerege-systems/eid-mongolia-sdk";

// гэрчилгээ олголт (TOKEN_ISSUE эрх) — иргэн утсаараа PIN2-оор батална
const input = { signerEtsi, csrAuth, csrSign, tokenSerial: "EP2003-0042A1" }; // onBehalfOf алга = хувийн
// push-ээс ӨМНӨ: ижил оролтоор dryRun — session/push үүсэхгүй, алдааны код бодиттой ижил
const pv = await eid.token.previewCertificate(input); // pv.supersedes байвал иргэнд анхааруулж зөвшөөрүүлээд ↓
const st = await eid.token.issueCertificate(input);
// … eid.session.poll(st.sessionId) → result.tokenCertificate?.status === "ISSUED"
const res = await eid.token.certificateResult(st.sessionId);
verifyTokenCertificates(res, csrAuth, csrSign); // гэрчилгээ бүр CSR-ийн түлхүүртэй
// 409 TOKEN_LIMIT_REACHED → tokenLimitOf(err): { kind, limit, organization? }
// 409 TOKEN_IN_USE — serial өөр иргэнд; 409 TOKEN_SCOPE_CHANGE — сунгалт scope солих гэсэн (доор)
// 400 APP_ATTESTATION_INVALID — appTransaction ирсэн боловч хүчингүй (доор)

// токеноор нэвтрэх (AUTH эрх)
const ch = await eid.token.authChallenge();
const digest = tokenAuthDigest(ch.rpUUID, ch.challenge); // токен CKM_ECDSA → түүхий r||s
// 0.19.0-аас challenge-ийг бүтнээр нь өгнө (RP хадгалсан, эсвэл клиентээс буцаж ирсэн — CA challengeId-ээр тулгана):
// SDK CA-ийн OK-д дангаар итгэхгүй — r||s-ийг гэрчилгээний түлхүүрээр, rpUUID-ийг өөрийнхтэй, гэрчилгээг trust-аар
// (гинж, issuer, зориулалт auth) шалгаад дараа нь CA руу илгээнэ.
const who = await eid.token.authVerify(ch, authCertDer, rs);

// токеноор PDF: §3d — prepare() → токен CKM_ECDSA(dtbs) → r||s → complete() → registerSignature() (sessionID-гүй, medium "token")
```

**Сунгалт scope-ийг хадгална** (CA 2026-10-16, discovery `tokenCertificate.scopeLockedOnRenewal: true` —
`eid.token.certificateInfo()`): ижил `tokenSerial` дээр иргэний ACTIVE бүртгэл байвал олголт = сунгалт; байгууллагын
токен зөвхөн тэр байгууллагаар (`onBehalfOf` ижил), хувийн токен зөвхөн хувиараа. Өөр scope бол `POST` (эсвэл
батлалтын дараа `certificateResult`) 409 `TOKEN_SCOPE_CHANGE`, session-ий `tokenCertificate.errorCode` мөн ийм — override
байхгүй. Scope солих = иргэн eID апп-аас токеноо цуцлаад (`/v3/mobile/tokens/{tokenSerial}/revoke`) шинээр олгуулна;
хэрэглэгчид: «Токены төрлийг (хувийн/байгууллага) солихын тулд eID апп-аас токеныг цуцлаад шинээр олгуулна уу».

**Хувийн токены автомат солилт** (CA 2026-10-19, discovery `tokenCertificate.personalAutoSupersede: true`): хувийн
хязгаар хүрсэн үед өөр `tokenSerial`-тай шинэ хувийн токен 409 биш — `st.supersedes` (`{ tokenSerial }[]`) ирнэ; хувийн
токенд шинэ олголт амжилттай болбол (PIN2 + гэрчилгээ) өмнөх хувийн токены AUTH + SIGN superseded (4)-оор цуцлагдана.
Татгалзсан / хугацаа дууссан олголт өмнөхийг хөндөхгүй. PIN2-оос өмнө: «Таны өмнөх USB токен (EP2003-…)-ийн гэрчилгээ
хүчингүй болно». 409 `TOKEN_LIMIT_REACHED` `kind: "PERSONAL"` зөвхөн `limit: 0` (хувийн олголт хаалттай) үед;
байгууллагын токен хатуу хязгаар хэвээр.

**dryRun — push-ээс өмнөх шалгалт** (CA 2026-10-19, discovery `tokenCertificate.dryRun: true` —
`certificateInfo().dryRun`): `issueCertificate`-ийн хариунд `supersedes` ирэх үед утас руу PIN2 push явсан байдаг —
desktop дээр цуцалсан ч иргэн утсаараа баталбал хуучин токен солигдоно. Тиймээс урсгал: CSR →
`eid.token.previewCertificate(input)` (бие нь ижил + `"dryRun": true`; бүх шалгалт, ижил алдааны код — өөр CSR хостой
хүлээгдэж буй олголт `409 TOKEN_ISSUANCE_PENDING` ч; session / push / state үүсэхгүй) → `supersedes` байвал анхааруулга,
иргэн зөвшөөрөх → `issueCertificate(input)`. Хурдны хязгаар (RP, иргэн) 20/мин ба RP нийт 120/10 мин — push-ийн 3/цагийг
зарцуулахгүй. Хариунд `dryRun: true` ирээгүй бол `ValidationError` (хуучин CA танихгүй талбарт 400 буцаана).

**Апп баталгаа (`appTransaction`, заавал биш)** (CA 2026-10-19, discovery `tokenCertificate.appTransaction:
"optional"` — `eid.token.certificateInfo().appTransaction`): macOS App Store build нь StoreKit 2 `AppTransaction`-ийн
JWS (compact) мөрийг desktop-оос дамжуулна — `issueCertificate({ …, appTransaction: jws })`. CA Apple-ийн сервер рүү
дуудахгүй, offline шалгана; ирсэн бол заавал хүчинтэй, эс бөгөөс 400 `APP_ATTESTATION_INVALID` (SDK-ийн
тогтмол; аль алхам унасныг хэлэхгүй, утас руу push явахгүй). Хоосон/алга (Windows) = баталгаагүй олголт.
`MAX_APP_TRANSACTION_BYTES` (16 KiB)-аас их бол SDK илгээхгүй, `AppTransactionTooLargeError` шиднэ. Хуучин CA-д талбар
илгээвэл 400.

`/token/auth/*` нь `/.well-known/eid`-ийн `endpoints.token.auth_challenge` / `auth_verify`-д жагсаагдсан (AUTH эрх) —
гэрээний тест бусад route-ийн адил шалгана.

## 3d. PDF гарын үсэг (PAdES, клиент тал) — `@gerege-systems/eid-mongolia-sdk/pades`

**PDF eID-ийн сервер рүү ОЧИХГҮЙ** (Smart-ID / DigiDoc загвар). Баримтыг таны тал (браузер эсвэл Node) НАТИВ
TypeScript-ээр (WASM-гүй, Web Crypto) угсарна; CA зөвхөн 32 байт DTBS-д гарын үсгийн session (ердийн
`RAW_DIGEST_SIGNATURE`) ба CMS-ийн бүртгэлийг хийнэ. Гаралт: PAdES-BASELINE-LT (цагийн тэмдэг tsa.timeserver.mn, OCSP/CRL
DSS-д), Adobe / EU DSS-д «LTV enabled», баталгаажуулах (QR) хуудастай (mn анхдагч / en). Go reference
(`eid-mongolia-sdk-go/pades`, профайл `pades-client/1`)-тэй **байт-ижил** — conformance golden-оор CI-д шалгагдана.

| Функц | Хаана | Тайлбар |
|---|---|---|
| `prepare(pdf, { signerCert, claimedRole?, verifyPage?, fileName?, lang?, docId?, appearance?, … })` | браузер / Node | `{ dtbs, digest, docId, state, placement? }` — сүлжээгүй |
| `eid.signPdfDigest({ dtbs, fileName, signer, flow?, onBehalfOf? })` | RP backend | DTBS-д гарын үсгийн session (push эсвэл device-link) |
| `complete(state, signature)` | браузер / Node | TSA + OCSP/CRL → `{ pdf, cms, docId, outSha256, inSha256, hasPage, pageSha256, … }` |
| `eid.registerSignature(registrationFromCompleted(done, { fileName, sessionID }))` | RP backend | `POST /pdf/signatures` — `/verify/{docID}` бүртгэл |

`/pades` хөтчийн bundle ~127 KB gzip (Noto Sans фонт asset-тэй, CI-д ≤ 300 KB); үндсэн entry үүнийг агуулахгүй. `/pades` (ба бүх багц) **Node ≥ 18** (CI: 18 / 20 / 22),
орчин үеийн хөтөч. Браузерийн CSP: `connect-src https://tsa.timeserver.mn https://ocsp.eidmongolia.mn
https://crl.eidmongolia.mn`. Хөтөчид гэрчилгээний `http://` AIA/CDP-г зөвхөн эдгээр хостод `https://` болгоно; үндэсний
CA-ийн CRL (`esign.gov.mn`) нь `crl.eidmongolia.mn` толин хуулбараас (бүх платформд). Шалгагч (`verify`) энд
**байхгүй** — бүрэн криптограф шалгалт Go backend SDK-д; `prepare` нь өмнөх гарын үсгийг «хөнгөн» шалгуураар (бүтэц,
CMS гарын үсэг, eID олгогч, timestamp, DSS) л шалгана.

**Зурагчийн гэрчилгээ.** `prepare` иргэний SIGN гэрчилгээг (`signingCertificateV2`) шаарддаг тул session-оос ӨМНӨ
хэрэгтэй. Үндсэн зам — **certificate-choice** (§3.1; RP-д `CERT` эрх): `validateCertificateChoice` → `signer.certificate`
+ `signer.documentNumber`, дараа нь `digestForSigner` / `deviceLinkForSigner`-ээр тэр төхөөрөмж рүү зуруулна.
`eid.person.certificates(etsi)` (`PKI_READ`; `type: "SIGN"`, `status: "VALID"`, `keyMedium: "MOBILE"` мөрийн `certValue` +
`documentNumber`) нь зөвхөн итгэмжлэгдсэн RP-д, иргэн сүүлийн 24 цагт тухайн RP-д амжилттай нэвтэрсэн үед (бусад → 403).
Session-ийг тэр `documentNumber`-ээр эхлүүлнэ — өөр төхөөрөмж зурвал `complete` `SIGNATURE_INVALID`.

### Вэб RP (браузер prepare/complete, backend session)

```ts
// ── браузер ─────────────────────────────────────────────────────────────────────────────
import { prepare, complete } from "@gerege-systems/eid-mongolia-sdk/pades";

const { signerCert, documentNumber } = await api("/sign/pdf/signer");          // backend: person.certificates
const p = await prepare(pdfBytes, {
  signerCert, verifyPage: true, fileName: "Гэрээ №12.pdf",
  claimedRole, // байгууллагаар бол getRepresentations()-ийн claimedRole ЯГ ХЭВЭЭР
});
await idb.put("pades-state", p.state);                                           // хуудас дахин ачаалагдаж болно
const s = await api("/sign/pdf/start", { dtbs: b64(p.dtbs), documentNumber, fileName: "Гэрээ №12.pdf" });
showToUser(s.vc);                                                                // эсвэл backend-ийн QR (§4)
const { signature } = await api(`/sign/pdf/${s.sessionId}/result`);              // backend poll + validateSign
const done = await complete(p.state, signature);                                 // TSA + OCSP/CRL + DSS
const { pdf, signerCert: _c, ...meta } = done;                                     // PDF backend рүү очихгүй
await api(`/sign/pdf/${s.sessionId}/register`, { ...meta, cms: b64(done.cms) });
download(done.pdf, "Гэрээ №12.pdf");

// ── RP backend (Node) ─────────────────────────────────────────────────────────────────────
// /sign/pdf/start — sessionSecret (device-link) backend-ээс гарахгүй; s.digest-ийг session-д хадгал.
const s = await eid.signPdfDigest({
  dtbs: req.body.dtbs, fileName: req.body.fileName,
  signer: { documentNumber: req.body.documentNumber }, // эсвэл { etsi }
  onBehalfOf: "NTRMN-6235972",                         // заавал биш
});
store(s.sessionId, { digest: s.digest, fileName: req.body.fileName });
// /sign/pdf/:id/result
const r = await eid.session.waitForResult(sessionId);
const sig = eid.validator.validateSign(r, store.get(sessionId).digest, { expectedFlowType: "Notification" });
reply({ signature: sig.signatureValueB64 });
// /sign/pdf/:id/register — CA CMS-ийг өөрөө шалгана (session digest = SHA-256(signedAttrs), cert, claimedRole)
// registrationFromCompleted: CA dto-той яг ижил бие (hasPage илгээхгүй, pageSha256 зөвхөн хуудастай үед); cms base64 ч болно.
const reg = await eid.registerSignature(registrationFromCompleted(req.body, {
  fileName: store.get(sessionId).fileName, sessionID: sessionId, onBehalfOf: "NTRMN-6235972" }));
reply({ verifyUrl: reg.verifyUrl });
```

- `reg.created` — `true` 201 (шинэ), `false` 200 (ижил биеийн давталт). Өмнөх гарын үсэг CA-ийн угсарсан (горим A) бол
  `complete().priorRevisionSha256`-ийг (`sha256(doc[0 : ByteRange[2]+ByteRange[3]])`) `registrationFromCompleted`
  `priorSignatures` болгож дамжуулна; `registerSignature` 409 `PRIOR_MISMATCH`-ийн дараа өөрөө revision-оор тааруулна
  (`priorRevisionSha256`-г гараар өгвөл оролдохгүй). Хөтчөөс JSON-оор дамжуулахдаа `priorRevisionSha256`-ийг ч явуул.
- `registerSignature`-ийн алдаа: `ApiError.code` / `ForbiddenError.code` ∈ `PdfRegisterErrorCode`
  (`PDF_REGISTER_ERROR_CODES`; Go: `eid.PDFRegisterErrorCodes`) — 400 `REQUEST_INVALID` / `CMS_INVALID` /
  `SIGNATURE_INVALID` / `TIMESTAMP_INVALID`; 403 `TOKEN_ORG_MISMATCH` / `REPRESENTATION_REVOKED`; 404 `DOC_NOT_FOUND`; 409
  `SIGNER_MISMATCH` / `SIGNER_CERT_INVALID` / `TOKEN_CERT_INVALID` / `SESSION_MISMATCH` / `SESSION_NOT_COMPLETE` /
  `SESSION_FAILED` / `CLAIMED_ROLE_MISMATCH` / `DOC_ID_CONFLICT` / `REGISTRY_CONFLICT` / `PRIOR_MISMATCH`; 413
  `REQUEST_TOO_LARGE`; 429 `RATE_LIMITED`, 503 `STATE_UNAVAILABLE` (`retryable`).

**Харагдах гарын үсэг (сонголттой).** `appearance: { page?, x, y, width, height, lang? }` өгвөл гарын үсэг хуудсан дээр
харагдана (QR + нэр, `claimedRole`, «eID Mongolia-аар зурсан», огноо `YYYY-MM-DD HH:MM (+08)`); байхгүй бол үл харагдах
(өмнөхтэй байт-ижил). Координат pt-ээр, хуудасны CropBox-ийн `/Rotate`-ийн дараах (дэлгэцэнд харагдах) зүүн доод булангаас;
`page` 1-ээс (байхгүй = оролтын сүүлийн хуудас; нэмэх verify хуудас тооцогдохгүй). Өндөр ≥ 45 pt; хуудаснаас гарах, бичвэр
багтахгүй, docId-гүй (хуудасгүй гарын үсэгтэй баримт) бол `REQUEST_INVALID`. Харагдах бүр ~+90 KB. Дүрэм: Go репогийн
`pades/APPEARANCE_SPEC.md`.

`x, y` нь **хүссэн** байрлал: тэр хэсэгт хуудасны агуулга (бичвэр, хүснэгтийн зураас, зураг, өмнөх гарын үсэг) байвал
дүрслэл чөлөөт зай руу шилжинэ — эхлээд толин тусгал багана (баруун доод → зүүн доод), дараа нь 12 pt-ээр дээш. Хуудсыг
рендерлэхгүй, content stream-ийг л уншина (Go-той хайрцаг бүрээр ижил). Үр дүн: `p.placement` —
`{ page, x, y, width, height, status }` (pt), `status`: `requested` (хүссэн газраа) | `moved` (шилжсэн) | `overlap` (чөлөөт
зай алга — хүссэн газраа, агуулга дээр) | `unscanned` (хуудсыг хязгаарт багтааж уншиж чадсангүй — хүссэн газраа). Гарын
үсэг аль ч үед хүчинтэй; `overlap` / `unscanned`-ийг хэрэглэгчид мэдэгдэх нь зүйтэй. Дүрэм: Go репогийн
`pades/PLACEMENT_SPEC.md`.

```ts
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "Гэрээ №12.pdf",
  appearance: { page: 1, x: 340, y: 36, width: 220, height: 64 } });
if (p.placement?.status === "overlap") notice("Гарын үсэг хуудасны агуулга дээр давхцаж байрлана");
```

### Зөвхөн Node (backend бүгдийг хийнэ)

```ts
import { registrationFromCompleted } from "@gerege-systems/eid-mongolia-sdk";
import { prepare, complete, PadesError } from "@gerege-systems/eid-mongolia-sdk/pades";

const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "Гэрээ №12.pdf" });
const s = await eid.signPdfDigest({ dtbs: p.dtbs, fileName: "Гэрээ №12.pdf", signer: { documentNumber } });
showToUser(s.vc);
const r = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(r, s.digest);
let done;
for (let i = 0; ; i++) {
  try {
    done = await complete(p.state, sig.signatureValueB64);
    break;
  } catch (e) {
    if (e instanceof PadesError && e.retryable && i < 3) continue; // TSA_UNAVAILABLE / LTV_UNAVAILABLE — ижил state+гарын үсэг
    throw e;
  }
}
await eid.registerSignature(registrationFromCompleted(done, { fileName: "Гэрээ №12.pdf", sessionID: s.sessionId }));
writeFileSync("signed.pdf", done.pdf);
```

**LTV retry (0.18.3+).** `complete` нь OCSP/CRL (DSS) цуглуулалт унавал (ж: CRL толь түр 404) ижил state, гарын үсэг,
TSA timestamp-аар өөрөө **2 удаа** дахин оролдоно (нийт 3; хүлээлт ~1 с, ~3 с + 0–25% jitter) — PIN дахин асуухгүй.
`ltvRetries` (анхдагч 2, `0` — унтраах); бүгд унавал `LTV_UNAVAILABLE`. `signal` (`AbortSignal`) нь TSA/OCSP/CRL таталт ба
хүлээлтийг тасална — `signal.reason` (анхдагч `DOMException` `AbortError`) шиднэ. Дээрх гадна давталт нь
`TSA_UNAVAILABLE` болон удаан тасалдалд л хэрэгтэй. OCSP/CRL (олгогчийн гарын үсэгтэй) нь гинжийн гэрчилгээг
**цуцалсан** гэвэл (0.21.0) тэр дор нь `LTV_UNAVAILABLE`, `cause` нь `CertificateRevokedError`, `retryable` false — дахин
оролдохгүй (өмнө нь revoked OCSP-г алгасаад CRL-ээр DSS угсардаг байв). OCSP/CRL-д мөн CertID/олгогч/шинэлэг байдлын
дүрэм (§ validate).

`PadesError.code` (тогтвортой, бүх платформд ижил): `PDF_INVALID`, `PDF_ENCRYPTED`, `PDF_LOCKED` (DocMDP P=1),
`PDF_TOO_LARGE`, `PDF_TOO_MANY_SIGNATURES`, `PDF_PRIOR_SIGNATURE_INVALID`, `PDF_FOREIGN_SIGNATURE`, `SIGNER_INVALID`,
`REQUEST_INVALID`, `SIGNATURE_INVALID` (state хэвээр — дахин зуруулж болно), `TSA_UNAVAILABLE`, `LTV_UNAVAILABLE`
(`retryable`), `SELF_VALIDATION_FAILED`, `PLACEHOLDER_OVERFLOW`, `STATE_INVALID`, `INTERNAL`.
`state` нь бэлтгэсэн PDF-ийг агуулна — PDF-тэй ижил нууцлалтай хадгал. Формат нь Go SDK-тай ижил (хөтөчид `prepare`,
Go backend-д `complete` хийж болно).

0.15.0-д `eid.pdf` (`prepare`, `document`, `documentVerified`, `tokenPrepare`, `tokenFinalize`, `tokenDocument`) ба
`pdfTimeoutMs` / `pdfMaxBytes` устсан — PDF upload endpoint-ууд CA-д байхгүй (2026-10-14-нд устсан, 404).

**Хугацаа.** `registerSignature` (`POST /pdf/signatures` — CA CMS + TSA + LTV-г шалгадаг) 0.19.0-аас өөрийн
`pdfTimeoutMs`-тэй, анхдагч **80 с** (`DEFAULT_PDF_TIMEOUT_MS`; Go SDK `Config.PDFTimeout` / `DefaultPDFTimeout`-тэй ижил);
бусад дуудлага `timeoutMs` (анхдагч 15 с). 0.18.x-д бүртгэл ердийн 15 с-ээр тасардаг байв.

## 3e. Word → PDF хөтөч дотор — `@gerege-systems/eid-mongolia-sdk/convert`

Иргэн Word (.docx / .doc) баримт сонговол хөтөч өөрөө PDF болгоно — **файл сервер рүү ОЧИХГҮЙ** (§3d-тэй ижил зарчим).
Хувиргагч нь LibreOffice 24.8-ийн WebAssembly build (`@matbee/libreoffice-converter@2.7.2`, MPL-2.0), Web Worker-т.
Гарын үсэг **Word файлд биш, хувиргасан PDF-д** зурагдана — иргэнд тэр PDF-ийг (яг тэр байтуудыг) зурахаас ӨМНӨ заавал
харуулж, «шалгасан» гэж зөвшөөрүүл; хувиргалтад фонт, мөр, хуудас шилжиж болно (`warnings`).

```bash
npm install @gerege-systems/eid-mongolia-sdk @matbee/libreoffice-converter@2.7.2   # optional peer — зөвхөн /convert-д
npx eid-mongolia-convert-assets public/eid-convert                                 # build үед; git-д commit хийхгүй (~190 MB + .br/.gz)
```

```ts
import { wordToPdf, converterStatus, isWordFile, ConvertError } from "@gerege-systems/eid-mongolia-sdk/convert";

if (isWordFile(file)) {
  const s = await converterStatus({ assetsBase: "/eid-convert/" });   // { cached, downloadBytes } — мобайл датанд анхааруул
  const { pdf, pages, warnings } = await wordToPdf(file, {
    assetsBase: "/eid-convert/",
    signal: controller.signal,                                        // цуцлах → DOMException AbortError
    onProgress: ({ phase, percent, loaded, total }) => show(phase, percent), // download (зөвхөн эхний удаа) → init → convert
  });
  preview(pdf);                       // иргэн шалгаад зөвшөөрнө
  const p = await prepare(pdf, { signerCert, verifyPage: true, fileName: "Гэрээ.pdf" });   // §3d
}
```

| Функц | Тайлбар |
|---|---|
| `wordToPdf(file, { assetsBase, onProgress?, signal?, fileName?, verbose? })` | `{ pdf, pages, warnings }`. Нэг worker-ийг дахин ашиглана, дуудлагууд дараалалд. `verbose: true` — LibreOffice-ийн оношилгооны лог консолд (анхдагч чимээгүй; утга солигдвол worker дахин асна) |
| `converterStatus({ assetsBase })` | `{ cached, downloadBytes }` — татахаас өмнө хэмжээг хэлэх (brotli хэмжээ, кэштэй бол 0) |
| `isWordFile(file \| name)` | .docx / .doc эсэх (нэр, MIME). Агуулгыг `wordToPdf` эхний байтаар шалгана |
| `disposeConverter()` | worker-ийг зогсоож санах ойг чөлөөлнө (кэш үлдэнэ) |

**Хост дээр (заавал).**
- Хувиргах хуудас **crossOriginIsolated**: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` (SharedArrayBuffer). Зөвхөн тэр route-д тавьж болно — тэгвэл тэр хуудас руу **hard navigation**
  (`<a href>`, client-side router биш). Үгүй бол `wordToPdf` шууд `NOT_ISOLATED` (хүлээхгүй). COEP-ийн дор гадны
  CORP/CORS-гүй зураг, iframe ачаалагдахгүй.
- Asset-ууд **өөрийн хост** дээр (`assetsBase`): `manifest.json` — `Cache-Control: no-cache`; `<хувилбар>-<hash>/*` —
  урт кэш (`public, max-age=31536000, immutable`), `.wasm` → `application/wasm`. Эхний удаа татсаныг SDK Cache Storage-д
  хадгална (дахин татахгүй); хавтас солигдвол хуучныг устгана.
- **Шахалт.** `eid-mongolia-convert-assets` файл бүрийн хажууд `.br` (brotli 11) ба `.gz` (gzip 9) бичнэ —
  серверт `brotli_static` / `gzip_static`-ээр өг (динамик шахалт 147 MB-ийн wasm-д хэт удаан). Хэмжээ (2.7.2):

  | файл | задарсан | gzip | brotli |
  |---|---|---|---|
  | soffice.wasm | 147.4 MB | 48.5 MB | 33.8 MB |
  | soffice.data | 43.2 MB (upstream 99.7 MB) | 11.9 MB | 7.1 MB |
  | soffice.js + бусад JS | 0.5 MB | 0.1 MB | 0.1 MB |

  Нийт эхний татал ≈ 41.0 MB brotli / 60.6 MB gzip (өмнө нь 77 MB gzip). brotli 11 нь soffice.wasm-д удаан (M4 Pro
  дээр ~4 мин) — build-ийг хурдасгах бол `EID_CONVERT_BROTLI_QUALITY=9` (wasm 39.2 MB, ~9 с). nginx (ngx_brotli модуль):

  ```nginx
  location /eid-convert/ {
      brotli_static on;          # <файл>.br, Accept-Encoding: br үед
      gzip_static   on;          # <файл>.gz, бусад үед
      types { application/wasm wasm; application/octet-stream data; text/javascript js; application/json json; }
      add_header Cache-Control "public, max-age=31536000, immutable";   # + доорх worker CSP (*.js)
      location = /eid-convert/manifest.json { add_header Cache-Control "no-cache"; }
  }
  ```

  SDK задарсан байтыг тоолж (`onProgress`-ийн `loaded`/`total`) manifest-ийн `bytes`-тэй тулгадаг тул сервер аль
  шахалтаар ч өгсөн progress зөв. Safari brotli-г зөвхөн HTTPS-ээр хүсдэг.
- **soffice.data-г багасгасан** (99.7 → 43.2 MB): Writer → PDF-д хэрэггүй фонт (араб, еврей, армян, гүрж,
  Libertine…), Calc/Impress/Draw/Math-ийн UI тохиргоо, дүрсний сан, gallery хасагдана; NotoSans/NotoSerif (Ө Ү-ийн
  орлуулагч) ба бүх `registry/*.xcd` (OMML томьёо) үлдэнэ. upstream `soffice.data` / `soffice.js`-ийн sha256 таарахгүй бол
  хуулалт унана. 4 баримт дээр (хүснэгт, зураг, диаграм, томьёо, 11 фонтоор кирилл) PDF пиксел-ижил.
  **Upstream хувилбар шинэчлэхэд** (`@matbee/libreoffice-converter` 2.7.2 → …): `DATA_TRIM`-ийн sha256 ба хасах жагсаалтыг
  шинэ build дээр дахин гаргаж `npm run test:convert-e2e`-ээр (Chromium + WebKit) батал — хүснэгт, Ө Ү, томьёо.
- Worker-ийн скриптүүдэд (`<assetsBase><хувилбар>/*.js`) **тусдаа CSP**: `default-src 'self'; script-src 'self'
  'wasm-unsafe-eval' 'unsafe-eval'` (Emscripten-д `eval` хэрэгтэй — зөвхөн worker-т). Хуудасны хатуу CSP (nonce +
  `'strict-dynamic'`) хэвээр байна; хуудсанд `connect-src 'self'` хангалттай.
- Консол: LibreOffice хувиргалт бүрд «warn:vcl…», «[LOK C++] …» гэх мэт оношилгооны мөр (алдаа биш) хэвлэдэг.
  `eid-mongolia-convert-assets` (≥ 0.18.2) upstream worker-ийг (`@matbee/libreoffice-converter@2.7.2`-ийн sha256-аар
  баталгаажсан үед л) patch хийж эдгээрийг `verbose: true`-гүй бол гаргахгүй; `manifest.json`-д `"patched": true`. Hash
  таарахгүй бол patch-гүй хуулж анхааруулна — хувиргалт ажиллана, лог л гарна. SDK шинэчилсний дараа asset-ийг дахин
  хуул (`rev` солигдож worker-ийн immutable кэш шинэчлэгдэнэ; soffice.js өөрчлөгдөөгүй бол soffice.wasm/.data дахин
  татагдахгүй).
- Удаан CPU (0.21.0): upstream `soffice.js`-ийн `pthreadPoolSize=4` нь удаан компьютер дээр баримт ачаалахад
  гацдаг (deadlock) тул `eid-mongolia-convert-assets` үүнийг 8 болгоно (`manifest.json`-д `"pthreadPoolSize": 8`;
  зөвхөн JS). `soffice.js`-ийн sha256 мэдэгдэж буй 2.7.2-тэй таарахгүй бол хуулалт унана — asset-ийг дахин хуул.
- MPL-2.0: `<хувилбар>/NOTICE.txt` (эх код, лицензийн холбоос) asset-уудтай хамт үйлчилгээнд байна — хэрэглэгчийн
  нүүрэнд (тусламж/лиценз хэсэгт) LibreOffice-ийг дурд.

`ConvertError.code`: `UNSUPPORTED_ENVIRONMENT`, `NOT_ISOLATED`, `UNSUPPORTED_FILE`, `INPUT_TOO_LARGE` (> 50 MB),
`ASSETS_UNAVAILABLE` (`retryable`), `CONVERT_FAILED` (эвдэрсэн / нууц үгтэй баримт). `warnings[].code`:
`FONT_SUBSTITUTED` (`fonts` — хувиргагчид байхгүй, хэмжээ-нийцтэй орлуулагчгүй фонт; Times New Roman / Arial /
Calibri / Cambria / Courier New-ийн Liberation / Carlito / Caladea орлуулагч анхааруулахгүй), `FONT_FALLBACK` (`fonts` —
зарим тэмдэгтийг өөр фонтоор, жишээ нь Caladea-д кирилл байхгүй тул Noto), `PDF_NEAR_LIMIT` / `PDF_TOO_LARGE` (`bytes`,
`limit` — §3d `prepare`-ийн 10 223 616 байт). Фонтын анхааруулга .docx-д л (heuristic); .doc-д үгүй.

Шалгасан: Chromium ба WebKit (Playwright, `npm run test:convert-e2e`) — .docx ба .doc → PDF → `prepare`, кэштэй дахин
ажиллуулахад татахгүй, цуцлалт, COEP-гүй хуудас. Мобайл хөтөчид 147 MB WASM санах ой их шаардана — сул утсанд унаж
болзошгүй.

## 3f. Гарын үсэгтэй файлыг имэйлээр — `eid.share()` (`SIGN` эрх)

Гарын үсэг зурсан PDF-ээ дараагийн гарын үсэг зурагч / хүлээн авагч руу хавсралтаар илгээнэ (`POST /share`). CA файлыг
**хадгалахгүй**: eID-ийн хүчинтэй гарын үсэгтэй эсэхийг шалгаад илгээж, хаяна. Хүлээн авагч бүрт тусдаа имэйл.

> CA дээр үргэлж асаалттай (2026-10-16-наас туг байхгүй). Хязгаар, квотыг `await eid.shareInfo()`-ээс уншина;
> `enabled` false бол имэйлийн үйлчилгээ түр тохируулагдаагүй (503).

```ts
import { ShareError } from "@gerege-systems/eid-mongolia-sdk";

const info = await eid.shareInfo(); // { enabled, maxFileBytes, maxRecipients, quota: { perRPHour, perRPDay, perRecipientDay }, … }
if (info.enabled) {
  try {
    const r = await eid.share({
      file: signedPdf,                 // Uint8Array | ArrayBuffer | Blob/File; ≤ 3 080 192 байт
      filename: "гэрээ.pdf",           // .pdf өргөтгөлтэй; анхдагч File-ийн нэр эсвэл document.pdf
      to: ["next@example.mn"],         // 1–5, давхардалгүй
      subject: "Гэрээ — гарын үсэг",   // ≤ 150; CA «‹RP нэр›: …» угтвар тавина
      message: "Хоёр дахь гарын үсгийг зурна уу", // ≤ 1000
      lang: "mn",                      // mn | en
    });
    console.log(r.sent, r.sha256, r.signatures, r.docID); // docID — CA-д бүртгэлтэй бол (имэйлд verify холбоос)
  } catch (e) {
    if (e instanceof ShareError) {
      // e.code: ShareErrorCode; 422 → e.reason; 502 → e.sent / e.failed / e.recipients ("sent" | "failed", to-гийн дарааллаар)
    }
    throw e;
  }
}
```

| HTTP | `ShareError.code` | Тайлбар |
|---|---|---|
| 400 | `REQUEST_INVALID`, `FILE_EMPTY`, `RECIPIENT_REQUIRED`, `TOO_MANY_RECIPIENTS`, `RECIPIENT_INVALID`, `RECIPIENT_DUPLICATE` | талбарын алдаа |
| 413 | `FILE_TOO_LARGE` | файл / имэйл хязгаараас их |
| 415 | `FILE_TYPE_NOT_SUPPORTED` | PDF биш (өргөтгөл, Content-Type, `%PDF-` гурвуулаа таарна) |
| 422 | `FILE_NOT_SIGNED` | `.reason`: `no_signature` \| `invalid` \| `untrusted` |
| 429 | `RATE_LIMITED` | квот; `.retryAfterMs`, `.retryable` |
| 502 | `MAIL_FAILED` | `.sent`, `.failed`, `.recipients` — зөвхөн `failed`-ийг дахин илгээ |
| 503 | `MAIL_UNAVAILABLE`, `VALIDATOR_UNAVAILABLE`, `VALIDATOR_BUSY` (`SHARE_DISABLED` — хуучин CA) | тохиргоо / ачаалал (`VALIDATOR_*` — Retry-After) |

401 → `AuthenticationError`, 403 (SIGN эрхгүй, IP/mTLS) → `ForbiddenError`. Квот: RP тутам цагт 30 / өдөрт 200 хүсэлт,
хүлээн авагч тутам өдөрт 10 имэйл (бодит утгыг `shareInfo().quota`-аас). Хугацаа анхдагч 150 с (`timeoutMs`).

## 3g. Гарын үсэгтэй PDF шалгах — `@gerege-systems/eid-mongolia-sdk/validate` (0.20.0)

PDF-ийг **хөтөч эсвэл Node дотор** шалгана — файл хаашаа ч илгээгдэхгүй. CA-ийн нийтийн шалгагчийн (`/v3/validate/pdf`,
Go SDK `pades.ValidatePDF`) дүрэм, ижил JSON тайлан (snake_case); conformance багц нь гурвууланд нэг.

```ts
import { validatePdf, ValidatePdfError } from "@gerege-systems/eid-mongolia-sdk/validate";

try {
  const rep = await validatePdf(new Uint8Array(await file.arrayBuffer())); // анхдагч: үндэсний Root CA, онлайн цуцлалт
  rep.indication; // "valid" | "invalid" | "indeterminate"
  for (const s of rep.signatures) {
    s.signer_name; s.signing_time; s.signature_level; s.certificate_level; s.problems; s.visible; s.key_medium;
  }
} catch (e) {
  if (e instanceof ValidatePdfError) e.code; // PDF_NO_SIGNATURE | PDF_INVALID | PDF_ENCRYPTED | PDF_TOO_LARGE | PDF_TOO_MANY_SIGNATURES | UNSUPPORTED_ENVIRONMENT
}
```

- Алдааны кодууд (0.20.1): `PDF_ENCRYPTED` — `/Encrypt`-тэй баримт (RC4, AES-128, AES-256; хоосон хэрэглэгчийн нууц үгтэй
  ч) шалгагдахгүй: «Шифрлэгдсэн PDF-ийг шалгах боломжгүй — нууцлалыг арилгаад дахин оролдоно уу» (Go `pades.ValidatePDF`,
  CA ижил). `UNSUPPORTED_ENVIRONMENT` — `crypto.subtle` алга (http хуудас — secure context биш, эсвэл хуучин хөтөч):
  https хуудас эсвэл шинэ хөтөч шаардлагатай (өмнө нь `PDF_INVALID`).

- Шалгалт: ByteRange (завсар нь яг `/Contents`) ба messageDigest, CMS гарын үсэг (WebCrypto), signingCertificateV2,
  гинж (үндэсний 01 → 02/03 → 04/05), KU/EKU, хугацаа (цагийн тэмдгийн цагт), RFC 3161 токен, гарын үсгийн ДАРААХ revision
  (eID-ийн гарын үсэг/LTV-ээс өөр бүх өөрчлөлт → `modified_after_signing`), харагдах гарын үсэг (APPEARANCE_SPEC §5), `ltv`,
  `certificate_level` (qcStatements: QUALIFIED/QSCD, бусад ADVANCED).
- Цуцлалт (eID-ийн 04/05-аас гарсан гэрчилгээнд): онлайн — AIA OCSP, эс бөгөөс CDP CRL (`fetch` + AbortSignal; хөтөчид
  `http://ocsp.|crl.eidmongolia.mn` → https, CORS `*`); хариугүй эсвэл `offline: true` бол баримтын DSS. Аль нь ч үгүй →
  `revocation_unavailable`. Сүлжээгээр зөвхөн гэрчилгээний serial (OCSP хүсэлт) явна.
- Цуцлалтын нотолгооны дүрэм (0.21.0, Go v0.7.2-тэй ижил, golden validate v4): OCSP нь ЭНЭ гэрчилгээнийх (CertID =
  гинжийн олгогчийн нэр/түлхүүрийн hash + serial), CRL нь олгогчийнх (нэр, AKI, гарын үсэг). «good» нь шалгах цагт
  шинэлэг байх ёстой: thisUpdate ирээдүйд биш (5 мин хүлцэл), nextUpdate өнгөрөөгүй, thisUpdate ≤ 24 цагийн өмнө эсвэл
  thisUpdate…nextUpdate нь шалгах цагийг хамарна (шалгах цаг = итгэмжлэгдсэн цагийн тэмдгийн цаг, эс бөгөөс `time`/одоо).
  Эс бөгөөс тооцохгүй → `revocation_unavailable`. Олгогчийн гарын үсэгтэй «revoked» (OCSP эсвэл CRL, онлайн эсвэл DSS)
  нь «good»-ийг үргэлж давна. **Өмнө `valid` байсан зарим баримт одоо `indeterminate` эсвэл `invalid`.**
- Итгэлгүй PDF: задлахын өмнө массив/толийн давхарлалт > 256 → `PDF_INVALID` (`prepare` ч мөн; `complete` —
  `STATE_INVALID`). Хамгаалалтын нэг давхарга л — хэмжээ (≤ 10 MiB) ба хугацааг хязгаарла.
- Options: `roots`, `intermediates`, `issuers` (DER, тест), `time`, `offline`, `fetch`, `signal`.
- `key_medium` — гэрчилгээнээс л: qcStatements-тэй иргэний SIGN → `phone`, бусад `unknown` (CA өөрийн бүртгэлээс `token`
  ч тогтооно). `session_id`, `doc_id`, `on_behalf_of_*` нь CA-ийн бүртгэлээс — локал тайланд байхгүй.
- Хөтчийн bundle (минифай): ~253 KB, gzip ~137 KB (`npm run size:validate`, хязгаар 300 KB).

## 4. QR ба ижил төхөөрөмж — device link v3

Иргэн өөр төхөөрөмжийн дэлгэц дээрх **QR**-ийг утсаараа уншина, эсвэл RP-ийн сайт/аппыг eID апптай **ижил
утсан** дээр нээсэн бол товчоор аппыг нээнэ (**Web2App** — утасны браузер, **App2App** — RP-ийн апп). Холбоосыг
ЗӨВХӨН RP backend `buildDeviceLink`-ээр угсарна (Smart-ID RP-API v3 «dynamic link»):

```
QR:      {deviceLinkBase}?deviceLinkType=QR&elapsedSeconds={E}&sessionToken={T}&sessionType=auth&version=1.0&lang=mon&authCode={A}
Web2App: {deviceLinkBase}?deviceLinkType=Web2App&sessionToken={T}&sessionType=auth&version=1.0&lang=mon&authCode={A}
```

- `authCode = BASE64URL(HMAC-SHA256(sessionSecret, …))` — холбоосын төрөл, session, RP-ийн challenge, callback-ийг
  хамгаална. Сервер төрлийг session-д бэхэлж, гарын үсгийн `flowType` = тэр төрөл (хуурамчлах боломжгүй).
- **QR секунд тутам шинэчлэгдэнэ** (`elapsedSeconds = floor(now − receivedAt)`); ~20 секундээс хуучин QR-ийг
  сервер татгалзана → SMS/мессенжерээр дамжуулсан холбоос ажиллахгүй.
- `sessionToken`, **`sessionSecret`-ийг зөвхөн backend-д** хадгална — браузер/апп руу ХЭЗЭЭ Ч бүү гарга.
  Браузер QR-ийн бэлэн холбоосыг backend endpoint-оос секунд тутам авна.
- QR ба товч хоёуланг нэг хуудсанд харуулах бол НЭГ session (`callbackUrl`-тай) эхлүүлж хоёр холбоос угсарна.
  Web2App/App2App нь `callbackUrl`-тай session-д л хүчинтэй.
- Гэрээ: [developer.eidmongolia.mn](https://developer.eidmongolia.mn/) ба ca-eidmongolia-mn `docs/DEVICE_LINK_V3.md`.

```ts
import { buildDeviceLink, type DeviceLinkSession } from "@gerege-systems/eid-mongolia-sdk";

// backend — session эхлүүлээд бүх хариуг СЕРВЕРТ хадгална (sessionToken/sessionSecret/receivedAt/acsp)
const s = await eid.auth.deviceLinkAnonymous(
  [{ type: "displayTextAndPIN", displayText60: "Хаан Банк-д нэвтрэх" }],
  { callbackUrl: "https://bank.example.mn/auth/eid/callback?state=…" }, // товч харуулах бол; host нь callbackHosts-д,
  // зам нь үргэлж /auth/eid/callback болж нормчлогдоно (зөвхөн query хадгалагдана), https заавал
);
store.put(s.sessionId, s);
res.json({ sessionId: s.sessionId, vc: s.vc }); // браузерт ЗӨВХӨН эдгээр

const link = (s: DeviceLinkSession, type: "QR" | "Web2App" | "App2App") =>
  buildDeviceLink({
    deviceLinkBase: s.deviceLinkBase!,
    deviceLinkType: type,
    sessionToken: s.sessionToken!,
    sessionSecret: s.sessionSecret!,
    sessionType: "auth",
    lang: "mon",
    receivedAt: s.receivedAt, // SDK хариу хүлээн авсан мөчийг тэмдэглэнэ
    rpChallenge: s.acsp!.rpChallenge,
    relyingPartyName: s.acsp!.relyingPartyName,
    interactions: s.acsp!.interactions,
    initialCallbackUrl: s.acsp!.initialCallbackUrl, // QR-д authCode-д орохгүй
  });

// GET /eid/qr?sessionId=…  → браузер 1 секунд тутам дуудаж QR-ийг дахин зурна (Cache-Control: no-store)
app.get("/eid/qr", (req, res) => {
  const s = store.get(String(req.query.sessionId)); // өөрийн browser session-д хамаарахыг шалга
  if (!s) return res.sendStatus(404);
  res.set("Cache-Control", "no-store").json({ link: link(s, "QR") });
});
// гар утсанд: товчны href = link(s, "Web2App") (нэг удаа, шинэчлэхгүй)
```

SSE/WebSocket-оор түлхэх бол `qrDeviceLinkTicker(input, (link) => send(link))` — шууд нэг, дараа нь секунд тутам
холбоос гаргаж, буцаасан функцээр зогсооно (session дуусах/клиент салахад заавал).

**Харуулсан төрлөө заавал тулга (relay хаалт).** `expectedFlowType` = RP-ийн харуулсан холбоосын төрөл:

```ts
// QR хуудас → poll-оор дууссан үр дүн
eid.validator.validateAuth(result, s.acsp, { expectedFlowType: "QR" });

// Web2App/App2App товч → апп callback URL-д `userChallengeVerifier` нэмж буцна
eid.validator.validateAuth(result, s.acsp, {
  expectedFlowType: "Web2App", // RP-ийн апп дахь товч бол "App2App"
  userChallengeVerifier: callbackQuery.get("userChallengeVerifier") ?? undefined,
});
// push (notificationBy*) → "Notification"
```

QR ба товч хоёуланг харуулсан хуудсанд: callback-аар ирсэн үр дүнг `Web2App`/`App2App`-аар, poll-оор ирснийг
`QR`-аар шалга (товчоор нээгдсэн session зөвхөн callback-аар дуусна).

> ⚠️ **Legacy холбоос хасагдсан.** Статик `{deviceLinkBase}?sessionId=…&vc=…` холбоосыг сервер 2026-10-07-нд,
> түүнийг угсардаг `deviceLink` / `openOrShowQR`-ийг SDK 0.16.0-д хассан — зөвхөн v3 (`buildDeviceLink`) ажиллана.
> v3 (`flowType`, `userChallengeVerifier`) iOS 2.2.3 (59) / Android 60-аас дэмжигдэнэ; сервер албадах доод хувилбар 2026-10-15-ны байдлаар iOS ≥ 2.2.7, Android ≥ 83
> (`/mobile/app-config`, §«eID аппын доод хувилбар»).

## Аюулгүй байдал — яагаад `validator` заавал

`endResult === "OK"` гэдэгт **дангаар нь итгэхгүй**. RP-API эвдэрсэн/proxy хийгдсэн бол хуурамч
OK ирж болзошгүй. Иймд `ResponseValidator`:

1. `state === COMPLETE && endResult === OK`
2. Иргэний гэрчилгээг **trust anchor (Mongolian National Root CA)** хүртэл chain-аар баталгаажуулна
   (Root → National Issuing CA → Gerege Issuing CA → eID Mongolia Issuing CA → иргэн) — RFC 5280 замын шалгалт
   (Go SDK-ийн `x509.Certificate.Verify`-тэй ижил дүрэм): issuer нэр + AKI/SKI + гарын үсэг, CA basicConstraints +
   **pathLenConstraint** (04 нь `pathlen:0`), CA-ийн keyUsage keyCertSign, CA бүрийн хугацаа, **EKU** (auth →
   clientAuth, sign → emailProtection — CA-ийн профайл; CA-д EKU байвал түүнд багтах), үл таних **critical
   extension** → татгалзана. **Name constraints**-тэй CA гинжинд байвал fail-closed (CA-ийн бодит гинжинд алга).
   Хариунд гинж ирдэггүй — `intermediatesPem` өгөөгүй бол SDK-д суусан 02, 03, 04 (`CITIZEN_INTERMEDIATES_PEM`,
   0.19.0-аас). certificatePolicies-ийг шалгахгүй.
3. Гэрчилгээ хүчинтэй хугацаанд + шаардсан `certificateLevel` (default `QUALIFIED`). **0.19.0-аас түвшинг
   гэрчилгээнээс тогтооно** (`certificateLevelOf`): гарын үсгийн гэрчилгээнд qcStatements QcCompliance → QUALIFIED
   (+ QcSSCD → QSCD), qcStatements-гүй (USB токен) → ADVANCED; нэвтрэлтийн гэрчилгээнд CA qcStatements бичдэггүй тул
   профайлаар — KeyUsage keyEncipherment (утасны P-CITIZEN-AUTH) → QUALIFIED, үгүй (токены) → ADVANCED. Хариуны
   `certificateLevel` түүнээс өндөр бол татгалзана; бага бол хариуныхыг авна. Буцаах `certificateLevel` = энэ утга.
4. Гарын үсгийг иргэний public key-ээр шалгана:
   - **auth** → ACSP_V2 payload (`smart-id|ACSP_V2|serverRandom|rpChallenge|userChallenge|B64(rpName)|B64(brokeredRpName)|B64(SHA-256(interactions))|interactionTypeUsed|initialCallbackUrl|flowType`, hash = хүсэлтийн `hashAlgorithm`) дээр — `flowType`, `userChallenge`, `serverRandom` ба алгоритмын downgrade-ийг мөн шалгана;
     `expectedFlowType` өгвөл `flowType` эхлүүлсэн урсгалтай ЯГ таарах, Web2App/App2App-д `userChallengeVerifier` заавал
     `initialCallbackUrl`-ийг хариуны `signature.initialCallbackUrl`-аас авна (CA урсгалаар шийднэ: QR/Notification →
     `""`, Web2App/App2App → таны callback) — зөвхөн `""` эсвэл
     таны илгээсэн callback байхад, Web2App/App2App-д заавал таны callback; өөр утга → татгалзана
   - **sign** → RP-ийн өгсөн digest дээр; `expectedFlowType` өгвөл хариуны `flowType` ЯГ таарах (гарын үсэгт ордоггүй — хариуны тулгалт)
   - алгоритм нь гэрчилгээний түлхүүртэй уях: `ecdsa-with-SHA256` зөвхөн EC P-256 түлхүүрт, RSA алгоритмууд зөвхөн
     RSA түлхүүрт (alg confusion хаалт). Hash нь үргэлж хүссэнтэй ЯГ тэнцүү. RP-API session-ий гарын үсэг CA дээр
     SplitKey RSA (одоогийн бүх мобайл гэрчилгээ) эсвэл legacy threshold ECDSA P-256-аас гарна; ECDSA credential
     зөвхөн SHA-256 digest зурдаг (өөр hash хүссэн session-д сервер гарын үсэг гаргахгүй), тиймээс SHA-384/512
     хүссэн session-д `ecdsa-with-SHA256` хариу ирвэл хуурамч гэж татгалзана.

5. Цуцлалт — `trust.revocation` (OCSP/CRL hook) → `checkRevocation`, эсвэл `checkRevocationStatus` (`"good"` /
   `"unchecked"` (soft-fail) / `"skipped"` (hook алга)). Бэлэн hook: `ocspRevocationChecker()` — гэрчилгээний AIA OCSP
   (revoked/unknown → `"revoked"`; хариугүй → `"unknown"`, горим шийднэ). Өөр checker/горимоор нэг удаа: `checkRevocationWith`.
6. **Issuer ба зориулалт (0.19.0-аас анхдагч):** `allowedIssuerSkis` анхдагч `[CITIZEN_ISSUING_CA_SKI]` (trust anchor
   тохируулсан үед) — зөвхөн иргэний Issuing CA (04)-ийн гэрчилгээ (ижил root-ийн доорх байгууллагын 05 г.м. хаагдана;
   унтраах: `allowAnyIssuer: true`); `checkKeyUsage` анхдагч `true` — auth → KU digitalSignature + EKU clientAuth,
   sign → KU nonRepudiation (CA-ийн профайл) — нэвтрэлтийн (PIN1) түлхүүрийн гарын үсэг `validateSign`-д тэнцэхгүй
   (унтраах: `checkKeyUsage: false`, зөвлөхгүй). `schemeName` — CA-ийн `acsp_scheme_name` (анхдагч `smart-id`).

Аль нэг алхам бүтэлгүйтвэл `ValidationError` шиднэ — хариунд **итгэхгүй**. Алдааны текстэд иргэний нэр, PNOMN, РД
ордоггүй (`NetworkError.op`-д замыг `/etsi/…` болгоно) — шууд лог руу бичиж болно.

## Алдааны төрлүүд

| Алдаа | Утга |
|---|---|
| `AuthenticationError` | 401 — API secret буруу/байхгүй; CA-ийн JSON бол `.serverMessage` (+ `.code`), proxy-ийнх бол алга (`.body`, `.headers`) |
| `ForbiddenError` | 403 — IP allowlist / mTLS / RP-ийн эрх; onBehalfOf татгалзвал `.code` (`OnBehalfErrorCode`) |
| `SessionFailedError` | endResult ≠ OK (TIMEOUT, USER_REFUSED…) — `.endResult`-оор салга |
| `ValidationError` | cert chain/signature/level шалгалт бүтэлгүйтсэн |
| `NoSigningCertificateError` | 409 `NO_SIGNING_CERTIFICATE` — гарын үсгийн гэрчилгээ / төхөөрөмж алга (sign, cert-choice start); `ApiError`-ийн дэд анги |
| `CertChoiceInvalidError` | 409 `CERT_CHOICE_INVALID` — linked sign-ийн certificate-choice хүчингүй; `ApiError`-ийн дэд анги |
| `RequestInvalidError` | 400 `REQUEST_INVALID` — хүсэлт буруу (ж: `linkedSessionID` дутуу); `ApiError`-ийн дэд анги |
| `ShareError` | `share()`-ийн 4xx/5xx (401/403-аас бусад) — `.code` (`ShareErrorCode`), `.reason` (422), `.sent`/`.failed`/`.recipients` (502); `ApiError`-ийн дэд анги |
| `ApiError` | бусад HTTP алдаа (`.status`, `.body`, серверийн `.code`, `.retryAfterMs`, `.headers`, `.retryable` — ж: 404 `ORG_NOT_FOUND`) |
| `ResponseTooLargeError` | хариу SDK-ийн хязгаараас их (JSON 4 MiB) — `.op`, `.limit` |
| `NetworkError` | timeout/сүлжээ (`.op` — таних тэмдэггүй зам, `.timeout`) |
| `PadesError` (`/pades`) | клиент талын PAdES — `.code` (§3d), `.retryable` |
| `DeviceLinkError` | device-link холбоос угсрах боломжгүй (`deviceLinkBase` https биш, token/secret/lang хэлбэр, төрөлд хэрэгтэй талбар дутуу) |

## mTLS (eIDAS qualified орчин)

```ts
import { Agent } from "undici";
const eid = new EidClient({
  /* … */
  dispatcher: new Agent({ connect: { cert: clientCertPem, key: clientKeyPem } }),
});
```

## Хөгжүүлэлт

```bash
npm install
npm run lint          # tsc --noEmit
npm test              # build + node --test (pades golden — Go reference-тэй байт-ижил)
npm run golden:check  # test/fixtures/pades/golden + src/pades/assets ↔ бэхэлсэн Go commit
npm run size:pades    # /pades хөтчийн bundle gzip ≤ 300 KB
npm run test:convert-e2e   # /convert жинхэнэ LibreOffice Chromium-д (BROWSER=webkit — WebKit)
```

`/pades`-ийн conformance fixture (golden: оролт, тестийн PKI-ийн гэрчилгээ, TSA/OCSP/CRL-ийн тогтмол хариу, хүлээгдэх
sha256) ба фонт/гинжийн asset-ийг Go reference-ээс `node scripts/sync-pades-golden.mjs` хуулна (`GO_SDK_COMMIT` —
tag `pades-golden-vN`, одоо v5 — `placement/` scanner vectors-той); CI `--check`-ээр бэхэлсэн commit-тэй тулгана. Профайл:
Go репогийн `pades/PROFILE.md`, `PAGE_SPEC.md`, `PRECHECKS.md`, `WIRE.md`, `APPEARANCE_SPEC.md`, `PLACEMENT_SPEC.md`.

### Гэрээний шалгалт

SDK-ийн дууддаг RP-API зам бүр (`src/contract.ts`) live [`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid)-ийн
`endpoints`-д байх ёстой. Discovery-д байгаа ч SDK хамраагүй замууд WARN (fail биш). Сүлжээ шаарддаг тул `npm test`-д ордоггүй:

```bash
npm run test:contract
```

CI: `.github/workflows/contract.yml` — PR, `main` push, өдөр бүр 00:00 UTC, гараар.
