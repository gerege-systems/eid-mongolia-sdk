# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia** (Монгол Улсын иргэний цахим үнэмлэх) Relying Party SDK — иргэнээр утсаар нь нэвтрэлт
(authentication) ба хууль ёсны цахим гарын үсэг (qualified signature) хийлгэх Node.js/TypeScript сан.
RP-API v3, Smart-ID нийцтэй. Бүрэн баримт: <https://developer.eidmongolia.mn/>.

> ⚠️ SDK **backend**-д ажиллана: бүх дуудлага API secret (`rp_sk_…`)-ээр баталгаажна, secret-ийг браузер/гар утсанд
> хэзээ ч задлахгүй. Браузерт зөвхөн таны backend-ийн өгсөн холбоос/QR/товч харагдана — «eID-ээр нэвтрэх» товч
> (`/button`) ч таны backend-ийг л дуудна (§1a). `@gerege-systems/eid-mongolia-sdk/browser`-ийн legacy device-link
> туслахууд 2026-10-07-оос ажиллахгүй (§4).

## Суулгах

```bash
npm install @gerege-systems/eid-mongolia-sdk
```

Node.js ≥ 22 (global `fetch`, `node:crypto`).

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
| Desktop хөтөч | Цонх: QR (секунд тутам шинэчлэгдэнэ) + «регистрийн дугаараар утас руу мэдэгдэл» (push), үлдсэн хугацаа, шууд төлөв |
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
import { EidClient, createEidLogin } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  credentials: { rpUUID: process.env.EID_RP_UUID!, rpName: "Интернэт банк", apiSecret: process.env.EID_SECRET! },
  trust: { trustAnchorsPem: [process.env.EID_NATIONAL_ROOT_CA_PEM!] },
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
  // rateLimit: (key) => redisLimiter.allow(key), // "start:<ip>", "push:<idCode>"; анхдагч push 3/мин нэг дугаарт
  trustProxy: 1, // handle(Request)-д клиент IP: nginx/LB нэг hop бол 1 (доор «Клиент IP»)
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
(Express `req.ip`, `app.set("trust proxy", …)`-тэй) шууд хэрэглэгдэнэ. Анхдагч `rateLimit` зөвхөн `push:`-ийг хязгаарладаг —
`start:<ip>`-ийг өөрийн `rateLimit`-ээр (Redis г.м.) хязгаарлана. Go: `eidlogin.Config.ClientIP` (`eidlogin.ForwardedClientIP(n)`) — ижил дүрэм.

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

эсвэл `mountEidLoginButton(el, { startUrl, statusUrl, lang: "en", theme: "auto", successUrl, onSuccess, onError })`.
Атрибут: `lang` (`mn` | `en`), `mode` (`auto` анхдагч — утас → Web2App, бусад → QR цонх; `qr`; `app`),
`theme` (`auto` анхдагч | `light` | `dark`), `success-url`.
Үйл явдал: `eid-login-success`, `eid-login-error` (`detail.error`: `USER_REFUSED…`, `VALIDATION`, `EXPIRED` …).
Гадны хамааралгүй (QR encoder дотроо), цонх нь focus trap, Esc, `aria-live` төлөвтэй.

**Дизайн, theme.** Дизайн нь eID нэвтрэх хуудсынх (лого, өнгө). Фонт нь хуудаснаас өвлөгдөнө (товч, цонх, input бүгд).
`theme="auto"` үед дараалал: хуудасны `html[data-theme="dark|light"]` → `html.dark` / `html.light` → OS
(`prefers-color-scheme`); хуудас theme солиход (MutationObserver) шууд дагана. `theme="light|dark"` нь хуудсыг давна.
Өнгө, радиусыг CSS хувьсагчаар (элемент дээр — shadow-ийн `:host`-оос давуу) дарна:

```css
eid-login-button {
  --eid-accent: #0b5cff; --eid-accent-fg: #fff;   /* үндсэн товч, QR-ийн алхмын тоо (--eid-accent-subtle, --eid-accent-subtle-fg) */
  --eid-bg: #fff; --eid-bg-subtle: …; --eid-bg-muted: …;  /* цонх, hover */
  --eid-fg: …; --eid-fg-muted: …; --eid-fg-subtle: …;     /* текст */
  --eid-border: …; --eid-border-strong: …; --eid-ring: …; /* хүрээ, focus */
  --eid-warning-bg: …; --eid-warning-border: …; --eid-warning-fg: …; --eid-danger-fg: …;
  --eid-radius: 6px; --eid-radius-lg: 8px;
}
html[data-theme="dark"] eid-login-button { --eid-accent: …; } /* dark-д өөр өнгө бол */
eid-login-button::part(button) { width: 100%; }               /* part: button, backdrop, dialog */
```

