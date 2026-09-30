# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia** (Монгол Улсын иргэний цахим үнэмлэх) Relying Party SDK — иргэнээр утсаар нь нэвтрэлт
(authentication) ба хууль ёсны цахим гарын үсэг (qualified signature) хийлгэх Node.js/TypeScript сан.
RP-API v3, Smart-ID нийцтэй. Бүрэн баримт: <https://developer.eidmongolia.mn/>.

> ⚠️ Зөвхөн **backend**-д ажиллана (`@gerege-systems/eid-mongolia-sdk/browser`-ийн device-link туслахаас бусад).
> API secret (`rp_sk_…`) браузер/гар утсанд хэзээ ч задлахгүй.

## Суулгах

```bash
npm install @gerege-systems/eid-mongolia-sdk
```

Node.js ≥ 22 (global `fetch`, `node:crypto`).

## 1. RP бүртгүүлэх

`POST https://ca.eidmongolia.mn/v3/rp-applications` (эсвэл [developer.eidmongolia.mn](https://developer.eidmongolia.mn)) —
оператор баталсны дараа **relyingPartyUUID** ба **API secret** (`rp_sk_…`) олгогдоно; secret **зөвхөн нэг удаа**
харагдана. Дэлгэрэнгүй: <https://developer.eidmongolia.mn/#burtgel>.

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

// ETSI (PNOMN-<иргэний дугаар>) / регистр / иргэний дугаар — аль нь ч болно (сервер таьна)
const s = await eid.auth.notificationByEtsi("PNOMN-12345678", [
  { type: "displayTextAndPIN", displayText60: "Хаан Банк-д нэвтрэх" },
]);

showToUser(s.vc); // ← иргэний утсан дээр харагдах баталгаажуулах код (VC)

const result = await eid.session.waitForResult(s.sessionId); // long-poll
const who = eid.validator.validateAuth(result, s.acsp); // ← гинж + ACSP_V2 крипто-баталгаажуулна

console.log(who.documentNumber, who.subject); // баталгаажсан иргэн
```

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

## 4. Ижил төхөөрөмж (App2App / Web2App)

Иргэн RP-ийн сайт/аппыг **eID апптай ижил утсан дээр** нээсэн бол QR уншуулах боломжгүй — device-link
session эхлүүлээд холбоосоор аппыг шууд нээнэ. Desktop дээр ижил холбоосыг QR болгож харуулна.

```ts
// backend — session эхлүүлээд браузерт ЗӨВХӨН sessionId, vc, deviceLinkBase-ийг өгнө (secret/token биш)
const s = await eid.auth.deviceLinkAnonymous([{ type: "displayTextAndPIN", displayText60: "Хаан Банк-д нэвтрэх" }]);
res.json({ sessionId: s.sessionId, vc: s.vc, deviceLinkBase: s.deviceLinkBase }); // s.acsp-ийг серверт хадгал

// холбоос: `${deviceLinkBase}?sessionId=<uuid>&vc=<5 орон>` (ж: https://ca.eidmongolia.mn/dl?...)
import { deviceLink } from "@gerege-systems/eid-mongolia-sdk";
const link = deviceLink(s);
```

```ts
// браузер — node:*-гүй тусдаа entry
import { openOrShowQR } from "@gerege-systems/eid-mongolia-sdk/browser";

button.onclick = () => {
  // session-ийг урьдчилж авсан байна — энд await хийхгүй
  const how = openOrShowQR(session, { showQR: (link) => renderQr(link) }); // "opened" | "qr"
  showVc(session.vc); // иргэний утсан дээрх кодтой тулгуулна (ПИН биш)
};
// дараа нь backend: eid.session.waitForResult(sessionId) → eid.validator.validateAuth(result, s.acsp, {...})
```

**Эхлүүлсэн урсгалаа заавал тулга (relay хаалт).** RP аль урсгалыг эхлүүлснээ мэддэг — гарын үсэг зурагдсан
`flowType` түүнтэй таарах ёстой, same-device үед callback-ийн `userChallengeVerifier` заавал:

```ts
// desktop дээр QR харуулсан
eid.validator.validateAuth(result, s.acsp, { expectedFlowType: "QR" });

// гар утасны браузераас апп нээсэн (callbackUrl-тай session) — апп буцахдаа
// `?userChallengeVerifier=...`-ийг callback URL-д нэмдэг
eid.validator.validateAuth(result, s.acsp, {
  expectedFlowType: "Web2App", // өөр аппаас бол "App2App"
  userChallengeVerifier: callbackQuery.get("userChallengeVerifier") ?? undefined,
});
```

> eID Mongolia апп бодит сувгийг 2.2.3 (build 58)-аас мэдээлнэ. Өмнөх build-ууд серверийн хүлээлтийг хуулдаг
> (callback-тай session → `App2App`, үгүй → `QR`) тул серверт min_version тавигдтал энэ шалгалт relay-ээс бүрэн
> хамгаалахгүй — гэхдээ QR урсгалд хуучин апптай ч эвдрэхгүй.

- Гар утас (iOS/Android, desktop UA илгээдэг iPadOS ч) бол `location.assign(link)` — Universal Link / App Link
  аппыг нээнэ; бусад үед `showQR(link)`. Илрүүлэгчийг `isMobile: boolean | () => boolean`-оор солино
  (анхдагч `isMobileUserAgent()`).
- **Click handler дотроос шууд дууд.** iOS урт async гинжийн (fetch → await → …) дараах навигацийг
  хэрэглэгчийн үйлдэл гэж үзэхгүй, Universal Link-ийг алгасаж `/dl` хуудсыг нээдэг — тэр хуудас
  «Аппаар нээх» товч ба App Store / Play холбоосыг санал болгоно (апп суугаагүй үед ч мөн).
- `deviceLinkBase` хариунд байхгүй, `sessionId` UUID биш, `vc` 5 орон биш бол `DeviceLinkError` — холбоосыг
  таахгүй. Апп руу custom scheme-ээр шууд бүү холбо — зөвхөн `deviceLink()`-ийн https холбоос.

## Аюулгүй байдал — яагаад `validator` заавал

`endResult === "OK"` гэдэгт **дангаар нь итгэхгүй**. RP-API эвдэрсэн/proxy хийгдсэн бол хуурамч
OK ирж болзошгүй. Иймд `ResponseValidator`:

1. `state === COMPLETE && endResult === OK`
2. Иргэний гэрчилгээг **trust anchor (Mongolian National Root CA)** хүртэл chain-аар баталгаажуулна
   (Root → National Issuing CA → Gerege Issuing CA → eID Mongolia Issuing CA → иргэн)
3. Гэрчилгээ хүчинтэй хугацаанд + шаардсан `certificateLevel` (default `QUALIFIED`)
4. Гарын үсгийг иргэний public key-ээр шалгана:
   - **auth** → ACSP_V2 payload (`smart-id|ACSP_V2|serverRandom|rpChallenge|userChallenge|B64(rpName)|B64(brokeredRpName)|B64(SHA-256(interactions))|interactionTypeUsed|initialCallbackUrl|flowType`, hash = хүсэлтийн `hashAlgorithm`) дээр — `flowType`, `userChallenge`, `serverRandom` ба алгоритмын downgrade-ийг мөн шалгана;
     `expectedFlowType` өгвөл `flowType` эхлүүлсэн урсгалтай ЯГ таарах, Web2App/App2App-д `userChallengeVerifier` заавал
   - **sign** → RP-ийн өгсөн digest дээр

Аль нэг алхам бүтэлгүйтвэл `ValidationError` шиднэ — хариунд **итгэхгүй**.

## Алдааны төрлүүд

| Алдаа | Утга |
|---|---|
| `AuthenticationError` | 401 — API secret буруу/байхгүй |
| `ForbiddenError` | 403 — IP allowlist / mTLS зөвшөөрөөгүй |
| `SessionFailedError` | endResult ≠ OK (TIMEOUT, USER_REFUSED…) — `.endResult`-оор салга |
| `ValidationError` | cert chain/signature/level шалгалт бүтэлгүйтсэн |
| `ApiError` | бусад HTTP алдаа (`.status`, `.body`) |
| `NetworkError` | timeout/сүлжээ |
| `DeviceLinkError` | device-link холбоос угсрах боломжгүй (`deviceLinkBase` байхгүй, sessionId/vc буруу) |

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
