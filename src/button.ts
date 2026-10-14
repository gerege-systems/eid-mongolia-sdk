// @gerege-systems/eid-mongolia-sdk/button — «eID-ээр нэвтрэх» нэг товч (Web Component, framework-гүй, node:* импортгүй).
//
//   <eid-login-button start-url="/auth/eid/start" status-url="/auth/eid/status" lang="mn"></eid-login-button>
//
// Backend нь `createEidLogin` (эсвэл Go `eidlogin.Handler`). Товч дарахад:
//   • desktop  → цонх (modal): QR (секунд тутам шинэчлэгдэнэ) + «регистрийн дугаараар утас руу мэдэгдэл», шууд төлөв;
//   • утасны хөтөч → `start-url?mode=web2app` руу шилжинэ (сервер 302 → eID апп; апп буцаахад backend callback дуусгана).
// Амжилттай бол `eid-login-success` (detail = backend-ийн {state, redirect, data}) — preventDefault хийгээгүй бол
// `redirect` (эсвэл `success-url`) руу шилжинэ. Алдаа: `eid-login-error` (detail = {error}).
// Дизайн: eID нэвтрэх хуудасны токен (ca-eidmongolia-mn oidc_login.html) — `--eid-*` CSS хувьсагчаар дарж болно.

import { isMobileUserAgent } from "./devicelink.js";
import { EID_LOGO_DATA_URI } from "./logo.js";
import { encodeQr, qrSvgPath } from "./qr.js";

type Lang = "mn" | "en";

const T = {
  mn: {
    button: "eID-ээр нэвтрэх",
    title: "eID-ээр нэвтрэх",
    close: "Хаах",
    loading: "Ачаалж байна",
    qrAlt: "Нэвтрэх QR код — утсан дээрх eID Mongolia аппаар уншуулна",
    steps: ["Утсан дээрх eID Mongolia аппыг нээнэ", "QR кодыг уншуулна", "PIN1 кодоо оруулна"],
    code: "Утсан дээрх код:",
    or: "эсвэл",
    idLabel: "Регистрийн дугаар",
    idHint: "Утсанд тань мэдэгдэл очно. Иргэний 12 оронтой дугаараар ч болно.",
    idEmpty: "Регистрийн дугаар оруулна уу",
    idLatin: "Үсгийг кириллээр бичнэ үү: УБ12345678",
    idBad: "Регистрийн дугаар 2 үсэг, 8 цифртэй байна: УБ12345678",
    push: "Мэдэгдэл илгээх",
    pushing: "Илгээж байна",
    rateLimited: "Хэт олон оролдлого. Түр хүлээгээд дахин оролдоно уу",
    pushFailed: "Мэдэгдэл илгээж чадсангүй. Дахин оролдоно уу",
    waitText: "Утсан дээрх код ижил бол PIN1 оруулна уу. Ижил биш бол татгалзана уу.",
    waiting: "Хүлээж байна",
    back: "Буцах",
    left: "Үлдсэн хугацаа",
    stale: "QR код хуучирсан",
    refresh: "Шинэчлэх",
    offline: "Холболт тасарсан. Интернэтээ шалгана уу — дахин холбогдохыг оролдож байна.",
    expiredTitle: "Нэвтрэлтийн хугацаа дууссан",
    refusedTitle: "Нэвтрэлтээс татгалзсан",
    failedTitle: "Нэвтэрч чадсангүй",
    failedText: "Баталгаажуулалт амжилтгүй боллоо. Дахин оролдоно уу.",
    unavailable: "eID үйлчилгээнд холбогдож чадсангүй. Түр хүлээгээд дахин оролдоно уу.",
    callbackTitle: "Утсан дээрх хөтчөөр үргэлжилнэ",
    callbackText: "Баталгаажуулалт амжилттай. Аппаас нээгдсэн хөтчийн цонхонд нэвтрэлт үргэлжилнэ.",
    retry: "Дахин оролдох",
    success: "Амжилттай нэвтэрлээ",
    sent: (vc: string) => `Мэдэгдэл илгээлээ. Утсан дээрх код ${vc.split("").join(" ")}`,
    minute: "1 минут үлдлээ",
  },
  en: {
    button: "Log in with eID",
    title: "Log in with eID",
    close: "Close",
    loading: "Loading",
    qrAlt: "Login QR code — scan it with the eID Mongolia app on your phone",
    steps: ["Open the eID Mongolia app on your phone", "Scan the QR code", "Enter your PIN1"],
    code: "Code on your phone:",
    or: "or",
    idLabel: "Registration number",
    idHint: "A notification will be sent to your phone. The 12-digit civil ID also works.",
    idEmpty: "Enter your registration number",
    idLatin: "Use Cyrillic letters: УБ12345678",
    idBad: "Registration number is 2 letters and 8 digits: УБ12345678",
    push: "Send notification",
    pushing: "Sending",
    rateLimited: "Too many attempts. Please wait and try again",
    pushFailed: "Could not send the notification. Please try again",
    waitText: "If the code on your phone matches, enter PIN1. Otherwise decline.",
    waiting: "Waiting",
    back: "Back",
    left: "Time left",
    stale: "QR code expired",
    refresh: "Refresh",
    offline: "Connection lost. Check your internet — reconnecting.",
    expiredTitle: "Login expired",
    refusedTitle: "Login declined",
    failedTitle: "Login failed",
    failedText: "Verification failed. Please try again.",
    unavailable: "Could not reach the eID service. Please try again shortly.",
    callbackTitle: "Continue in your phone's browser",
    callbackText: "Verified. Login continues in the browser window the app opened.",
    retry: "Try again",
    success: "Logged in",
    sent: (vc: string) => `Notification sent. Code on your phone ${vc.split("").join(" ")}`,
    minute: "1 minute left",
  },
} as const;

