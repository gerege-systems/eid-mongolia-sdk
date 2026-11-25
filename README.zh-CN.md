[Монгол](README.md) · [English](README.en.md) · 中文

# @gerege-systems/eid-mongolia-sdk

**e-ID Mongolia**（蒙古国国民电子身份证）Relying Party SDK——一个 Node.js/TypeScript 库，用于让公民通过手机完成身份认证
（authentication），并进行具有法律效力的电子签名（qualified signature）。
RP-API v3，兼容 Smart-ID。完整文档：<https://developer.eidmongolia.mn/>。

> ⚠️ SDK 运行在**后端**：所有调用都通过 API secret（`rp_sk_…`）认证，secret 绝不能暴露给浏览器或手机。
> 浏览器只会看到您的后端提供的链接/QR/按钮——“使用 eID 登录”按钮（`/button`）同样只调用您的后端（§1a）。
> `@gerege-systems/eid-mongolia-sdk/browser` 只导出 `isMobileUserAgent` 和错误类（旧的 `deviceLink`/`openOrShowQR` 已在 0.16.0 移除，§4）。例外：`@gerege-systems/eid-mongolia-sdk/pades`（客户端 PDF
> 签名，不含 secret）可在浏览器和 Node 中运行（§3d）。

## 安装

```bash
npm install @gerege-systems/eid-mongolia-sdk
```

Node.js ≥ 18（全局 `fetch`、`node:crypto`）——所有入口（`.`、`/browser`、`/button`、`/pades`；`/convert` 仅限浏览器，§3e），CI 中在 Node 18 / 20 / 22 上测试。
`/pades` 同样可在现代浏览器（Web Crypto）中运行。

## 1. 注册 RP

RP 由 eID Mongolia 运营方注册——请将申请发送至 <eIDsupport@gerege.com> 或致电 7777-3773
（公开的 `POST /v3/rp-applications` 自 2026-10-14 起处于维护状态：`503 rp_applications_maintenance`）。运营方
批准后会分配 **relyingPartyUUID** 和 **API secret**（`rp_sk_…`）；secret **只显示一次**。
所需信息（组织、用途 `AUTH`/`SIGN`、`callbackHosts`……）：
<https://developer.eidmongolia.mn/#registration>。

## 1a. “使用 eID 登录”——一个按钮

Smart-ID RP 的常见模式：浏览器中**一个按钮**，所有 eID 调用都在您的**后端**完成（使用 API secret）。SDK 提供两
部分——后端现成的流程 `createEidLogin` 和浏览器按钮 `@gerege-systems/eid-mongolia-sdk/button`。
下面的内容只使用 §2/§4 的 RP-API（device link v3、push、`ResponseValidator`）；并非独立的协议。

| 位置 | 发生的事情 |
|---|---|
| 桌面浏览器 | 弹窗：QR（约每 1–2 秒刷新——status long-poll ≤ 1 s + 1 s）+ 验证码 + “请求有效期 m:ss”（最后 30 秒显示警告色）+ “使用注册号登录”按钮（在同一弹窗中向下展开的 push 区域），实时状态 |
| 手机浏览器 | 按钮 → `start?mode=web2app` → 服务器 302 → eID 应用（Web2App）。应用确认后返回 `/auth/eid/callback` |
| 后端 | 发起 session、生成 QR（`sessionSecret` 留在服务器）、poll、`validateAuth`（证书链 + ACSP_V2 + `flowType` + Web2App 的 `userChallengeVerifier`）→ 您的 `onSuccess` |

**Endpoint**（位于 `/auth/eid` 下——eID 服务器始终将 Web2App 的返回路径规范化为 `/auth/eid/callback`）：

| | 请求 | 响应 |
|---|---|---|
| `POST /auth/eid/start` | `{"mode":"qr"}` 或 `{"mode":"push","idCode":"УБ12345678"}`（必须是 JSON） | `{mode, vc, qr?, expiresIn}` + `Set-Cookie: eid_login` |
| `GET /auth/eid/start?mode=web2app` | 手机浏览器（按钮跳转） | `302` → eID 应用 |
| `GET /auth/eid/status` | cookie | `PENDING`（+新的 `qr`、`expiresIn`）· `WAIT_CALLBACK` · `OK`（`redirect`、`data`）· `FAILED`（`error`）· `EXPIRED` |
| `GET /auth/eid/callback` | 应用返回：`?sessionId&userChallengeVerifier` | `303` → `onSuccess` 的 `redirect` / `successRedirect`，出错则为 `failureRedirect?eid_error=<代码>` |

**后端**（在模块级别创建一个实例）：

```ts
import { EidClient, NATIONAL_ROOT_CA_PEM, createEidLogin } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  credentials: { rpUUID: process.env.EID_RP_UUID!, rpName: "网上银行", apiSecret: process.env.EID_SECRET! },
  // Root (01) 是信任锚；中间证书 02 → 03 → 04 已内置于 SDK（CITIZEN_INTERMEDIATES_PEM，默认）。
  trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] },
});

export const eidLogin = createEidLogin({
  client: eid,
  callbackUrl: "https://bank.example.mn/auth/eid/callback", // host 必须在 RP 的 callbackHosts 中；手机流程必须提供
  async onSuccess(id) {
    // id.etsi (PNOMN-…) —— 请据此识别用户；id.givenName/surname（拉丁文），id.person（西里尔文，如有）
    // id.sessionId, id.documentNumber, id.certificateDerB64 —— 用于后续步骤（签名、关联证书）
    const user = await users.findOrCreateByEtsi(id.etsi);
    const sid = await sessions.create(user.id); // 新建 session（防 session fixation）
    return {
      redirect: "/dashboard",
      headers: { "Set-Cookie": `app_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax` },
    };
  },
  // store: redisStore,            // 多实例 / serverless 时使用（默认——进程内存）
  // rateLimit: { start: (key) => redisLimiter.allow(key) }, // 与默认值合并（push 仍为 3/分钟）——见下文“限流”
  trustProxy: 1, // handle(Request) 的客户端 IP：nginx/LB 为一跳时设为 1（见下文“客户端 IP”）
  onEvent: ({ kind, sessionId, meta }) => audit.record(`auth.eid_${kind}`, sessionId, meta), // 您的审计
  // auditKey: process.env.EID_AUDIT_KEY, // 使 pushKey 在多个实例/重启之间保持稳定
});
```

Next.js App Router——`app/auth/eid/[action]/route.ts`：

```ts
import { eidLogin } from "@/lib/eid";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => eidLogin.handle(req);
export const POST = (req: Request) => eidLogin.handle(req);
```

**客户端 IP**（`start:<ip>` 限制）。Web 标准的 `Request` 不带 IP——若使用 `handle(req)`，请提供以下其一：

- `trustProxy: n`——位于受信任的反向代理之后：取 `X-Forwarded-For` 中**从右数第 n 个**值（n = 您的代理数量），
  若没有 XFF 则取 `X-Real-IP`。`true` = 取 XFF 最左侧的值（仅当代理会覆盖客户端自带的 XFF 时）。没有代理时
  不要启用——客户端可以伪造该 header。
- `getClientIp: (req) => …`——平台提供的 IP（Bun `server.requestIP(req)?.address`、Deno `info.remoteAddr.hostname`、
  Vercel `req.headers.get("x-real-ip")`）。优先于 `trustProxy`。

两者都未提供则不按 IP 限制（首个请求时会通过 `onError` 警告一次）。`handleRequest` 直接使用 `req.ip`
（Express 的 `req.ip`，配合 `app.set("trust proxy", …)`）。Go：`eidlogin.Config.ClientIP`（`eidlogin.ForwardedClientIP(n)`）——规则相同。

**限流**（`rateLimit`）。键：`start:<ip>`（已知 IP 时）、`push:<idCode>`；被拒绝时返回 429 + `Retry-After: 60`。
默认 `defaultRateLimit` = `{ start: { limit: 20, windowMs: 60_000 }, push: { limit: 3, windowMs: 60_000 } }`——同一
IP 每分钟 20 次发起（自 0.19.0 起；已知 IP 时——`req.ip` / `trustProxy`），同一号码每分钟 3 条通知
（防 MFA 疲劳攻击）。内存限流器每种类型最多 ≤ 10 000 个键：满了就清理已过期的窗口，若仍未腾出空间，
则以 429 拒绝**新**键（fail-closed）——绝不会清除已有计数器，因此无法通过塞满大量 IP/号码来绕过限制。
`memoryLoginStore(max = 10_000)` 同理：满了则 start 返回 503 `{ error: "busy" }`，
不会删除已开始的登录。多实例时请使用 Redis store/limiter。

- **对象** `{ start?, push? }`——与默认值**合并**：您提供的类型覆盖默认值，未提供的保持默认。
  取值：`{ limit, windowMs }`（进程内存中的滑动窗口）、`(key) => boolean | Promise<boolean>`（Redis 等）、
  或 `false`（不限制该类型）。其他键 → `createEidLogin` 抛出异常。
- **函数** `(key) => …`——对所有键调用，**叠加在**默认限制之上（两者都必须放行）。
  若要放宽/替换默认值，请用对象指定该类型（`{ push: … }`）。

```ts
import { defaultRateLimit } from "@gerege-systems/eid-mongolia-sdk";
rateLimit: { start: { limit: 60, windowMs: 60_000 } },             // NAT 后有大量用户时；push 仍为 3/分钟
rateLimit: { start: false },                                       // 若在自己的层（nginx/gateway）对 start 限流
rateLimit: { ...defaultRateLimit, start: (k) => redis.allow(k) },  // 同上——显式写出默认值
rateLimit: { push: (k) => redis.allow(k, 3, 60) },                 // 多实例：用 Redis 替换 push
```

Go：`eidlogin.Config.RateLimits`（`map[string]eidlogin.RateRule{"start": {Max: 20, Window: time.Minute}}`，
`eidlogin.DefaultRateLimit()`）——合并方式相同；`Config.RateLimit` 函数同样叠加在默认值之上。

Express：

```ts
app.use("/auth/eid", express.json(), async (req, res) => {
  const r = await eidLogin.handleRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body, ip: req.ip });
  res.status(r.status).set(r.headers).send(r.body);
});
```

**浏览器**——Web Component（React/Vue/纯 HTML 均可）：

```html
<script type="module">import "@gerege-systems/eid-mongolia-sdk/button";</script>
<eid-login-button start-url="/auth/eid/start" status-url="/auth/eid/status" lang="mn"></eid-login-button>
<script type="module">
  document.querySelector("eid-login-button").addEventListener("eid-login-success", (e) => {
    // e.detail = { state: "OK", redirect, data } — 调用 preventDefault() 则不跳转
  });
</script>
```

或 `mountEidLoginButton(el, { startUrl, statusUrl, lang: "en", theme: "auto", successUrl, label, icon, variant, onSuccess, onError })`。

| 属性（`mount…` 选项） | 取值 | 默认 |
|---|---|---|
| `start-url`（`startUrl`）、`status-url`（`statusUrl`） | 后端 endpoint | —（必填） |
| `lang` | `mn` \| `en` \| `ru` \| `zh` \| `fr` \| `es` \| `ar`（eID 应用支持的语言；`zh-CN` 等 → 基础语言；其他 → `mn`）。`ar` → 弹窗 `dir="rtl"` | `mn` |
| `mode` | `auto`（手机 → Web2App，其他 → QR 弹窗）\| `qr` \| `app` | `auto` |
| `theme` | `auto` \| `light` \| `dark` | `auto` |
| `success-url`（`successUrl`） | 后端未返回 redirect 时要跳转的 URL | — |
| `label` | 按钮文字；`""` → 仅显示 logo | i18n：“e-ID-ээр нэвтрэх” / “Log in with e-ID” |
| `icon` | `eid`（“e-ID” wordmark，内联 SVG `fill: currentColor`——随按钮 / 标题文字颜色跟随 light / dark；高按钮中为 16px，仅 logo 时为 12px，弹窗标题中为 20px；使用默认文字时 logo 取代“e-ID”：[e-ID] нэвтрэх，完整名称放在 `aria-label` 中）\| `none`（无 logo，完整文字） | `eid` |
| `variant` | `default`（logo + 文字）\| `icon`（仅 logo，44×44） | `default` |
| `aria-label` | 按钮的无障碍名称（屏幕阅读器） | 仅 logo 时为 `label` 或 i18n 文字 |

`label`、`icon`、`variant`、`aria-label`、`lang` 变化时按钮会立即更新。`icon="none"` 且没有文字
（`variant="icon"` 或 `label=""`）的组合不会产生空按钮——会显示默认文字，并在控制台警告一次。
事件：`eid-login-success`、`eid-login-error`（见下）。

**`eid-login-error`**（0.20.0）——每当 start 失败或登录以失败结束时触发（`bubbles: true`，
`composed: true`——可穿出 shadow DOM）。`detail`：

| 字段 | 取值 |
|---|---|
| `error` | 代码或类型（`EXPIRED`、`USER_REFUSED…`、`VALIDATION` ……）——与旧版本相同 |
| `status` | start 的 HTTP 状态；网络错误为 `0`；poll 错误为 `null` |
| `code` | 响应中的 `error`/`code`，或 `HTTP_<状态>` / `NETWORK` |
| `retryAfter` | `Retry-After`（秒）或 `null` |

遇到 429 / 503（`{"error":"busy"}`）时，按钮显示“Систем завгүй — N сек дараа дахин оролдоно уу” / "Service busy — try again in N s"，
并按 `Retry-After`（默认 30 s）倒计时，在结束前“Дахин оролдох”（重试；push 表单中为“Мэдэгдэл илгээх”）保持禁用。

```js
document.querySelector("eid-login-button").addEventListener("eid-login-error", (e) => {
  const { status, code, retryAfter } = e.detail;
  if (status === 429 || status === 503) console.warn(`eID busy (${code}), retry in ${retryAfter ?? 30}s`);
});
```

无外部依赖（QR 编码器内置），弹窗带有焦点陷阱（focus trap）、Esc 关闭和 `aria-live` 状态。
弹窗使用原生 `<dialog>` + `showModal()`（浏览器 top layer）——RP 页面祖先元素的 `transform`/`filter`/`backdrop-filter`/`overflow` 不会影响它；不支持 `showModal` 的浏览器回退为 `position: fixed` 遮罩。

**设计与主题。** 设计沿用 eID 登录页（logo、颜色）。字体继承自页面（按钮、弹窗、input 均是）。
`theme="auto"` 时的优先顺序：页面的 `html[data-theme="dark|light"]` → `html.dark` / `html.light` → 操作系统
（`prefers-color-scheme`）；页面切换主题时（MutationObserver）会立即跟随。`theme="light|dark"` 覆盖页面设置。
颜色和圆角可通过 CSS 变量覆盖。`--eid-*` 仅是**输入**（不在 shadow 内部定义），因此在页面
任意层级（`:root`、父元素、`eid-login-button`）设置的值都会被继承，并对 **light 和 dark 同时生效**；
`--eid-<名称>-dark` 只对 dark 生效，且优先于 `--eid-<名称>`。都没有时使用 eID 的默认值（见下表）——仅作为 fallback。
Dark 的优先顺序：`--eid-<名称>-dark` → `--eid-<名称>` → dark 默认值。

```css
:root {                                   /* 或 eid-login-button { … } */
  --eid-accent: var(--brand);             /* 对两个主题均生效 */
  --eid-accent-dark: var(--brand-400);    /* 仅对 dark 生效（未设置则使用 --eid-accent） */
  --eid-radius: 6px; --eid-radius-lg: 8px;
}
eid-login-button::part(button) { width: 100%; }  /* part: button, icon, label, dialog (backdrop——仅用于 fallback) */
eid-login-button::part(label) { font-weight: 600; }
eid-login-button::part(icon) { height: 18px; }
```

