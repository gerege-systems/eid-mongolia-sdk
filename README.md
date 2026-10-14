# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia** (Монгол Улсын иргэний цахим үнэмлэх) Relying Party SDK — иргэнээр утсаар нь нэвтрэлт
(authentication) ба хууль ёсны цахим гарын үсэг (qualified signature) хийлгэх Node.js/TypeScript сан.
RP-API v3, Smart-ID нийцтэй. Бүрэн баримт: <https://developer.eidmongolia.mn/>.

> ⚠️ SDK **backend**-д ажиллана: бүх дуудлага API secret (`rp_sk_…`)-ээр баталгаажна, secret-ийг браузер/гар утсанд
> хэзээ ч задлахгүй. Браузерт зөвхөн таны backend-ийн өгсөн холбоос/QR/товч харагдана — «eID-ээр нэвтрэх» товч ч
> энгийн холбоос, `code` → `id_token` солих нь backend-д (§1a). `@gerege-systems/eid-mongolia-sdk/browser`-ийн
> legacy device-link туслахууд 2026-10-07-оос ажиллахгүй (§4). Үл хамаарах: `@gerege-systems/eid-mongolia-sdk/pades`
> (клиент талын PDF гарын үсэг, secret-гүй) хөтөч болон Node-д ажиллана (§3d).

## Суулгах

```bash
npm install @gerege-systems/eid-mongolia-sdk
```

Node.js ≥ 22 (global `fetch`, `node:crypto`).

## 1. RP бүртгүүлэх

RP-г eID Mongolia-гийн оператор бүртгэнэ — хүсэлтээ <eIDsupport@gerege.com> эсвэл 7777-3773-аар гаргана
(нийтийн `POST /v3/rp-applications` 2026-10-14-нөөс засвартай: `503 rp_applications_maintenance`). Оператор
баталсны дараа **relyingPartyUUID** ба **API secret** (`rp_sk_…`) олгогдоно; secret **зөвхөн нэг удаа** харагдана.
Шаардлагатай мэдээлэл (байгууллага, зорилго `AUTH`/`SIGN`, `callbackHosts`, OIDC redirect URI…):
<https://developer.eidmongolia.mn/#registration>.

## 1a. «eID-ээр нэвтрэх» (OpenID Connect)

Хамгийн хялбар нэвтрэлт: таны вэбэд нэг товч, нэвтрэх хуудсыг (QR · утсан дээрх аппаар нээх · регистрээр
мэдэгдэл) eID сервер өөрөө харуулж, гарын үсэг ба гэрчилгээний гинжийг шалгаад танд стандарт OpenID Connect
(Authorization Code + PKCE `S256`) `id_token` өгнө — Google/Apple нэвтрэлттэй ижил. Утасны хөтчөөс дарахад
хуудасгүйгээр шууд eID апп нээгдэнэ. Гэрээ: <https://developer.eidmongolia.mn/#oidc>.

**Хаана юу ажиллах.** Товч нь браузерт (энгийн `<a href>` таны backend-ийн `/auth/eid/login` руу); `EidOidcClient`
нь backend-д — authorize URL угсрах, callback-д `code`-ийг `client_secret`-ээр `id_token` болгон солих, гарын үсгийг
шалгах. eID-ийн OIDC client нь одоогоор зөвхөн **confidential client** (`client_secret_basic`): backend-гүй SPA эсвэл
native апп дангаараа token endpoint-ийг дуудаж чадахгүй — native апп ч `code`-ийг өөрийн backend-ээр солино (доор).

**Бүртгэл.** `client_id` = таны RP UUID (`relyingPartyUUID`), `client_secret` = RP API secret (`rp_sk_…`).
RP-д `AUTH` эрх, OIDC асаалттай, `redirect_uri` (https, ≤ 10) бүртгэлтэй байна — authorize/token-ий `redirect_uri`
бүртгэлтэйтэй **тэмдэгт бүрээрээ** таарах ёстой. Иргэний ETSI дугаар (`pnomn` claim) хэрэгтэй бол `PNOMN` эрх
хүсэж, `scope: "openid pnomn"`. Token endpoint-д RP-ийн IP allowlist мөрдөгдөнө.

**mTLS-тэй RP (`require_mtls`).** `login.` хост mTLS хийдэггүй тул ийм RP-ийн code солих хүсэлт
`login.eidmongolia.mn/oauth2/token` дээр `401 invalid_client` авна. Discovery-ийн `mtls_endpoint_aliases.token_endpoint`
(RFC 8705 §5, `https://rp.eidmongolia.mn/oauth2/token`) руу RP-API-д хэрэглэдэг **ижил client cert**-ээр явуулна:
`useMtlsEndpointAliases: true` + `dispatcher` (RP-API client-ийнхтэй ижил undici `Agent`). Discovery-д alias байхгүй
бол `token_endpoint` руу буцна; alias https биш бол `discovery_failed`. mTLS-гүй RP флаг тавихгүй.

