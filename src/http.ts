// HTTP давхарга — бүх RP-API дуудлагад Bearer secret хавсаргаж, timeout тавьж, HTTP статусыг
// typed алдаа руу буулгана. mTLS (eIDAS qualified орчин)-д RP undici Dispatcher өгч болно.

import { AuthenticationError, ForbiddenError, ApiError, NetworkError } from "./errors.js";

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
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class Http {
  constructor(private readonly cfg: HttpConfig) {}

  post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    return this.request("POST", path, body, timeoutMs);
  }

  get(path: string, timeoutMs?: number): Promise<unknown> {
    return this.request("GET", path, undefined, timeoutMs);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const f = this.cfg.fetchImpl ?? fetch;
    const url = this.cfg.baseUrl + path;
    // init-ийг loose объектоор угсарна: undici-ийн `dispatcher` (mTLS) нь стандарт
    // RequestInit-д байхгүй тул fetch дуудахдаа cast хийнэ.
    const init: Record<string, unknown> = {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiSecret}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    if (this.cfg.dispatcher) init.dispatcher = this.cfg.dispatcher;

    let res: Response;
    try {
      res = await f(url, init as RequestInit);
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new NetworkError(`Хүсэлт хугацаа хэтэрлээ: ${method} ${path}`);
      }
      throw new NetworkError(`Сүлжээний алдаа (${method} ${path}): ${err.message}`);
    }

    const text = await res.text();
    if (res.status === 401) throw new AuthenticationError("API secret буруу эсвэл байхгүй (401)");
    if (res.status === 403) throw new ForbiddenError("IP allowlist эсвэл mTLS зөвшөөрөөгүй (403)");
    if (res.status >= 300) throw new ApiError(res.status, text);
    return text ? (JSON.parse(text) as unknown) : {};
  }
}