| 变量（有 `-dark` 版本） | 用途 | Light 默认 | Dark 默认 |
|---|---|---|---|
| `--eid-accent` | 主按钮 | `oklch(0.534 0.2 259)` | `oklch(0.64 0.15 259)` |
| `--eid-logo` | **已弃用（0.38.0）**——不再生效；自 0.40.0 起 wordmark 为 `currentColor`（按钮 / 标题文字颜色） | — | — |
| `--eid-accent-fg` | 主按钮文字 | `#fff` | `hsl(229 50% 6%)` |
| `--eid-accent-subtle` | 步骤编号背景 | `oklch(0.97 0.03 259)` | `oklch(0.24 0.06 259)` |
| `--eid-accent-subtle-fg` | 步骤编号 | `oklch(0.474 0.19 259)` | `oklch(0.82 0.1 259)` |
| `--eid-ring` | focus | `oklch(0.604 0.2 259)` | `oklch(0.68 0.15 259)` |
| `--eid-bg` | 弹窗、outline 按钮、input | `hsl(0 0% 100%)` | `hsl(229 50% 6%)` |
| `--eid-bg-subtle` | —（备用） | `hsl(210 40% 98%)` | `hsl(222 47% 9%)` |
| `--eid-bg-muted` | hover | `hsl(210 40% 96%)` | `hsl(217 33% 13%)` |
| `--eid-fg` | 文字 | `hsl(222 47% 11%)` | `hsl(210 40% 98%)` |
| `--eid-fg-muted` | 次要文字 | `hsl(215 19% 35%)` | `hsl(213 27% 84%)` |
| `--eid-fg-subtle` | 说明文字、placeholder | `hsl(215 16% 45%)` | `hsl(215 20% 65%)` |
| `--eid-border` | 弹窗、QR、分隔线 | `hsl(214 32% 91%)` | `hsl(217 33% 17%)` |
| `--eid-border-strong` | outline 按钮、input | `hsl(213 27% 84%)` | `hsl(215 20% 45%)` |
| `--eid-warning-bg` / `-border` / `-fg` | 网络警告 | `hsl(48 100% 96%)` / `hsl(45 95% 78%)` / `hsl(23 75% 33%)` | `hsl(20 60% 10%)` / `hsl(22 70% 26%)` / `hsl(40 92% 65%)` |
| `--eid-danger-fg` | 错误 | `hsl(0 74% 42%)` | `hsl(0 91% 71%)` |
| `--eid-radius` / `--eid-radius-lg`（无 theme） | 圆角 | `6px` / `8px` | — |

**eID 应用的最低版本。** `flowType` 绑定（device link v3）和 Web2App 的 `userChallengeVerifier` 自
**iOS 2.2.3（build 59）**、**Android 2.2.3（versionCode 60）** 起支持。eID 服务器自 2026-10-07 起
完全移除了旧版链接（对没有 v3 的 session，手机返回 `DEVICE_LINK_REQUIRED`），并通过 `/mobile/app-config` 强制升级最低版本：
Android 自 2026-10-07 起 ≥ 70（带设备证明），截至 2026-10-20，iOS ≥ 2.2.8，
Android ≥ 91（`curl https://ca.eidmongolia.mn/mobile/app-config`）。因此所有能够签名的应用都支持这些——
RP 一侧无需额外检查。来源：eID CA 的 `docs/DEVICE_LINK_V3.md` §5、§7；changelog
`2026-10-02-ios-min-version-2-2-3`、`2026-10-07-android-min-70`。

**安全性。**

- `sessionToken`、`sessionSecret`、`rpChallenge` 保留在服务器（store）中；浏览器只拿到 HttpOnly、Secure、SameSite=Lax 的 cookie
  （`<sessionId>.<binding>`，store 中保存 binding 的 SHA-256）。Status 和 callback 只响应**发起登录的那个浏览器**——
  在其他浏览器中打开的 callback URL（即使带有 verifier）也不会被接受（登录 CSRF）。
- `start` 的 POST 必须是 JSON（不是 simple request → 跨域会触发 preflight），`Sec-Fetch-Site: cross-site` → 403。
- 只有 `validateAuth` 成功时才返回 `OK`：QR → `flowType=QR`，push → `Notification`，手机 → `Web2App` + callback 中的
  `userChallengeVerifier`。Web2App 的 session 不会被 poll 结束（`WAIT_CALLBACK`）。`onSuccess` 对每个 session 只执行一次
  （store 的 `delete` 必须是原子的——Redis `DEL`）。
- `onSuccess` 返回的 `data` 会发送到浏览器——不要放入机密。
- **注册号 oracle 防护（decoy + 最短耗时，默认开启）。** 当 eID 因号码原因拒绝 push 时
  （eID 自身的 JSON 4xx——未知 / 无法使用的号码），返回与真实 push **完全相同**的响应：`{mode, vc（随机
  5 位数字——与 eID 形式相同）, expiresIn}`、相同的 cookie；`status` 在 `pollMs` 时间内不询问 eID，保持
  `PENDING`，TTL 后为 `EXPIRED`——与没有接手机的公民无法区分（真实 push 的 CA `TIMEOUT` 也会变为 `EXPIRED`）。每个 push start 的响应（真实、decoy、502）
  都不会快于 `pushFloorMs`（默认 1000）——使 decoy 无法通过时间区分（对 `handle(Request)`，请求被中断时不会
  等待；对 `handleRequest` 请传入 `signal`）。限制（`push:<idCode>`、`start:<ip>`）同样适用于 decoy；限流器的 429 和 400
  （`invalid_id`——格式错误，与注册情况无关）没有 floor（eID 的 429 和 503 `busy` 有 floor）。eID 的 5xx、连接错误、非 JSON 的 4xx（eID 前面的
  proxy，如 mTLS 拒绝）、401/403（RP 的 secret/权限）和 429 **不使用 decoy**——返回 `502 eid_unavailable` / `429`（eID
  门户的行为：若用 decoy 掩盖故障，公民会看到无尽的转圈；这些与号码无关，因此不构成
  oracle）。关闭方式：`decoy: false`、`pushFloorMs: 0`——**⚠️** 关闭后 `/start` 会向任何未登录的人透露“该注册号是否已在 eID 注册”；
  仅限内部/测试环境。
- **有效期（`ttlMs`，默认 120 000）不会超过 CA 的 session。** QR / Web2App：`expiresIn`、cookie `Max-Age`、
  store = min(`ttlMs`, CA start 响应的 `expiresAt` − 当前时间)。Push（真实与 decoy **相同**）：min(`ttlMs`, discovery
  `sessionTtl.auth`)——decoy 没有 CA 响应，所以取自 discovery（`client.auth.sessionTtl()`，
  缓存 10 分钟，出错则 `onError` + 1 分钟后重试）而非 CA 的 `expiresAt`——以免时长差异成为 oracle。
  旧版 CA（discovery 中没有 `sessionTtl`）：下一个 decoy 采用从真实 push 的 `expiresAt` 观察到的值（±1 s）；在首个
  真实 push 之前使用 `ttlMs`。
- **证书吊销（OCSP，默认开启）。** 在 `validateAuth` 之后、`onSuccess` 之前，会向公民证书
  AIA 中列出的 OCSP responder 查询（`revocation`，默认 `ocspRevocationChecker()`；响应须由颁发者或
  其 OCSPSigning responder 签名、针对该序列号、thisUpdate ≤ 48 小时，good 结果缓存 5 分钟）。`revoked`，
  以及 `unknown`（颁发者未签发此证书）→ `FAILED` / `VALIDATION`（不是 500），不会调用 `onSuccess`。无响应
  （超时 2 s、5xx、没有 AIA、检查失败）时：`revocationMode` 默认 `"soft-fail"`——放行并通过 `onError`
  发出警告，`identity.revocation = "unchecked"`（eID 门户的 `EID_OCSP=soft`：CA 的 responder 宕机时不会
  锁住所有公民；而且手机确认 session 时 CA 可能提前几秒就已知情）；`"hard-fail"` → `FAILED` /
  `VALIDATION`。`revocation: false`——**⚠️** 持有已吊销（被盗手机）证书的人也能登录。
- **审计——`onEvent({ kind, sessionId, meta })`**（会被 await，错误交给 `onError`）：`push_sent`（meta `decoy`——
  仅出现在您的审计中，绝不发给浏览器）、`push_limited`、`refused`（公民拒绝）、`expired`（TIMEOUT / 在
  eID 中找不到）、`unverified`（`reason`：`validation` | `revoked` | `revocation_unavailable`）、`flow_refused`（Web2App callback
  出现在另一个浏览器）、`success`（`flow`、`revocation`）、`failed`（其他 `endResult`）。meta 中有 `mode`；不包含令牌/机密、注册号——
  对 push，`pushKey` = HMAC-SHA256(`auditKey`, 号码) 的 32 位十六进制（若无 `auditKey`，则每个进程随机生成）。
- 在多实例 / serverless（Vercel 等）环境下，默认的内存 store 无法工作——请用 Redis 实现 `EidLoginStore`（`get`/`set`/`delete`）。
- 在调用 `onSuccess` 之前，tx 已从 store 中原子删除（一次性保证）——不要在 `onSuccess` 内部从 store 读取；
  所需的一切都在 `identity` 中（`sessionId`、`documentNumber`、`certificateDerB64`、……）。

**Redis store**（SDK 没有额外依赖——例如 `ioredis`）：

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
    return (await redis.del(key(sid))) === 1; // DEL 是原子的——两个并发的 status 调用中只有一个会触发 onSuccess
  },
};
```

Tx 中包含 `sessionSecret`（用于生成 QR 的材料）——请将 Redis 与外网隔离，并启用 TLS/AUTH。

## 2. 认证（push）

```ts
import { EidClient, NATIONAL_ROOT_CA_PEM } from "@gerege-systems/eid-mongolia-sdk";

const eid = new EidClient({
  // baseUrl 默认为 https://rp.eidmongolia.mn（RP-API，不带 /v3）——使用 mTLS 的 RP 也用此主机
  credentials: {
    rpUUID: process.env.EID_RP_UUID!,
    rpName: "网上银行", // 子系统名称，≤ 120 个字符（CA 会截断多余部分）
    apiSecret: process.env.EID_SECRET!, // rp_sk_…
  },
  trust: { trustAnchorsPem: [NATIONAL_ROOT_CA_PEM] }, // ← Mongolian National Root CA, 生产环境必须配置（中间证书 02–04 已内置于 SDK）
});

// ETSI（PNOMN-<公民编号>）/ 注册号 / 公民编号——任一均可（服务器会识别）
const s = await eid.auth.notificationByEtsi("PNOMN-12345678", [
  { type: "displayTextAndPIN", displayText60: "登录汗银行" },
]);

showToUser(s.vc); // ← 公民手机上显示的验证码（VC）

// long-poll；等待至 session 到期：expiresAt + 15 s（缺省时用 discovery 的 sessionTtl，否则 600 s）。
// CA 会将已过期的 session 置为 COMPLETE/TIMEOUT。若提供 { maxWaitMs }，则按其截止（返回 RUNNING）。
const result = await eid.session.waitForResult(s.sessionId, { expiresAt: s.expiresAt });
const who = eid.validator.validateAuth(result, s.acsp!); // ← 对证书链 + ACSP_V2 做密码学验证（若为 RUNNING 则抛出 ValidationError）

console.log(who.documentNumber, who.subject); // 已验证的公民
const { name, serialNumber } = who.parsedSubject; // 拉丁文“givenName surname”，"PNOMN-12345678"（givenName/surname/commonName/country…）
```

Session 的 `person` 块（来自 CA 的登记——证书中没有的西里尔文姓名、出生日期、性别）**不包含在**签名中——
必须与证书的 `SERIALNUMBER` 比对一致后才能信任：

```ts
import { personMatchesCertificate } from "@gerege-systems/eid-mongolia-sdk";
if (personMatchesCertificate(result.person, who.parsedSubject)) {
  const { firstName, lastName /* 父名 */, familyName /* 姓氏 */, civilId, regNo, birthDate, gender, geID,
    nationality /* “MNG”——ISO 3166-1 alpha-3，不是证书中的 country；未知则为 undefined */ } = result.person!;
}
// result.raw — 服务器的原始 JSON（用于 SDK 未解析的字段）
```

Subject 的各字段（`parsedSubject`，`validateSign` 中同样提供）来自 `parseSubject(cert)`——OID 2.5.4.42/4/3/5/6/10/97，
UTF8String/PrintableString/BMPString。`parseSubject` 只做解析：不要信任未经验证的证书中的姓名。

> **不要在同一部手机上使用 push。** Push（`notificationBy*`）请求会以通知 /“待处理”列表的形式到达 eID 应用；
> Smart-ID 和 eID 中**不存在** Notification 类型的 device link（CA `docs/DEVICE_LINK_V3.md` §3）。
> 如果公民在与 eID 应用相同的手机上打开了 RP，请改用 **device-link Web2App** 流程，而不是 push
>（`auth.deviceLink*` / `signPdfDigest({ flow: "device-link" })` + `buildDeviceLink(…, "Web2App")`，§4）——按钮会直接
> 打开应用，并通过 callback 返回。对于 push，“请打开您的 eID 应用”这样的提示文字就足够了。

## 3. 签名（qualified signature）

```ts
import { sha256Base64 } from "@gerege-systems/eid-mongolia-sdk";

const digest = sha256Base64(pdfBytes); // 文档的 SHA-256（base64）

const s = await eid.sign.digestByEtsi("PNOMN-12345678", digest, [
  { type: "displayTextAndPIN", displayText60: "签署贷款合同" },
]);
showToUser(s.vc);

const result = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(result, digest); // 针对 digest 进行验证

