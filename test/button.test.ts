// <eid-login-button> — jsdom дээрх төлөвүүд: QR цонх, push, амжилт (event + redirect), татгалзсан, хугацаа дууссан,
// сүлжээ тасарсан, утсан дээр Web2App навигаци, Esc / focus.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://bank.example.mn/login" });
const w = dom.window as unknown as Record<string, unknown>;
for (const k of ["window", "document", "HTMLElement", "customElements", "CustomEvent", "Node", "KeyboardEvent", "location", "navigator", "MutationObserver"]) {
  Object.defineProperty(globalThis, k, { value: k === "window" ? dom.window : w[k], configurable: true, writable: true });
}

type Status = Record<string, unknown>;
let startReplies: Array<{ status: number; body: Status; headers?: Record<string, string> } | "neterr"> = [];
let statusReplies: Array<Status | "neterr"> = [];
let requests: { url: string; method: string; body?: unknown }[] = [];

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (String(url).includes("/start")) {
    const r = startReplies.shift() ?? { status: 500, body: {} };
    if (r === "neterr") throw new TypeError("network");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", ...r.headers } });
  }
  const s = statusReplies.shift() ?? { state: "PENDING" };
  if (s === "neterr") throw new TypeError("network");
  return new Response(JSON.stringify(s), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const { EidLoginButton, mountEidLoginButton, resolveEidTheme } = await import("../dist/button.js");

const QR = "https://ca.eidmongolia.mn/dl?deviceLinkType=QR&elapsedSeconds=0&sessionToken=t&sessionType=auth&version=1.0&lang=mon&authCode=x";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("хүлээлт дууслаа");
    await tick(10);
  }
}

function make(attrs: Record<string, string> = {}, mobile = false) {
  document.body.replaceChildren();
  const b = mountEidLoginButton(document.body, { startUrl: "/auth/eid/start", statusUrl: "/auth/eid/status", lang: "mn", ...attrs });
  const navs: string[] = [];
  b.isMobile = () => mobile;
  b.navigate = (u: string) => navs.push(u);
  const sr = b.shadowRoot!;
  const text = () => sr.textContent ?? "";
  return { b, sr, navs, text, click: () => (sr.querySelector("button.trigger") as HTMLButtonElement).click() };
}

beforeEach(() => {
  startReplies = [];
  statusReplies = [];
  requests = [];
});

test("товч: брэнд лого + текст, aria-haspopup; lang=en", () => {
  const { sr, b } = make();
  const btn = sr.querySelector("button.trigger")!;
  assert.equal(btn.getAttribute("aria-haspopup"), "dialog");
  const logo = btn.querySelector("svg.logo")!;
  assert.equal(logo.getAttribute("viewBox"), "0 0 3840 1372");
  assert.equal(logo.getAttribute("aria-hidden"), "true");
  assert.ok((logo.querySelector("path")!.getAttribute("d") ?? "").length > 1000);
  assert.equal(btn.querySelector("img"), null, "inline SVG — data URI зураг үгүй");
  assert.equal(btn.getAttribute("aria-label"), "eID-ээр нэвтрэх", "уншигчийн нэр бүтэн, зайгүй");
  // Лого «e-ID» гэж бичигддэг — харагдах текстэд «eID» давтагдахгүй: [лого]-ээр нэвтрэх.
  const visible = () => Array.from(btn.querySelectorAll(".brand > span")).map((n) => n.textContent).join("|");
  assert.equal(visible(), "-ээр нэвтрэх");
  assert.equal(btn.querySelector(".brand")!.firstElementChild!.tagName.toLowerCase(), "svg", "лого эхэнд");
  b.setAttribute("lang", "en");
  assert.equal(btn.getAttribute("aria-label"), "Log in with eID");
  assert.equal(visible(), "Log in with ");
  assert.equal(btn.querySelector(".brand")!.lastElementChild!.tagName.toLowerCase(), "svg", "en: лого төгсгөлд");
  assert.ok(b instanceof EidLoginButton);
});

