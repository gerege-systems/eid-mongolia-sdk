// TSA/OCSP/CRL-ийн HTTP (Go reference pades/fetch.go). Хөтөчид http:// AIA/CDP-г зөвхөн eID-ийн allowlist хостод https
// болгоно (mixed content); бусад http:// URL-ийг татахгүй → LTV_UNAVAILABLE.

export const DEFAULT_TSA_URL = "https://tsa.timeserver.mn/";
const HTTP_TIMEOUT_MS = 10_000;
const MAX_HTTP_RESPONSE = 4 << 20;
const BROWSER_HTTPS = new Set(["ocsp.eidmongolia.mn", "crl.eidmongolia.mn", "tsa.timeserver.mn"]);
/**
 * WIRE.md §3: үндэсний CA-ийн (esign.gov.mn — http-only, CORS-гүй) CRL-ийг бүх платформд eID-ийн https толин хуулбараас
 * (CORS `*`). CRL-ийн гарын үсгийг олгогчоор шалгадаг тул толинд итгэх шаардлагагүй. Яг тэнцүү URL л.
 */
const CRL_MIRROR: Record<string, string> = {
  "http://esign.gov.mn/MNICA-2022.crl": "https://crl.eidmongolia.mn/MNICA-2022.crl",
  "http://esign.gov.mn/MNRCA-2021.crl": "https://crl.eidmongolia.mn/MNRCA-2021.crl",
};

export type FetchFn = (url: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array; redirect: "manual"; signal?: AbortSignal }) => Promise<{
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class Fetcher {
  private readonly cache = new Map<string, Uint8Array>();

  constructor(
    private readonly fetchFn: FetchFn,
    /** http → https (allowlist) — хөтчийн орчин. */
    private readonly upgrade: boolean,
  ) {}

  /** Татах URL: CRL толин хуулбар; хөтөчид http → https (allowlist); бусад үед хэвээр (Go url.String()-тэй ижил). */
  private target(raw: string): string {
    const mirror = CRL_MIRROR[raw];
    if (mirror) return mirror;
    const u = new URL(raw);
    if (u.protocol === "https:") return raw;
    if (u.protocol !== "http:") throw new Error(`URL scheme ${u.protocol} дэмжигдэхгүй`);
    if (!this.upgrade) return raw;
    if (!BROWSER_HTTPS.has(u.hostname)) throw new Error(`хөтөч: http URL нь https allowlist-д алга: ${u.hostname}`);
    u.protocol = "https:";
    return u.toString();
  }

  async do(method: "GET" | "POST", raw: string, contentType: string, body?: Uint8Array): Promise<Uint8Array> {
    const target = this.target(raw);
    if (method === "GET") {
      const hit = this.cache.get(target);
      if (hit) return hit;
    }
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS) : undefined;
    try {
      const res = await this.fetchFn(target, {
        method,
        headers: contentType ? { "Content-Type": contentType } : undefined,
        body,
        redirect: "manual",
        signal: ctl?.signal,
      });
      const out = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200 || out.length > MAX_HTTP_RESPONSE) throw new Error(`${target}: HTTP ${res.status}`);
      if (method === "GET") this.cache.set(target, out);
      return out;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Хөтөч (эсвэл Node биш) орчин. */
export function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown; process?: { versions?: { node?: string } } };
  return typeof g.window !== "undefined" || typeof g.process?.versions?.node !== "string";
}
