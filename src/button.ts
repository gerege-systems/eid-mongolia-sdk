// @gerege-systems/eid-mongolia-sdk/button — «eID-ээр нэвтрэх» нэг товч (Web Component, framework-гүй, node:* импортгүй).
//
//   <eid-login-button start-url="/auth/eid/start" status-url="/auth/eid/status" lang="mn"></eid-login-button>
//
// Backend нь `createEidLogin` (эсвэл Go `eidlogin.Handler`). Товч дарахад:
//   • desktop  → цонх (modal): QR (секунд тутам шинэчлэгдэнэ) + «Регистрийн дугаараар нэвтрэх» товч (ижил цонхонд дэлгэгдэх push хэсэг), шууд төлөв;
//   • утасны хөтөч → `start-url?mode=web2app` руу шилжинэ (сервер 302 → eID апп; апп буцаахад backend callback дуусгана).
// Амжилттай бол `eid-login-success` (detail = backend-ийн {state, redirect, data}) — preventDefault хийгээгүй бол
// `redirect` (эсвэл `success-url`) руу шилжинэ. Алдаа: `eid-login-error` (detail = {error, status, code, retryAfter}; 429/503 — Retry-After-ын countdown).
// Дизайн: `--eid-*` CSS хувьсагчаар дарж болно (README-ийн хүснэгт).

import { isMobileUserAgent } from "./devicelink.js";
import { EID_LOGO_SHAPES, EID_LOGO_VIEWBOX } from "./logo.js";
import { encodeQr, qrSvgPath } from "./qr.js";

/** eID аппын хэлнүүд (Монгол + НҮБ-ын 6 албан ёсны хэл); бусад утга → mn. */
export const EID_LOGIN_LANGS = ["mn", "en", "ru", "zh", "fr", "es", "ar"] as const;
type Lang = (typeof EID_LOGIN_LANGS)[number];

/** `lang` атрибутыг (ж: "ru", "zh-CN", "AR") дэмжигдэх хэл болгоно; үл мэдэгдэх → mn. */
export function resolveEidLang(lang: string | null | undefined): Lang {
  const primary = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0] as Lang;
  return EID_LOGIN_LANGS.includes(primary) ? primary : "mn";
}

const MN = {
    button: "eID-ээр нэвтрэх",
    title: "eID-ээр нэвтрэх",
    close: "Хаах",
    loading: "Ачаалж байна",
    qrAlt: "Нэвтрэх QR код — утсан дээрх eID Mongolia аппаар уншуулна",
    steps: ["Утсан дээрх eID Mongolia аппыг нээнэ", "QR кодыг уншуулна", "PIN1 кодоо оруулна"],
    vcLabel: "Баталгаажуулах код",
    or: "эсвэл",
    usePush: "Регистрийн дугаараар нэвтрэх",
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
    left: "Хүсэлтийн хугацаа:",
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
    minutes: (n: number) => `${n} минут үлдлээ`,
    busy: (n: number) => `Систем завгүй — ${n} сек дараа дахин оролдоно уу`,
};

type Texts = typeof MN;