console.log(sig.signatureValueB64, sig.subject);
```

`SignOptions.fileName`——文档名称，会显示在 CA 的 /verify 页面和公民的历史记录中（可选）。

对于通过 device-link / push 发起的 sign session，请用 `expectedFlowType` 核对您发起的流程（与 `validateAuth`
相同：不一致则抛出 `ValidationError`）。第三个参数是 `hashAlgorithm` 字符串（旧形式）或对象：

```ts
eid.validator.validateSign(result, digest, { expectedFlowType: "QR" }); // 或 "Web2App" / "App2App" / "Notification"
eid.validator.validateSign(result, digest384, { hashAlgorithm: "SHA-384", expectedFlowType: "Web2App" });
```

对于 RAW_DIGEST_SIGNATURE，`flowType` 不属于签名内容（只对 digest 签名）——这是对 RP-API 响应的核对。

**QR / Web2App / App2App**——`eid.sign.deviceLinkByEtsi` / `deviceLinkByDocument`（带 `callbackUrl` 时为 Web2App/App2App）；
链接在后端通过 `buildDeviceLink(deviceLinkInput(s, "QR", "mon"))` 生成（auth/cert session 同样适用）。请将 `s.sign`
（`SignContext`：digest、hash、算法、interactions、callback）与 session 一同保存在服务器。

**`expiresAt`**（毫秒 epoch）——session 结束的时刻：CA 的 session start 响应中的 `expiresAt`（RFC 3339；auth / sign /
certificate-choice 均有，自 2026-10-14 起）。旧版 CA（无该字段）下，对 sign / certificate-choice 由 SDK 计算——CA 的
默认 600 秒（`DEFAULT_SIGN_SESSION_TTL_MS`；CA 管理员可设为 60–1800 秒 → `signSessionTtlMs`），对 auth 则为 undefined。
最终以 `GET /session`（`TIMEOUT`）为准。CA 配置的实时值：`client.auth.sessionTtl()`——discovery 的
`sessionTtl`（`{ authMs, signMs }`；旧版 CA 为 0）。

**Session 启动错误**（`ApiError` 的子类，带 `.code`）：`NoSigningCertificateError`——409
`NO_SIGNING_CERTIFICATE`（sign / certificate-choice start：公民没有活跃设备 / 有效的
签名证书，未创建 session）；`CertChoiceInvalidError`——409 `CERT_CHOICE_INVALID`（linked sign 的
certificate-choice 无效 / 已过期 / 已被使用 → 重新发起 cert-choice）；`RequestInvalidError`——400
`REQUEST_INVALID`（例如 linked 中缺少 `linkedSessionID`）。

### 3.1. 预先获知证书（client-side PAdES / CMS）

由于证书会进入 DTBS（`signingCertificateV2`），应先做 certificate-choice，然后让**恰好那台设备
（`documentNumber`）** 对 digest 签名。RP 权限：certificate-choice——`CERT`，digest sign——`SIGN`。对于拥有多部手机的公民，若按 etsi 发起，会由另一部手机签名，签名将与
证书不匹配。

```ts
const cc = await eid.sign.certificateChoiceByEtsi("PNOMN-12345678"); // 或 certificateChoiceDeviceLink()（QR；提供 callbackUrl 时也支持 Web2App/App2App）
const signer = eid.validator.validateCertificateChoice(await eid.session.waitForResult(cc.sessionId), cc.sessionId);
const dtbs = myCmsBuilder.dtbs(signer.certificate); // 由您自己提供：SHA-256(signedAttrs)，32 字节，标准 base64（PDF 则使用 /pades 的 prepare）
const ix = [{ type: "displayTextAndPIN" as const, displayText60: "签署合同" }];
const s = await eid.sign.digestForSigner(signer, dtbs, ix, { fileName: "合同.pdf" }); // linked/{documentNumber}
// QR / Web2App: eid.sign.deviceLinkForSigner(signer, dtbs, ix, { callbackUrl })
const r = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(r, s.sign!.digest, {
  hashAlgorithm: s.sign!.hashAlgorithm,
  expectedFlowType: "Notification",
  expectedAlgorithm: s.sign!.signatureAlgorithm, // sha256WithRSAEncryption——会拒绝 PSS 响应
  expectedCertificate: signer.certificate,       // 若使用其他证书签名则拒绝
});
```

`digestForSigner` / `deviceLinkForSigner` 的默认值：`sha256WithRSAEncryption` + `SHA-256`（CA 的 SplitKey RSA 按请求的
算法签名，PKCS#1 v1.5；旧的 threshold-ECDSA credential 始终是 `ecdsa-with-SHA256`——`expectedAlgorithm` 仅在
EC P-256 证书时才接受它）。如果 digest 长度与 hash 不符，请求不会发出。

#### 在手机上进行 linked signing（带返回 URL）

`certificateChoiceDeviceLink({ callbackUrl })`——用同一个 session，在桌面端显示 QR，在手机上显示 Web2App 按钮。
`callbackUrl` 必须是位于 RP 的 `callback_hosts` 列表中的 `https` URL（CA 会将路径规范化为 `/auth/eid/callback`）；
不在列表中则 CA 会丢弃它，session 仅支持 QR。手机只有在 linked SIGN 完成之后才会打开 callback：
带有 RP 自己的 query（如 `value=<随机值>`）原样不变 + `sessionSecretDigest` + `sessionId`（certificate-choice 的）。

```ts
// 1) 带 callback 发起 cert-choice；将 `value` 存入发起该流程的浏览器的 cookie
const cc = await eid.sign.certificateChoiceDeviceLink({ callbackUrl: `${origin}/auth/eid/callback?value=${value}` });
const qr = buildDeviceLink(deviceLinkInput(cc, "QR", "mon"));        // desktop (每秒刷新)
const w2a = buildDeviceLink(deviceLinkInput(cc, "Web2App", "mon"));  // 手机上的按钮（同一个 session）
// 2) validateCertificateChoice → 3) digestForSigner(signer, …) — 即上文的 linked sign
const signer = eid.validator.validateCertificateChoice(await eid.session.waitForResult(cc.sessionId), cc.sessionId);
const s = await eid.sign.digestForSigner(signer, dtbs, ix);

// 4) 在 /auth/eid/callback 处
const ok = q.value === cookieValue && verifySessionSecretDigest(q.sessionSecretDigest, cc.sessionSecret!);
// 若 ok，则仅接受该 session 一次（不得重复使用），然后读取 linked SIGN 的结果：
const r = await eid.session.waitForResult(s.sessionId);
```

Linked SIGN session 本身没有 callback。`sessionSecretDigest` = BASE64URL(SHA-256(base64-decode(`sessionSecret`)))，
不会返回 `userChallengeVerifier`。`sessionSecret`/`sessionToken` 只能保留在后端。

## 3a. 以组织名义签名（onBehalfOf）

公民**使用自己的 PIN2 证书**签名；eID 会**根据自己的登记**核查其在该时刻是否有权代表
该组织（爱沙尼亚模式）。这是**个人的 qualified 签名**——不是组织证书，也不是印章（e-Seal）。
e-Seal 仅用于没有人参与的自动化系统的文档。前提条件：组织在 eID 中为 `ACTIVE`（董事
通过应用经国家登记关联），签名人为 `ADMIN` 或经 PIN2 验证的 `MANAGER`，且 RP 具有 `SIGN` 权限。
详情：[developer.eidmongolia.mn](https://developer.eidmongolia.mn/)。

```ts
import { ForbiddenError, ApiError, ON_BEHALF_ERROR_CODES } from "@gerege-systems/eid-mongolia-sdk";

// 1. 公民必须在最近 24 小时内通过您的 RP 登录过。
const { representations } = await eid.organization.getRepresentations("PNOMN-12345678");
// → [{ orgEtsi: "NTRMN-6235972", orgName: "Gerege Systems 有限责任公司", role: "ceo", roleLabel: "首席执行官",
//      rightType: "ADMIN", rightTypeLabel: "管理员", source: "REGISTRY", sourceLabel: "国家登记", … }]

// 2. PDF：§3d（客户端 PAdES） — signPdfDigest({ …, onBehalfOf }) + prepare({ claimedRole: rep.claimedRole }).
// 3. Raw digest 签名： eid.sign.digestByEtsi(id, digest, interactions, { onBehalfOf: "NTRMN-6235972" })
//    ——由于 CMS 由您自行组装，需自行添加声明的角色（signer-attributes-v2）。
try {
  /* … */
} catch (e) {
  if ((e instanceof ForbiddenError || e instanceof ApiError) && e.code) {
    // REPRESENTATION_DENIED | REPRESENTATION_PENDING | REPRESENTATION_EXPIRED | ORG_NOT_ACTIVE |
    // SIGNER_UNIDENTIFIED (403) · ORG_NOT_FOUND (404) · REPRESENTATION_REVOKED (403, 登记时)
  }
  throw e;
}
```

临时性错误——`ApiError.retryable` 为 true，应在 `retryAfterMs`（CA 的 `Retry-After`，秒数或日期）之后重试
（`RETRYABLE_ERROR_CODES`）。`headers`——响应的 header。JSON 响应超过 4 MiB 时抛出 `ResponseTooLargeError`（不会截断）。
`getRepresentations` 的 `raw`——服务器的原始 JSON。

**向用户展示时请使用 `roleLabel` / `rightTypeLabel` / `sourceLabel`**（representations 以及 session 的
`onBehalfOf`；`onBehalfOf` 中没有 `source`，因此只有 `roleLabel` / `rightTypeLabel`）——`role`（`ceo` / `founder` /
`stakeholder`，或为 MANAGER 填写的文字）、`rightType`（`ADMIN` | `MANAGER`）、`source`（`REGISTRY` | `MANUAL`）是
机器值，请勿自行翻译。语言：`new EidClient({ …, language: "en" })` → 每次调用带 `Accept-Language`；默认
不发送（服务器使用 mn）。旧版 CA 没有这些字段。

Session 的 `onBehalfOf` 块（`role`/`roleLabel`/`rightType`/`rightTypeLabel`）是组装响应时的登记记录。

## 3b. 公民 PKI 面板（`PKI_READ` 权限）

`eid.person.certificates(etsi)` · `devices` · `activity(etsi, { flow, limit, offset })` · `summary` · `children`——公民
必须在最近 24 小时内通过您的 RP 登录过（否则抛出 `ForbiddenError`）。每个响应都带有 `raw`。

每个证书（自 0.18.0 起）有 `issuedAt`（签发时间）、`revokedAt?`（吊销时间——REVOKED）、`revocationReason?`（RFC 5280
名称：`keyCompromise`、`superseded`、`cessationOfOperation` ……）。`status` 不会改变：因续期/重新登记
而被替换的记录为 `SUSPENDED` + `revocationReason: "superseded"` + `revokedAt`（被替换的时刻，CA 自 2026-10-16 起）。

`keyMedium: "TOKEN"` 的记录带有 `organization?`（组织令牌）和 `tokenSerial?`——证书所签发到的 USB 令牌的
序列号。不要按组织/日期去猜同一令牌的 AUTH + SIGN，请按 `tokenSerial` 分组（因续期
而被替换的记录同样带有自己令牌的编号）。MOBILE/HSM 记录以及旧版 CA 没有该字段。

```ts
const { certificates } = await eid.person.certificates(etsi);
const byToken = new Map<string, typeof certificates>(); // Map.groupBy 需要 Node ≥ 21——在 Node 18/20 上不可用
for (const c of certificates) if (c.tokenSerial) byToken.set(c.tokenSerial, [...(byToken.get(c.tokenSerial) ?? []), c]);
```

## 3c. USB 令牌

```ts
import { verifyTokenCertificates, tokenAuthDigest, tokenLimitOf } from "@gerege-systems/eid-mongolia-sdk";

// 证书签发（TOKEN_ISSUE 权限）——公民在手机上用 PIN2 确认
const input = { signerEtsi, csrAuth, csrSign, tokenSerial: "EP2003-0042A1" }; // 没有 onBehalfOf = 个人
// push 之前：用相同输入做 dryRun——不创建 session/push，错误代码与真实调用相同
const pv = await eid.token.previewCertificate(input); // 若 pv.supersedes 存在，先警告公民并取得同意，再 ↓
const st = await eid.token.issueCertificate(input);
// … eid.session.poll(st.sessionId) → result.tokenCertificate?.status === "ISSUED"
const res = await eid.token.certificateResult(st.sessionId);
verifyTokenCertificates(res, csrAuth, csrSign); // 每个证书都与其 CSR 的密钥一致
// 409 TOKEN_LIMIT_REACHED → tokenLimitOf(err): { kind, limit, organization? }
// 409 TOKEN_IN_USE — 该序列号属于另一位公民；409 TOKEN_SCOPE_CHANGE——续期会更改 scope（见下）
// 400 APP_ATTESTATION_INVALID — 提供了 appTransaction 但无效（见下）

// 使用令牌登录（AUTH 权限）
const ch = await eid.token.authChallenge();
const digest = tokenAuthDigest(ch.rpUUID, ch.challenge); // 令牌的 CKM_ECDSA → 原始 r||s
// 自 0.19.0 起需完整传入 challenge（由 RP 保存，或由客户端回传——CA 通过 challengeId 比对）：
// SDK 不会仅凭 CA 的 OK 就信任——它会用证书密钥验证 r||s，将 rpUUID 与自己的比对，并按 trust 验证证书
// （证书链、颁发者、用途为 auth），然后才发送给 CA。
const who = await eid.token.authVerify(ch, authCertDer, rs);