**eID аппын доод хувилбар.** `flowType` бэхлэлт (device link v3) ба Web2App-ийн `userChallengeVerifier` нь
**iOS 2.2.3 (build 59)**, **Android 2.2.3 (versionCode 60)**-аас эхэлсэн. eID сервер 2026-10-07-оос legacy холбоосыг
бүрэн хассан (v3-гүй session-д утас `DEVICE_LINK_REQUIRED`) бөгөөд доод хувилбарыг `/mobile/app-config`-оор албадан
шинэчлүүлдэг: Android 2026-10-07-оос ≥ 70 (төхөөрөмжийн баталгаатай), 2026-10-14-ний байдлаар iOS ≥ 2.2.7,
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
- `onSuccess`-ийн `data` хөтөчид очно — нууц бүү оруул. Иргэний бүртгэлтэй эсэхийг push алдаагаар задлахгүй (`eid_unavailable`).
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
  trust: { trustAnchorsPem: [process.env.EID_NATIONAL_ROOT_CA_PEM!] }, // ← Mongolian National Root CA, production-д ЗААВАЛ
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
> Хуучин `/dl?sessionId&vc` холбоос (`deviceLink`) push session-д ч юу ч өгөхгүй (сервер `DEVICE_LINK_REQUIRED`).
> Иргэн RP-ийг eID апптай ижил утсан дээр нээсэн бол push-ийн оронд **device-link Web2App** урсгал хэрэглэ
> (`auth.deviceLink*` / `pdf.prepare({ flow: "device-link" })` + `buildDeviceLink(…, "Web2App")`, §4) — товч аппыг шууд
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
Эцсийн үнэн нь `GET /session` (`TIMEOUT`).

**Session эхлэх алдаа** (`ApiError`-ийн дэд анги, `.code`-той): `NoSigningCertificateError` — 409
`NO_SIGNING_CERTIFICATE` (sign / certificate-choice start, `/pdf/sign/prepare`: иргэнд идэвхтэй төхөөрөмж / хүчинтэй
гарын үсгийн гэрчилгээ алга, session үүсээгүй); `CertChoiceInvalidError` — 409 `CERT_CHOICE_INVALID` (linked sign-ийн
certificate-choice хүчингүй / хуучирсан / ашиглагдсан → cert-choice-ийг дахин эхлүүл); `RequestInvalidError` — 400
`REQUEST_INVALID` (ж: linked-д `linkedSessionID` дутуу).

### 3.1. Гэрчилгээг урьдчилж мэдэх (client-side PAdES / CMS)

Гэрчилгээ DTBS-д (`signingCertificateV2`) ордог тул эхлээд certificate-choice, дараа нь digest-ийг **яг тэр төхөөрөмж
рүү (`documentNumber`)** зуруулна. Олон утастай иргэнд etsi-ээр эхлүүлбэл өөр утас зурж, гарын үсэг гэрчилгээтэйгээ
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

// 2. PDF (PAdES, CA угсарна) — санал болгох урсгал.
try {
  const s = await eid.pdf.prepare({
    pdf: pdfBytes, fileName: "Гэрээ №12.pdf",
    signer: { etsi: "PNOMN-12345678" }, flow: "notification",
    onBehalfOf: "NTRMN-6235972",
  });
  showToUser(s.vc);
  const r = await eid.session.waitForResult(s.sessionId);
  // MUST: endResult OK, pdf.documentStatus READY, pdf.signer.onBehalfOf = хүссэн байгууллага,
  // татсан файлын SHA-256 = pdf.outSha256, validation.indication "valid", ltv true.
  if (r.pdf?.documentStatus !== "READY" || r.pdf.signer?.onBehalfOf !== "NTRMN-6235972") throw new Error("…");
  const signed = await eid.pdf.documentVerified(s.sessionId, r.pdf); // SHA-256 ≠ pdf.outSha256 → ValidationError
  console.log(r.pdf.signer.claimedRole); // "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)"
} catch (e) {
  if ((e instanceof ForbiddenError || e instanceof ApiError) && e.code) {
    // REPRESENTATION_DENIED | REPRESENTATION_PENDING | REPRESENTATION_EXPIRED | ORG_NOT_ACTIVE |
    // SIGNER_UNIDENTIFIED (403) · ORG_NOT_FOUND (404) · REPRESENTATION_REVOKED (403, document татах үед)
  }
  throw e;
}