// Орчуулга нь eID аппын (eid-mongolia-mobile Strings*) нэр томьёог дагана.
const T: Record<Lang, Texts> = {
  mn: MN,
  en: {
    button: "Log in with eID",
    title: "Log in with eID",
    close: "Close",
    loading: "Loading",
    qrAlt: "Login QR code — scan it with the eID Mongolia app on your phone",
    steps: ["Open the eID Mongolia app on your phone", "Scan the QR code", "Enter your PIN1"],
    vcLabel: "Verification code",
    or: "or",
    usePush: "Log in with registration number",
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
    left: "Request expires in:",
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
    minutes: (n: number) => `${n} minute${n === 1 ? "" : "s"} left`,
    busy: (n: number) => `Service busy — try again in ${n} s`,
  },
  ru: {
    button: "Войти через eID",
    title: "Войти через eID",
    close: "Закрыть",
    loading: "Загрузка",
    qrAlt: "QR-код для входа — отсканируйте его приложением eID Mongolia на телефоне",
    steps: ["Откройте приложение eID Mongolia на телефоне", "Отсканируйте QR-код", "Введите PIN1"],
    vcLabel: "Код подтверждения",
    or: "или",
    usePush: "Войти по регистрационному номеру",
    idLabel: "Регистрационный номер",
    idHint: "На ваш телефон придёт уведомление. Можно указать и 12-значный гражданский номер.",
    idEmpty: "Введите регистрационный номер",
    idLatin: "Буквы вводите кириллицей: УБ12345678",
    idBad: "Регистрационный номер — 2 буквы и 8 цифр: УБ12345678",
    push: "Отправить уведомление",
    pushing: "Отправка",
    rateLimited: "Слишком много попыток. Подождите немного и повторите",
    pushFailed: "Не удалось отправить уведомление. Повторите попытку",
    waitText: "Если код на телефоне совпадает, введите PIN1. Если нет — отклоните запрос.",
    waiting: "Ожидание",
    back: "Назад",
    left: "Запрос истекает через:",
    stale: "QR-код устарел",
    refresh: "Обновить",
    offline: "Соединение потеряно. Проверьте подключение к интернету — идёт переподключение.",
    expiredTitle: "Срок входа истёк",
    refusedTitle: "Вход отклонён",
    failedTitle: "Не удалось войти",
    failedText: "Проверка не пройдена. Повторите попытку.",
    unavailable: "Не удалось подключиться к сервису eID. Повторите попытку чуть позже.",
    callbackTitle: "Продолжите в браузере телефона",
    callbackText: "Проверка пройдена. Вход продолжится в окне браузера, которое открыло приложение.",
    retry: "Повторить",
    success: "Вход выполнен",
    sent: (vc: string) => `Уведомление отправлено. Код на телефоне ${vc.split("").join(" ")}`,
    minutes: (n: number) => `Осталось времени: ${n} мин`,
    busy: (n: number) => `Сервис занят — повторите через ${n} с`,
  },
  zh: {
    button: "使用 eID 登录",
    title: "使用 eID 登录",
    close: "关闭",
    loading: "加载中",
    qrAlt: "登录二维码 — 请用手机上的 eID Mongolia 应用扫描",
    steps: ["在手机上打开 eID Mongolia 应用", "扫描二维码", "输入 PIN1"],
    vcLabel: "验证码",
    or: "或",
    usePush: "使用登记号登录",
    idLabel: "登记号",
    idHint: "通知将发送到您的手机。也可使用 12 位公民号码。",
    idEmpty: "请输入登记号",
    idLatin: "字母请使用西里尔字母：УБ12345678",
    idBad: "登记号由 2 个字母和 8 位数字组成：УБ12345678",
    push: "发送通知",
    pushing: "发送中",
    rateLimited: "尝试次数过多。请稍候再试",
    pushFailed: "无法发送通知。请重试",
    waitText: "如果手机上的验证码一致，请输入 PIN1；如不一致，请拒绝。",
    waiting: "等待中",
    back: "返回",
    left: "请求剩余时间：",
    stale: "二维码已过期",
    refresh: "刷新",
    offline: "连接已断开。请检查网络连接 — 正在重新连接。",
    expiredTitle: "登录已过期",
    refusedTitle: "登录已被拒绝",
    failedTitle: "登录失败",
    failedText: "验证失败。请重试。",
    unavailable: "无法连接 eID 服务。请稍后再试。",
    callbackTitle: "请在手机浏览器中继续",
    callbackText: "验证成功。登录将在应用打开的浏览器窗口中继续。",
    retry: "重试",
    success: "登录成功",
    sent: (vc: string) => `通知已发送。手机上的验证码 ${vc.split("").join(" ")}`,
    minutes: (n: number) => `剩余 ${n} 分钟`,
    busy: (n: number) => `服务繁忙 — 请在 ${n} 秒后重试`,
  },
  fr: {
    button: "Se connecter avec eID",
    title: "Se connecter avec eID",
    close: "Fermer",
    loading: "Chargement",
    qrAlt: "Code QR de connexion — scannez-le avec l'application eID Mongolia sur votre téléphone",
    steps: ["Ouvrez l'application eID Mongolia sur votre téléphone", "Scannez le code QR", "Saisissez votre PIN1"],
    vcLabel: "Code de vérification",
    or: "ou",
    usePush: "Se connecter avec le numéro national d'identité",
    idLabel: "Numéro national d'identité",
    idHint: "Une notification sera envoyée sur votre téléphone. Le numéro civil à 12 chiffres est aussi accepté.",
    idEmpty: "Saisissez votre numéro national d'identité",
    idLatin: "Utilisez des lettres cyrilliques : УБ12345678",
    idBad: "Le numéro comporte 2 lettres et 8 chiffres : УБ12345678",
    push: "Envoyer la notification",
    pushing: "Envoi",
    rateLimited: "Trop de tentatives. Patientez un moment puis réessayez",
    pushFailed: "Impossible d'envoyer la notification. Réessayez",
    waitText: "Si le code sur votre téléphone est identique, saisissez le PIN1. Sinon, refusez.",
    waiting: "En attente",
    back: "Retour",
    left: "La demande expire dans :",
    stale: "Code QR expiré",
    refresh: "Actualiser",
    offline: "Connexion perdue. Vérifiez votre connexion Internet — reconnexion en cours.",
    expiredTitle: "Connexion expirée",
    refusedTitle: "Connexion refusée",
    failedTitle: "Échec de la connexion",
    failedText: "La vérification a échoué. Réessayez.",
    unavailable: "Impossible de joindre le service eID. Réessayez dans un instant.",
    callbackTitle: "Continuez dans le navigateur du téléphone",
    callbackText: "Vérification réussie. La connexion se poursuit dans la fenêtre du navigateur ouverte par l'application.",
    retry: "Réessayer",
    success: "Connecté",
    sent: (vc: string) => `Notification envoyée. Code sur votre téléphone ${vc.split("").join(" ")}`,
    minutes: (n: number) => (n > 1 ? `${n} minutes restantes` : `${n} minute restante`),
    busy: (n: number) => `Service occupé — réessayez dans ${n} s`,
  },
  es: {
    button: "Iniciar sesión con eID",
    title: "Iniciar sesión con eID",
    close: "Cerrar",
    loading: "Cargando",
    qrAlt: "Código QR de inicio de sesión: escanéelo con la aplicación eID Mongolia de su teléfono",
    steps: ["Abra la aplicación eID Mongolia en su teléfono", "Escanee el código QR", "Introduzca su PIN1"],
    vcLabel: "Código de verificación",
    or: "o",
    usePush: "Iniciar sesión con el documento nacional de identidad",
    idLabel: "Documento nacional de identidad",
    idHint: "Se enviará una notificación a su teléfono. También sirve el número civil de 12 dígitos.",
    idEmpty: "Introduzca su documento nacional de identidad",
    idLatin: "Escriba las letras en cirílico: УБ12345678",
    idBad: "El número tiene 2 letras y 8 dígitos: УБ12345678",
    push: "Enviar notificación",
    pushing: "Enviando",
    rateLimited: "Demasiados intentos. Espere un momento e inténtelo de nuevo",
    pushFailed: "No se pudo enviar la notificación. Inténtelo de nuevo",
    waitText: "Si el código de su teléfono coincide, introduzca el PIN1. Si no, rechace la solicitud.",
    waiting: "Esperando",
    back: "Atrás",
    left: "La solicitud caduca en:",
    stale: "Código QR caducado",
    refresh: "Actualizar",
    offline: "Conexión perdida. Compruebe su conexión a Internet; reconectando.",
    expiredTitle: "Inicio de sesión caducado",
    refusedTitle: "Inicio de sesión rechazado",
    failedTitle: "No se pudo iniciar sesión",
    failedText: "La verificación ha fallado. Inténtelo de nuevo.",
    unavailable: "No se pudo conectar con el servicio eID. Inténtelo de nuevo en breve.",
    callbackTitle: "Continúe en el navegador del teléfono",
    callbackText: "Verificación correcta. El inicio de sesión continúa en la ventana del navegador que abrió la aplicación.",
    retry: "Reintentar",
    success: "Sesión iniciada",
    sent: (vc: string) => `Notificación enviada. Código en su teléfono ${vc.split("").join(" ")}`,
    minutes: (n: number) => (n === 1 ? "Queda 1 minuto" : `Quedan ${n} minutos`),
    busy: (n: number) => `Servicio ocupado: inténtelo de nuevo en ${n} s`,
  },
  ar: {
    button: "تسجيل الدخول عبر eID",
    title: "تسجيل الدخول عبر eID",
    close: "إغلاق",
    loading: "جارٍ التحميل",
    qrAlt: "رمز QR لتسجيل الدخول — امسحه بتطبيق eID Mongolia على هاتفك",
    steps: ["افتح تطبيق eID Mongolia على هاتفك", "امسح رمز QR", "أدخل PIN1"],
    vcLabel: "رمز التحقق",
    or: "أو",
    usePush: "تسجيل الدخول برقم الهوية الوطنية",
    idLabel: "رقم الهوية الوطنية",
    idHint: "سيصل إشعار إلى هاتفك. يمكن أيضًا استخدام الرقم المدني المكوّن من 12 رقمًا.",
    idEmpty: "أدخل رقم الهوية الوطنية",
    idLatin: "اكتب الحروف بالأبجدية السيريلية: УБ12345678",
    idBad: "رقم الهوية يتكوّن من حرفين و8 أرقام: УБ12345678",
    push: "إرسال إشعار",
    pushing: "جارٍ الإرسال",
    rateLimited: "محاولات كثيرة جدًا. انتظر قليلًا ثم أعد المحاولة",
    pushFailed: "تعذّر إرسال الإشعار. أعد المحاولة",
    waitText: "إذا تطابق الرمز على هاتفك فأدخل PIN1، وإلا فارفض الطلب.",
    waiting: "في الانتظار",
    back: "رجوع",
    left: "تنتهي صلاحية الطلب خلال:",
    stale: "انتهت صلاحية رمز QR",
    refresh: "تحديث",
    offline: "انقطع الاتصال. تحقّق من اتصالك بالإنترنت — جارٍ إعادة الاتصال.",
    expiredTitle: "انتهت مهلة تسجيل الدخول",
    refusedTitle: "تم رفض تسجيل الدخول",
    failedTitle: "تعذّر تسجيل الدخول",
    failedText: "فشل التحقق. أعد المحاولة.",
    unavailable: "تعذّر الاتصال بخدمة eID. أعد المحاولة بعد قليل.",
    callbackTitle: "تابع في متصفح الهاتف",
    callbackText: "تم التحقق بنجاح. يتابع تسجيل الدخول في نافذة المتصفح التي فتحها التطبيق.",
    retry: "إعادة المحاولة",
    success: "تم تسجيل الدخول",
    sent: (vc: string) => `تم إرسال الإشعار. الرمز على هاتفك ${vc.split("").join(" ")}`,
    minutes: (n: number) => `الوقت المتبقي: ${n} دقيقة`,
    busy: (n: number) => `الخدمة مشغولة — أعد المحاولة بعد ${n} ث`,
  },
};

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

