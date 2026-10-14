// Session poll — long-poll давталт. RP-API нь serverPollMs хүртэл хүлээгээд (эсвэл иргэн
// хариу өгмөгц) буцдаг тул хэдхэн дуудлагаар үр дүн авна. waitForResult нь COMPLETE
// болтол давтаж, эцсийн SessionResult-ыг буцаана.

import { RP_ROUTES, routePath } from "./contract.js";
import type { Http } from "./http.js";
import type {
  OrgResult,
  PersonBlock,
  SessionResult,
  SignatureAlgorithmParameters,
  TokenCertSessionBlock,
} from "./types.js";

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
    // CA-ийн eID нэмэлт (f59d14ee-оос): гарын үсэг зурагдсан ACSP_V2 initialCallbackUrl. "" нь утга —
    // null/undefined-аас ялгана (талбар алга = хуучин CA).
    initialCallbackUrl: typeof sig.initialCallbackUrl === "string" ? sig.initialCallbackUrl : null,
    signatureAlgorithmParameters: parseSigParams(sig.signatureAlgorithmParameters),
    interactionTypeUsed: str(r.interactionTypeUsed),
    onBehalfOf: parseOrg(r.onBehalfOf),
    person: parsePerson(r.person),
    tokenCertificate: parseTokenCert(r.tokenCertificate),
    raw,
  };
}

const PERSON_STRINGS = [
  "firstName", "lastName", "familyName", "firstNameEn", "lastNameEn", "civilId", "regNo", "birthDate", "gender",
] as const;

/** `person` блок. Байхгүй / хоосон бол null. */
function parsePerson(raw: unknown): PersonBlock | null {
  const p = asRecord(raw);
  const out: PersonBlock = {};
  for (const k of PERSON_STRINGS) if (typeof p[k] === "string" && p[k]) out[k] = p[k] as string;
  if (typeof p.geID === "number" && p.geID !== 0) out.geID = p.geID;
  return Object.keys(out).length ? out : null;
}

/** `tokenCertificate` блок. status алга бол null. */
function parseTokenCert(raw: unknown): TokenCertSessionBlock | null {
  const t = asRecord(raw);
  const status = str(t.status);
  if (!status) return null;
  const out: TokenCertSessionBlock = { status };
  if (t.errorCode) out.errorCode = String(t.errorCode);
  if (t.authSerialHex) out.authSerialHex = String(t.authSerialHex);
  if (t.signSerialHex) out.signSerialHex = String(t.signSerialHex);
  return out;
}

/**
 * Person блокийн `civilId` нь баталгаажсан гэрчилгээний SERIALNUMBER-тэй (`PNOMN-<civilId>`) таарах эсэх — хоёулаа
 * хоосон биш байх ёстой. Person блок гарын үсэгт ордоггүй тул RP үүнийг validateAuth-ийн дараа шалгаж байж нэр /
 * төрсөн огноонд итгэнэ. `subject` — validateAuth-ийн `parsedSubject` (эсвэл түүний `serialNumber`).
 */
export function personMatchesCertificate(
  person: PersonBlock | null | undefined,
  subject: { serialNumber?: string } | string | null | undefined,
): boolean {
  const serial = typeof subject === "string" ? subject : subject?.serialNumber;
  return !!person?.civilId && !!serial && serial === `PNOMN-${person.civilId}`;
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
  const roleLabel = str(o.roleLabel);
  const rightTypeLabel = str(o.rightTypeLabel);
  return {
    orgEtsi: etsi,
    orgName: str(o.orgName),
    role: str(o.role),
    ...(roleLabel ? { roleLabel } : {}),
    rightType: str(o.rightType),
    ...(rightTypeLabel ? { rightTypeLabel } : {}),
  };
}

export class SessionApi {
  constructor(private readonly http: Http) {}

  /** Нэг удаагийн long-poll. serverPollMs хүртэл хүлээнэ. */
  async poll(sessionId: string, serverPollMs: number = SERVER_POLL_MS): Promise<SessionResult> {
    const raw = await this.http.get(
      `${routePath(RP_ROUTES.session, sessionId)}?timeoutMs=${serverPollMs}`,
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