// Raw digest гарын үсэгт ч мөн: eid.sign.digestByEtsi(id, digest, interactions, { onBehalfOf: "NTRMN-6235972" })
// — CMS/PDF-ийг та угсардаг тул мэдүүлсэн үүргийг (signer-attributes-v2) өөрөө нэмнэ.
```

`prepare`-ийн хариу `digest` (DTBS, base64) — иргэний зурах 32 байт, push ба device-link хоёуланд (хуучин CA push-д
`undefined`). Иргэний гарын үсгийг өөрөө шалгах бол: `eid.validator.validateSign(r, s.digest!, { expectedFlowType: "QR" })`
(харуулсан урсгалаа). Гарын үсэгтэй PDF-ийг
`pdf.document()`-ийн оронд `pdf.documentVerified(sessionId, r.pdf)`-аар тат — `READY` + `outSha256` тулгалтыг хийнэ.

Түр алдаа — `ApiError.retryable` үнэн, `retryAfterMs`-ийн (CA-ийн `Retry-After`, секунд эсвэл огноо) дараа давтана:
prepare 429 `PDF_PREPARE_BUSY`, 503 `LTV_UNAVAILABLE` / `TSA_UNAVAILABLE`; document 503 `DOCUMENT_PENDING`,
`TSA_UNAVAILABLE`, `LTV_UNAVAILABLE` (`RETRYABLE_ERROR_CODES`). `headers` — хариуны header. PDF дуудлагын хугацаа
`pdfTimeoutMs` (анхдагч 80000). `pdf.document` санах ойд `pdfMaxBytes` (анхдагч `DEFAULT_PDF_MAX_BYTES` = 64 MiB)
хүртэл уншина; хэтэрвэл `ResponseTooLargeError`. JSON хариу 4 MiB-ээс хэтэрвэл мөн `ResponseTooLargeError` (таслахгүй).
`getRepresentations`-ийн `raw` — серверийн түүхий JSON.

**Хүнд харуулахдаа `roleLabel` / `rightTypeLabel` / `sourceLabel` ашигла** (representations болон session-ий
`onBehalfOf`; `onBehalfOf`-д `source` байхгүй тул зөвхөн `roleLabel` / `rightTypeLabel`) — `role` (`ceo` / `founder` /
`stakeholder` эсвэл MANAGER-т бичсэн текст), `rightType` (`ADMIN` | `MANAGER`), `source` (`REGISTRY` | `MANUAL`) нь
машин утга, өөрөө орчуулахгүй. Хэл: `new EidClient({ …, language: "en" })` → дуудлага бүрд `Accept-Language`; анхдагч
илгээхгүй (сервер mn). Хуучин CA-д эдгээр талбар байхгүй.

Олон талт гэрээ: А байгууллагын гаралтыг өөрчлөлтгүй Б-ийн `prepare`-д (`docID`, өөр `onBehalfOf`) илгээнэ.
Session-ий `onBehalfOf` блок (`role`/`roleLabel`/`rightType`/`rightTypeLabel`) нь хариу угсрах үеийн бүртгэл; `pdf.signer.onBehalfOf`/`claimedRole`
нь баримтад бичигдсэн утга.

## 3b. Иргэний PKI самбар (`PKI_READ` эрх)

`eid.person.certificates(etsi)` · `devices` · `activity(etsi, { flow, limit, offset })` · `summary` · `children` — иргэн
сүүлийн 24 цагт танай RP-ээр нэвтэрсэн байх ёстой (эс бөгөөс `ForbiddenError`). Хариу бүрт `raw`.

## 3c. USB токен

```ts
import { verifyTokenCertificates, tokenAuthDigest, tokenLimitOf } from "@gerege-systems/eid-mongolia-sdk";

// гэрчилгээ олголт (TOKEN_ISSUE эрх) — иргэн утсаараа PIN2-оор батална
const st = await eid.token.issueCertificate({ signerEtsi, csrAuth, csrSign, tokenSerial: "EP2003-0042A1" }); // onBehalfOf алга = хувийн
// … eid.session.poll(st.sessionId) → result.tokenCertificate?.status === "ISSUED"
const res = await eid.token.certificateResult(st.sessionId);
verifyTokenCertificates(res, csrAuth, csrSign); // гэрчилгээ бүр CSR-ийн түлхүүртэй
// 409 TOKEN_LIMIT_REACHED → tokenLimitOf(err): { kind, limit, organization? }

// токеноор нэвтрэх (AUTH эрх)
const ch = await eid.token.authChallenge();
const digest = tokenAuthDigest(ch.rpUUID, ch.challenge); // токен CKM_ECDSA → түүхий r||s
const who = await eid.token.authVerify(ch.challengeId, authCertDer, rs);