test("товч: label атрибут (шууд шинэчлэгдэнэ), анхдагч i18n; part=button/icon/label", () => {
  const { sr, b } = make();
  const btn = sr.querySelector("button.trigger")!;
  assert.equal(btn.getAttribute("part"), "button");
  assert.equal(btn.querySelector("svg.logo")!.getAttribute("part"), "icon");
  assert.equal(btn.querySelector("span[part=label]")!.textContent, "-ээр нэвтрэх");
  assert.equal(btn.getAttribute("aria-label"), "eID-ээр нэвтрэх", "лого + анхдагч текст → бүтэн нэр");
  b.setAttribute("label", "Нэвтрэх");
  assert.equal(btn.textContent, "Нэвтрэх");
  assert.equal(btn.hasAttribute("aria-label"), false, "өөрийн label → aria-label үгүй");
  b.setAttribute("lang", "en");
  assert.equal(btn.textContent, "Нэвтрэх", "label нь lang-аас давуу");
  b.removeAttribute("label");
  assert.equal(btn.getAttribute("aria-label"), "Log in with eID");
  const m = make({ label: "Sign in" } as Record<string, string>);
  assert.equal(m.sr.querySelector("button.trigger")!.textContent, "Sign in");
});

test("товч: icon=none → лого үгүй; icon=eid буцаана", () => {
  const { sr, b } = make({ icon: "none" } as Record<string, string>);
  const btn = sr.querySelector("button.trigger")!;
  assert.equal(btn.querySelector("svg[part=icon]"), null);
  assert.equal(btn.textContent, "eID-ээр нэвтрэх");
  b.setAttribute("icon", "eid");
  assert.ok(btn.querySelector("svg[part=icon]"));
});

test("товч: variant=icon / label=\"\" → зөвхөн лого, дөрвөлжин, aria-label = i18n / label / хостын aria-label", () => {
  const { sr, b } = make({ variant: "icon" } as Record<string, string>);
  const btn = sr.querySelector("button.trigger")!;
  assert.equal(btn.querySelector("span"), null);
  assert.ok(btn.querySelector("svg[part=icon]"));
  assert.ok(btn.classList.contains("icon-only"));
  assert.equal(btn.getAttribute("aria-label"), "eID-ээр нэвтрэх");
  b.setAttribute("lang", "en");
  assert.equal(btn.getAttribute("aria-label"), "Log in with eID");
  b.setAttribute("label", "Sign in");
  assert.equal(btn.getAttribute("aria-label"), "Sign in");
  b.setAttribute("aria-label", "Нэвтрэх (eID)");
  assert.equal(btn.getAttribute("aria-label"), "Нэвтрэх (eID)");
  b.removeAttribute("aria-label");
  b.removeAttribute("variant");
  assert.equal(btn.textContent, "Sign in");
  assert.equal(btn.hasAttribute("aria-label"), false);
  assert.equal(btn.classList.contains("icon-only"), false);
  b.setAttribute("label", "");
  assert.equal(btn.querySelector("span"), null);
  assert.equal(btn.getAttribute("aria-label"), "Log in with eID");
  const css = [...sr.querySelectorAll("style")].map((x) => x.textContent ?? "").join("\n");
  assert.match(css, /\.trigger\.icon-only \{ width: 44px; height: 44px; padding: 0; \}/);
});

test("товч: icon=none + текстгүй → анхдагч текст (хоосон товч үгүй), console.warn нэг удаа", () => {
  const warns: unknown[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a);
  try {
    const { sr, b } = make({ icon: "none", label: "" } as Record<string, string>);
    const btn = sr.querySelector("button.trigger")!;
    assert.equal(btn.querySelector("svg[part=icon]"), null);
    assert.equal(btn.textContent, "eID-ээр нэвтрэх");
    assert.equal(btn.classList.contains("icon-only"), false);
    b.setAttribute("variant", "icon");
    b.setAttribute("lang", "en");
    assert.equal(btn.textContent, "Log in with eID");
    assert.equal(warns.length, 1);
  } finally {
    console.warn = orig;
  }
});

