// «eID-ээр нэвтрэх» — OpenID Connect (Authorization Code + PKCE S256) RP тал. Зөвхөн backend (client_secret).
//
// Гэрээ: ca-eidmongolia-mn `docs/OIDC.md` (issuer https://login.eidmongolia.mn). Нэвтрэх хуудсыг (QR / push /
// утасны хөтчөөс шууд апп) eID сервер өөрөө харуулна; RP зөвхөн:
//   1. createAuthorization() → state/nonce/codeVerifier-ийг httpOnly cookie/session-д хадгалаад url руу 302;
//   2. handleCallback(callbackUrl, хадгалсан) → state тулгаж, code-ийг id_token болгон сольж, ES256-аар шалгана.
// Шинэ хамааралгүй: global fetch + WebCrypto (globalThis.crypto.subtle).

import { timingSafeEqual } from "node:crypto";
import { OIDC_EXPECT } from "./contract.js";
import { EidError, NetworkError } from "./errors.js";

/** eID-ийн OIDC issuer (төгсгөлд `/` байхгүй). */
export const EID_OIDC_ISSUER = "https://login.eidmongolia.mn";

/** `acr` утгууд — иргэний гэрчилгээний бодит түвшин. */
export const EID_ACR_QUALIFIED = "urn:eidmongolia:loa:qualified";
export const EID_ACR_ADVANCED = "urn:eidmongolia:loa:advanced";

const CLOCK_SKEW_S = 60;
const CACHE_MS = 60 * 60 * 1000; // discovery/JWKS — eID шинэ түлхүүрийг ≥ 1 цаг урьдчилж зарлана
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * OIDC алдааны код. Authorize redirect (RFC 6749 §4.1.2.1) ба token endpoint (§5.2)-ийн стандарт кодууд, мөн
 * SDK-ийн өөрийн шалгалтын кодууд:
 * - `state_mismatch` — callback-ийн `state` хадгалсантай таарсангүй (CSRF / өөр tab / cookie дууссан) → дахин эхлүүл;
 * - `invalid_callback` — `code` алга / хэт урт, эсвэл `iss` параметр өөр;
 * - `invalid_id_token` — id_token-ий гарын үсэг / iss / aud / exp / iat / nonce шалгалт унасан (ИТГЭХГҮЙ);
 * - `discovery_failed` — discovery/JWKS буруу эсвэл issuer таарахгүй.
 *
 * `access_denied` = иргэн татгалзсан, нэвтрэлтийн хугацаа дууссан, эсвэл гэрчилгээний шалгалт унасан → «дахин оролд».
 */
export type EidOidcErrorCode =
  | "access_denied"
  | "login_required"
  | "invalid_request"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_response_type"
  | "request_not_supported"
  | "temporarily_unavailable"
  | "server_error"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "state_mismatch"
  | "invalid_callback"
  | "invalid_id_token"
  | "discovery_failed";

const KNOWN_CODES = new Set<string>([
  "access_denied",
  "login_required",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_response_type",
  "request_not_supported",
  "temporarily_unavailable",
  "server_error",
  "invalid_client",
  "invalid_grant",
  "unsupported_grant_type",
]);

/**
 * OIDC урсгалын алдаа. `code`-оор салгана. `description` нь серверийн `error_description` — логт л,
 * хэрэглэгчид шууд харуулахгүй.
 */
export class EidOidcError extends EidError {
  constructor(
    public readonly code: EidOidcErrorCode,
    message: string,
    public readonly description?: string,
  ) {
    super(message);
  }
}

export interface EidOidcClientConfig {
  /** RP UUID (`relyingPartyUUID`). */
  clientId: string;
  /** RP API secret (`rp_sk_…`) — зөвхөн backend-д. */
  clientSecret: string;
  /** Бүртгэлтэй redirect URI — тэмдэгт бүрээрээ таарах ёстой. */
  redirectUri: string;
  /** Анхдагч {@link EID_OIDC_ISSUER}. */
  issuer?: string;
  /** Анхдагч `"openid"`. Иргэний ETSI дугаар хэрэгтэй бол `"openid pnomn"` (RP-д `PNOMN` эрх). */
  scope?: string;
  /** HTTP timeout (мс), анхдагч 10000. */
  timeoutMs?: number;
  /** fetch орлуулагч (тест). */
  fetchImpl?: typeof fetch;
}