// токеноор PDF (PAdES, SIGN эрх) — session/утасгүй; байгууллагын токенд onBehalfOf = тухайн байгууллага
const p = await eid.pdf.tokenPrepare({ pdf, fileName: "Гэрээ.pdf", signerEtsi, certificate: signCertDer });
const rs = /* токен (PKCS#11): CKM_ECDSA(p.hashToSign) → түүхий r||s, 64 байт — p.expiresAt хүртэл */ new Uint8Array(64);
const blk = await eid.pdf.tokenFinalize(p.signingId, rs); // READY; 503 DOCUMENT_PENDING → ижил rs-ийг дахин
const signed = await eid.pdf.tokenDocument(p.signingId); // SHA-256 = blk.outSha256 тулга
```

`/token/auth/*`, `/pdf/token/*` нь CA-д байгаа ч `/.well-known/eid`-д хараахан жагсаагдаагүй (гэрээний тест WARN).

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

> ⚠️ **Legacy холбоос хасагдсан (2026-10-07).** Статик `deviceLink(session)` (`{deviceLinkBase}?sessionId=…&vc=…`)
> болон `/browser` entry-ийн `openOrShowQR`-ээр нээгдсэн session-д сервер утасны үйлдлийг `DEVICE_LINK_REQUIRED`-аар
> татгалзана — зөвхөн v3 (`buildDeviceLink`) ажиллана. Аппын доод хувилбар: iOS 2.2.3 (59), Android 70.

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
   `intermediatesPem`-д 02, 03, 04-ийг бүгдийг өгнө (хариунд гинж ирдэггүй). certificatePolicies-ийг шалгахгүй.
3. Гэрчилгээ хүчинтэй хугацаанд + шаардсан `certificateLevel` (default `QUALIFIED`)
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
   `"unchecked"` (soft-fail) / `"skipped"` (hook алга)).
6. Нэмэлт (сонголттой): `allowedIssuerSkis: [CITIZEN_ISSUING_CA_SKI]` — зөвхөн иргэний Issuing CA (04)-ийн гэрчилгээ;
   `checkKeyUsage: true` — auth → clientAuth, sign → nonRepudiation (CA-ийн профайл); `schemeName` — CA-ийн
   `acsp_scheme_name` (анхдагч `smart-id`).

Аль нэг алхам бүтэлгүйтвэл `ValidationError` шиднэ — хариунд **итгэхгүй**. Алдааны текстэд иргэний нэр, PNOMN, РД
ордоггүй (`NetworkError.op`-д замыг `/etsi/…` болгоно) — шууд лог руу бичиж болно.

## Алдааны төрлүүд

| Алдаа | Утга |
|---|---|
| `AuthenticationError` | 401 — API secret буруу/байхгүй; CA-ийн JSON бол `.serverMessage` (+ `.code`), proxy-ийнх бол алга (`.body`, `.headers`) |
| `ForbiddenError` | 403 — IP allowlist / mTLS / RP-ийн эрх; onBehalfOf татгалзвал `.code` (`OnBehalfErrorCode`) |
| `SessionFailedError` | endResult ≠ OK (TIMEOUT, USER_REFUSED…) — `.endResult`-оор салга |
| `ValidationError` | cert chain/signature/level шалгалт бүтэлгүйтсэн |
| `NoSigningCertificateError` | 409 `NO_SIGNING_CERTIFICATE` — гарын үсгийн гэрчилгээ / төхөөрөмж алга (sign, cert-choice start, PDF prepare); `ApiError`-ийн дэд анги |
| `CertChoiceInvalidError` | 409 `CERT_CHOICE_INVALID` — linked sign-ийн certificate-choice хүчингүй; `ApiError`-ийн дэд анги |
| `RequestInvalidError` | 400 `REQUEST_INVALID` — хүсэлт буруу (ж: `linkedSessionID` дутуу); `ApiError`-ийн дэд анги |
| `ApiError` | бусад HTTP алдаа (`.status`, `.body`, серверийн `.code`, `.retryAfterMs`, `.headers`, `.retryable` — ж: 404 `ORG_NOT_FOUND`) |
| `ResponseTooLargeError` | хариу SDK-ийн хязгаараас их (JSON 4 MiB, PDF `pdfMaxBytes`) — `.op`, `.limit` |
| `NetworkError` | timeout/сүлжээ (`.op` — таних тэмдэггүй зам, `.timeout`) |
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
npm run lint   # tsc --noEmit
npm test       # build + node --test
```

### Гэрээний шалгалт

SDK-ийн дууддаг RP-API зам бүр (`src/contract.ts`) live [`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid)-ийн
`endpoints`-д байх ёстой. Discovery-д байгаа ч SDK хамраагүй замууд WARN (fail биш). Сүлжээ шаарддаг тул `npm test`-д ордоггүй:

```bash
npm run test:contract
```

CI: `.github/workflows/contract.yml` — PR, `main` push, өдөр бүр 00:00 UTC, гараар.