```ts
import { Agent } from "undici";
const oidc = new EidOidcClient({
  clientId: process.env.EID_RP_UUID!,
  clientSecret: process.env.EID_SECRET!,
  redirectUri: "https://bank.example.mn/auth/eid/callback",
  dispatcher: new Agent({ connect: { cert: clientCertPem, key: clientKeyPem } }), // RP-API-ийн cert
  useMtlsEndpointAliases: true, // token → https://rp.eidmongolia.mn/oauth2/token
});
```

```ts
import { EidOidcClient, EidOidcError } from "@gerege-systems/eid-mongolia-sdk";

const oidc = new EidOidcClient({
  clientId: process.env.EID_RP_UUID!,
  clientSecret: process.env.EID_SECRET!, // rp_sk_… — зөвхөн backend
  redirectUri: "https://bank.example.mn/auth/eid/callback",
  // issuer анхдагч https://login.eidmongolia.mn, scope анхдагч "openid"
});

const TX = "eid_oidc_tx";
const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax", path: "/auth/eid", maxAge: 600_000 } as const;

// GET /auth/eid/login — товчны href
app.get("/auth/eid/login", async (_req, res) => {
  const a = await oidc.createAuthorization(); // { url, state, nonce, codeVerifier }
  res.cookie(TX, JSON.stringify({ state: a.state, nonce: a.nonce, codeVerifier: a.codeVerifier }), cookieOpts);
  res.set("Cache-Control", "no-store").redirect(302, a.url);
});

// GET /auth/eid/callback?code&state (эсвэл ?error) — бүртгэлтэй redirect_uri
app.get("/auth/eid/callback", async (req, res) => {
  const tx = JSON.parse(req.cookies[TX] ?? "null");
  res.clearCookie(TX, { path: "/auth/eid" });
  if (!tx) return res.redirect(303, "/login?error=state");
  try {
    const { claims } = await oidc.handleCallback(req.originalUrl, tx); // state → token → id_token (ES256)
    const user = await users.findOrCreateBySub(claims.sub); // pairwise sub-аар таньна (нэрээр биш)
    await startSession(res, user); // таны session-ийг шинээр үүсгэ (session fixation)
    res.redirect(303, "/");
  } catch (e) {
    const code = e instanceof EidOidcError ? e.code : "server_error"; // access_denied → «дахин оролдоно уу»
    res.redirect(303, `/login?error=${code}`);
  }
});
```

Next.js App Router-д ижил: `app/auth/eid/login/route.ts` → `NextResponse.redirect(a.url, 302)` + `res.cookies.set(…)`;
callback → `oidc.handleCallback(request.nextUrl.searchParams, tx)` (зөвхөн query уншина — прокси ард host хамаагүй).

**Товч** — энгийн холбоос (`<a href>` эсвэл form GET). `fetch`/XHR/JS redirect биш: iOS Universal Link зөвхөн
хэрэглэгчийн tap-аас эхэлсэн redirect гинжид eID аппыг нээнэ.

```html
<a class="eid-login" href="/auth/eid/login">
  <img src="/img/eid-mongolia.png" alt="" width="20" height="20">
  eID Mongolia-аар нэвтрэх
</a>
<style>
  .eid-login { display: inline-flex; align-items: center; justify-content: center; gap: .5rem; min-height: 44px;
    padding: 0 1.25rem; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; color: #111827;
    font: 500 1rem/1 system-ui, sans-serif; text-decoration: none; }
  .eid-login:hover { background: #f5f7fa; }
  .eid-login:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
```

Бичвэр «eID Mongolia-аар нэвтрэх», зүүн талд eID Mongolia лого (<https://developer.eidmongolia.mn/logo-96.png>-ийг
татаж өөрийн хостоос үйлчил). Google/Apple-ийн товч шиг саармаг (цагаан, хүрээтэй) — таны сайтын бусад нэвтрэх
товчтой зэрэгцэж болно. Жишээ: <https://demo.eidmongolia.mn>.

`createAuthorization({ display: "page" })` — утсан дээр ч нэвтрэх хуудас (QR / push) харуулна (ж: таблет киоск).

**`id_token` claims** (`EidIdTokenClaims`): `sub` (pairwise — RP тус бүрд өөр, иргэнд тогтмол), `acr`
(`urn:eidmongolia:loa:qualified` | `…:advanced`), `auth_time`, `given_name` / `family_name` (латин, гэрчилгээнээс),
`given_name_mn` / `family_name_mn` (кирилл, байвал), `pnomn` (`pnomn` scope + эрхтэй үед). `id_token` 5 минут
хүчинтэй; access_token / refresh_token / userinfo байхгүй — нэвтрэлтийн дараа өөрийн session-оо хэрэглэнэ.