/** Backend-ийн status хариу. */
export interface EidLoginStatus {
  state: "PENDING" | "WAIT_CALLBACK" | "OK" | "FAILED" | "EXPIRED";
  qr?: string;
  vc?: string | null;
  expiresIn?: number;
  redirect?: string;
  data?: unknown;
  error?: string;
}

export interface EidLoginButtonOptions {
  /** Backend start endpoint (ж: `/auth/eid/start`). */
  startUrl: string;
  /** Backend status endpoint (ж: `/auth/eid/status`). */
  statusUrl: string;
  lang?: Lang;
  /** auto (анхдагч: утас → Web2App, бусад → QR цонх) | qr | app. */
  mode?: "auto" | "qr" | "app";
  /** auto (анхдагч: html[data-theme] / html.dark / prefers-color-scheme-ийг дагана) | light | dark. */
  theme?: "auto" | "light" | "dark";
  /** Амжилтын дараа (backend redirect өгөөгүй бол) шилжих URL. */
  successUrl?: string;
  onSuccess?: (s: EidLoginStatus) => void;
  onError?: (error: string) => void;
}

// Өнгөний токен: [нэр, light анхдагч, dark анхдагч]. Нийтийн `--eid-<нэр>` нь ЗӨВХӨН оролт — shadow дотор
// тодорхойлогддоггүй тул хуудасны аль ч түвшинд (`:root`, эцэг, элемент) өгсөн утга өвлөгдөж ХОЁР theme-д үйлчилнэ.
// `--eid-<нэр>-dark` нь dark-д давуу. Анхдагч нь зөвхөн fallback. Дотоод утга `--_eid-<нэр>`.
const EID_COLOR_TOKENS: ReadonlyArray<readonly [string, string, string]> = [
  ["bg", "hsl(0 0% 100%)", "hsl(229 50% 6%)"],
  ["bg-subtle", "hsl(210 40% 98%)", "hsl(222 47% 9%)"],
  ["bg-muted", "hsl(210 40% 96%)", "hsl(217 33% 13%)"],
  ["fg", "hsl(222 47% 11%)", "hsl(210 40% 98%)"],
  ["fg-muted", "hsl(215 19% 35%)", "hsl(213 27% 84%)"],
  ["fg-subtle", "hsl(215 16% 45%)", "hsl(215 20% 65%)"],
  ["border", "hsl(214 32% 91%)", "hsl(217 33% 17%)"],
  ["border-strong", "hsl(213 27% 84%)", "hsl(215 25% 27%)"],
  ["accent", "oklch(0.534 0.2 259)", "oklch(0.64 0.15 259)"],
  ["accent-fg", "#fff", "hsl(229 50% 6%)"],
  ["accent-subtle", "oklch(0.97 0.03 259)", "oklch(0.24 0.06 259)"],
  ["accent-subtle-fg", "oklch(0.474 0.19 259)", "oklch(0.82 0.1 259)"],
  ["ring", "oklch(0.604 0.2 259)", "oklch(0.68 0.15 259)"],
  ["warning-bg", "hsl(48 100% 96%)", "hsl(20 60% 10%)"],
  ["warning-border", "hsl(45 95% 78%)", "hsl(22 70% 26%)"],
  ["warning-fg", "hsl(23 75% 33%)", "hsl(40 92% 65%)"],
  ["danger-fg", "hsl(0 74% 42%)", "hsl(0 91% 71%)"],
];