// 使用令牌签 PDF：§3d — prepare() → 令牌 CKM_ECDSA(dtbs) → r||s → complete() → registerSignature() (无 sessionID，medium 为 "token")
```

**续期会保留 scope**（CA 2026-10-16，discovery `tokenCertificate.scopeLockedOnRenewal: true`——
`eid.token.certificateInfo()`）：若公民在同一 `tokenSerial` 上已有 ACTIVE 记录，则签发即续期；组织
令牌只能用于该组织（`onBehalfOf` 相同），个人令牌只能作个人使用。若 scope 不同，`POST`（或在
确认后的 `certificateResult`）返回 409 `TOKEN_SCOPE_CHANGE`，session 的 `tokenCertificate.errorCode` 同样如此——没有
override。更改 scope = 公民在 eID 应用中吊销令牌（`/v3/mobile/tokens/{tokenSerial}/revoke`）后重新签发；
对用户的提示：“要更改令牌类型（个人/组织），请在 eID 应用中吊销该令牌后重新签发。”

**个人令牌的自动替换**（CA 2026-10-19，discovery `tokenCertificate.personalAutoSupersede: true`）：当个人
数量达到上限时，使用不同 `tokenSerial` 的新个人令牌不再返回 409——而是返回 `st.supersedes`（`{ tokenSerial }[]`）；对个人
令牌的新签发成功后（PIN2 + 证书），之前个人令牌的 AUTH + SIGN 会以 superseded (4) 被吊销。
被拒绝 / 已过期的签发不会影响之前的令牌。在 PIN2 之前提示：“您之前的 USB 令牌（EP2003-…）的证书
将失效。”409 `TOKEN_LIMIT_REACHED` 的 `kind: "PERSONAL"` 仅在 `limit: 0`（个人签发被关闭）时出现；
组织令牌仍是硬性限制。

**dryRun——push 之前的检查**（CA 2026-10-19，discovery `tokenCertificate.dryRun: true`——
`certificateInfo().dryRun`）：当 `issueCertificate` 的响应中出现 `supersedes` 时，PIN2 push 已经发往手机——
即使在桌面端取消，只要公民在手机上确认，旧令牌仍会被替换。因此流程为：CSR →
`eid.token.previewCertificate(input)`（请求体相同 + `"dryRun": true`；执行所有检查，错误代码相同——包括
CSR 主机不同的待处理签发所返回的 `409 TOKEN_ISSUANCE_PENDING`；不会创建 session / push / state）→ 若有 `supersedes` 则警告，
让公民同意 → `issueCertificate(input)`。限流（RP、公民）为 20/分钟，RP 总计 120/10 分钟——不会
消耗 push 的 3/小时。若响应中没有返回 `dryRun: true`，则抛出 `ValidationError`（旧版 CA 对不认识的字段返回 400）。

**应用证明（`appTransaction`，可选）**（CA 2026-10-19，discovery `tokenCertificate.appTransaction:
"optional"`——`eid.token.certificateInfo().appTransaction`）：macOS App Store 构建会从桌面端传递 StoreKit 2 `AppTransaction`
的 JWS（compact）字符串——`issueCertificate({ …, appTransaction: jws })`。CA 不会调用 Apple 的服务器，而是离线检查；
若提供则必须有效，否则返回 400 `APP_ATTESTATION_INVALID`（SDK 的
常量；不会说明是哪一步失败，也不会向手机发送 push）。为空/缺失（Windows）= 无证明的签发。
超过 `MAX_APP_TRANSACTION_BYTES`（16 KiB）时 SDK 不会发送，而是抛出 `AppTransactionTooLargeError`。向旧版 CA 发送该字段
会返回 400。

`/token/auth/*` 已列入 `/.well-known/eid` 的 `endpoints.token.auth_challenge` / `auth_verify`（AUTH 权限）——
合约测试会像检查其他 route 一样检查它。

## 3d. PDF 签名（PAdES，客户端）——`@gerege-systems/eid-mongolia-sdk/pades`

**PDF 不会发送到 eID 服务器**（Smart-ID / DigiDoc 模式）。文档由您这一侧（浏览器或 Node）用原生
TypeScript（无 WASM，Web Crypto）组装；CA 仅对 32 字节的 DTBS 执行签名 session（普通的
`RAW_DIGEST_SIGNATURE`）并完成 CMS 的登记。输出：PAdES-BASELINE-LT（时间戳 tsa.timeserver.mn，OCSP/CRL
写入 DSS），在 Adobe / EU DSS 中显示“LTV enabled”，带验证（QR）页（mn 默认 / en）。与 Go reference
（`eid-mongolia-sdk-go/pades`，profile `pades-client/1`）**字节完全一致**——由 CI 中的 conformance golden 校验。

| 函数 | 位置 | 说明 |
|---|---|---|
| `prepare(pdf, { signerCert, claimedRole?, verifyPage?, verifyPagePosition?, fileName?, lang?, docId?, appearance?, … })` | 浏览器 / Node | `{ dtbs, digest, docId, state, placement? }`——无网络 |
| `suggestPlacement(pdf, appearance)` | 浏览器 / Node | 在不签名的情况下给出印章的位置 + 页面尺寸（用于预览，0.29.0+）——无网络 |
| `eid.signPdfDigest({ dtbs, fileName, signer, flow?, onBehalfOf? })` | RP 后端 | 针对 DTBS 的签名 session（push 或 device-link） |
| `complete(state, signature)` | 浏览器 / Node | TSA + OCSP/CRL → `{ pdf, cms, docId, outSha256, inSha256, hasPage, pageSha256, … }` |
| `eid.registerSignature(registrationFromCompleted(done, { fileName, sessionID, onBehalfOf? }))` | RP 后端 | `POST /pdf/signatures`——登记 `/verify/{docID}`。若无 `medium`，则由 `sessionID` 推断（phone ⇔ sessionID）；冲突，或带 `claimedRole` 的签名缺少 `onBehalfOf` 时，抛出 `ValidationError` |

`/pades` 浏览器 bundle 约 136 KB gzip（含 Noto Sans 字体 asset，CI 中 ≤ 300 KB）；主入口不包含它。`/pades`（以及整个包）需要 **Node ≥ 18**（CI：18 / 20 / 22）或
现代浏览器。浏览器 CSP：`connect-src https://tsa.timeserver.mn https://ocsp.eidmongolia.mn
https://crl.eidmongolia.mn`。在浏览器中，证书的 `http://` AIA/CDP 仅对这些主机改写为 `https://`；国家
CA 的 CRL（`esign.gov.mn`）取自 `crl.eidmongolia.mn` 镜像（所有平台）。验证器**不在**
`/pades` 中——完整验证在 `@gerege-systems/eid-mongolia-sdk/validate`（`validatePdf`，§3g）或 Go `pades.ValidatePDF` 中；`prepare` 对之前的签名只做“轻量”检查（结构、
CMS 签名、eID 颁发者、时间戳、DSS）。

**签名人证书。** `prepare` 需要公民的 SIGN 证书（`signingCertificateV2`），因此在 session 之前就需要它。
主要路径是 **certificate-choice**（§3.1；RP 需要 `CERT` 权限）：`validateCertificateChoice` → `signer.certificate`
+ `signer.documentNumber`，然后通过 `digestForSigner` / `deviceLinkForSigner` 让该设备签名。
`eid.person.certificates(etsi)`（`PKI_READ`；`type: "SIGN"`、`status: "VALID"`、`keyMedium: "MOBILE"` 记录的 `certValue` +
`documentNumber`）仅限受信任的 RP，且公民在最近 24 小时内已成功登录该 RP（否则 → 403）。
请使用该 `documentNumber` 启动 session——若由另一台设备签名，`complete` 返回 `SIGNATURE_INVALID`。

### Web RP（浏览器 prepare/complete，后端 session）

```ts
// ── 浏览器 ─────────────────────────────────────────────────────────────────────────────
import { prepare, complete } from "@gerege-systems/eid-mongolia-sdk/pades";

const { certB64, documentNumber } = await api("/sign/pdf/signer");             // backend: person.certificates
const signerCert = Uint8Array.from(atob(certB64), (ch) => ch.charCodeAt(0));     // prepare 接受 DER 格式的 Uint8Array
const p = await prepare(pdfBytes, {
  signerCert, verifyPage: true, fileName: "合同第12号.pdf",
  claimedRole, // 若以组织名义签名，则原样使用 getRepresentations() 返回的 claimedRole
});
await idb.put("pades-state", p.state);                                           // 页面可能会被重新加载
const s = await api("/sign/pdf/start", { dtbs: b64(p.dtbs), documentNumber, fileName: "合同第12号.pdf" });
showToUser(s.vc);                                                                // 或使用后端的 QR（§4）
const { signature } = await api(`/sign/pdf/${s.sessionId}/result`);              // backend poll + validateSign
const done = await complete(p.state, signature);                                 // TSA + OCSP/CRL + DSS
const { pdf, signerCert: _c, ...meta } = done;                                     // PDF 不会发送到后端
await api(`/sign/pdf/${s.sessionId}/register`, { ...meta, cms: b64(done.cms) });
download(done.pdf, "合同第12号.pdf");
```

```ts
// ── RP backend (Node) ─────────────────────────────────────────────────────────────────────
import { registrationFromCompleted } from "@gerege-systems/eid-mongolia-sdk";

// /sign/pdf/start — sessionSecret（device-link）绝不离开后端；请将 s.digest 保存在 session 中。
const s = await eid.signPdfDigest({
  dtbs: req.body.dtbs, fileName: req.body.fileName,
  signer: { documentNumber: req.body.documentNumber }, // 或 { etsi }
  onBehalfOf: "NTRMN-6235972",                         // 可选
});
store(s.sessionId, { digest: s.digest, fileName: req.body.fileName });
// /sign/pdf/:id/result
const r = await eid.session.waitForResult(sessionId);
const sig = eid.validator.validateSign(r, store.get(sessionId).digest, { expectedFlowType: "Notification" });
reply({ signature: sig.signatureValueB64 });
// /sign/pdf/:id/register — CA 会自行验证 CMS（session digest = SHA-256(signedAttrs)、证书、claimedRole）
// registrationFromCompleted：请求体与 CA 的 dto 完全一致（不发送 hasPage，仅在有页面时才有 pageSha256）；cms 也可以是 base64。
const reg = await eid.registerSignature(registrationFromCompleted(req.body, {
  fileName: store.get(sessionId).fileName, sessionID: sessionId, onBehalfOf: "NTRMN-6235972" }));
reply({ verifyUrl: reg.verifyUrl });
```

- `reg.created`——`true` 为 201（新建），`false` 为 200（相同请求体的重复提交）。若之前的签名由 CA 组装（模式 A），请将
  `complete().priorRevisionSha256`（`sha256(doc[0 : ByteRange[2]+ByteRange[3]])`）作为 `registrationFromCompleted` 的
  `priorSignatures` 传入；在收到 409 `PRIOR_MISMATCH` 后，`registerSignature` 会自行按 revision 对齐
  （若您手动提供了 `priorRevisionSha256` 则不会尝试）。从浏览器以 JSON 传递时，也要一并发送 `priorRevisionSha256`。
- `registerSignature` 的错误：`ApiError.code` / `ForbiddenError.code` ∈ `PdfRegisterErrorCode`
  （`PDF_REGISTER_ERROR_CODES`；Go：`eid.PDFRegisterErrorCodes`）——400 `REQUEST_INVALID` / `CMS_INVALID` /
  `SIGNATURE_INVALID` / `TIMESTAMP_INVALID`；403 `TOKEN_ORG_MISMATCH` / `REPRESENTATION_REVOKED`；404 `DOC_NOT_FOUND`；409
  `SIGNER_MISMATCH` / `SIGNER_CERT_INVALID` / `TOKEN_CERT_INVALID` / `SESSION_MISMATCH` / `SESSION_NOT_COMPLETE` /
  `SESSION_FAILED` / `CLAIMED_ROLE_MISMATCH` / `DOC_ID_CONFLICT` / `REGISTRY_CONFLICT` / `PRIOR_MISMATCH`；413
  `REQUEST_TOO_LARGE`；429 `RATE_LIMITED`，503 `STATE_UNAVAILABLE`（`retryable`）。

**可见签名（可选）。** 传入 `appearance: { page?, x, y, width, height, lang?, exact? }` 后，签名会在页面上
可见（QR + 姓名、`claimedRole`、“eID Mongolia-аар зурсан”（“由 eID Mongolia 签署”）、日期 `YYYY-MM-DD HH:MM (+08)`）；否则签名不可见
（与之前字节一致）。坐标单位为 pt，自页面 CropBox 在应用 `/Rotate` 之后（屏幕上所见）的左下角起算；
`page` 从 1 开始（缺省/0 = 最后一页，而**不是**输入文档中的 eID verify 页——本次 prepare 新增的以及之前签名所
新增的 verify 页不计入（0.26.0+）；显式指定的页码即使是 verify 页也保持不变）。高度 ≥ 45 pt；超出页面、文字
放不下，或没有 docId（带有无页签名的文档）时返回 `REQUEST_INVALID`。每个可见签名约增加 ~90 KB。规则：Go 仓库的
`pades/APPEARANCE_SPEC.md`。

`x, y` 是**请求的**位置：若该处存在页面内容（文字、表格线、图片、之前的签名），
印章会移到空白区域——先到镜像列（右下 → 左下），然后每次上移 12 pt。不会渲染页面，
只读取 content stream（与 Go 逐个盒子保持一致）。结果：`p.placement`——
`{ page, x, y, width, height, status }`（pt），`status`：`requested`（在请求的位置）| `moved`（已移动）| `overlap`（没有空白
区域——仍在请求的位置，压在内容上）| `unscanned`（在限制内无法读取该页——仍在请求的位置）。签名
在任何情况下都有效；建议将 `overlap` / `unscanned` 告知用户。规则：Go 仓库的
`pades/PLACEMENT_SPEC.md`。

```ts
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "合同第12号.pdf",
  appearance: { page: 1, x: 340, y: 36, width: 220, height: 64 } });
if (p.placement?.status === "overlap") notice("签名与页面内容重叠");
```

**让公民自行选择位置（0.29.0+）。** `suggestPlacement(pdf, appearance)` 在没有证书、签名和网络的情况下运行 `prepare` 的
位置算法（page 0 的解析、读取页面、查找空白区域）：
`{ page, x, y, width, height, status, pageWidth, pageHeight, pageCount, pages: [{ width, height }] }`（pt；`pages[i]`——
每页的可见尺寸，几何信息无法读取的页面为 `{0, 0}`）。`page, x, y, width, height, status` 与同一 PDF + appearance 的
`prepare().placement` 相同（对无签名的文档，page 0 不会跳过任何页——即最后一页）。
若 UI 以 `s` px/pt、左上角为原点绘制页面：`left = x·s`，`top = (pageHeight − y − height)·s`；反向换算时
`x = left/s`，`y = pageHeight − top/s − height`，然后设置 `appearance.exact: true`——印章会被准确绘制在那里，绝不会
移动（超出页面则返回 `REQUEST_INVALID`，不会裁剪）。由于仍会读取页面，`status` 为：`requested`（空白）|
`overlap`（压在内容上）| `unscanned`；绝不会是 `moved`。没有 `exact`/为 false 时与之前字节一致。检查顺序：
`PDF_TOO_LARGE` → `PDF_INVALID`（头部/结构）→ `REQUEST_INVALID`（appearance 的值）→ `PDF_ENCRYPTED` → `PDF_INVALID`
（读取签名）→ `REQUEST_INVALID`（页数、盒子、超出页面）。不检查之前的签名、
签名人以及姓名是否放得下（这些由 `prepare` 检查）。规则：`PLACEMENT_SPEC.md` §6a/§6b。

```ts
const s = await suggestPlacement(pdfBytes, { x: 340, y: 36, width: 220, height: 64 }); // 默认位置
// … 公民在预览上拖动图章 → { page, x, y }（pt，原点在左下角） …
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "合同第12号.pdf",
  appearance: { page, x, y, width: s.width, height: s.height, exact: true } });
```

**将验证页放在开头（0.30.0+）。** `verifyPagePosition: "first"`——QR 页成为文档的第 1 页（默认
`"last"`——在末尾，与之前字节一致；其他值返回 `REQUEST_INVALID`）。仅在会新增页面时才有效果（无签名的文档，
`verifyPage: true`）。`appearance.page`、`suggestPlacement` 和 `placement.page` 始终按**输入** PDF 的页码计算——
新增的页不计入，因此可直接传入预览中的页码。规则：`PAGE_SPEC.md` §8a，
`PLACEMENT_SPEC.md` §1b。

```ts
const p = await prepare(pdfBytes, { signerCert, verifyPage: true, verifyPagePosition: "first", fileName: "合同第12号.pdf",
  appearance: { page: 2, x: 340, y: 36, width: 220, height: 64, exact: true } }); // 位于输出的第 3 页
```

### 仅 Node（后端完成全部工作）

```ts
import { writeFileSync } from "node:fs";
import { registrationFromCompleted } from "@gerege-systems/eid-mongolia-sdk";
import { prepare, complete, PadesError } from "@gerege-systems/eid-mongolia-sdk/pades";

const p = await prepare(pdfBytes, { signerCert, verifyPage: true, fileName: "合同第12号.pdf" });
const s = await eid.signPdfDigest({ dtbs: p.dtbs, fileName: "合同第12号.pdf", signer: { documentNumber } });
showToUser(s.vc);
const r = await eid.session.waitForResult(s.sessionId);
const sig = eid.validator.validateSign(r, s.digest);
let done;
for (let i = 0; ; i++) {
  try {
    done = await complete(p.state, sig.signatureValueB64);
    break;
  } catch (e) {
    if (e instanceof PadesError && e.retryable && i < 3) continue; // TSA_UNAVAILABLE / LTV_UNAVAILABLE — 相同的 state + 签名
    throw e;
  }
}
await eid.registerSignature(registrationFromCompleted(done, { fileName: "合同第12号.pdf", sessionID: s.sessionId }));
writeFileSync("signed.pdf", done.pdf);
```

**LTV 重试（0.18.3+）。** 若收集 OCSP/CRL（DSS）失败（例如 CRL 镜像暂时返回 404），`complete` 会使用相同的 state、签名和
TSA 时间戳自行**重试 2 次**（共 3 次；等待约 1 s、约 3 s + 0–25% 抖动）——不会再次询问 PIN。
`ltvRetries`（默认 2，`0`——关闭）；全部失败则返回 `LTV_UNAVAILABLE`。`signal`（`AbortSignal`）会中止 TSA/OCSP/CRL 的下载以及
等待——抛出 `signal.reason`（默认是 `DOMException` `AbortError`）。上面的外层循环只在
`TSA_UNAVAILABLE` 和长时间故障时才需要。若 OCSP/CRL（由颁发者签名）表明链中某个证书已
**吊销**（0.21.0），则立即返回 `LTV_UNAVAILABLE`，`cause` 为 `CertificateRevokedError`，`retryable` 为 false——不会
重试（此前会跳过已吊销的 OCSP，转而用 CRL 组装 DSS）。OCSP/CRL 还遵循 CertID/颁发者/新鲜度
规则（§ validate）。

**OCSP/CRL 顺序（0.46.1）。** `complete` 按各自的角色获取链中每个证书的吊销证据：
链中的第一个证书（公民、TSA）——先 OCSP（普通的 10 s 超时，“晚于时间戳”规则），再 CRL
（两者都有效则两者都写入 DSS）；CA 证书（其余所有）——先 CRL，若已获得有效的 CRL，则**不会向**该证书的 OCSP
responder **发送**请求，仅在没有有效 CRL 时才用 OCSP（10 s）。两者都无效 → `LTV_UNAVAILABLE`（fail-closed），
由颁发者签名的“revoked”（OCSP 或 CRL）→ `CertificateRevokedError`。此前，对于接受连接但
一直不响应的 CA 证书 OCSP responder，每次签名都会被拖延约 20 s。DSS 中 CA 证书只写入 CRL。
`validatePdf` 的在线吊销检查保持不变（仅针对 eID 的 04/05 所签发的证书，OCSP → CRL）。

`PadesError.code`（稳定，所有平台相同）：`PDF_INVALID`、`PDF_ENCRYPTED`、`PDF_LOCKED`（DocMDP P=1）、
`PDF_TOO_LARGE`、`PDF_TOO_MANY_SIGNATURES`、`PDF_PRIOR_SIGNATURE_INVALID`、`PDF_FOREIGN_SIGNATURE`、`SIGNER_INVALID`、
`REQUEST_INVALID`、`SIGNATURE_INVALID`（state 保持不变——可以重新签名）、`TSA_UNAVAILABLE`、`LTV_UNAVAILABLE`
（`retryable`）、`SELF_VALIDATION_FAILED`、`PLACEHOLDER_OVERFLOW`、`STATE_INVALID`、`INTERNAL`（仅 TS——Go 中没有）。
`state` 包含已准备好的 PDF——请以与 PDF 相同的保密级别保存。其格式与 Go SDK 相同（可以在浏览器中 `prepare`，
在 Go 后端中 `complete`）。

在 0.15.0 中，`eid.pdf`（`prepare`、`document`、`documentVerified`、`tokenPrepare`、`tokenFinalize`、`tokenDocument`）以及
`pdfMaxBytes` 已被移除（`pdfTimeoutMs` 在 0.19.0 中为 `registerSignature` 重新加入——见下）——CA 上已不存在 PDF 上传 endpoint（2026-10-14 移除，404）。

**超时。** `registerSignature`（`POST /pdf/signatures`——CA 校验 CMS + TSA + LTV）自 0.19.0 起有自己的
`pdfTimeoutMs`，默认 **80 s**（`DEFAULT_PDF_TIMEOUT_MS`；与 Go SDK 的 `Config.PDFTimeout` / `DefaultPDFTimeout` 一致）；
其他调用使用 `timeoutMs`（默认 15 s）。在 0.18.x 中，登记会在普通的 15 s 处超时。

## 3e. 浏览器内 Word → PDF——`@gerege-systems/eid-mongolia-sdk/convert`

公民选择 Word（.docx / .doc）文档时，浏览器会自行转换为 PDF——**文件不会发送到服务器**（原则与 §3d 相同）。
转换器是 LibreOffice 24.8 的 WebAssembly 构建（`@matbee/libreoffice-converter@2.7.2`，MPL-2.0），运行在 Web Worker 中。
签名是针对**转换后的 PDF，而不是 Word 文件**——在签名之前，必须向公民展示该 PDF（正是那些字节），
并让其确认“已检查”；转换可能导致字体、行、页面发生位移（`warnings`）。

```bash
npm install @gerege-systems/eid-mongolia-sdk @matbee/libreoffice-converter@2.7.2   # optional peer——仅用于 /convert
npx eid-mongolia-convert-assets public/eid-convert                                 # 在构建时执行；不要提交到 git (~190 MB + .br/.gz)
```

```ts
import { wordToPdf, converterStatus, isWordFile, ConvertError } from "@gerege-systems/eid-mongolia-sdk/convert";
import { prepare } from "@gerege-systems/eid-mongolia-sdk/pades";

if (isWordFile(file)) {
  const s = await converterStatus({ assetsBase: "/eid-convert/" });   // { cached, downloadBytes } — 提醒移动数据流量
  const { pdf, pages, warnings } = await wordToPdf(file, {
    assetsBase: "/eid-convert/",
    signal: controller.signal,                                        // 取消 → DOMException AbortError
    onProgress: ({ phase, percent, loaded, total }) => show(phase, percent), // download（仅首次）→ init → convert
  });
  preview(pdf);                       // 由公民检查并确认
  const p = await prepare(pdf, { signerCert, verifyPage: true, fileName: "合同.pdf" });   // §3d
}
```

| 函数 | 说明 |
|---|---|
| `wordToPdf(file, { assetsBase, onProgress?, signal?, fileName?, verbose? })` | `{ pdf, pages, warnings }`。复用同一个 worker；调用会排队。`verbose: true`——将 LibreOffice 的诊断日志输出到控制台（默认静默；取值变化时 worker 会重启） |
| `converterStatus({ assetsBase })` | `{ cached, downloadBytes }`——在下载前告知大小（brotli 大小；已缓存则为 0） |
| `isWordFile(file \| name)` | 是否为 .docx / .doc（名称、MIME）。内容由 `wordToPdf` 根据开头字节检查 |
| `disposeConverter()` | 停止 worker 并释放内存（缓存保留） |

**在主机上（必须）。**
- 转换页面必须 **crossOriginIsolated**：`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`（SharedArrayBuffer）。可以只在该 route 上设置——这样就必须用**硬跳转**进入该页面
  （`<a href>`，而不是 client-side router）。否则 `wordToPdf` 会立即返回 `NOT_ISOLATED`（不会等待）。在 COEP 下，没有
  CORP/CORS 的外部图片、iframe 无法加载。
- Asset 放在**您自己的主机**上（`assetsBase`）：`manifest.json`——`Cache-Control: no-cache`；`<版本>-<hash>/*`——
  长缓存（`public, max-age=31536000, immutable`），`.wasm` → `application/wasm`。首次下载的内容，SDK 会
  保存在 Cache Storage 中（不再重复下载）；目录变化时删除旧的。
- **压缩。** `eid-mongolia-convert-assets` 会在每个文件旁写入 `.br`（brotli 11）和 `.gz`（gzip 9）——
  请在服务器上用 `brotli_static` / `gzip_static` 提供（对 147 MB 的 wasm 做动态压缩太慢）。大小（2.7.2）：

  | 文件 | 解压后 | gzip | brotli |
  |---|---|---|---|
  | soffice.wasm | 147.4 MB | 48.5 MB | 33.8 MB |
  | soffice.data | 43.2 MB（upstream 99.7 MB） | 11.9 MB | 7.1 MB |
  | soffice.js + 其他 JS | 0.5 MB | 0.1 MB | 0.1 MB |

  首次下载总计 ≈ 41.0 MB brotli / 60.6 MB gzip（此前为 77 MB gzip）。brotli 11 对 soffice.wasm 很慢（在 M4 Pro
  上约 4 分钟）——若要加快构建，使用 `EID_CONVERT_BROTLI_QUALITY=9`（wasm 39.2 MB，约 9 s）。nginx（ngx_brotli 模块）：

  ```nginx
  location /eid-convert/ {
      brotli_static on;          # <file>.br，当 Accept-Encoding 为 br 时
      gzip_static   on;          # <file>.gz，其他情况
      types { application/wasm wasm; application/octet-stream data; text/javascript js; application/json json; }
      add_header Cache-Control "public, max-age=31536000, immutable";   # + 下文的 worker CSP（*.js）
      location = /eid-convert/manifest.json { add_header Cache-Control "no-cache"; }
  }
  ```

  SDK 会统计解压后的字节（`onProgress` 的 `loaded`/`total`）并与 manifest 的 `bytes` 比对，因此无论服务器
  使用哪种压缩，进度都是正确的。Safari 仅在 HTTPS 下才请求 brotli。
- **soffice.data 已精简**（99.7 → 43.2 MB）：移除 Writer → PDF 用不到的字体（阿拉伯文、希伯来文、亚美尼亚文、格鲁吉亚文、
  Libertine……）、Calc/Impress/Draw/Math 的 UI 配置、图标库和 gallery；保留 NotoSans/NotoSerif（Ө Ү 的
  替代字体）和全部 `registry/*.xcd`（OMML 公式）。若 upstream `soffice.data` / `soffice.js` 的 sha256 不匹配，
  则复制失败。在 4 份文档（表格、图片、图表、公式、11 种字体的西里尔文）上，PDF 像素级一致。
  **升级 upstream 版本时**（`@matbee/libreoffice-converter` 2.7.2 → …）：请在新构建上重新生成 `DATA_TRIM` 的 sha256 和移除列表，
  并用 `npm run test:convert-e2e`（Chromium + WebKit）确认——表格、Ө Ү、公式。
- Worker 脚本（`<assetsBase><版本>/*.js`）使用**单独的 CSP**：`default-src 'self'; script-src 'self'
  'wasm-unsafe-eval' 'unsafe-eval'`（Emscripten 需要 `eval`——仅限 worker）。页面的严格 CSP（nonce +
  `'strict-dynamic'`）保持不变；页面上 `connect-src 'self'` 即可。
- 控制台：LibreOffice 每次转换都会打印“warn:vcl…”、“[LOK C++] …”之类的诊断行（不是错误）。
  `eid-mongolia-convert-assets`（≥ 0.18.2）会对 upstream worker 打补丁（仅当通过 `@matbee/libreoffice-converter@2.7.2` 的 sha256 验证时），
  使其在没有 `verbose: true` 时不输出这些内容；`manifest.json` 中带有 `"patched": true`。若 hash
  不匹配，则不打补丁直接复制并给出警告——转换可正常工作，只是会出现日志。升级 SDK 后请重新复制
  asset（`rev` 变化，从而刷新 worker 的 immutable 缓存；若 soffice.js 未变化，则 soffice.wasm/.data 不会重新
  下载）。
- 慢速 CPU（0.21.0）：upstream `soffice.js` 的 `pthreadPoolSize=4` 在慢速电脑上加载文档时会
  卡死（deadlock），因此 `eid-mongolia-convert-assets` 将其改为 8（`manifest.json` 中为 `"pthreadPoolSize": 8`；
  仅 JS）。若 `soffice.js` 的 sha256 与已知的 2.7.2 不匹配，则复制失败——请重新复制 asset。
- 首次转换约 80 s 的延迟（≥ 0.44.1；0.44.0 中未包含）：upstream glue 会与 LibreOfficeKit 的 init 同时启动 LibreOffice 的 `main()`，因此即使 pool 为 8，在部分
  冷启动场景中首次转换（或 init）也会被拖慢约 80 s。
  `eid-mongolia-convert-assets` 现在会让 `soffice.js` 不启动 `main()`（`shouldRunNow=false`——
  与 `Module.noInitialRun` 相同；`manifest.json` 中为 `"noInitialRun": true`；仅 JS；PDF 的文字、布局、栅格一致）。Pool 仍为 8
  ——即使没有 `main()`，pool 4 在 ≤ 2 核的设备上保存时仍会卡死。Upstream：
  [issue #19](https://github.com/matbeedotcom/libreoffice-document-converter/issues/19)（PR #20、#21）——两者都包含在内的
  release 发布后，这两个补丁将被移除。升级 SDK 后请重新复制 asset（目录名和 `rev` 会变化；
  即使 `soffice.wasm` / `.data` 的内容未变，也会从新目录下载一次）。
- MPL-2.0：`<版本>/NOTICE.txt`（源码、许可证链接）必须随 asset 一同提供——请在面向用户的
  界面（帮助/许可证部分）中提及 LibreOffice。

`ConvertError.code`：`UNSUPPORTED_ENVIRONMENT`、`NOT_ISOLATED`、`UNSUPPORTED_FILE`、`INPUT_TOO_LARGE`（为空或 > 50 MiB）、
`ASSETS_UNAVAILABLE`（`retryable`）、`CONVERT_FAILED`（文档损坏 / 有密码）。`warnings[].code`：
`FONT_SUBSTITUTED`（`fonts`——转换器中没有且没有度量兼容替代品的字体；Times New Roman / Arial /
Calibri / Cambria / Courier New 的 Liberation / Carlito / Caladea 替代字体不会触发警告）、`FONT_FALLBACK`（`fonts`——
部分字符使用了其他字体，例如因为 Caladea 不含西里尔文而改用 Noto）、`PDF_NEAR_LIMIT` / `PDF_TOO_LARGE`（`bytes`、
`limit`——§3d `prepare` 的 10 223 616 字节）。字体警告仅针对 .docx（启发式）；.doc 没有。

已测试：Chromium 和 WebKit（Playwright，`npm run test:convert-e2e`）——.docx 和 .doc → PDF → `prepare`、有缓存时重复
运行不再下载、取消、没有 COEP 的页面。在移动浏览器中，147 MB 的 WASM 需要大量内存——在性能较弱的
手机上可能崩溃。

## 3f. 通过电子邮件发送已签名文件——`eid.share()`（`SIGN` 权限）

将您已签名的 PDF 作为附件发送给下一位签名人 / 收件人（`POST /share`）。CA **不会保存**该文件：它会检查
文件是否带有有效的 eID 签名，发送后即丢弃。每位收件人收到单独的一封邮件。

> 在 CA 上始终开启（自 2026-10-16 起不再有开关）。限制和配额请从 `await eid.shareInfo()` 读取；
> 若 `enabled` 为 false，则邮件服务暂未配置（503）。

```ts
import { ShareError } from "@gerege-systems/eid-mongolia-sdk";

const info = await eid.shareInfo(); // { enabled, maxFileBytes, maxRecipients, quota: { perRPHour, perRPDay, perRecipientDay }, … }
if (info.enabled) {
  try {
    const r = await eid.share({
      file: signedPdf,                 // Uint8Array | ArrayBuffer | Blob/File; ≤ 3 080 192 字节
      filename: "合同.pdf",           // 须带 .pdf 扩展名；默认为 File 的名称或 document.pdf
      to: ["next@example.mn"],         // 1–5 个，不可重复
      subject: "合同——签名",   // ≤ 150; CA 会添加“‹RP 名称›: …”前缀
      message: "请添加第二个签名", // ≤ 1000
      lang: "mn",                      // mn | en
    });
    console.log(r.sent, r.sha256, r.signatures, r.docID); // docID——若已在 CA 登记（邮件中会带 verify 链接）
  } catch (e) {
    if (e instanceof ShareError) {
      // e.code: ShareErrorCode; 422 → e.reason; 502 → e.sent / e.failed / e.recipients ("sent" | "failed", 按 to 的顺序)
    }
    throw e;
  }
}
```

| HTTP | `ShareError.code` | 说明 |
|---|---|---|
| 400 | `REQUEST_INVALID`, `FILE_EMPTY`, `RECIPIENT_REQUIRED`, `TOO_MANY_RECIPIENTS`, `RECIPIENT_INVALID`, `RECIPIENT_DUPLICATE` | 字段错误 |
| 413 | `FILE_TOO_LARGE` | 文件 / 邮件超过限制 |
| 415 | `FILE_TYPE_NOT_SUPPORTED` | 不是 PDF（扩展名、Content-Type、`%PDF-` 三者必须一致），无法解析或已加密的 PDF |
| 422 | `FILE_NOT_SIGNED` | `.reason`：`no_signature` \| `invalid` \| `untrusted` |
| 429 | `RATE_LIMITED` | 配额；`.retryAfterMs`、`.retryable` |
| 502 | `MAIL_FAILED` | `.sent`、`.failed`、`.recipients`——仅重新发送 `failed` 的 |
| 503 | `MAIL_UNAVAILABLE`、`VALIDATOR_UNAVAILABLE`、`VALIDATOR_BUSY`（`SHARE_DISABLED`——旧版 CA） | 配置 / 负载（`VALIDATOR_*`——Retry-After） |

401 → `AuthenticationError`，403（没有 SIGN 权限、IP/mTLS）→ `ForbiddenError`。配额：每个 RP 每小时 300 / 每天 3000 次请求，
每位收件人每天 10 封邮件（实际值请取自 `shareInfo().quota`）。超时默认 150 s（`timeoutMs`）。

## 3g. 验证已签名的 PDF——`@gerege-systems/eid-mongolia-sdk/validate`（0.20.0）

**在浏览器或 Node 内**验证 PDF——文件不会发往任何地方。规则与 CA 公共验证器（`/v3/validate/pdf`，
Go SDK `pades.ValidatePDF`）相同，JSON 报告相同（snake_case）；三者共用同一套 conformance 套件。

```ts
import { validatePdf, ValidatePdfError } from "@gerege-systems/eid-mongolia-sdk/validate";

try {
  const rep = await validatePdf(new Uint8Array(await file.arrayBuffer())); // 默认：国家 Root CA，在线吊销检查
  rep.indication; // "valid" | "invalid" | "indeterminate"
  for (const s of rep.signatures) {
    s.signer_name; s.signing_time; s.signature_level; s.certificate_level; s.problems; s.visible; s.key_medium;
  }
} catch (e) {
  if (e instanceof ValidatePdfError) e.code; // PDF_NO_SIGNATURE | PDF_INVALID | PDF_ENCRYPTED | PDF_TOO_LARGE | PDF_TOO_MANY_SIGNATURES | UNSUPPORTED_ENVIRONMENT | REQUEST_INVALID (roots/intermediates/issuers)
}
```

- 错误代码（0.20.1）：`PDF_ENCRYPTED`——带 `/Encrypt` 的文档（RC4、AES-128、AES-256；即使用户密码为空
  也一样）无法验证：“无法验证已加密的 PDF——请移除保护后重试”（Go `pades.ValidatePDF`，
  CA 相同）。`UNSUPPORTED_ENVIRONMENT`——没有 `crypto.subtle`（http 页面——不是 secure context——或旧浏览器）：
  需要 https 页面或较新的浏览器（此前为 `PDF_INVALID`）。

- 检查项：ByteRange（间隙恰好是 `/Contents`）和 messageDigest、CMS 签名（WebCrypto）、signingCertificateV2、
  证书链（国家 01 → 02/03 → 04/05）、KU/EKU、有效期（按时间戳的时间）、RFC 3161 令牌、签名之后的 revision
  （除 eID 的签名/LTV 之外的任何改动 → `modified_after_signing`）、可见签名（APPEARANCE_SPEC §5）、`ltv`、
  `certificate_level`（qcStatements：QUALIFIED/QSCD，否则 ADVANCED）。
- 吊销（针对由 eID 的 04/05 签发的证书）：在线——AIA OCSP，否则 CDP CRL（`fetch` + AbortSignal；在浏览器中
  `http://ocsp.|crl.eidmongolia.mn` → https，CORS `*`）；无响应或 `offline: true` 时使用文档的 DSS。两者都没有 →
  `revocation_unavailable`。网络上只会发送证书序列号（OCSP 请求）。
- 吊销证据规则（0.21.0，与 Go v0.7.2 相同，golden validate v4）：OCSP 必须针对**该**证书（CertID =
  链中颁发者的名称/密钥 hash + 序列号），CRL 必须属于颁发者（名称、AKI、签名）。“good”在检查时必须是新鲜的：
  thisUpdate 不在未来（5 分钟容差）、nextUpdate 未过期，且 thisUpdate ≤ 24 小时前，或
  thisUpdate…nextUpdate 覆盖检查时间（检查时间 = 受信任时间戳的时间，否则为 `time`/当前时间）。
  否则不予采信 → `revocation_unavailable`。由颁发者签名的“revoked”（OCSP 或 CRL，在线或 DSS）
  始终压过“good”。**此前为 `valid` 的部分文档现在会变为 `indeterminate` 或 `invalid`。**
- 不受信任的 PDF：在解析之前，数组/字典嵌套 > 256 → `PDF_INVALID`（`prepare` 同样；`complete`——
  `STATE_INVALID`）。这只是一层防护——请限制大小（≤ 10 MiB）和时间。
- 选项：`roots`、`intermediates`、`issuers`（DER，测试用）、`time`、`offline`、`fetch`、`signal`。
- `key_medium`——仅来自证书：带 qcStatements 的公民 SIGN → `phone`，其他为 `unknown`。CA（`POST /v3/validate/pdf`）
  根据自己的登记确定 `token`，以及 eID 签发的组织印章的 `server_software` / `server_hsm`（密钥位于
  服务器一侧；这并不声明其为 QSCD）——类型（`SignatureReport["key_medium"]`，0.45.0）有五个取值。`session_id`、`doc_id`、`on_behalf_of_*` 来自 CA 的登记——本地报告中没有。
- 浏览器 bundle（压缩后）：约 253 KB，gzip 约 137 KB（`npm run size:validate`，限制 300 KB）。

## 3h. “我的 QR”——当面验证（`eid.qr`，0.37.0）

公民在 eID 应用中展示“我的 QR”（`EIDMN-QR1:<token>`，120 s，一次性）。RP（收银台、POS、应用）扫描 →
公民在手机上用 PIN2（QUALIFIED 签名密钥）批准“您将与 <RP> 共享“我的信息”部分的全部信息”这句话 → RP 获得公民**自己**签名的
（PS256 JWS，`x5c` = [SIGN 证书, 颁发 CA]）“我的信息”（应用中存储的键/值原样保留，外加人脸 JPEG 图像）。
RP 只需要 `QR_PRESENT` 权限。CA 不会将数据保存到数据库——在 RP 首次成功读取时即删除。

```ts
import { QrError, QrTokenInvalidError, SessionFailedError } from "@gerege-systems/eid-mongolia-sdk";

const s = await eid.qr.start({ qr: scanned, nonce: orderId }); // 若未提供 nonce，则为 base64url(16 字节)；没有 VC
// s（{ sessionId, nonce }）可以保存为 JSON——result/check 会核对 nonce 和 session。
try {
  const p = await eid.qr.result(s); // 或用于轮询 UI： await eid.qr.check(s) → { complete: false } | { complete: true, result }
  p.data;          // { birth_date: "1990-01-01", given_name: "巴特", … } — 按 payload 的顺序，键保持原样
  p.source;        // "dan" | "passport" | "citizenid" | "gsign" | "guardian" | "unknown" | …
  p.photo;         // Uint8Array (JPEG) | undefined
  p.signer;        // { certificate, etsi: "PNOMN-…", givenName, surname, commonName } — 来自证书
  p.signedAt;      // Date (iat)
  p.sha256;        // hex SHA-256(signingInput) = CA 审计中的 qrsha（用于争议核对）
} catch (e) {
  if (e instanceof QrTokenInvalidError) {/* start：404——请重新生成 QR */}
  else if (e instanceof SessionFailedError) {/* USER_REFUSED, TIMEOUT … */}
  else if (e instanceof QrError && e.code === "QR_PRESENTATION_GONE") {/* 已被读取 / 已过期——请使用新的 QR */}
  else if (e instanceof QrError && e.code === "QR_REVOCATION_UNKNOWN") {/* OCSP 无响应——暂时性，请重新验证 */}
  else if (e instanceof QrError) {/* QR_* 检查失败——不要信任 */}
  else throw e;
}
```

验证（`verifyQrPresentation(jws, expect, trust)`；与 Go / .NET SDK 相同，`test/fixtures/myqr_vectors.json`）：
形态（≤ 512 KiB，3 段）→ header 必须恰好是 `alg` PS256 / `typ` `eidmn-myqr+jwt` / `x5c` 为 2 张证书（`QR_HEADER_INVALID`）
→ 证书链：x5c[1] ∪ `trust.intermediatesPem` → `trust.trustAnchorsPem`（默认 `NATIONAL_ROOT_CA_PEM`），时间 ± 60 s，非 CA，
KeyUsage contentCommitment，QUALIFIED（qcStatements），颁发者 allowlist（默认 `CITIZEN_ISSUING_CA_SKI`），RSA ≥ 2048
（`QR_CHAIN_INVALID`；x5c[1] 绝不会成为 anchor）→ 吊销 `trust.revocation`（若无则用 SDK 的 OCSP；`revocationMode`
默认 hard-fail：`QR_CERT_REVOKED` / `QR_REVOCATION_UNKNOWN`）→ 针对收到的字节验证 PS256（salt 32）
（`QR_SIGNATURE_INVALID`）→ claim：`iss` = `https://ca.eidmongolia.mn`，`sub` = 证书的 serialNumber，`statement` 必须与由
`rp_name` 组装的结果完全相等（`QR_CLAIMS_INVALID`），`aud` = RP UUID（不区分大小写，
`QR_AUDIENCE_MISMATCH`），`sid`（`QR_SESSION_MISMATCH`），`nonce`（`QR_NONCE_MISMATCH`），`0 < exp − iat ≤ 300`，
`iat ≤ 现在+60`（`QR_NOT_YET_VALID`），`现在 < exp+60`（`QR_EXPIRED`）→ 数据：`source` `^[a-z0-9_-]{1,32}$`，`fields`
≤ 128 个键（1–64 个字符，无控制字符），值为字符串 ≤ 2048 字节，`photo` 为严格 base64 的 JPEG ≤ 150 KiB，
没有其他成员（`QR_DATA_INVALID`）。`trust` = `ClientConfig.trust`（`allowUntrusted`、`checkKeyUsage: false` 在此
不生效）。