**Аюулгүй байдал.**

- `state`, `nonce`, `codeVerifier`-ийг **хөтчийн session-тэй** (httpOnly, Secure, SameSite=Lax cookie эсвэл server
  session) холбож хадгална; `handleCallback` state-ийг timing-safe тулгаж, таарахгүй бол code-ийг солихгүй
  (`state_mismatch`). Үүнгүйгээр «өөрийн бүртгэлд хохирогчийн eID-ийг холбуулах» (login CSRF) нээлттэй.
- `handleCallback` / `verifyIdToken` нь ES256 гарын үсэг (JWKS `kid`, cache 1 цаг, танихгүй `kid` → нэг удаа дахин
  татна), `iss`, `aud` (= `clientId`; олон aud бол `azp`), `exp` / `iat` (±60 сек), `nonce`-ийг шалгана.
  `EidOidcError` (`invalid_id_token`) гарвал **итгэхгүй**.
- Code нэг удаагийн, 60 секунд — callback-ийг дахин ачаалбал `invalid_grant`; хэрэглэгчийг дахин нэвтрүүлнэ.
- `error_description` (`EidOidcError.description`)-ийг логт бичиж болно, хэрэглэгчид шууд харуулахгүй.
- **Native апп (RFC 8252):** authorize-ийг системийн хөтчөөр нээнэ — iOS `ASWebAuthenticationSession`
  (`prefersEphemeralWebBrowserSession = false`), Android Custom Tabs. **WebView хориотой.** `redirect_uri` = таны
  https Universal Link / App Link (custom scheme дэмжихгүй). `state` / `nonce` / `codeVerifier` апп-ын санах ойд;
  code-ийг таны backend `client_secret`-ээр солино (`client_secret`-ийг аппад хадгалахгүй).

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