const lightVars = EID_COLOR_TOKENS.map(([n, l]) => `--_eid-${n}: var(--eid-${n}, ${l});`).join("\n  ");
const darkVars = EID_COLOR_TOKENS.map(([n, , d]) => `--_eid-${n}: var(--eid-${n}-dark, var(--eid-${n}, ${d}));`).join("\n  ");

const CSS_BASE = `
:host { display: inline-block; font-family: inherit; color-scheme: light;
  ${lightVars}
  --_eid-radius: var(--eid-radius, 6px); --_eid-radius-lg: var(--eid-radius-lg, 8px); }
button, input { font-family: inherit; }
`;

// Dark — `theme`-ээс (эсвэл auto үед хуудсын html[data-theme] / html.dark / prefers-color-scheme) хамаарч тусдаа
// <style>-д идэвхжинэ: `--eid-<нэр>-dark` → `--eid-<нэр>` → dark анхдагч.
const DARK_CSS = `:host { color-scheme: dark;
  ${darkVars} }
`;

const CSS_REST = `
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
h2, p, ol { margin: 0; }
:focus-visible { outline: 2px solid var(--_eid-ring); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.btn { display: inline-flex; width: 100%; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 20px;
  border-radius: var(--_eid-radius); font-family: inherit; font-weight: 500; font-size: 1rem; line-height: 1.25; text-decoration: none; border: 1px solid transparent; cursor: pointer;
  transition: background-color 160ms cubic-bezier(0,0,0.2,1); }
.btn:disabled { opacity: 0.6; cursor: progress; }
.btn-primary { background: var(--_eid-accent); color: var(--_eid-accent-fg); }
.btn-primary:hover { background: color-mix(in oklab, var(--_eid-accent) 88%, black); }
.btn-outline { background: var(--_eid-bg); color: var(--_eid-fg); border-color: var(--_eid-border-strong); }
.btn-outline:hover { background: var(--_eid-bg-muted); }
.btn-sm { width: auto; min-height: 36px; padding: 0 14px; font-size: 0.8125rem; }
.trigger { width: auto; }
.trigger img { width: 20px; height: 20px; border-radius: 4px; }
.backdrop { position: fixed; inset: 0; z-index: 2147483000; background: hsl(222 47% 11% / 0.5); display: flex; align-items: center;
  justify-content: center; padding: 16px; overflow-y: auto; }
.dialog { position: relative; width: 100%; max-width: 26rem; max-height: calc(100dvh - 32px); overflow-y: auto; background: var(--_eid-bg);
  color: var(--_eid-fg); border: 1px solid var(--_eid-border); border-radius: var(--_eid-radius-lg); padding: 24px; font-size: 0.875rem; line-height: 1.5rem; }
@media (max-width: 639px) { .dialog { padding: 16px; } }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.head img { width: 28px; height: 28px; border-radius: var(--_eid-radius); }
.head h2 { flex: 1; font-size: 1.125rem; line-height: 1.75rem; font-weight: 600; }
.x { width: 36px; height: 36px; border: 0; border-radius: var(--_eid-radius); background: transparent; color: var(--_eid-fg-muted); cursor: pointer; font-size: 1.25rem; line-height: 1; }
.x:hover { background: var(--_eid-bg-muted); color: var(--_eid-fg); }
.qr { position: relative; width: 256px; max-width: 100%; aspect-ratio: 1; margin: 0 auto; border: 1px solid var(--_eid-border);
  border-radius: var(--_eid-radius-lg); background: #fff; overflow: hidden; }
.qr svg { display: block; width: 100%; height: 100%; }
.qr.stale svg { opacity: 0.12; }
.qr-stale { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  color: hsl(222 47% 11%); font-weight: 500; }
.qr-vc { margin-top: 8px; text-align: center; font-size: 0.8125rem; color: var(--_eid-fg-subtle); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; letter-spacing: 0.08em; color: var(--_eid-fg-muted); }
.steps { margin-top: 16px; padding: 0; list-style: none; counter-reset: st; display: grid; gap: 8px; }
.steps li { counter-increment: st; display: flex; align-items: center; gap: 12px; }
.steps li::before { content: counter(st); flex: none; width: 24px; height: 24px; border-radius: 9999px; background: var(--_eid-accent-subtle);
  color: var(--_eid-accent-subtle-fg); display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 600; }
.or { display: flex; align-items: center; gap: 12px; margin: 24px 0; color: var(--_eid-fg-subtle); font-size: 0.8125rem; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--_eid-border); }
.field { display: grid; gap: 8px; }
.field label { font-weight: 500; }
.field input { width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--_eid-border-strong); border-radius: var(--_eid-radius);
  background: var(--_eid-bg); color: var(--_eid-fg); font-family: inherit; font-size: 1rem; line-height: 1.5rem; letter-spacing: 0.02em; text-transform: uppercase; }
.field input::placeholder { color: var(--_eid-fg-subtle); text-transform: none; }
.field input[aria-invalid="true"] { border-color: var(--_eid-danger-fg); }
.hint { font-size: 0.8125rem; color: var(--_eid-fg-subtle); }
.err { font-size: 0.8125rem; color: var(--_eid-danger-fg); font-weight: 500; }
.push { margin-top: 16px; }
.center { text-align: center; }
.vc { font: 600 2.25rem/2.5rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.16em; padding-left: 0.16em; }
.vc:focus, h2:focus { outline: none; }
.text { margin-top: 12px; color: var(--_eid-fg-muted); }
.pending { margin-top: 16px; display: inline-flex; align-items: center; gap: 8px; color: var(--_eid-fg-muted); }
.end .btn, .center .btn { margin-top: 24px; }
.spinner { width: 16px; height: 16px; flex: none; border: 2px solid currentColor; border-right-color: transparent; border-radius: 9999px; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.netwarn { margin-top: 16px; padding: 8px 12px; border: 1px solid var(--_eid-warning-border); border-radius: var(--_eid-radius); background: var(--_eid-warning-bg);
  color: var(--_eid-warning-fg); font-size: 0.8125rem; }
.meta { margin-top: 16px; font-size: 0.8125rem; color: var(--_eid-fg-subtle); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; }
  .spinner { animation: none; border-right-color: currentColor; opacity: 0.6; } }
`;