若 `result` 的 `maxWaitMs` 到期时公民仍未应答，则返回 `QrError` `QR_PENDING`（可再次调用）。CA 的代码
（`ApiError` / `ForbiddenError` 的 `code`）：400 `REQUEST_INVALID`（nonce 为 16–128 字节 ASCII 0x21–0x7E）、403
`PERMISSION_DENIED` / `RP_REQUIRED`、404 `QR_TOKEN_INVALID`、409 `NO_SIGNING_CERTIFICATE`、429 `RATE_LIMITED`；`GET /session` 的
410 → `QrError` `QR_PRESENTATION_GONE`（presentation 只会给出一次）。`qr.issuer` 配置——仅用于测试环境。

## 3i. 组织电子印章（e-Seal）——`eid.seal`、`sealPdf`（0.42.0）

以组织名义，由**无人值守的自动化**系统对文档加盖印章（发票、证明、对账单）：密钥保存在 eID 的
服务器上，不涉及公民/PIN/应用，响应即时返回（无 session）。RP 需要该组织的 **`SEAL:<orgEtsi>`** 权限——
该权限**由组织自己授权**（见下文“印章权限、密钥、有效期”）；没有权限则返回 `ForbiddenError` 403。
若是公民以组织名义签名，请参见 §3a（不是印章）。仅限后端（RP secret）。

