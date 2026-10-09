# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia** (Монгол Улсын иргэний цахим үнэмлэх) Relying Party SDK — иргэнээр утсаар нь нэвтрэлт
(authentication) ба хууль ёсны цахим гарын үсэг (qualified signature) хийлгэх Node.js/TypeScript сан.
RP-API v3, Smart-ID нийцтэй. Бүрэн баримт: <https://developer.eidmongolia.mn/>.

> ⚠️ Зөвхөн **backend**-д ажиллана (`@gerege-systems/eid-mongolia-sdk/browser`-ийн legacy device-link туслахаас бусад).
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
// → [{ orgEtsi: "NTRMN-6235972", orgName: "Гэрэгэ Системс ХХК", role: "ceo", rightType: "ADMIN", … }]

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
  const signed = await eid.pdf.document(s.sessionId);
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

Олон талт гэрээ: А байгууллагын гаралтыг өөрчлөлтгүй Б-ийн `prepare`-д (`docID`, өөр `onBehalfOf`) илгээнэ.
Session-ий `onBehalfOf` блок (`role`/`rightType`) нь хариу угсрах үеийн бүртгэл; `pdf.signer.onBehalfOf`/`claimedRole`
нь баримтад бичигдсэн утга.

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
  { callbackUrl: "https://bank.example.mn/eid/callback?state=…" }, // товч харуулах бол
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

> ⚠️ **Шилжилт.** eID Mongolia 2.2.3 (build 59)-өөс өмнөх апп v3 холбоосыг танихгүй. RP-ийн v3 рүү шилжилтийг
> тохиргооны унтраалгаар (анхдагч legacy) хийж, build 59 store-д гарч `min_version=59` тавигдах мөчид асаана.
> Legacy `deviceLink(session)` (`{deviceLinkBase}?sessionId=…&vc=…`) болон `/browser` entry-ийн
> `openOrShowQR` **deprecated** — тэр мөчөөс сервер статик холбоосыг хүлээн авахгүй.

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
     `initialCallbackUrl`-ийг хариуны `signature.initialCallbackUrl`-аас авна (CA урсгалаар шийднэ: QR/Notification →
     `""`, Web2App/App2App → таны callback; шилжилтийн үед legacy `/dl` ба push-д таны callback) — зөвхөн `""` эсвэл
     таны илгээсэн callback байхад, Web2App/App2App-д заавал таны callback; өөр утга → татгалзана
   - **sign** → RP-ийн өгсөн digest дээр

Аль нэг алхам бүтэлгүйтвэл `ValidationError` шиднэ — хариунд **итгэхгүй**.

## Алдааны төрлүүд

| Алдаа | Утга |
|---|---|
| `AuthenticationError` | 401 — API secret буруу/байхгүй |
| `ForbiddenError` | 403 — IP allowlist / mTLS / RP-ийн эрх; onBehalfOf татгалзвал `.code` (`OnBehalfErrorCode`) |
| `SessionFailedError` | endResult ≠ OK (TIMEOUT, USER_REFUSED…) — `.endResult`-оор салга |
| `ValidationError` | cert chain/signature/level шалгалт бүтэлгүйтсэн |
| `ApiError` | бусад HTTP алдаа (`.status`, `.body`, серверийн `.code` — ж: 404 `ORG_NOT_FOUND`) |
| `NetworkError` | timeout/сүлжээ |
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