const CSS = CSS_BASE + CSS_REST;

type Scheme = "light" | "dark";

/** `theme` атрибутын утгыг (light | dark | auto) бодит схем болгоно. auto: html[data-theme] → html.dark/.light → OS. */
export function resolveEidTheme(theme: string | null, doc: Document = document): Scheme {
  if (theme === "light" || theme === "dark") return theme;
  const html = doc.documentElement;
  const dt = html?.getAttribute("data-theme");
  if (dt === "dark" || dt === "light") return dt;
  if (html?.classList.contains("dark")) return "dark";
  if (html?.classList.contains("light")) return "light";
  const mq = doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
  return mq?.matches ? "dark" : "light";
}

const ID_RE = /^([А-ЯЁӨҮ]{2}[0-9]{8}|[0-9]{8,14})$/;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

const Base: typeof HTMLElement = typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/** `<eid-login-button>` — атрибут: start-url, status-url, lang (mn|en), mode (auto|qr|app), theme (auto|light|dark), success-url. */
export class EidLoginButton extends Base {
  static readonly observedAttributes = ["lang", "theme"];
  /** Тест/дотоод: гар утас эсэхийг дарж бичих. */
  isMobile: () => boolean = () => isMobileUserAgent();
  /** Тест/дотоод: шилжилт (location.assign). */
  navigate: (url: string) => void = (url) => location.assign(url);

