// Session poll — long-poll давталт. RP-API нь serverPollMs хүртэл хүлээгээд (эсвэл иргэн
// хариу өгмөгц) буцдаг тул хэдхэн дуудлагаар үр дүн авна. waitForResult нь COMPLETE
// болтол давтаж, эцсийн SessionResult-ыг буцаана.

import type { Http } from "./http.js";
import type { OrgResult, SessionResult, SignatureAlgorithmParameters } from "./types.js";

/** Серверийн нэг long-poll-ийн дээд хугацаа (мс). */
const SERVER_POLL_MS = 30_000;
/** Нийт хүлээх дээд хугацаа (мс) — иргэн хариу өгөхгүй бол үүгээр таслана. */
const MAX_WAIT_MS = 150_000;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return v != null ? String(v) : null;
}

/** RP-API-ийн session JSON-ийг SessionResult болгон задална (rpclient.ts-тэй ижил mapping). */
export function parseSessionResult(raw: unknown): SessionResult {
  const r = asRecord(raw);
  const result = asRecord(r.result);
  const sig = asRecord(r.signature);
  const cert = asRecord(r.cert);
  return {
    state: String(r.state ?? ""),
    endResult: str(result.endResult),
    documentNumber: str(result.documentNumber),
    certificateDerB64: str(cert.value),
    certificateLevel: str(cert.certificateLevel),
    signatureValueB64: str(sig.value),
    signatureAlgorithm: str(sig.signatureAlgorithm),
    signatureProtocol: str(r.signatureProtocol ?? sig.signatureProtocol),
    serverRandom: str(sig.serverRandom),
    userChallenge: str(sig.userChallenge),
    flowType: str(sig.flowType),
    signatureAlgorithmParameters: parseSigParams(sig.signatureAlgorithmParameters),
    interactionTypeUsed: str(r.interactionTypeUsed),
    onBehalfOf: parseOrg(r.onBehalfOf),
  };
}

/** rsassa-pss параметр — hashAlgorithm л заавал; бусад нь мэдээлэл. */
function parseSigParams(raw: unknown): SignatureAlgorithmParameters | null {
  const p = asRecord(raw);
  const hash = str(p.hashAlgorithm);
  if (!hash) return null;
  const mgf = asRecord(p.maskGenAlgorithm);
  return {
    hashAlgorithm: hash,
    maskGenAlgorithm: mgf.algorithm
      ? { algorithm: String(mgf.algorithm), parameters: { hashAlgorithm: String(asRecord(mgf.parameters).hashAlgorithm ?? hash) } }
      : undefined,
    saltLength: p.saltLength != null ? Number(p.saltLength) : undefined,
    trailerField: str(p.trailerField) ?? undefined,
  };
}

/** onBehalfOf блок (байгууллагаар нэвтрэх/зурах). Байхгүй бол null. */
function parseOrg(raw: unknown): OrgResult | null {
  const o = asRecord(raw);
  const etsi = str(o.orgEtsi);
  if (!etsi) return null;
  return {
    orgEtsi: etsi,
    orgName: str(o.orgName),
    role: str(o.role),
    rightType: str(o.rightType),
  };
}

export class SessionApi {
  constructor(private readonly http: Http) {}

  /** Нэг удаагийн long-poll. serverPollMs хүртэл хүлээнэ. */
  async poll(sessionId: string, serverPollMs: number = SERVER_POLL_MS): Promise<SessionResult> {
    const raw = await this.http.get(
      `/session/${encodeURIComponent(sessionId)}?timeoutMs=${serverPollMs}`,
      serverPollMs + 10_000, // HTTP timeout нь серверийн poll-оос урт
    );
    return parseSessionResult(raw);
  }

  /**
   * COMPLETE болтол давтаж poll хийнэ. maxWaitMs дуустал хүлээгээд гараагүй бол сүүлчийн
   * (RUNNING) үр дүнг буцаана — дуудагч endResult==null-ийг TIMEOUT мэт боловсруулна.
   */
  async waitForResult(
    sessionId: string,
    opts?: { maxWaitMs?: number; serverPollMs?: number },
  ): Promise<SessionResult> {
    const deadline = Date.now() + (opts?.maxWaitMs ?? MAX_WAIT_MS);
    const pollMs = opts?.serverPollMs ?? SERVER_POLL_MS;
    let last: SessionResult = { state: "RUNNING" } as SessionResult;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      last = await this.poll(sessionId, Math.max(1_000, Math.min(pollMs, remaining)));
      if (last.state === "COMPLETE") return last;
    }
    return last;
  }
}