```ts
import { sealPdf, PadesError } from "@gerege-systems/eid-mongolia-sdk/pades";

const done = await sealPdf(eid.seal, "NTRMN-6235972", pdfBytes, { reason: "发票" });
writeFileSync("sealed.pdf", done.pdf); // PAdES-BASELINE-LT, 带有组织印章
```

- 流程：`eid.seal.getCertificate(org)`（`GET /seal/certificate/{orgEtsi}`）→ `prepare`（signerCert = 印章证书）→
  将 32 字节 DTBS 交给 `eid.seal.seal(org, dtbs, "SHA-256")`（`POST /seal/{orgEtsi}`，`{digest, hashType}`）→ `complete`。
  PDF 不会发送到 eID。
- **必须包含 RFC 3161 时间戳**（eID TSA，`complete.tsaUrl`）：若无法连接 TSA，则返回 `TSA_UNAVAILABLE`，绝不
  返回没有时间戳的文件；OCSP/CRL + DSS → B-LT。没有验证（QR）页——印章不会进入公民签名的
  登记（`registerSignature`），因此不提供 `/verify/{docId}` 链接。
- 验证器（`validatePdf`，CA 的 `/v3/validate/pdf`）会将此签名归类为 `certificate.usage: "seal"`——请向用户
  显示为“组织印章”。
- **可见的印章图章——`sealPdf` 的默认行为已更改**（APPEARANCE_SPEC.md §6.4，与 Go 的 `SealPDF` 相同）：
  `sealPdf` 默认让图章**可见**——位于文档最后一页（不是 eID verify 页）的右下角，220 × 64 pt
  （`x = 页面宽度 − 256`，`y = 36`；在小页面上按 `w = min(220, pw − 8)`、`h = min(64, ph − 8)` 适配），
  若与内容重叠则移到空白位置（PLACEMENT_SPEC.md）；最终位置见 `result.placement`。若图章放不进
  页面，或输出超过大小限制，则为不可见印章（没有 `placement`）。若要自行定位，使用
  `appearance: { x, y, width, height, page?, lang?, exact? }`（无效/放不下则返回 `REQUEST_INVALID`，过大则返回
  `PDF_TOO_LARGE`）。**`invisible: true`——与之前的 `sealPdf` 字节一致的不可见印章。** 直接调用 `prepare` 时：
  `prepare(pdf, { signerCert: <印章证书>, appearance })` → `eid.seal.seal` → `complete`。变体仅由证书决定（§6.1：非 CA，KeyUsage 中有 nonRepudiation 且
  没有 digitalSignature，没有 EKU 用途——extendedKeyUsage 不存在或为空）：e-Seal 证书 → 不含 QR/链接/角色的图章（名称、“eID Mongolia-аар тамгалсан” /
  "Sealed with eID Mongolia"、日期），不要求 `docId`，没有 45 pt 的最小高度（220 × 64 pt 下 f = 11）；其他证书 →
  公民图章（不变）。位置和 `suggestPlacement` 与公民相同。自本版本起 `validatePdf` 会根据证书重新生成图章
  并比对——若证书/图章不一致，则之前的签名会变为 `modified_after_signing`。**注意：**
  未实现 §6.3 的验证器（在 CA 的 `/v3/validate/pdf` 更新之前，以及本 SDK 的更早版本）会将带有印章
  图章的 revision 视为对之前签名的修改——在 CA validator 发布 §6.3 之前，不要为 RP 生成可见印章
 （`invisible: true`）。
- **带 QR 的印章图章（APPEARANCE_SPEC.md §6.5，golden v13）——仅限验证器。** 自本版本起，`validatePdf`
  也接受带 QR 的印章图章：若 e-Seal 证书的 form stream 以 `/EIDVerify` 开头，则按与公民图章相同的
  结构（QR、`/EIDVerify` BDC、URL 的 rev/docId 检查）、带有“eID Mongolia-аар тамгалсан”（“由 eID Mongolia 加盖”）标签且没有角色行的图章重新生成并比对；
  若不以其开头，则按不带 QR 的图章处理。标记（marker）决定变体——不会尝试另一种，不一致时
  之前的签名为 `modified_after_signing`。**写入方仍输出不带 QR 的图章：** `sealPdf`
  和 `prepare` 没有生成带 QR 印章的公开选项（`sealPdf` 的输出与 0.48.x 字节一致）；不带 QR 的图章
  永远有效。在 CA validator 和 `/verify` bundle 发布 §6.5 之前，任何写入方都不会输出带 QR 的印章。
- **`prepare` 的 docId（APPEARANCE_SPEC.md §6.6）：** 若已签名文档中没有 verify 页链接，则取经验证的
  **e-Seal** 签名中最早签署的 `/EIDVerify` 图章的 docId（marker 的 rev = 该签名的
  顺序，`/V` 不是间接引用，每个签名只有一个 widget，`/Filter` 不存在或直接为 `null`）；公民图章永远不会成为
  来源。若提供的 `docId` 与所找到的不同，则返回 `REQUEST_INVALID`——**即使是不可见签名也一样**（行为变更：
  对带有 QR 印章但没有 verify 页的文档，不可见签名此前会取 `opts.docId` 或 ""，现在
  会取印章的 docId）。若什么都没找到，则用 `opts.docId`，否则为 ""——绝不会为已签名文档生成随机 docId
 （需要绘制 QR 的图章此时返回 `REQUEST_INVALID`，与之前相同）。若读取印章图章时发现损坏，则返回 `PDF_INVALID`。
  对于这类文档，`sealPdf` 返回的 `docId`（而非输出字节）会成为之前带 QR 印章的 docId。
- `eid.seal.seal` 会校验响应：签名必须能用响应中的证书对 digest 验证通过，且证书必须是 e-Seal profile
 （`isSealCertificate`：KeyUsage 仅为 nonRepudiation，没有 EKU 用途——extendedKeyUsage 不存在或为空）——否则抛出 `ValidationError`。
  `hashAlgorithm`：`SHA-256`（默认）| `SHA-384` | `SHA-512`。
- 错误：`PadesError` 的 `SIGNER_INVALID`（证书不是 e-Seal，或在加盖印章期间证书已更换——重试）、
  `SIGNATURE_INVALID`、`TSA_UNAVAILABLE` / `LTV_UNAVAILABLE`（`retryable`）；RP-API 的错误保持不变：**429
  `RATE_LIMITED`** → `ApiError`（`retryable`，在 `retryAfterMs` 之后重试；每个 RP 每分钟 300 次盖章）、404——
  找不到组织、**409**——每个 code 都有自己的错误类（见下表，0.45.0）、**503
  `SEAL_SERVICE_DISABLED`** → `SealServiceDisabledError`（见下文“服务已关闭”）。
