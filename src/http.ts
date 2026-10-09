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
    return this.json("POST", path, JSON.stringify(body), "application/json", timeoutMs);
  }

  get(path: string, timeoutMs?: number): Promise<unknown> {
    return this.json("GET", path, undefined, undefined, timeoutMs);
  }

  /** multipart/form-data POST (Content-Type-ийг boundary-тай нь fetch тавина). JSON хариу. */
  postMultipart(path: string, form: FormData, timeoutMs?: number): Promise<unknown> {
    return this.json("POST", path, form, undefined, timeoutMs);
  }

  /** GET — хариуг байтаар (ж: гарын үсэгтэй PDF). */
  async getBytes(path: string, timeoutMs?: number): Promise<Uint8Array> {
    const res = await this.send("GET", path, undefined, undefined, timeoutMs);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async json(
    method: "GET" | "POST",
    path: string,
    body: string | FormData | undefined,
    contentType: string | undefined,
    timeoutMs?: number,
  ): Promise<unknown> {
    const res = await this.send(method, path, body, contentType, timeoutMs);
    const text = await res.text();
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
      },
      body,
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
    if (res.status < 300) return res;

    const text = await res.text();
    const { error, code } = errorBody(text);
    if (res.status === 401) throw new AuthenticationError("API secret буруу эсвэл байхгүй (401)");
    if (res.status === 403) {
      throw new ForbiddenError(
        error ? `RP-API 403${code ? ` ${code}` : ""}: ${error}` : "IP allowlist эсвэл mTLS зөвшөөрөөгүй (403)",
        code,
      );
    }
    throw new ApiError(res.status, text, code);
  }
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