  private root!: ShadowRoot;
  private trigger!: HTMLButtonElement;
  private backdrop: HTMLDivElement | null = null;
  private body!: HTMLDivElement;
  private live!: HTMLParagraphElement;
  private timer = 0;
  private tick = 0;
  private left = -1;
  private fails = 0;
  private gen = 0; // цонх нээх бүрд нэмэгдэнэ — хуучин fetch-ийн хариуг үл тооно
  private lastFocus: Element | null = null;
  private darkStyle!: HTMLStyleElement;
  private themeObs: MutationObserver | null = null;
  private mq: MediaQueryList | null = null;
  private readonly onScheme = () => this.applyTheme();

  private get t() {
    return T[this.getAttribute("lang") === "en" ? "en" : "mn"];
  }
  private attr(name: string, def = ""): string {
    return this.getAttribute(name) ?? def;
  }

  connectedCallback(): void {
    if (!this.root) {
      this.root = this.attachShadow({ mode: "open" });
      const style = el("style");
      style.textContent = CSS;
      this.darkStyle = el("style", { "data-eid-theme": "dark" });
      this.trigger = el("button", { type: "button", class: "btn btn-outline trigger", part: "button", "aria-haspopup": "dialog" });
      this.trigger.append(el("img", { src: EID_LOGO_DATA_URI, alt: "", width: "20", height: "20" }), el("span", {}, this.t.button));
      this.trigger.addEventListener("click", () => this.start());
      this.root.append(style, this.darkStyle, this.trigger);
    }
    this.watchTheme();
    this.applyTheme();
  }

  attributeChangedCallback(name: string): void {
    if (name === "theme") {
      if (this.root) this.applyTheme();
      return;
    }
    const label = this.trigger?.querySelector("span");
    if (label) label.textContent = this.t.button;
  }

  disconnectedCallback(): void {
    this.close();
    this.themeObs?.disconnect();
    this.themeObs = null;
    this.mq?.removeEventListener?.("change", this.onScheme);
    this.mq = null;
  }

  /** Одоогийн бодит схем (`theme` + auto үед хуудас/OS). */
  get scheme(): Scheme {
    return resolveEidTheme(this.getAttribute("theme"));
  }

  private applyTheme(): void {
    const css = this.scheme === "dark" ? DARK_CSS : "";
    if (this.darkStyle.textContent !== css) this.darkStyle.textContent = css;
  }

  /** auto үед хуудасны html[data-theme]/class ба OS-ийн схемийн өөрчлөлтийг дагана. */
  private watchTheme(): void {
    if (!this.themeObs && typeof MutationObserver !== "undefined" && document.documentElement) {
      this.themeObs = new MutationObserver(this.onScheme);
      this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    }
    if (!this.mq && typeof matchMedia === "function") {
      this.mq = matchMedia("(prefers-color-scheme: dark)");
      this.mq.addEventListener?.("change", this.onScheme);
    }
  }

  /** Товчны үйлдэл (программаар ч дуудаж болно). */
  start(): void {
    const mode = this.attr("mode", "auto");
    if (mode === "app" || (mode === "auto" && this.isMobile())) {
      // Хэрэглэгчийн tap-аас шууд (await-гүй) навигаци — iOS Universal Link-д заавал.
      const u = new URL(this.attr("start-url"), location.href);
      u.searchParams.set("mode", "web2app");
      u.searchParams.set("lang", this.attr("lang") === "en" ? "en" : "mn");
      this.navigate(u.toString());
      return;
    }
    this.open();
  }