- `eid.seal.getCertificate(org)` 返回组织**当前（已签发、有效）** 的印章证书——不会
  新签发；若未签发 / 已吊销 / 不在有效期内，则返回 **409**（`SealNotIssuedError` | `SealCertRevokedError` |
  `SealCertExpiredError` | `SealCertNotYetValidError`）——绝不会以 200 返回无效证书。Go：`pades.SealPDF`；.NET：
  `EidPades.SealAsync`。

### 申请印章权限——由 RP 发起（0.47.0）

无需运营方：让组织的**首席执行官（CEO）** 通过您的系统用 eID 登录（AUTHENTICATION session），再用该
session 发送权限申请。CEO 在 eID 应用中看到 RP 的名称和组织，并用 **PIN2** 批准。不
计费；无需预先具备 `SEAL:<orgEtsi>` 权限。

```ts
import {
  ForbiddenError, AuthSessionTooOldError, AuthSessionAlreadyUsedError, SealGrantRequestError,
} from "@gerege-systems/eid-mongolia-sdk";
import { sealPdf } from "@gerege-systems/eid-mongolia-sdk/pades";

// 1. 让 CEO 登录（您的 RP 的 auth session，以 OK 结束）——保存 sessionId。
const session = await eid.auth.notificationByEtsi("PNOMN-12345678", [{ type: "displayTextAndPIN", displayText60: "登录" }]);
const result = await eid.session.waitForResult(session.sessionId, { expiresAt: session.expiresAt });
eid.validator.validateAuth(result, session.acsp!); // 登录必须为 OK

// 2. 在登录后 5 分钟内发送申请——push 只会发给该 CEO。
try {
  const g = await eid.seal.requestGrant("NTRMN-6235972", session.sessionId); // 202 {grantId, status: "PENDING", expiresAt}
  // 3. 等待 CEO 用 PIN2 批准。
  await eid.seal.waitForGrant(g.grantId, { timeoutMs: 10 * 60_000 });
  // 4. 现在 /seal/{orgEtsi} 可用。
  const sealed = await sealPdf(eid.seal, "NTRMN-6235972", pdfBytes);
} catch (e) {
  if (e instanceof ForbiddenError && e.code === "NOT_ORG_CEO") {
    // 登录的人不是经国家登记验证的该组织首席执行官
  } else if (e instanceof AuthSessionTooOldError || e instanceof AuthSessionAlreadyUsedError) {
    // 让 CEO 重新登录，并用新的 session 申请
  } else if (e instanceof SealGrantRequestError) {
    // e.outcome: "REJECTED" | "EXPIRED" | "FAILED" | "REVOKED" → 新的登录 + 申请；"TIMEOUT" → 可用相同的 grantId 继续等待
  } else throw e;
}
```

- `requestGrant(orgEtsi, sessionId)`——`POST /seal/grants` `{orgEtsi, sessionId}` → `SealGrantRequest`（`grantId`、
  `status: "PENDING"`、`expiresAt`）。`sessionId`——由您的 RP 发起、并在最近 **5 分钟**内以 OK 结束的
  AUTHENTICATION session；其对应的人必须是经国家登记验证的该组织**首席执行官（CEO）**，push
  只会发给他。**一个 session——一次申请**；用同一个 session 再次调用会返回同一个 PENDING 申请。
- `grantStatus(grantId)`——`GET /seal/grants/{grantId}`：`status` = `PENDING` | `APPROVED` | `REJECTED` | `EXPIRED` |
  `FAILED` | `REVOKED`；`approvedAt`、`revokedAt`、`failure`。仅限发起该申请的 RP（其他方得到 `SealGrantNotFoundError`）。
  权限**在被吊销之前一直有效**（CEO 在 eID 应用中吊销，或由运营方吊销 → `REVOKED`；`expiresAt` 只是批准 PENDING
  申请的期限）。
- `waitForGrant(grantId, { timeoutMs = 15 分钟, intervalMs = 3 秒, signal })`——轮询直到 APPROVED 后返回；
  REJECTED / EXPIRED / FAILED / REVOKED / 超时 → `SealGrantRequestError`（`outcome`、`grantId`、`failure`）。
  对 429/503 + Retry-After 的等待方式与 `waitForCertificate` 相同。
- `eid.organization.sealGrants(personEtsi)`——`GET /organization/seal-grants/etsi/{personEtsi}`（PKI_READ；公民在最近
  24 小时内通过您的 RP 登录过）：公民在国家登记中担任 CEO 的每个组织
 （`orgEtsi`、`orgName`、`orgStatus`）及其权限（`grants[]`：`grantId`、`rpName`、`rpDomain?`、`status`、
  `createdAt`、`decidedAt?`、`expiresAt?`、`approverName?`、`sealCount`、`sealCount30d`、`lastSealedAt`）。普通 RP 只能看到
  自己的权限。只读。
- 错误（`requestGrant`）：**400 `REQUEST_INVALID`** → `RequestInvalidError`；**403 `RP_NOT_REGISTERED` | `NOT_ORG_CEO`** →
  `ForbiddenError`（`e.code`）；**404 `AUTH_SESSION_NOT_FOUND`** → `AuthSessionNotFoundError`（另一个 RP 的 session 同样如此），
  **404 `ORG_NOT_FOUND`** → `ApiError`；**409** `AUTH_SESSION_WRONG_FLOW` / `AUTH_SESSION_NOT_COMPLETED` /
  `AUTH_SESSION_TOO_OLD` / `AUTH_SESSION_ALREADY_USED` → `AuthSessionWrongFlowError` / `AuthSessionNotCompletedError` /
  `AuthSessionTooOldError` / `AuthSessionAlreadyUsedError`；`ORG_NOT_ACTIVE` → `OrgNotActiveError`；`RP_NOT_ACTIVE` →
  `RpNotActiveError`；`SEAL_GRANT_ALREADY_APPROVED` → `SealGrantAlreadyApprovedError`；`RP_PERMISSIONS_FULL` →
  `RpPermissionsFullError`；`SEAL_APPROVER_UNAVAILABLE` → `SealApproverUnavailableError`；**429 `RATE_LIMITED`** →
  `ApiError`（`retryAfterMs`）。代码列表：`SEAL_GRANT_ERROR_CODES`。Go：`Seal.RequestGrant` / `GrantStatus` /
  `Organization.SealGrants`。

### 印章权限、密钥、有效期（0.45.0）

- **权限（`SEAL:<orgEtsi>`）——经组织同意。** **您的 RP 可以自行申请**该权限（见上文“申请印章权限”，
  0.47.0），也可以由 eID 运营方创建申请。无论哪种途径，只有在该组织**经国家登记验证**的
  CEO/ADMIN 在 eID 应用中看到 RP 的名称、域名、组织名称和注册号，并用 **PIN2** 批准之后，权限才会产生。在
  批准之前（即使被拒绝、已过期），盖章和
  证书申请（`seal`、`sealPdf`、`requestCertificate`、`getCertificateRequest`）都返回 `ForbiddenError` 403
 （`getCertificate` 不需要权限）。若运营方撤销权限或组织被注销，权限即失效（403）。在
  拥有权限期间，不能更改 RP 的名称、callback host 和 mTLS 证书 subject（运营方一侧的规则——若要更改，
  必须重新获取权限）。
- **密钥。** 印章密钥为 ECDSA P-256，是保存在 eID 服务器上的**软件密钥**（由 HSM 密钥
  包装）——**不是 QSCD**。证书级别为 `QUALIFIED`（依据蒙古国法律；没有 QcSSCD）——并非欧盟 qualified。
- **有效期、续期。** 证书有效期 3 年。续期 = 新申请（`requestCertificate`）：会生成新密钥、新
  证书，之前的证书被吊销（superseded）。用之前的证书盖章的文档，只要带有时间戳就仍然有效——
  `sealPdf` 的输出（PAdES-BASELINE-LT）满足这一点。
- **吊销。** 吊销之后，`seal` / `sealPdf` / `getCertificate` → `SealCertRevokedError`；在吊销**之前**
  盖章的文档在验证中仍然有效（`revoked_after_signing`）。
- **第三方验证器。** 证书链直至蒙古国国家 Root CA；证书中带有 OCSP / CRL 地址。除非手动信任国家 Root，
  否则 Adobe 和欧盟的验证器不会将印章显示为受信任 / qualified。

| HTTP `code` | 错误 | 位置 | 如何处理 |
|---|---|---|---|
| 409 `ORG_NOT_ACTIVE` | `OrgNotActiveError` | `seal`、`sealPdf`、`requestCertificate` | 组织不是 ACTIVE——恢复之前不要重试 |
| 409 `SEAL_NOT_ISSUED` | `SealNotIssuedError` | `seal`、`sealPdf`、`getCertificate` | 证书尚未签发——`requestCertificate` |
| 409 `SEAL_CERT_REVOKED` | `SealCertRevokedError` | `seal`、`sealPdf`、`getCertificate` | 已吊销——申请新证书 |
| 409 `SEAL_CERT_EXPIRED` | `SealCertExpiredError` | `seal`、`sealPdf`、`getCertificate` | 已过期——申请新证书 |
| 409 `SEAL_CERT_NOT_YET_VALID` | `SealCertNotYetValidError` | `seal`、`sealPdf`、`getCertificate` | 有效期尚未开始 |
| 409 `SEAL_KEY_UNAVAILABLE` | `SealKeyUnavailableError` | `seal`、`sealPdf` | 服务器配置中缺少密钥——联系 eID 支持 |
| 409 `SEAL_APPROVER_UNAVAILABLE` | `SealApproverUnavailableError` | `requestCertificate` | 没有拥有活跃 eID 的 ADMIN |
| 404 `SEAL_REQUEST_NOT_FOUND` | `SealRequestNotFoundError` | `getCertificateRequest`、`waitForCertificate` | 申请 id 错误 |
| 503 `SEAL_SERVICE_DISABLED` | `SealServiceDisabledError` | `seal`、`sealPdf`、`requestCertificate` | 运营方已关闭——不要重试 |

全部是 `ApiError` 的子类（`status`、`code`、`body` 不变；`retryable` 为 false）——原有的 `instanceof ApiError` /
`e.code` 分支仍然有效。代码列表：`SEAL_ERROR_CODES`（`SealErrorCode`）。403 → `ForbiddenError`，429
`RATE_LIMITED` → `ApiError`（`retryable`）。

```ts
import { SealCertRevokedError, SealCertExpiredError, SealNotIssuedError, OrgNotActiveError } from "@gerege-systems/eid-mongolia-sdk";

try {
  await sealPdf(eid.seal, org, pdfBytes);
} catch (e) {
  if (e instanceof SealNotIssuedError || e instanceof SealCertRevokedError || e instanceof SealCertExpiredError) {
    // 没有有效的印章证书 → eid.seal.requestCertificate(org)（组织的 ADMIN 用 PIN2 确认）
  } else if (e instanceof OrgNotActiveError) {
    // 组织已暂停 / 已吊销——不要重试
  } else throw e;
}
```

### 申请印章证书（0.43.0）

证书既不由 RP 也不由运营方直接签发——而是创建一个**申请**。组织每个有效的 **ADMIN** 代表（拥有活跃
eID 设备，≤ 5 人）会在 eID 应用中收到“同意签发“<组织>”的电子印章证书”的申请，并
用 **PIN2** 确认。只要有一位 ADMIN 确认，证书即签发（`ISSUED`）；若拒绝则为 `REJECTED`；若批准期限（签名
session 的 TTL + 2 分钟）结束则为 `EXPIRED`。

```ts
import { SealApproverUnavailableError, SealCertificateRequestError } from "@gerege-systems/eid-mongolia-sdk";

const req = await eid.seal.requestCertificate("NTRMN-6235972"); // 202 {requestId, status: "PENDING", expiresAt, approvers}
try {
  const cert = await eid.seal.waitForCertificate("NTRMN-6235972", req.requestId, { timeoutMs: 10 * 60_000 });
  // cert: {certificate (DER), serialNumber, notBefore, notAfter, certificateLevel, …} — 与 getCertificate 的形式相同
} catch (e) {
  if (e instanceof SealCertificateRequestError) {
    // e.outcome: "REJECTED" | "EXPIRED" | "FAILED" → 新的申请；"TIMEOUT" → 可用相同的 requestId 继续等待
  } else if (e instanceof SealApproverUnavailableError) {
    // （requestCertificate）该组织没有拥有有效 eID 的 ADMIN
  } else throw e;
}
```

- `requestCertificate(org)`——`POST /seal/certificate/{orgEtsi}` → `SealCertificateRequest`（`requestId`、`status:
  "PENDING"`、`createdAt`、`expiresAt`、`approvers`）。若该组织已有 PENDING 申请，CA 会返回它（不会新发 push）。
- `getCertificateRequest(org, requestId)`——`GET /seal/certificate/{orgEtsi}/requests/{requestId}`：`status` = `PENDING` |
  `APPROVED`（正在签发）| `ISSUED`（`certificate` 已填充）| `REJECTED` | `EXPIRED` | `FAILED`（`failure`：
  `SEAL_ISSUANCE_FAILED` | `PUSH_FAILED` | `SEAL_SERVICE_DISABLED`）。一次性查询（用于您自己的 UI poll）。
- `waitForCertificate(org, requestId, { timeoutMs = 15 分钟, intervalMs = 3 秒, signal })`——轮询直到 ISSUED 并返回
  证书；REJECTED / EXPIRED / FAILED / 超时 → `SealCertificateRequestError`（`outcome`、`requestId`、
  `failure`）。遇到 429/503 + Retry-After（`ApiError.retryable`）时——等待 Retry-After 后继续；`signal` 中止时
  抛出 `signal.reason`。
- 错误：**409 `SEAL_APPROVER_UNAVAILABLE`** → `SealApproverUnavailableError`；**409 `ORG_NOT_ACTIVE`** →
  `OrgNotActiveError`（0.45.0；此前为不带 code 的 409）——组织不是 ACTIVE；
  **404 `SEAL_REQUEST_NOT_FOUND`** → `SealRequestNotFoundError`（另一个组织的 id 同样如此）；403 → `ForbiddenError`
 （没有 `SEAL:<orgEtsi>` 权限）；**429 `RATE_LIMITED`** → `ApiError`（`retryAfterMs`）——每个组织每小时 5 次申请（防止
  PIN2 push 骚扰）。申请状态的 poll 不计入限额；**503 `SEAL_SERVICE_DISABLED`** →
  `SealServiceDisabledError`（见下文）。

### 服务已关闭——`SealServiceDisabledError`（503 `SEAL_SERVICE_DISABLED`）

eID 运营方可以在整个平台范围内分别关闭印章的两项服务。关闭时，CA 返回
`503 {"error", "code": "SEAL_SERVICE_DISABLED", "service"}`（不带 Retry-After）——SDK 抛出 `SealServiceDisabledError`
（`ApiError` 的子类；`status: 503`、`code`、`service`）：

| `service` | 位置 | 含义 |
|---|---|---|
| `"issuance"` | `eid.seal.requestCertificate` | 证书签发已关闭——不接受新的申请 |
| `"sealing"` | `eid.seal.seal`、`sealPdf` | 盖章已关闭 |

```ts
import { SealServiceDisabledError } from "@gerege-systems/eid-mongolia-sdk";

try {
  await sealPdf(eid.seal, "NTRMN-6235972", pdfBytes);
} catch (e) {
  if (e instanceof SealServiceDisabledError) {
    // e.service: "issuance" | "sealing" | undefined — 向用户显示“服务暂时关闭”；不要自动重试
  } else throw e;
}
```

- `retryable` 始终为 `false`：由于 CA 不会告知何时恢复，SDK（`sealPdf`、`waitForCertificate`）不会重试，而是
  直接抛出。其他 503（如 `STATE_UNAVAILABLE` + Retry-After）仍是 `ApiError`（`retryable`）。