// токеноор PDF: §3d — prepare() → токен CKM_ECDSA(dtbs) → r||s → complete() → registerSignature() (sessionId-гүй)
```

`/token/auth/*` нь CA-д байгаа ч `/.well-known/eid`-д хараахан жагсаагдаагүй (гэрээний тест WARN).

## 3d. PDF гарын үсэг (PAdES, клиент тал) — `@gerege-systems/eid-mongolia-sdk/pades`

**PDF eID-ийн сервер рүү ОЧИХГҮЙ** (Smart-ID / DigiDoc загвар). Баримтыг таны тал (браузер эсвэл Node) Go core-ийн
WebAssembly-аар угсарна; CA зөвхөн 32 байт DTBS-д гарын үсгийн session (ердийн `RAW_DIGEST_SIGNATURE`) ба CMS-ийн
бүртгэлийг хийнэ. Гаралт: PAdES-BASELINE-LT (цагийн тэмдэг tsa.timeserver.mn, OCSP/CRL DSS-д), Adobe / EU DSS-д
«LTV enabled», баталгаажуулах (QR) хуудастай. Бүх платформд (Go, iOS, Android, Windows) нэг core — гаралт байт-ижил.

| Функц | Хаана | Тайлбар |
|---|---|---|
| `prepare(pdf, { signerCert, claimedRole?, verifyPage?, fileName?, docId?, … })` | браузер / Node | `{ dtbs, digest, docId, state }` — сүлжээгүй |
| `eid.signPdfDigest({ dtbs, fileName, signer, flow?, onBehalfOf? })` | RP backend | DTBS-д гарын үсгийн session (push эсвэл device-link) |
| `complete(state, signature)` | браузер / Node | TSA + OCSP/CRL → `{ pdf, cms, docId, outSha256, inSha256, hasPage, pageSha256, … }` |
| `eid.registerSignature({ docID, sessionId, cms, … })` | RP backend | `POST /pdf/signatures` — `/verify/{docID}` бүртгэл |
| `verify(pdf)` | браузер / Node | гарын үсгүүдийн тайлан (CA-ийн нийтийн шалгагчийн хэлбэр) |

Үндсэн entry WASM-ыг агуулахгүй (PDF ашиглахгүй RP-д bundle томрохгүй); `/pades` WASM-аа (~24 MB, gzip ~8 MB) анхны
дуудлагад залхуугаар ачаална. Node ≥ 18, орчин үеийн хөтөч. Браузерийн CSP: `script-src 'wasm-unsafe-eval'`,
`connect-src https://tsa.timeserver.mn https://ocsp.eidmongolia.mn https://crl.eidmongolia.mn`. Bundler (Vite / webpack 5)
`new URL("./eid-pades.wasm", import.meta.url)`-ийг asset болгон хуулна; өөр байрлалаас бол `loadPades({ wasm: url })`.

**Зурагчийн гэрчилгээ.** `prepare` иргэний SIGN гэрчилгээг (`signingCertificateV2`) шаарддаг тул session-оос ӨМНӨ
хэрэгтэй — одоогоор `eid.person.certificates(etsi)` (`PKI_READ`; `type: "SIGN"`, `status: "VALID"`, `keyMedium: "MOBILE"`
мөрийн `certValue` + `documentNumber`). Session-ийг тэр `documentNumber`-ээр эхлүүлнэ — өөр төхөөрөмж зурвал `complete`
`SIGNATURE_INVALID`.

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
const done = await complete(p.state, signature);                                 // TSA + LTV + self-validation
await api(`/sign/pdf/${s.sessionId}/register`, {
  docID: done.docId, cms: b64(done.cms), outSha256: done.outSha256, inSha256: done.inSha256,
  hasPage: done.hasPage, pageSha256: done.pageSha256,
});
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
const reg = await eid.registerSignature({ ...req.body, cms: fromB64(req.body.cms), sessionId,
  fileName: store.get(sessionId).fileName, onBehalfOf: "NTRMN-6235972" });
reply({ verifyUrl: reg.verifyUrl });
```

### Зөвхөн Node (backend бүгдийг хийнэ)

```ts
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
await eid.registerSignature({ docID: done.docId, sessionId: s.sessionId, cms: done.cms, outSha256: done.outSha256,
  inSha256: done.inSha256, fileName: "Гэрээ №12.pdf", hasPage: done.hasPage, pageSha256: done.pageSha256 });
writeFileSync("signed.pdf", done.pdf);
```

`PadesError.code` (тогтвортой, бүх платформд ижил): `PDF_INVALID`, `PDF_ENCRYPTED`, `PDF_LOCKED` (DocMDP P=1),
`PDF_TOO_LARGE`, `PDF_TOO_MANY_SIGNATURES`, `PDF_PRIOR_SIGNATURE_INVALID`, `PDF_FOREIGN_SIGNATURE`, `SIGNER_INVALID`,
`REQUEST_INVALID`, `SIGNATURE_INVALID` (state хэвээр — дахин зуруулж болно), `TSA_UNAVAILABLE`, `LTV_UNAVAILABLE`
(`retryable`), `SELF_VALIDATION_FAILED`, `PLACEHOLDER_OVERFLOW`, `STATE_INVALID`, `WASM_UNAVAILABLE`, `INTERNAL`.
`state` нь бэлтгэсэн PDF-ийг агуулна — PDF-тэй ижил нууцлалтай хадгал.

0.14.0-д `eid.pdf` (`prepare`, `document`, `documentVerified`, `tokenPrepare`, `tokenFinalize`, `tokenDocument`) ба
`pdfTimeoutMs` / `pdfMaxBytes` устсан — PDF upload endpoint-ууд CA-д байхгүй болно.

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
| `ApiError` | бусад HTTP алдаа (`.status`, `.body`, серверийн `.code`, `.retryAfterMs`, `.headers`, `.retryable` — ж: 404 `ORG_NOT_FOUND`) |
| `ResponseTooLargeError` | хариу SDK-ийн хязгаараас их (JSON 4 MiB) — `.op`, `.limit` |
| `NetworkError` | timeout/сүлжээ (`.op` — таних тэмдэггүй зам, `.timeout`) |
| `EidOidcError` | «eID-ээр нэвтрэх» (OIDC) — `.code`: `access_denied`, `login_required`, `state_mismatch`, `invalid_grant`, `invalid_id_token`, `server_error` … |
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
npm run build:wasm  # Go core → wasm/eid-pades.wasm (Go 1.25.5; scripts/build-pades-wasm.sh-д бэхэлсэн Go SDK commit)
npm run lint        # tsc --noEmit
npm test            # build + node --test (WASM байхгүй бол golden тест skip)
```

`/pades`-ийн golden vector (`test/fixtures/pades/vectors.json`) НАТИВ Go core-оор гарна: `npm run build:wasm -- --vectors`.
WASM-ын гаралт түүнтэй байт-ижил байх ёстой (тестийн PKI — бодит гэрчилгээ биш).

### Гэрээний шалгалт

SDK-ийн дууддаг RP-API зам бүр (`src/contract.ts`) live [`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid)-ийн
`endpoints`-д байх ёстой; OIDC-ийн хүлээдэг утгууд (issuer, `ES256`, PKCE `S256`, `client_secret_basic`, `EidIdTokenClaims`-ийн
талбарууд) [discovery](https://login.eidmongolia.mn/.well-known/openid-configuration)-тэй таарах ёстой. Discovery-д
байгаа ч SDK хамраагүй замууд WARN (fail биш). Сүлжээ шаарддаг тул `npm test`-д ордоггүй:

```bash
npm run test:contract
```

CI: `.github/workflows/contract.yml` — PR, `main` push, өдөр бүр 00:00 UTC, гараар.