export interface EidOidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  [k: string]: unknown;
}

export interface CreateAuthorizationOptions {
  /** Энэ хүсэлтэд scope-ыг дарна. */
  scope?: string;
  /**
   * `touch` (анхдагч) — утасны хөтчөөс шууд eID апп; `page` — үргэлж нэвтрэх хуудас (QR / push), ж: таблет киоск.
   */
  display?: "page" | "touch";
}

/** RP-ийн хадгалах ёстой гүйлгээ — httpOnly cookie / server session-д (браузерийн JS-д биш). */
export interface EidAuthorization {
  /** Хөтчийг энэ рүү 302. */
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** createAuthorization-аас хадгалсан утгууд. */
export interface EidCallbackChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** id_token-ий claim-ууд (`docs/OIDC.md` §4). */
export interface EidIdTokenClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  /** Pairwise — RP тус бүрд өөр, иргэнд тогтмол. Хэрэглэгчийг ҮҮГЭЭР таньна. */
  sub: string;
  exp: number;
  iat: number;
  nonce: string;
  /** Иргэн баталгаажуулсан мөч (Unix сек). */
  auth_time: number;
  /** {@link EID_ACR_QUALIFIED} эсвэл {@link EID_ACR_ADVANCED}. */
  acr: string;
  /** Гэрчилгээний GIVENNAME — латин (ICAO, том үсэг). */
  given_name: string;
  /** Гэрчилгээний SURNAME (эцэг/эхийн нэр) — латин. */
  family_name: string;
  /** Нэр — кирилл (бүртгэлд байхгүй бол алга). */
  given_name_mn?: string;
  /** Эцэг/эхийн нэр — кирилл (бүртгэлд байхгүй бол алга). */
  family_name_mn?: string;
  /** `PNOMN-<иргэний дугаар>` — зөвхөн `pnomn` scope + `PNOMN` эрхтэй үед. */
  pnomn?: string;
  [k: string]: unknown;
}

export interface EidCallbackResult {
  claims: EidIdTokenClaims;
  idToken: string;
}

interface Jwk {
  kty?: string;
  crv?: string;
  kid?: string;
  use?: string;
  alg?: string;
  x?: string;
  y?: string;
}

export class EidOidcClient {
  readonly issuer: string;
  private readonly scope: string;
  private discovery?: { at: number; d: Promise<EidOidcDiscovery> };
  private jwks?: { at: number; keys: Promise<Jwk[]> };