  private open(): void {
    this.close();
    const gen = ++this.gen;
    this.lastFocus = (this.getRootNode() as Document | ShadowRoot).activeElement ?? document.activeElement;
    const bd = el("div", { class: "backdrop", part: "backdrop" });
    const dlg = el("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "eid-title", part: "dialog" });
    const head = el("div", { class: "head" });
    const x = el("button", { type: "button", class: "x", "aria-label": this.t.close }, "×");
    x.addEventListener("click", () => this.close());
    head.append(el("img", { src: EID_LOGO_DATA_URI, alt: "", width: "28", height: "28" }), el("h2", { id: "eid-title" }, this.t.title), x);
    this.body = el("div");
    this.live = el("p", { class: "sr-only", "aria-live": "polite" });
    dlg.append(head, this.body, this.live);
    bd.append(dlg);
    bd.addEventListener("mousedown", (e) => {
      if (e.target === bd) this.close();
    });
    bd.addEventListener("keydown", (e) => this.onKey(e));
    this.root.append(bd);
    this.backdrop = bd;
    this.showLoading();
    x.focus();
    void this.begin(gen, { mode: "qr" });
  }

  /** Цонхыг хааж poll-ийг зогсооно. */
  close(): void {
    this.gen++;
    clearTimeout(this.timer);
    clearInterval(this.tick);
    if (!this.backdrop) return;
    this.backdrop.remove();
    this.backdrop = null;
    (this.lastFocus as HTMLElement | null)?.focus?.();
    if (!this.lastFocus) this.trigger.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key !== "Tab" || !this.backdrop) return;
    const items = Array.from(this.backdrop.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.closest("[hidden]"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = this.root.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private say(text: string): void {
    this.live.textContent = text;
  }

  private view(...nodes: Node[]): void {
    this.body.replaceChildren(...nodes);
  }

  private showLoading(): void {
    const p = el("p", { class: "pending", role: "status" });
    p.append(el("span", { class: "spinner", "aria-hidden": "true" }), el("span", {}, this.t.loading));
    const c = el("div", { class: "center" });
    c.append(p);
    this.view(c);
  }

  private async begin(gen: number, body: { mode: "qr" } | { mode: "push"; idCode: string }): Promise<Response | null> {
    let r: Response;
    try {
      r = await fetch(this.attr("start-url"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, lang: this.attr("lang") === "en" ? "en" : "mn" }),
      });
    } catch {
      if (gen === this.gen && body.mode === "qr") this.end("unavailable");
      return null;
    }
    if (gen !== this.gen) return null;
    if (body.mode === "push") return r;
    if (!r.ok) {
      this.end("unavailable");
      return null;
    }
    const s = (await r.json()) as EidLoginStatus;
    this.showQr(s);
    this.startTimer(s.expiresIn ?? -1);
    this.schedule(gen, 1000);
    return r;
  }

  private qrBox!: HTMLDivElement;
  private qrStale!: HTMLDivElement;
  private netwarn!: HTMLParagraphElement;

  private drawQr(link: string): void {
    const q = encodeQr(link);
    const n = q.size + 8;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", this.t.qrAlt);
    svg.setAttribute("shape-rendering", "crispEdges");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", qrSvgPath(q));
    path.setAttribute("fill", "#000");
    svg.append(path);
    this.qrBox.querySelector("svg")?.remove();
    this.qrBox.prepend(svg);
  }

  private showQr(s: EidLoginStatus): void {
    const t = this.t;
    this.qrBox = el("div", { class: "qr" });
    this.qrStale = el("div", { class: "qr-stale", hidden: "" });
    const refresh = el("button", { type: "button", class: "btn btn-outline btn-sm" }, t.refresh);
    refresh.addEventListener("click", () => this.schedule(this.gen, 0));
    this.qrStale.append(el("p", {}, t.stale), refresh);
    this.qrBox.append(this.qrStale);
    if (s.qr) this.drawQr(s.qr);
    const nodes: Node[] = [this.qrBox];
    if (s.vc) {
      const vc = el("p", { class: "qr-vc" }, t.code + " ");
      vc.append(el("span", { class: "mono" }, s.vc));
      nodes.push(vc);
    }
    const steps = el("ol", { class: "steps" });
    for (const st of t.steps) steps.append(el("li", {}, st));
    nodes.push(steps, el("div", { class: "or", role: "separator", "aria-label": t.or }, t.or), this.pushForm());
    this.netwarn = el("p", { class: "netwarn", role: "status", hidden: "" }, t.offline);
    nodes.push(this.netwarn, this.meta());
    this.view(...nodes);
  }

  private leftEl: HTMLSpanElement | null = null;

  private meta(): HTMLElement {
    const p = el("p", { class: "meta" }, this.t.left + " ");
    this.leftEl = el("span", { class: "mono", role: "timer", "aria-live": "off" }, "--:--");
    p.append(this.leftEl);
    if (this.left < 0) p.hidden = true;
    return p;
  }

  private startTimer(seconds: number): void {
    clearInterval(this.tick);
    this.left = seconds;
    const render = () => {
      if (!this.leftEl || this.left < 0) return;
      this.leftEl.parentElement!.hidden = false;
      const m = Math.floor(this.left / 60);
      const s = this.left % 60;
      this.leftEl.textContent = `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
      if (this.left === 60) this.say(this.t.minute);
    };
    render();
    if (seconds < 0) return;
    this.tick = setInterval(() => {
      this.left -= 1;
      render();
      if (this.left <= 0) this.end("expired");
    }, 1000) as unknown as number;
  }

  private pushForm(): HTMLFormElement {
    const t = this.t;
    const form = el("form", { novalidate: "" });
    const field = el("div", { class: "field" });
    const input = el("input", {
      id: "eid-id", name: "idCode", type: "text", autocapitalize: "characters", autocomplete: "off", autocorrect: "off",
      spellcheck: "false", maxlength: "14", placeholder: "УБ12345678", "aria-describedby": "eid-id-hint eid-id-err",
    });
    const err = el("p", { class: "err", id: "eid-id-err", hidden: "" });
    field.append(el("label", { for: "eid-id" }, t.idLabel), input, el("p", { class: "hint", id: "eid-id-hint" }, t.idHint), err);
    const btn = el("button", { type: "submit", class: "btn btn-primary push" });
    const spin = el("span", { class: "spinner", hidden: "", "aria-hidden": "true" });
    const label = el("span", {}, t.push);
    btn.append(spin, label);
    form.append(field, btn);
    const check = () => {
      const v = input.value.replace(/\s+/g, "").toUpperCase();
      if (v === "") return t.idEmpty;
      if (ID_RE.test(v)) return "";
      if (/^[A-Z]{2}[0-9]{8}$/.test(v)) return t.idLatin;
      return t.idBad;
    };
    const setErr = (msg: string) => {
      err.textContent = msg;
      err.hidden = !msg;
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    const busy = (on: boolean) => {
      btn.disabled = on;
      spin.hidden = !on;
      label.textContent = on ? t.pushing : t.push;
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const msg = check();
      setErr(msg);
      if (msg) {
        input.focus();
        return;
      }
      busy(true);
      const gen = this.gen;
      void this.begin(gen, { mode: "push", idCode: input.value.replace(/\s+/g, "").toUpperCase() }).then(async (r) => {
        if (gen !== this.gen) return;
        busy(false);
        if (!r) return setErr(t.pushFailed);
        const b = (await r.json().catch(() => ({}))) as EidLoginStatus;
        if (r.ok && b.vc) return this.showWait(b);
        if (r.status === 429) return setErr(t.rateLimited);
        if (r.status === 400) return setErr(t.idBad);
        setErr(t.pushFailed);
      });
    });
    return form;
  }

  private showWait(s: EidLoginStatus): void {
    const t = this.t;
    const c = el("div", { class: "center" });
    c.append(el("h2", { class: "sr-only" }, t.waiting));
    const vc = el("p", { class: "vc", tabindex: "-1", "aria-describedby": "eid-wait" }, s.vc ?? "");
    const pending = el("p", { class: "pending" });
    pending.append(el("span", { class: "spinner", "aria-hidden": "true" }), el("span", {}, t.waiting));
    const back = el("button", { type: "button", class: "btn btn-outline" }, t.back);
    back.addEventListener("click", () => this.open());
    this.netwarn = el("p", { class: "netwarn", role: "status", hidden: "" }, t.offline);
    c.append(vc, el("p", { class: "text", id: "eid-wait" }, t.waitText), pending, back, this.netwarn, this.meta());
    this.view(c);
    this.startTimer(s.expiresIn ?? -1);
    vc.focus();
    this.say(t.sent(s.vc ?? ""));
  }

  private schedule(gen: number, ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(gen), ms) as unknown as number;
  }

  private async poll(gen: number): Promise<void> {
    if (gen !== this.gen) return;
    let s: EidLoginStatus;
    try {
      const r = await fetch(this.attr("status-url"), { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      s = (await r.json()) as EidLoginStatus;
    } catch {
      if (gen !== this.gen) return;
      this.fails++;
      if (this.fails >= 3) {
        this.netwarn.hidden = false;
        this.qrBox?.classList.add("stale");
        if (this.qrStale) this.qrStale.hidden = false;
      }
      this.schedule(gen, 2000);
      return;
    }
    if (gen !== this.gen) return;
    this.fails = 0;
    this.netwarn.hidden = true;
    this.qrBox?.classList.remove("stale");
    if (this.qrStale) this.qrStale.hidden = true;
    switch (s.state) {
      case "PENDING":
        if (s.qr && this.qrBox?.isConnected) this.drawQr(s.qr);
        if (typeof s.expiresIn === "number" && Math.abs(s.expiresIn - this.left) > 2) this.startTimer(s.expiresIn);
        this.schedule(gen, 1000);
        return;
      case "OK":
        return this.succeed(s);
      case "WAIT_CALLBACK":
        return this.end("callback");
      case "EXPIRED":
        return this.end("expired");
      default:
        return this.end(s.error && s.error.startsWith("USER_REFUSED") ? "refused" : s.error === "TIMEOUT" ? "expired" : "failed", s.error);
    }
  }

  private succeed(s: EidLoginStatus): void {
    clearInterval(this.tick);
    const c = el("div", { class: "center" });
    const h = el("h2", { tabindex: "-1" }, this.t.success);
    c.append(h);
    this.view(c);
    h.focus();
    const ev = new CustomEvent<EidLoginStatus>("eid-login-success", { detail: s, bubbles: true, composed: true, cancelable: true });
    const go = this.dispatchEvent(ev);
    const to = s.redirect ?? this.getAttribute("success-url");
    if (go && to) this.navigate(to);
  }

  private end(kind: "expired" | "refused" | "failed" | "unavailable" | "callback", error?: string): void {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.gen++;
    const t = this.t;
    const titles = { expired: t.expiredTitle, refused: t.refusedTitle, failed: t.failedTitle, unavailable: t.failedTitle, callback: t.callbackTitle };
    const c = el("div", { class: "end", role: "alert" });
    const h = el("h2", { tabindex: "-1" }, titles[kind]);
    c.append(h);
    if (kind === "failed") c.append(el("p", { class: "text" }, t.failedText));
    if (kind === "unavailable") c.append(el("p", { class: "text" }, t.unavailable));
    if (kind === "callback") c.append(el("p", { class: "text" }, t.callbackText));
    if (kind !== "callback") {
      const retry = el("button", { type: "button", class: "btn btn-primary" }, t.retry);
      retry.addEventListener("click", () => this.open());
      c.append(retry);
      this.dispatchEvent(new CustomEvent("eid-login-error", { detail: { error: error ?? kind.toUpperCase() }, bubbles: true, composed: true }));
    }
    this.view(c);
    h.focus();
  }
}

/** `<eid-login-button>`-ийг бүртгэнэ (давхар бүртгэхгүй). Энэ модулийг импортлоход автоматаар дуудагдана. */
export function defineEidLoginButton(tag = "eid-login-button"): void {
  if (typeof customElements !== "undefined" && !customElements.get(tag)) customElements.define(tag, EidLoginButton);
}

/** Элементэд товч нэмнэ (framework-гүй хуудас, React/Vue-ийн ref). Үүссэн элементийг буцаана. */
export function mountEidLoginButton(target: Element, opts: EidLoginButtonOptions): EidLoginButton {
  defineEidLoginButton();
  const b = document.createElement("eid-login-button") as EidLoginButton;
  b.setAttribute("start-url", opts.startUrl);
  b.setAttribute("status-url", opts.statusUrl);
  b.setAttribute("lang", opts.lang ?? "mn");
  if (opts.mode) b.setAttribute("mode", opts.mode);
  if (opts.theme) b.setAttribute("theme", opts.theme);
  if (opts.successUrl) b.setAttribute("success-url", opts.successUrl);
  if (opts.onSuccess) b.addEventListener("eid-login-success", (e) => opts.onSuccess!((e as CustomEvent<EidLoginStatus>).detail));
  if (opts.onError) b.addEventListener("eid-login-error", (e) => opts.onError!((e as CustomEvent<{ error: string }>).detail.error));
  target.append(b);
  return b;
}

defineEidLoginButton();