/**
 * `eid-login-error` event-ийн detail. `error` — хуучин талбар (код эсвэл төрөл); `status` — start-ийн HTTP статус (сүлжээний
 * алдаанд 0, start-аас бусад алдаанд null); `code` — хариуны `error`/`code` (эсвэл `NETWORK`, `HTTP_<статус>`);
 * `retryAfter` — Retry-After (секунд) эсвэл null.
 */
export interface EidLoginErrorDetail {
  error: string;
  status: number | null;
  code: string;
  retryAfter: number | null;
}

/** 429/503-д Retry-After алга бол хүлээх секунд. */
const BUSY_DEFAULT_S = 30;

/** Retry-After (секунд эсвэл HTTP-date) → секунд; алга/буруу бол null. */
function retryAfterOf(r: Response): number | null {
  const v = r.headers.get("Retry-After")?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

/** start-ийн алдааны хариунаас detail (body нь аль хэдийн задалсан байж болно). */
async function startErrorOf(r: Response | null, body?: Record<string, unknown>): Promise<EidLoginErrorDetail> {
  if (!r) return { error: "NETWORK", status: 0, code: "NETWORK", retryAfter: null };
  const b = body ?? ((await r.json().catch(() => ({}))) as Record<string, unknown>);
  const c = typeof b.error === "string" ? b.error : typeof b.code === "string" ? b.code : `HTTP_${r.status}`;
  return { error: c, status: r.status, code: c, retryAfter: retryAfterOf(r) };
}

const isBusy = (d: EidLoginErrorDetail): boolean => d.status === 429 || d.status === 503;

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
  /** Товчны текст (анхдагч: i18n «eID-ээр нэвтрэх» / «Log in with eID»). `""` → зөвхөн лого (`variant: "icon"`-той ижил). */
  label?: string;
  /** eid (анхдагч — eID лого) | none (логогүй). */
  icon?: "eid" | "none";
  /** default (лого + текст) | icon (зөвхөн лого, дөрвөлжин; текст нь aria-label болно). */
  variant?: "default" | "icon";
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
.logo .m-a { fill: #fff; }
.logo .m-l { stroke: #0A1631; }
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
.logo { display: block; flex: none; width: 20px; height: 20px; }
.logo .m-a { fill: #0A1631; }
.logo .m-l { stroke: #fff; }
.trigger.icon-only .logo { width: 24px; height: 24px; }
.trigger.icon-only { width: 44px; height: 44px; padding: 0; }
.backdrop { position: fixed; inset: 0; z-index: 2147483000; background: hsl(222 47% 11% / 0.5); display: flex; align-items: center;
  justify-content: center; padding: 16px; overflow-y: auto; }
.dialog { position: relative; width: 100%; max-width: 26rem; max-height: calc(100dvh - 32px); overflow-y: auto; background: var(--_eid-bg);
  color: var(--_eid-fg); border: 1px solid var(--_eid-border); border-radius: var(--_eid-radius-lg); padding: 24px; font-size: 0.875rem; line-height: 1.5rem; }
@media (max-width: 639px) { .dialog { padding: 16px; } }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.head .logo { width: 24px; height: 24px; }
.head h2 { flex: 1; font-size: 1.125rem; line-height: 1.75rem; font-weight: 600; }
.x { width: 36px; height: 36px; border: 0; border-radius: var(--_eid-radius); background: transparent; color: var(--_eid-fg-muted); cursor: pointer; font-size: 1.25rem; line-height: 1; }
.x:hover { background: var(--_eid-bg-muted); color: var(--_eid-fg); }
.qr { position: relative; width: 256px; max-width: 100%; aspect-ratio: 1; margin: 0 auto; border: 1px solid var(--_eid-border);
  border-radius: var(--_eid-radius-lg); background: #fff; overflow: hidden; }
.qr svg { display: block; width: 100%; height: 100%; }
.qr.stale svg { opacity: 0.12; }
.qr-stale { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  color: hsl(222 47% 11%); font-weight: 500; }
.qr-vc { margin-top: 12px; text-align: center; }
.vc-label { font-size: 0.8125rem; color: var(--_eid-fg-subtle); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; letter-spacing: 0.08em; color: var(--_eid-fg-muted); }
.steps { margin-top: 16px; padding: 0; list-style: none; counter-reset: st; display: grid; gap: 8px; }
.steps li { counter-increment: st; display: flex; align-items: center; gap: 12px; }
.steps li::before { content: counter(st); flex: none; width: 24px; height: 24px; border-radius: 9999px; background: var(--_eid-accent-subtle);
  color: var(--_eid-accent-subtle-fg); display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 600; }
.or { display: flex; align-items: center; gap: 12px; margin: 24px 0; color: var(--_eid-fg-subtle); font-size: 0.8125rem; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--_eid-border); }
.disc-btn .chev { width: 16px; height: 16px; flex: none; transition: transform 200ms cubic-bezier(0,0,0.2,1); }
.disc-btn[aria-expanded="true"] .chev { transform: rotate(180deg); }
.disc { margin: 0 -4px; display: grid; grid-template-rows: 0fr; transition: grid-template-rows 200ms cubic-bezier(0,0,0.2,1); }
.disc.open { grid-template-rows: 1fr; }
.disc > div { min-height: 0; overflow: hidden; visibility: hidden; transition: visibility 0s linear 200ms; }
.disc.open > div { visibility: visible; transition-delay: 0s; }
.disc form { padding: 16px 4px 4px; }
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
.vc { font: 700 2rem/2.5rem ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; letter-spacing: 0.16em;
  padding-left: 0.16em; color: var(--_eid-fg); }
.vc:focus, h2:focus { outline: none; }
.text { margin-top: 12px; color: var(--_eid-fg-muted); }
.pending { margin-top: 16px; display: inline-flex; align-items: center; gap: 8px; color: var(--_eid-fg-muted); }
.end .btn, .center .btn { margin-top: 24px; }
.spinner { width: 16px; height: 16px; flex: none; border: 2px solid currentColor; border-right-color: transparent; border-radius: 9999px; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.netwarn { margin-top: 16px; padding: 8px 12px; border: 1px solid var(--_eid-warning-border); border-radius: var(--_eid-radius); background: var(--_eid-warning-bg);
  color: var(--_eid-warning-fg); font-size: 0.8125rem; }
.meta { margin-top: 4px; text-align: center; font-size: 0.8125rem; color: var(--_eid-fg-subtle); }
.meta.low, .meta.low .mono { color: var(--_eid-warning-fg); }
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

/** eID emblem — inline SVG; theme-ийн өнгө нь `.m-a` / `.m-l` class-аар shadow CSS-ээс (light / DARK_CSS). */
function logo(attrs: Record<string, string> = {}): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ class: "logo", viewBox: EID_LOGO_VIEWBOX, "aria-hidden": "true", focusable: "false", ...attrs })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, a] of EID_LOGO_SHAPES) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

/** Доош заасан сум (lucide chevron-down) — дэлгэгдэх товчинд. */
function chevron(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ class: "chev", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  svg.append(path);
  return svg;
}

const Base: typeof HTMLElement = typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/** `<eid-login-button>` — атрибут: start-url, status-url, lang (mn|en|ru|zh|fr|es|ar; бусад → mn), mode (auto|qr|app), theme (auto|light|dark), success-url,
 *  label (товчны текст), icon (eid|none), variant (default|icon), aria-label. */
export class EidLoginButton extends Base {
  static readonly observedAttributes = ["lang", "theme", "label", "icon", "variant", "aria-label"];
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
  private warned = false;

  private get uiLang(): Lang {
    return resolveEidLang(this.getAttribute("lang"));
  }
  private get t(): Texts {
    return T[this.uiLang];
  }
  /** Shadow доторх бичлэгийн чиглэл: ar → rtl, бусад → ltr (хуудсын dir-ээс үл хамаарна). */
  private get uiDir(): "rtl" | "ltr" {
    return this.uiLang === "ar" ? "rtl" : "ltr";
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
      this.renderTrigger();
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
    if (this.trigger) this.renderTrigger();
  }

  /** Trigger-ийн агуулга: label / icon / variant / aria-label-аас. Хоосон товч хэзээ ч үүсгэхгүй. */
  private renderTrigger(): void {
    const label = this.getAttribute("label");
    const hasIcon = this.getAttribute("icon") !== "none";
    let iconOnly = this.getAttribute("variant") === "icon" || label === "";
    const text = label || this.t.button;
    if (iconOnly && !hasIcon) {
      iconOnly = false;
      if (!this.warned) {
        this.warned = true;
        console.warn('<eid-login-button>: icon="none" ба текстгүй (variant="icon" эсвэл label="") — анхдагч текстийг харуулав.');
      }
    }
    // Emblem-д үсэг алга тул текст үргэлж бүтэн: [emblem] eID-ээр нэвтрэх.
    const nodes: Node[] = [];
    if (hasIcon) nodes.push(logo({ part: "icon" }));
    if (!iconOnly) nodes.push(el("span", { part: "label" }, text));
    this.trigger.replaceChildren(...nodes);
    this.trigger.classList.toggle("icon-only", iconOnly);
    this.trigger.setAttribute("dir", this.uiDir);
    // Зөвхөн-лого үед (лого aria-hidden) нэрийг aria-label-аар өгнө.
    const aria = this.getAttribute("aria-label") || (iconOnly ? text : null);
    if (aria) this.trigger.setAttribute("aria-label", aria);
    else this.trigger.removeAttribute("aria-label");
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
      u.searchParams.set("lang", this.uiLang);
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
    const dlg = el("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "eid-title", part: "dialog", dir: this.uiDir, lang: this.uiLang });
    const head = el("div", { class: "head" });
    const x = el("button", { type: "button", class: "x", "aria-label": this.t.close }, "×");
    x.addEventListener("click", () => this.close());
    const h2 = el("h2", { id: "eid-title" }, this.t.title);
    head.append(logo(), h2, x);
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
    const items = Array.from(this.backdrop.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.closest("[hidden], [inert]"));
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
        body: JSON.stringify({ ...body, lang: this.uiLang }),
      });
    } catch {
      if (gen === this.gen && body.mode === "qr") void startErrorOf(null).then((d) => this.end("unavailable", d));
      return null;
    }
    if (gen !== this.gen) return null;
    if (body.mode === "push") return r;
    if (!r.ok) {
      const d = await startErrorOf(r);
      if (gen === this.gen) this.end(isBusy(d) ? "busy" : "unavailable", d);
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
      const vc = el("div", { class: "qr-vc" });
      vc.append(el("p", { class: "vc-label", id: "eid-vc-label" }, t.vcLabel), el("p", { class: "vc" }, s.vc));
      nodes.push(vc);
    }
    nodes.push(this.meta());
    const steps = el("ol", { class: "steps" });
    for (const st of t.steps) steps.append(el("li", {}, st));
    nodes.push(steps, el("div", { class: "or", role: "separator", "aria-label": t.or }, t.or), ...this.pushToggle());
    this.netwarn = el("p", { class: "netwarn", role: "status", hidden: "" }, t.offline);
    nodes.push(this.netwarn);
    this.view(...nodes);
  }

  private leftEl: HTMLSpanElement | null = null;

  private meta(): HTMLElement {
    const p = el("p", { class: "meta" }, this.t.left + " ");
    this.leftEl = el("span", { class: "mono", role: "timer", "aria-live": "off" }, "-:--");
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
      this.leftEl.textContent = `${m}:${s < 10 ? "0" : ""}${s}`;
      this.leftEl.parentElement!.classList.toggle("low", this.left <= 30);
      // Дэлгэц уншигчид минут тутам л (секунд тутам биш).
      if (this.left > 0 && s === 0 && this.left !== seconds) this.say(this.t.minutes(m));
    };
    render();
    if (seconds < 0) return;
    this.tick = setInterval(() => {
      this.left -= 1;
      render();
      if (this.left <= 0) this.end("expired");
    }, 1000) as unknown as number;
  }

  /** «Регистрийн дугаараар нэвтрэх» товч + ижил цонхонд доошоо дэлгэгдэх push хэсэг (QR, код харагдсаар; QR poll үргэлжилнэ). */
  private pushToggle(): [HTMLButtonElement, HTMLDivElement] {
    const toggle = el("button", { type: "button", class: "btn btn-outline disc-btn", "aria-expanded": "false", "aria-controls": "eid-push" });
    toggle.append(el("span", {}, this.t.usePush), chevron());
    const disc = el("div", { class: "disc", id: "eid-push" });
    const inner = el("div", { inert: "" });
    const form = this.pushForm();
    inner.append(form);
    disc.append(inner);
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      disc.classList.toggle("open", open);
      inner.toggleAttribute("inert", !open);
      if (open) form.querySelector("input")?.focus();
    });
    return [toggle, disc];
  }

  private pushForm(): HTMLFormElement {
    const t = this.t;
    const form = el("form", { novalidate: "" });
    const field = el("div", { class: "field" });
    const input = el("input", {
      id: "eid-id", name: "idCode", type: "text", autocapitalize: "characters", autocomplete: "off", autocorrect: "off",
      spellcheck: "false", maxlength: "14", placeholder: "УБ12345678", "aria-describedby": "eid-id-hint eid-id-err", dir: "ltr",
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
        if (!r) {
          this.emitError(await startErrorOf(null));
          return setErr(t.pushFailed);
        }
        const b = (await r.json().catch(() => ({}))) as EidLoginStatus;
        if (r.ok && b.vc) return this.showWait(b);
        const d = await startErrorOf(r, b as unknown as Record<string, unknown>);
        this.emitError(d);
        if (isBusy(d)) {
          btn.disabled = true;
          return this.countdown(gen, d.retryAfter ?? BUSY_DEFAULT_S, (n) => setErr(n > 0 ? t.busy(n) : ""), () => (btn.disabled = false));
        }
        if (r.status === 400) return setErr(t.idBad);
        setErr(t.pushFailed);
      });
    });
    return form;
  }

  private showWait(s: EidLoginStatus): void {
    const t = this.t;
    const c = el("div", { class: "center" });
    c.append(el("h2", { class: "sr-only" }, t.waiting), el("p", { class: "vc-label", id: "eid-vc-label" }, t.vcLabel));
    const vc = el("p", { class: "vc", tabindex: "-1", "aria-labelledby": "eid-vc-label", "aria-describedby": "eid-wait" }, s.vc ?? "");
    const pending = el("p", { class: "pending" });
    pending.append(el("span", { class: "spinner", "aria-hidden": "true" }), el("span", {}, t.waiting));
    const back = el("button", { type: "button", class: "btn btn-outline" }, t.back);
    back.addEventListener("click", () => this.open());
    this.netwarn = el("p", { class: "netwarn", role: "status", hidden: "" }, t.offline);
    c.append(vc, this.meta(), el("p", { class: "text", id: "eid-wait" }, t.waitText), pending, back, this.netwarn);
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

  private emitError(detail: EidLoginErrorDetail): void {
    this.dispatchEvent(new CustomEvent<EidLoginErrorDetail>("eid-login-error", { detail, bubbles: true, composed: true }));
  }

  /** n секундээс 0 хүртэл секунд тутам show(n); 0 болоход done(). Цонх хаагдвал (gen өөрчлөгдвөл) зогсоно. */
  private countdown(gen: number, n: number, show: (n: number) => void, done: () => void): void {
    clearInterval(this.tick);
    show(n);
    if (n <= 0) return done();
    this.tick = setInterval(() => {
      if (gen !== this.gen) return clearInterval(this.tick);
      n--;
      show(n);
      if (n <= 0) {
        clearInterval(this.tick);
        done();
      }
    }, 1000) as unknown as number;
  }

  private end(kind: "expired" | "refused" | "failed" | "unavailable" | "busy" | "callback", error?: string | EidLoginErrorDetail): void {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.gen++;
    const t = this.t;
    const titles = {
      expired: t.expiredTitle, refused: t.refusedTitle, failed: t.failedTitle, unavailable: t.failedTitle, busy: t.failedTitle, callback: t.callbackTitle,
    };
    const c = el("div", { class: "end", role: "alert" });
    const h = el("h2", { tabindex: "-1" }, titles[kind]);
    c.append(h);
    if (kind === "failed") c.append(el("p", { class: "text" }, t.failedText));
    if (kind === "unavailable") c.append(el("p", { class: "text" }, t.unavailable));
    if (kind === "callback") c.append(el("p", { class: "text" }, t.callbackText));
    if (kind !== "callback") {
      const retry = el("button", { type: "button", class: "btn btn-primary" }, t.retry);
      retry.addEventListener("click", () => this.open());
      if (kind === "busy") {
        const msg = el("p", { class: "text busy", role: "status" });
        c.append(msg);
        retry.disabled = true;
        const d = error as EidLoginErrorDetail;
        this.countdown(this.gen, d.retryAfter ?? BUSY_DEFAULT_S, (n) => (msg.textContent = n > 0 ? t.busy(n) : ""), () => {
          retry.disabled = false;
          msg.hidden = true;
        });
      }
      c.append(retry);
      this.emitError(
        typeof error === "object" ? error : { error: error ?? kind.toUpperCase(), status: null, code: error ?? kind.toUpperCase(), retryAfter: null },
      );
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
  if (opts.label != null) b.setAttribute("label", opts.label);
  if (opts.icon) b.setAttribute("icon", opts.icon);
  if (opts.variant) b.setAttribute("variant", opts.variant);
  if (opts.onSuccess) b.addEventListener("eid-login-success", (e) => opts.onSuccess!((e as CustomEvent<EidLoginStatus>).detail));
  if (opts.onError) b.addEventListener("eid-login-error", (e) => opts.onError!((e as CustomEvent<{ error: string }>).detail.error));
  target.append(b);
  return b;
}

defineEidLoginButton();