test("mountEidLoginButton: label / icon / variant атрибут болно", () => {
  const { b } = make({ label: "", icon: "eid", variant: "icon" } as Record<string, string>);
  assert.equal(b.getAttribute("label"), "");
  assert.equal(b.getAttribute("icon"), "eid");
  assert.equal(b.getAttribute("variant"), "icon");
});

test("фонт: `font: … inherit` (хүчингүй shorthand) үгүй; button/input хуудасны фонтыг өвлөнө, хэмжээ тодорхой", () => {
  const { sr } = make();
  const css = [...sr.querySelectorAll("style")].map((x) => x.textContent ?? "").join("\n");
  // jsdom-ийн CSSOM shorthand-ийн хүчинтэй эсэхийг шалгадаггүй тул эх текстээр тулгана.
  assert.doesNotMatch(css, /\bfont\s*:[^;}]*\binherit\b/, "font shorthand-д inherit орвол бүх мөр хүчингүй");
  assert.match(css, /button, input \{ font-family: inherit; \}/);
  const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(/[.*]/g, "\\$&")} \\{[^}]*font-family: inherit;[^}]*font-size: 1rem;`);
  assert.match(css, rule(".btn"));
  assert.match(css, rule(".field input"));
});

test("theme: light|dark атрибут; auto → html[data-theme] / html.dark / OS-ийг дагана (MutationObserver)", async () => {
  const html = document.documentElement;
  const darkOn = (sr: ShadowRoot) => (sr.querySelector('style[data-eid-theme="dark"]')!.textContent ?? "").includes("color-scheme: dark");
  const { b, sr } = make();
  assert.equal(b.scheme, "light");
  assert.equal(darkOn(sr), false);
  html.setAttribute("data-theme", "dark");
  await tick(0);
  assert.equal(darkOn(sr), true, "data-theme=dark");
  html.removeAttribute("data-theme");
  html.classList.add("dark");
  await tick(0);
  assert.equal(darkOn(sr), true, "html.dark");
  b.setAttribute("theme", "light");
  assert.equal(darkOn(sr), false, "theme=light нь хуудсыг давна");
  html.classList.remove("dark");
  b.setAttribute("theme", "dark");
  assert.equal(darkOn(sr), true);
  b.setAttribute("theme", "auto");
  assert.equal(darkOn(sr), false);
  // OS (prefers-color-scheme) — html-д тэмдэг байхгүй үед.
  const fakeDoc = { documentElement: html, defaultView: { matchMedia: () => ({ matches: true }) } } as unknown as Document;
  assert.equal(resolveEidTheme("auto", fakeDoc), "dark");
  assert.equal(resolveEidTheme(null, fakeDoc), "dark");
  html.setAttribute("data-theme", "light");
  assert.equal(resolveEidTheme("auto", fakeDoc), "light", "хуудасны data-theme OS-ийг давна");
  html.removeAttribute("data-theme");
  // Салгахад observer зогсоно.
  b.remove();
  html.classList.add("dark");
  await tick(0);
  assert.equal(darkOn(sr), false);
  html.classList.remove("dark");
});

test("mountEidLoginButton: theme сонголт атрибут болно", () => {
  document.body.replaceChildren();
  const b = mountEidLoginButton(document.body, { startUrl: "/s", statusUrl: "/t", theme: "dark" });
  assert.equal(b.getAttribute("theme"), "dark");
  assert.equal(b.scheme, "dark");
});

test("токен: --eid-* хоёр theme-д (хуудасны аль ч түвшнээс), --eid-*-dark зөвхөн dark-д; анхдагч нь fallback", () => {
  const { sr, b } = make({ theme: "light" });
  const base = sr.querySelector("style:not([data-eid-theme])")!.textContent ?? "";
  const dark = () => sr.querySelector('style[data-eid-theme="dark"]')!.textContent ?? "";
  const names = ["bg", "bg-subtle", "bg-muted", "fg", "fg-muted", "fg-subtle", "border", "border-strong", "accent", "accent-fg",
    "accent-subtle", "accent-subtle-fg", "ring", "warning-bg", "warning-border", "warning-fg", "danger-fg"];
  // Нийтийн --eid-* shadow дотор ТОДОРХОЙЛОГДОХГҮЙ (тэгвэл :root/эцгийн утга өвлөгдөхгүй) — зөвхөн var()-аар уншина.
  assert.doesNotMatch(base, /(^|[\s;{])--eid-[a-z-]+\s*:/);
  for (const n of names) assert.ok(base.includes(`--_eid-${n}: var(--eid-${n}, `), `light ${n}`);
  assert.match(base, /--_eid-accent: var\(--eid-accent, oklch\(0\.534 0\.2 259\)\);/);
  assert.match(base, /--_eid-radius: var\(--eid-radius, 6px\); --_eid-radius-lg: var\(--eid-radius-lg, 8px\);/);
  assert.match(base, /\.btn-primary \{ background: var\(--_eid-accent\); color: var\(--_eid-accent-fg\); \}/);
  assert.equal(dark(), "");
  b.setAttribute("theme", "dark");
  assert.doesNotMatch(dark(), /(^|[\s;{])--eid-[a-z-]+\s*:/);
  for (const n of names) assert.ok(dark().includes(`--_eid-${n}: var(--eid-${n}-dark, var(--eid-${n}, `), `dark ${n}`);
  assert.match(dark(), /--_eid-accent: var\(--eid-accent-dark, var\(--eid-accent, oklch\(0\.64 0\.15 259\)\)\);/);
  assert.doesNotMatch(dark(), /^[^]*:\s*oklch\(0\.64 0\.15 259\);/m, "dark accent хатуу утгаар тодорхойлогдохгүй");
});

test("desktop: ачаалж байна → QR (svg) + VC + алхмууд → OK: event + redirect", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "12345", expiresIn: 120 } }];
  statusReplies = [{ state: "PENDING", qr: QR, expiresIn: 119 }, { state: "OK", redirect: "/dashboard", data: { u: 1 } }];
  const { sr, navs, text, click, b } = make();
  const events: unknown[] = [];
  b.addEventListener("eid-login-success", (e: Event) => events.push((e as CustomEvent).detail));
  click();
  const dlg = sr.querySelector('[role="dialog"]')!;
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  const h2 = sr.querySelector("#eid-title")!;
  assert.equal(dlg.getAttribute("aria-labelledby"), "eid-title");
  assert.equal(h2.getAttribute("aria-label"), "eID-ээр нэвтрэх", "нэр бүтэн, зайгүй");
  assert.ok(h2.querySelector(".brand > svg.logo"), "лого гарчиг дотор");
  assert.equal(h2.querySelector(".brand > span")!.textContent, "-ээр нэвтрэх");
  assert.match(text(), /Ачаалж байна/);
  await until(() => !!sr.querySelector(".qr svg path"));
  assert.match(text(), /Баталгаажуулах код/);
  assert.equal(sr.querySelector(".qr-vc .vc")!.textContent, "12345");
  assert.match(sr.querySelector(".meta")!.textContent!, /^Хүсэлтийн хугацаа: \d:\d\d$/);
  assert.match(text(), /PIN1 кодоо оруулна/);
  assert.deepEqual(requests[0], { url: "/auth/eid/start", method: "POST", body: { mode: "qr", lang: "mn" } });
  await until(() => navs.length > 0, 5000);
  assert.deepEqual(navs, ["/dashboard"]);
  assert.deepEqual(events, [{ state: "OK", redirect: "/dashboard", data: { u: 1 } }]);
  assert.match(text(), /Амжилттай нэвтэрлээ/);
  b.close();
});

test("success event preventDefault → redirect хийхгүй", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } }];
  statusReplies = [{ state: "OK", redirect: "/x" }];
  const { navs, click, b, text } = make();
  b.addEventListener("eid-login-success", (e: Event) => e.preventDefault());
  click();
  await until(() => /Амжилттай/.test(text()), 5000);
  await tick(20);
  assert.deepEqual(navs, []);
  b.close();
});

test("push: регистр шалгалт (латин, хоосон) → илгээх → том VC → татгалзсан → дахин оролдох", async () => {
  startReplies = [
    { status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } },
    { status: 200, body: { mode: "push", vc: "54321", expiresIn: 120 } },
  ];
  statusReplies = [{ state: "PENDING", qr: QR }];
  const { sr, text, click, b } = make();
  const errs: string[] = [];
  b.addEventListener("eid-login-error", (e: Event) => errs.push((e as CustomEvent).detail.error));
  click();
  await until(() => !!sr.querySelector("form"));
  const form = sr.querySelector("form")!;
  const input = sr.querySelector("input")! as HTMLInputElement;
  form.dispatchEvent(new (dom.window.Event)("submit", { cancelable: true }));
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.match(text(), /Регистрийн дугаар оруулна уу/);
  input.value = "UB12345678";
  form.dispatchEvent(new (dom.window.Event)("submit", { cancelable: true }));
  assert.match(text(), /кириллээр/);
  input.value = "уб 12345678";
  statusReplies = [{ state: "FAILED", error: "USER_REFUSED_DISPLAYTEXTANDPIN" }];
  form.dispatchEvent(new (dom.window.Event)("submit", { cancelable: true }));
  await until(() => !sr.querySelector(".qr"));
  assert.equal(sr.querySelector(".vc")!.textContent, "54321");
  assert.match(sr.querySelector(".meta")!.textContent!, /^Хүсэлтийн хугацаа: \d:\d\d$/);
  assert.deepEqual(requests.find((r) => (r.body as { mode?: string })?.mode === "push")!.body, { mode: "push", idCode: "УБ12345678", lang: "mn" });
  await until(() => /татгалзсан/.test(text()), 5000);
  assert.deepEqual(errs, ["USER_REFUSED_DISPLAYTEXTANDPIN"]);
  assert.ok(sr.querySelector(".end button"), "дахин оролдох товч");
  b.close();
});

test("push хэсэг: «Регистрийн дугаараар нэвтрэх» товч → ижил цонхонд дэлгэгдэнэ (aria-expanded, focus input) → дахин дарахад хураагдана; QR хэвээр", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "12345", expiresIn: 120 } }];
  const { sr, b } = make();
  (sr.querySelector("button.trigger") as HTMLButtonElement).click();
  await until(() => !!sr.querySelector(".disc-btn"));
  const toggle = sr.querySelector(".disc-btn") as HTMLButtonElement;
  const disc = sr.getElementById("eid-push")!;
  const inner = disc.firstElementChild!;
  assert.equal(toggle.textContent, "Регистрийн дугаараар нэвтрэх");
  assert.equal(toggle.getAttribute("aria-controls"), "eid-push");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(inner.hasAttribute("inert"), "хураасан үед input-д focus очихгүй");
  assert.ok(!disc.classList.contains("open"));
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(disc.classList.contains("open"));
  assert.ok(!inner.hasAttribute("inert"));
  assert.equal(sr.activeElement, sr.querySelector("#eid-id"));
  assert.ok(sr.querySelector(".qr svg path"), "QR харагдсаар");
  assert.equal(sr.querySelector(".qr-vc .vc")!.textContent, "12345");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(!disc.classList.contains("open"));
  assert.ok(inner.hasAttribute("inert"));
  const css = sr.querySelector("style:not([data-eid-theme])")!.textContent ?? "";
  assert.match(css, /\.disc \{[^}]*transition: grid-template-rows/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ transition: none !important; \}/);
  b.setAttribute("lang", "en");
  b.close();
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } }];
  (sr.querySelector("button.trigger") as HTMLButtonElement).click();
  await until(() => !!sr.querySelector(".disc-btn"));
  assert.equal(sr.querySelector(".disc-btn")!.textContent, "Log in with registration number");
  b.close();
});

test("countdown: VC-ийн доор m:ss; минут тутам л зарлана; сүүлийн 30с анхааруулах өнгө", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "12345", expiresIn: 61 } }];
  statusReplies = Array.from({ length: 10 }, () => ({ state: "PENDING", qr: QR }));
  let m = make();
  m.click();
  await until(() => !!m.sr.querySelector(".qr-vc"));
  const meta = () => m.sr.querySelector(".meta") as HTMLElement;
  assert.equal(m.sr.querySelector(".qr-vc")!.nextElementSibling, meta(), "countdown VC-ийн шууд доор");
  assert.equal(meta().textContent, "Хүсэлтийн хугацаа: 1:01");
  assert.equal(meta().querySelector('[role="timer"]')!.getAttribute("aria-live"), "off");
  const live = () => m.sr.querySelector('[aria-live="polite"]')!.textContent;
  assert.equal(live(), "", "эхэнд зарлахгүй");
  await until(() => /1:00$/.test(meta().textContent!), 2500);
  assert.equal(live(), "1 минут үлдлээ");
  assert.ok(!meta().classList.contains("low"));
  m.b.close();

  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 31 } }];
  m = make({ lang: "en" });
  m.click();
  await until(() => !!m.sr.querySelector(".meta"));
  assert.equal(meta().textContent, "Request expires in: 0:31");
  assert.ok(!meta().classList.contains("low"));
  await until(() => /0:30$/.test(meta().textContent!), 2500);
  assert.ok(meta().classList.contains("low"), "≤30с → --eid-warning-fg");
  const css = m.sr.querySelector("style:not([data-eid-theme])")!.textContent ?? "";
  assert.match(css, /\.meta\.low, \.meta\.low \.mono \{ color: var\(--_eid-warning-fg\); \}/);
  m.b.close();
});

test("push 429 → busy countdown (товч идэвхгүй), eid-login-error {status, code, retryAfter}", async () => {
  startReplies = [
    { status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } },
    { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "2" } },
  ];
  const { sr, text, click, b } = make();
  const evs: unknown[] = [];
  b.addEventListener("eid-login-error", (e: Event) => evs.push((e as CustomEvent).detail));
  click();
  await until(() => !!sr.querySelector("form"));
  (sr.querySelector("input") as HTMLInputElement).value = "УБ12345678";
  sr.querySelector("form")!.dispatchEvent(new (dom.window.Event)("submit", { cancelable: true }));
  await until(() => /Систем завгүй — 2 сек/.test(text()));
  const push = sr.querySelector("button.push") as HTMLButtonElement;
  assert.equal(push.disabled, true);
  assert.deepEqual(evs, [{ error: "rate_limited", status: 429, code: "rate_limited", retryAfter: 2 }]);
  await until(() => /Систем завгүй — 1 сек/.test(text()), 1500);
  await until(() => !push.disabled, 2500);
  assert.doesNotMatch(text(), /Систем завгүй/);
  b.close();
});

test("start 503 busy → цонхонд countdown (en), дахин оролдох идэвхгүй → идэвхжинэ; event composed", async () => {
  startReplies = [{ status: 503, body: { error: "busy" }, headers: { "Retry-After": "1" } }];
  const { sr, text, click, b } = make({ lang: "en" });
  const evs: CustomEvent[] = [];
  document.body.addEventListener("eid-login-error", (e: Event) => evs.push(e as CustomEvent));
  click();
  await until(() => /Service busy — try again in 1 s/.test(text()));
  const retry = sr.querySelector(".end button") as HTMLButtonElement;
  assert.equal(retry.disabled, true);
  assert.equal(evs.length, 1);
  assert.ok(evs[0]!.composed && evs[0]!.bubbles);
  assert.deepEqual(evs[0]!.detail, { error: "busy", status: 503, code: "busy", retryAfter: 1 });
  await until(() => !retry.disabled, 2500);
  assert.doesNotMatch(text(), /Service busy/);
  b.close();
});

test("start 503 Retry-After-гүй → 30 сек анхдагч; 502 ба сүлжээний алдаанд event", async () => {
  startReplies = [{ status: 503, body: { error: "busy" } }];
  let m = make();
  const evs: unknown[] = [];
  m.b.addEventListener("eid-login-error", (e: Event) => evs.push((e as CustomEvent).detail));
  m.click();
  await until(() => /Систем завгүй — 30 сек/.test(m.text()));
  m.b.close();
  assert.deepEqual(evs, [{ error: "busy", status: 503, code: "busy", retryAfter: null }]);

  startReplies = [{ status: 502, body: {} }];
  m = make();
  const evs2: unknown[] = [];
  m.b.addEventListener("eid-login-error", (e: Event) => evs2.push((e as CustomEvent).detail));
  m.click();
  await until(() => /холбогдож чадсангүй/.test(m.text()));
  m.b.close();
  startReplies = ["neterr"];
  m = make();
  m.b.addEventListener("eid-login-error", (e: Event) => evs2.push((e as CustomEvent).detail));
  m.click();
  await until(() => evs2.length === 2);
  m.b.close();
  assert.deepEqual(evs2, [
    { error: "HTTP_502", status: 502, code: "HTTP_502", retryAfter: null },
    { error: "NETWORK", status: 0, code: "NETWORK", retryAfter: null },
  ]);
});

test("EXPIRED / WAIT_CALLBACK / start алдаа", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } }];
  statusReplies = [{ state: "EXPIRED" }];
  let m = make();
  m.click();
  await until(() => /хугацаа дууссан/.test(m.text()), 5000);
  m.b.close();

  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } }];
  statusReplies = [{ state: "WAIT_CALLBACK" }];
  m = make();
  m.click();
  await until(() => /хөтчөөр үргэлжилнэ/.test(m.text()), 5000);
  m.b.close();

  startReplies = [{ status: 502, body: { error: "eid_unavailable" } }];
  m = make();
  m.click();
  await until(() => /холбогдож чадсангүй/.test(m.text()));
  m.b.close();
});

test("сүлжээ 3 удаа тасарвал анхааруулга + QR саарал", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } }];
  statusReplies = ["neterr", "neterr", "neterr", "neterr", "neterr"];
  const { sr, click, b } = make();
  click();
  await until(() => !(sr.querySelector(".netwarn") as HTMLElement | null)?.hidden && !!sr.querySelector(".qr.stale"), 8000);
  b.close();
});

test("утас: Web2App start-url руу шууд навигаци (fetch-гүй)", () => {
  const { navs, click, sr } = make({}, true);
  click();
  assert.deepEqual(navs, ["https://bank.example.mn/auth/eid/start?mode=web2app&lang=mn"]);
  assert.equal(sr.querySelector('[role="dialog"]'), null);
  assert.equal(requests.length, 0);
});

test("Esc цонхыг хааж, poll зогсоно; Tab focus цонхонд үлдэнэ", async () => {
  startReplies = [{ status: 200, body: { mode: "qr", qr: QR, vc: "1", expiresIn: 120 } }];
  const { sr, click } = make();
  click();
  await until(() => !!sr.querySelector("form"));
  const dlg = sr.querySelector(".backdrop")!;
  const focusables = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled]), input")).filter((n) => !n.closest("[hidden], [inert]"));
  focusables.at(-1)!.focus();
  dlg.dispatchEvent(new (dom.window.KeyboardEvent)("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(sr.activeElement, focusables[0]);
  dlg.dispatchEvent(new (dom.window.KeyboardEvent)("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(sr.querySelector(".backdrop"), null);
  const n = requests.length;
  await tick(1200);
  assert.equal(requests.length, n, "хаасны дараа poll үгүй");
});
