// Гэрчилгээний AIA-д бичигдсэн OCSP responder-оос асуух RevocationChecker (Go SDK-ийн eid.NewOCSPChecker, eID порталын
// EID_OCSP-тэй ижил дүрэм; ялгаа: «good»-ийг тогтмол 5 мин кэшилнэ — Go min(CacheTTL, nextUpdate)-ээр). OCSP-ийн DER-ийг PAdES-ийн LTV-д ашигладаг задлагчаар (pades/ltv.ts) уншина.

import type { X509Certificate } from "node:crypto";
import { createHash } from "node:crypto";
import { intValue } from "./pades/asn1.js";
import { ocspRequest, parseOCSPFrom, sameCertKey } from "./pades/ltv.js";
import { OID, parseCertificate, type Certificate } from "./pades/x509.js";
import type { RevocationChecker, RevocationStatus } from "./validator.js";

export interface OcspCheckerOptions {
  /** fetch (тест/proxy). Анхдагч globalThis.fetch. Redirect дагахгүй ("manual"). */
  fetchImpl?: typeof fetch;
  /** Нэг асуултын хугацаа (мс). Анхдагч 2000 — иргэн poll дээр хүлээж байна. */
  timeoutMs?: number;
  /** Цаг (мс, тест). Анхдагч Date.now. */
  now?: () => number;
}

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 1024;
const MAX_BYTES = 16 << 10;
const CLOCK_SKEW_MS = 5 * 60_000;
// CA хариу бүрийг шинээр зурдаг (thisUpdate = now, nextUpdate = +24 ц); энэ хязгаар нь цуцлалтаас өмнө авсан "good"-ийг
// plain HTTP-ээр давтан тоглуулахаас хамгаална.
const MAX_AGE_MS = 48 * 3600_000;

/**
 * AIA OCSP-оор цуцлалт шалгагч ({@link RevocationChecker}):
 *
 * - good → "good" (5 мин кэшлэнэ);
 * - revoked, мөн unknown (олгогч энэ serial-ийг олгоогүй — өөр хэн нэгний хийсэн гэрчилгээ) → "revoked";
 * - хариугүй (AIA алга, issuer олдоогүй, timeout, HTTP ≠ 200, гарын үсэг/serial/хугацаа таараагүй) → "unknown" —
 *   `revocationMode` шийднэ: soft-fail — зөвшөөрнө ("unchecked"), hard-fail — татгалзана.
 *
 * Хариуг олгогч эсвэл олгогчийн id-kp-OCSPSigning EKU-тэй (одоо хүчинтэй) responder зурсан, энэ serial-ийн тухай,
 * thisUpdate ∈ [now−48ц, now+5мин], nextUpdate өнгөрөөгүй байх ёстой.
 */
export function ocspRevocationChecker(opts: OcspCheckerOptions = {}): RevocationChecker {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const totalMs = Math.max(timeoutMs, 3000);
  const now = opts.now ?? Date.now;
  const cache = new Map<string, number>(); // key → good-ийн дуусах цаг

  async function ask(leaf: Certificate, issuer: Certificate): Promise<RevocationStatus | undefined> {
    const body = await ocspRequest(leaf, issuer);
    // Нийт хугацаа (AIA-д олон URL байсан ч) — иргэн poll дээр хүлээж байна.
    const deadline = Date.now() + totalMs;
    for (const raw of leaf.ocspServers) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const res = await doFetch(u.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/ocsp-request", Accept: "application/ocsp-response" },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        });
        if (res.status !== 200) continue;
        const der = new Uint8Array(await res.arrayBuffer());
        if (der.length > MAX_BYTES) continue;
        const resp = await parseOCSPFrom(der, intValue(leaf.serial), issuer);
        const t = now();
        const rc = resp.certificate;
        if (rc && !sameCertKey(rc, issuer)) {
          if (!rc.extKeyUsage.includes(OID.kpOCSPSigning)) continue;
          if (t < rc.notBefore.getTime() || t > rc.notAfter.getTime()) continue;
        }
        const tu = resp.thisUpdate.date.getTime();
        if (tu > t + CLOCK_SKEW_MS || tu < t - MAX_AGE_MS) continue;
        if (resp.nextUpdate && resp.nextUpdate.getTime() < t) continue;
        return resp.status === "good" ? "good" : "revoked";
      } catch {
        // дараагийн responder; бүгд унавал хариугүй
      }
    }
    return undefined;
  }

  return async (cert: X509Certificate, issuer: X509Certificate | undefined): Promise<RevocationStatus> => {
    if (!issuer) return "unknown";
    let leaf: Certificate, iss: Certificate;
    try {
      leaf = parseCertificate(new Uint8Array(cert.raw));
      iss = parseCertificate(new Uint8Array(issuer.raw));
    } catch {
      return "unknown";
    }
    const key = createHash("sha256").update(issuer.raw).digest("hex").slice(0, 16) + ":" + cert.serialNumber;
    const exp = cache.get(key);
    if (exp !== undefined && now() < exp) return "good";
    const status = await ask(leaf, iss);
    if (!status) return "unknown";
    // Зөвхөн "good"-ийг кэшлэнэ: revoked эцсийн, unknown нь дөнгөж олгогдсон гэрчилгээг кэшийн хугацаанд түгжихгүй.
    if (status === "good") {
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(key, now() + CACHE_TTL_MS);
    }
    return status;
  };
}