- 若待处理的申请已被 ADMIN 批准但签发已关闭，则申请变为 `FAILED`，`failure: "SEAL_SERVICE_DISABLED"`
 （不会签发证书）——`waitForCertificate` → `SealCertificateRequestError`（`outcome: "FAILED"`、`failure`）；签发
  恢复后请创建新的申请。
- 永远不会关闭的：`getCertificate`、`getCertificateRequest` / `waitForCertificate` 的 poll、验证
 （`validatePdf`、CA 的 `/v3/validate/*`）、OCSP/CRL——此前盖章的文档仍然有效。
- 实时状态：[`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid) 的 `seal` 块——`{issuanceEnabled,
  sealingEnabled, disabledCode: "SEAL_SERVICE_DISABLED"}`。
- `certificateLevel`（`getCertificate`、`seal` 的响应）取自证书本身：有 QcSSCD 则为 `QSCD`，否则为
  `QUALIFIED`。

## 4. QR 与同设备——device link v3

公民用手机扫描另一台设备屏幕上的 **QR**，或者，如果在与 eID 应用**同一部手机**上打开了 RP 的网站/应用，则通过按钮
打开应用（**Web2App**——手机浏览器，**App2App**——RP 的应用）。链接
只能由 RP 后端通过 `buildDeviceLink` 生成（Smart-ID RP-API v3 “dynamic link”）：

```
QR:      {deviceLinkBase}?deviceLinkType=QR&elapsedSeconds={E}&sessionToken={T}&sessionType=auth&version=1.0&lang=mon&authCode={A}
Web2App: {deviceLinkBase}?deviceLinkType=Web2App&sessionToken={T}&sessionType=auth&version=1.0&lang=mon&authCode={A}
```

- `authCode = BASE64URL(HMAC-SHA256(sessionSecret, …))`——保护链接类型、session、RP 的 challenge 和 callback。
  服务器将类型绑定到 session，签名的 `flowType` = 该类型（无法伪造）。
- **QR 每秒刷新**（`elapsedSeconds = floor(now − receivedAt)`）；服务器会拒绝超过约 20 秒的 QR
  → 通过短信/即时通讯转发的链接将无法使用。
- `sessionToken` 和 **`sessionSecret` 只保存在后端**——绝不要发送给浏览器/应用。
  浏览器每秒从后端 endpoint 获取现成的 QR 链接。
- 若要在同一页面同时显示 QR 和按钮，请发起同一个 session（带 `callbackUrl`），并生成两个链接。
  Web2App/App2App 仅对带 `callbackUrl` 的 session 有效。
- 合约：[developer.eidmongolia.mn](https://developer.eidmongolia.mn/) 以及 ca-eidmongolia-mn 的 `docs/DEVICE_LINK_V3.md`。

```ts
import { buildDeviceLink, type DeviceLinkSession } from "@gerege-systems/eid-mongolia-sdk";

// 后端——发起 session，并将完整响应保存在服务器上 (sessionToken/sessionSecret/receivedAt/acsp)
const s = await eid.auth.deviceLinkAnonymous(
  [{ type: "displayTextAndPIN", displayText60: "登录汗银行" }],
  { callbackUrl: "https://bank.example.mn/auth/eid/callback?state=…" }, // 如需显示按钮；host 必须在 callbackHosts 中，
  // 路径始终会被规范化为 /auth/eid/callback（仅保留 query），必须使用 https
);
store.put(s.sessionId, s);
res.json({ sessionId: s.sessionId, vc: s.vc }); // 只有这些会发送给浏览器

const link = (s: DeviceLinkSession, type: "QR" | "Web2App" | "App2App") =>
  buildDeviceLink({
    deviceLinkBase: s.deviceLinkBase!,
    deviceLinkType: type,
    sessionToken: s.sessionToken!,
    sessionSecret: s.sessionSecret!,
    sessionType: "auth",
    lang: "mon",
    receivedAt: s.receivedAt, // SDK 会记录收到响应的时刻
    rpChallenge: s.acsp!.rpChallenge,
    relyingPartyName: s.acsp!.relyingPartyName,
    interactions: s.acsp!.interactions,
    initialCallbackUrl: s.acsp!.initialCallbackUrl, // 对 QR 而言不参与 authCode
  });

// GET /eid/qr?sessionId=…  → 浏览器每秒调用一次并重新绘制 QR (Cache-Control: no-store)
app.get("/eid/qr", (req, res) => {
  const s = store.get(String(req.query.sessionId)); // 检查它是否属于调用者自己的浏览器 session
  if (!s) return res.sendStatus(404);
  res.set("Cache-Control", "no-store").json({ link: link(s, "QR") });
});
// 手机端：按钮的 href = link(s, "Web2App")（一次性，无需刷新）
```

若通过 SSE/WebSocket 推送，请使用 `qrDeviceLinkTicker(input, (link) => send(link))`——它会立即发出一个链接，之后每秒
发出一个，并通过返回的函数停止（在 session 结束/客户端断开时必须调用）。

**务必核对您所展示的类型（防中继）。** `expectedFlowType` = RP 所展示链接的类型：

```ts
// QR 页面 → 通过轮询完成的结果
eid.validator.validateAuth(result, s.acsp!, { expectedFlowType: "QR" });

// Web2App/App2App 按钮 → 应用会在 callback URL 中附加 `userChallengeVerifier` 后返回
eid.validator.validateAuth(result, s.acsp!, {
  expectedFlowType: "Web2App", // 若按钮位于 RP 的应用内，则为 "App2App"
  userChallengeVerifier: callbackQuery.get("userChallengeVerifier") ?? undefined,
});
// push (notificationBy*) → "Notification"
```

在同时显示 QR 和按钮的页面上：通过 callback 到达的结果按 `Web2App`/`App2App` 核对，通过 poll 到达的结果按
`QR` 核对（通过按钮打开的 session 只会经由 callback 结束）。

> ⚠️ **旧版链接已移除。** 服务器已于 2026-10-07 移除静态的 `{deviceLinkBase}?sessionId=…&vc=…` 链接，
> 而生成它的 `deviceLink` / `openOrShowQR` 已在 SDK 0.16.0 中移除——只有 v3（`buildDeviceLink`）可用。
> v3（`flowType`、`userChallengeVerifier`）自 iOS 2.2.3 (59) / Android 60 起支持；截至 2026-10-20，服务器强制的最低版本为 iOS ≥ 2.2.8、Android ≥ 91
>（`/mobile/app-config`，§“eID 应用的最低版本”）。

## 安全性——为什么必须使用 `validator`

**不要单凭** `endResult === "OK"` **就信任结果**。若 RP-API 被破坏/被代理，可能会收到伪造的
OK。因此 `ResponseValidator` 会：

1. 检查 `state === COMPLETE && endResult === OK`
2. 沿证书链将公民证书一直验证到 **trust anchor（Mongolian National Root CA）**
  （Root → National Issuing CA → Gerege Issuing CA → eID Mongolia Issuing CA → 公民）——RFC 5280 路径验证
 （与 Go SDK 的 `x509.Certificate.Verify` 规则相同）：颁发者名称 + AKI/SKI + 签名、CA basicConstraints +
   **pathLenConstraint**（04 为 `pathlen:0`）、CA 的 keyUsage keyCertSign、每个 CA 的有效期、**EKU**（auth →
   clientAuth，sign → emailProtection——CA 的 profile；若 CA 有 EKU，则必须落在其范围内）、无法识别的 **critical
   extension** → 拒绝。若链中出现带 **name constraints** 的 CA，则 fail-closed（CA 的实际证书链中没有）。
   响应中不携带证书链——若未提供 `intermediatesPem`，则使用 SDK 内置的 02、03、04（`CITIZEN_INTERMEDIATES_PEM`，
   自 0.19.0 起）。不检查链中的 certificatePolicies（检查的是级别——第 3 步）。
3. 证书在有效期内 + 满足所需的 `certificateLevel`（默认 `QUALIFIED`）。**自 0.19.0 起，级别由
   证书本身确定**（`certificateLevelOf`）：对签名证书，qcStatements 的 QcCompliance → QUALIFIED
   （+ QcSSCD → QSCD；手机以及 2026-11-06 之后签发的 USB 令牌为 QUALIFIED），没有 qcStatements（此前签发的
   令牌）→ ADVANCED；对认证证书，由于 CA 不写入 qcStatements，因此按 profile 判定 → QUALIFIED：KeyUsage
   keyEncipherment（手机的 P-CITIZEN-AUTH），或 EKU clientAuth + emailProtection 且带国家 policy
   `2.16.496.1.101.1.2.8`（令牌的 P-CITIZEN-AUTH-TOKEN，自 0.40.3 起）；其余 → ADVANCED。若响应中的 `certificateLevel`
   高于该值则拒绝；低于该值则采用响应中的值（CA 将旧令牌的 AUTH 声明为 ADVANCED）。返回的
   `certificateLevel` = 此值。
4. 用公民的公钥验证签名：
   - **auth** → 针对 ACSP_V2 payload（`smart-id|ACSP_V2|serverRandom|rpChallenge|userChallenge|B64(rpName)|B64(brokeredRpName)|B64(SHA-256(interactions))|interactionTypeUsed|initialCallbackUrl|flowType`，hash = 请求的 `hashAlgorithm`）——同时检查 `flowType`、`userChallenge`、`serverRandom` 以及算法降级；
     若提供了 `expectedFlowType`，则 `flowType` 必须与所发起的流程完全一致，Web2App/App2App 必须提供 `userChallengeVerifier`；
     `initialCallbackUrl` 取自响应的 `signature.initialCallbackUrl`（CA 按流程决定：QR/Notification →
     `""`，Web2App/App2App → 您的 callback）——仅当其为 `""` 或
     您发送的 callback 时才接受，Web2App/App2App 必须是您的 callback；其他值 → 拒绝
   - **sign** → 针对 RP 提供的 digest；若提供了 `expectedFlowType`，响应的 `flowType` 必须完全一致（它不属于签名内容——是对响应的核对）
   - 算法与证书密钥绑定：`ecdsa-with-SHA256` 仅限 EC P-256 密钥，RSA 算法仅限
     RSA 密钥（防算法混淆）。Hash 始终与请求的完全相等。CA 上 RP-API session 的签名来自
     SplitKey RSA（当前所有手机证书）或旧的 threshold ECDSA P-256；ECDSA credential
     只对 SHA-256 digest 签名（若请求了其他 hash，服务器不会出具签名），因此如果请求了
     SHA-384/512 的 session 收到 `ecdsa-with-SHA256` 响应，则视为伪造而拒绝。

5. 吊销——`trust.revocation`（OCSP/CRL hook）→ `checkRevocation`，或 `checkRevocationStatus`（`"good"` /
   `"unchecked"`（soft-fail）/ `"skipped"`（没有 hook））。现成的 hook：`ocspRevocationChecker()`——证书 AIA 中的 OCSP
  （revoked/unknown → `"revoked"`；无响应 → `"unknown"`，由模式决定）。若要用其他 checker/模式做一次性检查：`checkRevocationWith`。
6. **颁发者与用途（0.19.0 起的默认值）：** `allowedIssuerSkis` 默认为 `[CITIZEN_ISSUING_CA_SKI]`（配置了 trust anchor
   时）——只接受公民 Issuing CA（04）的证书（同一 root 之下组织的 05 等会被拦截；
   关闭方式：`allowAnyIssuer: true`）；`checkKeyUsage` 默认为 `true`——auth → KU digitalSignature + EKU clientAuth，
   sign → KU nonRepudiation（CA 的 profile）——认证（PIN1）密钥所产生的签名不符合 `validateSign` 的要求
  （关闭方式：`checkKeyUsage: false`，不推荐）。`schemeName`——CA 的 `acsp_scheme_name`（默认 `smart-id`）。

任何一步失败都会抛出 `ValidationError`——**不要信任**该响应。错误文本中不会包含公民的姓名、PNOMN、注册号
（`NetworkError.op` 会将路径改写为 `/etsi/…`）——可以直接写入日志。

## 错误类型

| 错误 | 含义 |
|---|---|
| `AuthenticationError` | 401——API secret 错误/缺失；若为 CA 的 JSON 则有 `.serverMessage`（+ `.code`），若为 proxy 的则没有（`.body`、`.headers`） |
| `ForbiddenError` | 403——IP allowlist / mTLS / RP 的权限；onBehalfOf 被拒绝时有 `.code`（`OnBehalfErrorCode`） |
| `SessionFailedError` | endResult ≠ OK（TIMEOUT、USER_REFUSED……）——通过 `.endResult` 区分 |
| `ValidationError` | cert chain/signature/level 验证失败 |
| `NoSigningCertificateError` | 409 `NO_SIGNING_CERTIFICATE`——没有签名证书 / 设备（sign、cert-choice start）；`ApiError` 的子类 |
| `CertChoiceInvalidError` | 409 `CERT_CHOICE_INVALID`——linked sign 的 certificate-choice 无效；`ApiError` 的子类 |
| `RequestInvalidError` | 400 `REQUEST_INVALID`——请求有误（如缺少 `linkedSessionID`）；`ApiError` 的子类 |
| `ShareError` | `share()` 的 4xx/5xx（401/403 除外）——`.code`（`ShareErrorCode`）、`.reason`（422）、`.sent`/`.failed`/`.recipients`（502）；`ApiError` 的子类 |
| `ApiError` | 其他 HTTP 错误（`.status`、`.body`、服务器的 `.code`、`.retryAfterMs`、`.headers`、`.retryable`——如 404 `ORG_NOT_FOUND`） |
| `ResponseTooLargeError` | 响应超过 SDK 限制（JSON 4 MiB）——`.op`、`.limit` |
| `NetworkError` | 超时/网络（`.op`——不含标识信息的路径，`.timeout`） |
| `PadesError`（`/pades`） | 客户端 PAdES——`.code`（§3d）、`.retryable` |
| `DeviceLinkError` | 无法生成 device-link 链接（`deviceLinkBase` 不是 https、token/secret/lang 的格式错误、缺少该类型所需的字段） |

## mTLS（eIDAS qualified 环境）

```ts
import { Agent } from "undici";
const eid = new EidClient({
  /* … */
  dispatcher: new Agent({ connect: { cert: clientCertPem, key: clientKeyPem } }),
});
```

## 开发

```bash
npm install
npm run lint          # tsc --noEmit (主配置 + tsconfig.button.json)
npm test              # build + node --test (pades golden——与 Go reference 字节一致)
npm run golden:check  # test/fixtures/pades/golden + src/pades/assets ↔ 固定的 Go commit
npm run size:pades    # /pades 浏览器 bundle 的 gzip ≤ 300 KB
npm run test:convert-e2e   # /convert 在 Chromium 中使用真实的 LibreOffice（BROWSER=webkit——WebKit）
```

`/pades` 的 conformance fixture（golden：输入、测试 PKI 的证书、TSA/OCSP/CRL 的固定响应、预期的
sha256）以及字体/证书链 asset，由 `node scripts/sync-pades-golden.mjs` 从 Go reference 复制（`GO_SDK_COMMIT`——
tag `pades-golden-vN`，当前为 v7——包含 `placement/` scanner vectors，page 0 会跳过 verify 页，`exact` +
`expect.suggestion`）；CI 通过 `--check` 与固定的 commit 比对。Profile：
Go 仓库的 `pades/PROFILE.md`、`PAGE_SPEC.md`、`PRECHECKS.md`、`WIRE.md`、`APPEARANCE_SPEC.md`、`PLACEMENT_SPEC.md`。

### 合约检查

SDK 调用的每一个 RP-API 路径（`src/contract.ts`）都必须出现在线上 [`/.well-known/eid`](https://rp.eidmongolia.mn/.well-known/eid) 的
`endpoints` 中。Discovery 中存在但 SDK 未覆盖的路径只给出 WARN（不算失败）。由于需要网络，它不包含在 `npm test` 中：

```bash
npm run test:contract
```

CI：`.github/workflows/contract.yml`——PR、`main` push、每天 00:00 UTC、手动触发。
