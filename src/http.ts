// HTTP давхарга — бүх RP-API дуудлагад Bearer secret хавсаргаж, timeout тавьж, HTTP статусыг
// typed алдаа руу буулгана. mTLS (eIDAS qualified орчин)-д RP undici Dispatcher өгч болно.

import {
  AuthenticationError,
  ForbiddenError,
  ApiError,
  NoSigningCertificateError,
  CertChoiceInvalidError,
  RequestInvalidError,
  QrTokenInvalidError,
  NetworkError,
  ResponseTooLargeError,
  maskPath,
  parseRetryAfter,
} from "./errors.js";

export interface HttpConfig {
  /** RP-API-ийн бүтэн суурь URL. Ж: https://rp.eidmongolia.mn */
  baseUrl: string;
  /** API secret (rp_sk_…) — Authorization: Bearer-д орно. */
  apiSecret: string;
  /** Дуудлагын timeout (мс). Default 15000. Long-poll нь өөрийн уртыг дамжуулна. */
  timeoutMs?: number;
  /**
   * undici Dispatcher — mTLS client cert тохируулахад. RP тал:
   *   new Agent({ connect: { cert, key, ca } })
   * Дамжуулсан бол fetch дуудлага бүрд хэрэглэнэ. Зөвхөн Node орчинд.
   */
  dispatcher?: unknown;
  /** Тест/custom орчинд fetch-ийг орлуулах (default — global fetch). */
  fetchImpl?: typeof fetch;
  /** `Accept-Language` header-ийн утга (ж: "en"); хоосон бол илгээхгүй. */
  language?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** JSON хариуны дээд хэмжээ — хэтэрвэл {@link ResponseTooLargeError} (таслахгүй). */
export const MAX_JSON_BYTES = 4 << 20;

export class Http {
  constructor(private readonly cfg: HttpConfig) {}

  post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    return this.json("POST", path, JSON.stringify(body), "application/json", timeoutMs);
  }

  /** {@link post} + HTTP статус (201 / 200-г ялгах: `POST /pdf/signatures`). */
  async postWithStatus(path: string, body: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown }> {
    const op = `POST ${maskPath(path)}`;
    const res = await this.send("POST", path, JSON.stringify(body), "application/json", timeoutMs);
    const text = new TextDecoder().decode(await readLimited(res, MAX_JSON_BYTES, op));
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : {} };
  }

  /** multipart/form-data POST (`/share`); Content-Type-ийг (boundary) fetch тавина. */
  postForm(path: string, form: FormData, timeoutMs?: number): Promise<unknown> {
    return this.json("POST", path, form, undefined, timeoutMs);
  }

  get(path: string, timeoutMs?: number): Promise<unknown> {
    return this.json("GET", path, undefined, undefined, timeoutMs);
  }

  private async json(
    method: "GET" | "POST",
    path: string,
    body: string | FormData | undefined,
    contentType: string | undefined,
    timeoutMs?: number,
  ): Promise<unknown> {
    const res = await this.send(method, path, body, contentType, timeoutMs);
    const text = new TextDecoder().decode(await readLimited(res, MAX_JSON_BYTES, `${method} ${maskPath(path)}`));
    return text ? (JSON.parse(text) as unknown) : {};
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body: string | FormData | undefined,
    contentType: string | undefined,
    timeoutMs?: number,
  ): Promise<Response> {
    const f = this.cfg.fetchImpl ?? fetch;
    const url = this.cfg.baseUrl + path;
    // init-ийг loose объектоор угсарна: undici-ийн `dispatcher` (mTLS) нь стандарт
    // RequestInit-д байхгүй тул fetch дуудахдаа cast хийнэ.
    const init: Record<string, unknown> = {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiSecret}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(this.cfg.language ? { "Accept-Language": this.cfg.language } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    if (this.cfg.dispatcher) init.dispatcher = this.cfg.dispatcher;

    let res: Response;
    // Алдааны текст/op-д иргэний дугаар (замын /etsi/{…}) орохгүй.
    const op = `${method} ${maskPath(path)}`;
    try {
      res = await f(url, init as RequestInit);
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new NetworkError(`Хүсэлт хугацаа хэтэрлээ: ${op}`, { op, timeout: true });
      }
      throw new NetworkError(`Сүлжээний алдаа (${op}): ${err.message.split(url).join(op)}`, { op, timeout: false });
    }
    if (res.status < 300) return res;

    const text = await res.text();
    const { error, code } = errorBody(text);
    const headers = res.headers;
    const retryAfterMs = parseRetryAfter(headers.get("Retry-After"));
    if (res.status === 401) {
      throw new AuthenticationError(`API secret буруу эсвэл байхгүй (401${code ? ` ${code}` : ""})`, { code, serverMessage: error, body: text, headers });
    }
    if (res.status === 403) {
      throw new ForbiddenError(
        error ? `RP-API 403${code ? ` ${code}` : ""}: ${error}` : "IP allowlist эсвэл mTLS зөвшөөрөөгүй (403)",
        code,
        { headers, retryAfterMs },
      );
    }
    const Typed =
      code === "NO_SIGNING_CERTIFICATE"
        ? NoSigningCertificateError
        : code === "CERT_CHOICE_INVALID"
          ? CertChoiceInvalidError
          : code === "REQUEST_INVALID"
            ? RequestInvalidError
            : code === "QR_TOKEN_INVALID"
              ? QrTokenInvalidError
              : ApiError;
    throw new Typed(res.status, text, code, { headers, retryAfterMs });
  }
}

/** Хариуны биеийг `limit` хүртэл уншина; Content-Length эсвэл бодит урт хэтэрвэл {@link ResponseTooLargeError}. */
async function readLimited(res: Response, limit: number, op: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(op, limit);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(op, limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Серверийн алдааны JSON `{"error","code"}` — JSON биш (proxy) бол хоосон. */
function errorBody(text: string): { error?: string; code?: string } {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    return {
      error: typeof o.error === "string" && o.error ? o.error : undefined,
      code: typeof o.code === "string" && o.code ? o.code : undefined,
    };
  } catch {
    return {};
  }
}