  constructor(private readonly cfg: EidOidcClientConfig) {
    if (!cfg.clientId) throw new EidError("EidOidcClient: clientId хоосон");
    if (!cfg.clientSecret) throw new EidError("EidOidcClient: clientSecret хоосон");
    if (!/^https:\/\//.test(cfg.redirectUri ?? "")) throw new EidError("EidOidcClient: redirectUri https:// байх ёстой");
    this.issuer = (cfg.issuer ?? EID_OIDC_ISSUER).replace(/\/+$/, "");
    this.scope = cfg.scope ?? OIDC_EXPECT.defaultScope;
  }

  /** Discovery document (1 цаг cache). `issuer` нь тохиргоотой яг таарах ёстой (OIDC Discovery §4.3). */
  discover(): Promise<EidOidcDiscovery> {
    const c = this.discovery;
    if (c && Date.now() - c.at < CACHE_MS) return c.d;
    const d = this.fetchDiscovery();
    this.discovery = { at: Date.now(), d };
    d.catch(() => {
      if (this.discovery?.d === d) this.discovery = undefined; // алдааг cache-лэхгүй
    });
    return d;
  }

  private async fetchDiscovery(): Promise<EidOidcDiscovery> {
    const d = (await this.getJson(this.issuer + "/.well-known/openid-configuration")) as EidOidcDiscovery;
    if (!d || d.issuer !== this.issuer) {
      throw new EidOidcError("discovery_failed", `OIDC discovery-ийн issuer таарахгүй (хүлээсэн ${this.issuer})`);
    }
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof d[k] !== "string" || !d[k].startsWith("https://")) {
        throw new EidOidcError("discovery_failed", `OIDC discovery: ${k} буруу`);
      }
    }
    return d;
  }

  /**
   * Authorize URL + санамсаргүй state / nonce / PKCE codeVerifier. RP буцаасан `state`, `nonce`, `codeVerifier`-ийг
   * хөтчийн session-тэй холбож (httpOnly cookie эсвэл server session) хадгалаад хөтчийг `url` руу 302 хийнэ.
   */
  async createAuthorization(opts: CreateAuthorizationOptions = {}): Promise<EidAuthorization> {
    const d = await this.discover();
    const state = randomB64url(32);
    const nonce = randomB64url(32);
    const codeVerifier = randomB64url(32); // 43 тэмдэгт
    const u = new URL(d.authorization_endpoint);
    const p = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: opts.scope ?? this.scope,
      state,
      nonce,
      code_challenge: await pkceChallenge(codeVerifier),
      code_challenge_method: OIDC_EXPECT.pkceMethod,
    });
    if (opts.display) p.set("display", opts.display);
    u.search = p.toString();
    return { url: u.toString(), state, nonce, codeVerifier };
  }

  /**
   * redirect_uri руу ирсэн callback-ийг шийднэ: state тулгах → `error` бол {@link EidOidcError} → code солих →
   * id_token шалгах. `input` — бүтэн callback URL, харьцангуй зам (`/cb?code=…`) эсвэл query (`URLSearchParams` / `code=…&state=…`); зөвхөн query-г уншина.
   * Амжилтгүй бүх тохиолдолд {@link EidOidcError} (эсвэл {@link NetworkError}) шиднэ.
   */
  async handleCallback(input: string | URL | URLSearchParams, checks: EidCallbackChecks): Promise<EidCallbackResult> {
    const q = callbackParams(input);
    const state = q.get("state") ?? "";
    // state таарахгүй бол code-ийг огт солихгүй (RFC 6749 §10.12, OIDC.md §3.4).
    if (!checks.state || !timingSafeEqualStr(state, checks.state)) {
      throw new EidOidcError("state_mismatch", "OIDC state таарсангүй — нэвтрэлтийг дахин эхлүүлнэ үү");
    }
    const iss = q.get("iss");
    if (iss !== null && iss !== this.issuer) {
      throw new EidOidcError("invalid_callback", "OIDC callback-ийн iss таарахгүй");
    }
    const err = q.get("error");
    if (err) {
      const code = (KNOWN_CODES.has(err) ? err : "server_error") as EidOidcErrorCode;
      throw new EidOidcError(code, `eID нэвтрэлт амжилтгүй: ${code}`, q.get("error_description") ?? undefined);
    }
    const code = q.get("code") ?? "";
    if (code === "" || code.length > 512) throw new EidOidcError("invalid_callback", "OIDC callback-д code алга");
    const idToken = await this.exchangeCode(code, checks.codeVerifier);
    const claims = await this.verifyIdToken(idToken, { nonce: checks.nonce });
    return { claims, idToken };
  }

  /** `POST token_endpoint` (client_secret_basic, RFC 6749 §2.3.1) → id_token. */
  private async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const d = await this.discover();
    const basic = Buffer.from(formEncode(this.cfg.clientId) + ":" + formEncode(this.cfg.clientSecret)).toString("base64");
    const res = await this.fetch(d.token_endpoint, {
      method: "POST",
      headers: {
        Authorization: "Basic " + basic,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.cfg.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    });
    let j: { id_token?: unknown; error?: unknown; error_description?: unknown } = {};
    try {
      j = (await res.json()) as typeof j;
    } catch {
      // JSON биш (proxy) — доор статусаар
    }
    if (!res.ok) {
      const e = typeof j.error === "string" && KNOWN_CODES.has(j.error) ? (j.error as EidOidcErrorCode) : "server_error";
      throw new EidOidcError(
        e,
        `OIDC token ${res.status}: ${e}`,
        typeof j.error_description === "string" ? j.error_description : undefined,
      );
    }
    if (typeof j.id_token !== "string" || j.id_token === "") {
      throw new EidOidcError("server_error", "OIDC token хариунд id_token алга");
    }
    return j.id_token;
  }

  /**
   * id_token шалгана: JWKS (`kid`, cache; танихгүй kid → нэг удаа дахин татна) ES256 гарын үсэг, `iss`, `aud`
   * (= clientId; олон aud бол `azp`), `exp`/`iat` (±60 сек), `nonce`. Амжилтгүй бол `invalid_id_token`.
   */
  async verifyIdToken(idToken: string, opts: { nonce: string }): Promise<EidIdTokenClaims> {
    const bad = (why: string) => new EidOidcError("invalid_id_token", `id_token: ${why}`);
    const parts = idToken.split(".");
    if (parts.length !== 3) throw bad("хэлбэр буруу");
    const header = decodeJsonPart(parts[0]!);
    const payload = decodeJsonPart(parts[1]!);
    if (!header || !payload) throw bad("хэлбэр буруу");
    if (header.alg !== OIDC_EXPECT.idTokenAlg) throw bad("alg ES256 биш");
    const kid = typeof header.kid === "string" ? header.kid : "";
    if (!kid) throw bad("kid алга");

    const pick = (ks: Jwk[]) =>
      ks.find(
        (k) =>
          k.kid === kid &&
          k.kty === "EC" &&
          k.crv === "P-256" &&
          (k.use === undefined || k.use === "sig") &&
          (k.alg === undefined || k.alg === "ES256"),
      );
    const jwk = pick(await this.keys(false)) ?? pick(await this.keys(true));
    if (!jwk || !jwk.x || !jwk.y) throw bad(`танихгүй kid ${kid}`);

    const sig = Buffer.from(parts[2]!, "base64url");
    if (sig.length !== 64) throw bad("гарын үсэг таарсангүй");
    let ok = false;
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      // JWS ES256 = r||s (64 байт) — WebCrypto-ийн хүлээдэг хэлбэр (DER биш).
      ok = await globalThis.crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        sig,
        new TextEncoder().encode(parts[0] + "." + parts[1]),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw bad("гарын үсэг таарсангүй");

    const c = payload as Partial<EidIdTokenClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (c.iss !== this.issuer) throw bad("iss таарахгүй");
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(this.cfg.clientId)) throw bad("aud таарахгүй");
    if (aud.length > 1 && c.azp !== this.cfg.clientId) throw bad("azp таарахгүй");
    if (typeof c.exp !== "number" || now > c.exp + CLOCK_SKEW_S) throw bad("хугацаа дууссан");
    if (typeof c.iat !== "number" || c.iat > now + CLOCK_SKEW_S) throw bad("iat ирээдүйд");
    if (typeof c.nonce !== "string" || !opts.nonce || !timingSafeEqualStr(c.nonce, opts.nonce)) throw bad("nonce таарахгүй");
    if (typeof c.sub !== "string" || c.sub === "") throw bad("sub алга");
    return c as EidIdTokenClaims;
  }

  private keys(force: boolean): Promise<Jwk[]> {
    const c = this.jwks;
    if (!force && c && Date.now() - c.at < CACHE_MS) return c.keys;
    const keys = this.discover().then(async (d) => {
      const j = (await this.getJson(d.jwks_uri)) as { keys?: unknown };
      return Array.isArray(j?.keys) ? (j.keys as Jwk[]) : [];
    });
    this.jwks = { at: Date.now(), keys };
    keys.catch(() => {
      if (this.jwks?.keys === keys) this.jwks = undefined;
    });
    return keys;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) throw new EidOidcError("discovery_failed", `OIDC ${res.status}: ${url}`);
    try {
      return await res.json();
    } catch {
      throw new EidOidcError("discovery_failed", `OIDC JSON биш: ${url}`);
    }
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.cfg.fetchImpl ?? fetch;
    try {
      return await f(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new NetworkError(`OIDC хүсэлт хугацаа хэтэрлээ: ${url}`);
      }
      throw new NetworkError(`OIDC сүлжээний алдаа (${url}): ${err.message}`);
    }
  }
}

/** PKCE S256: `BASE64URL(SHA-256(ASCII(code_verifier)))` (RFC 7636 §4.2). */
export async function pkceChallenge(codeVerifier: string): Promise<string> {
  const h = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return Buffer.from(h).toString("base64url");
}

function randomB64url(bytes: number): string {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** application/x-www-form-urlencoded (RFC 6749 Appendix B) — client_secret_basic-ийн id/secret-д. */
function formEncode(s: string): string {
  return new URLSearchParams({ v: s }).toString().slice(2);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function decodeJsonPart(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function callbackParams(input: string | URL | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return new URL(s).searchParams;
  // Харьцангуй зам (`/cb?code=…`, Express `req.originalUrl`) эсвэл зөвхөн query.
  const i = s.indexOf("?");
  return new URLSearchParams(i >= 0 ? s.slice(i + 1) : s);
}
