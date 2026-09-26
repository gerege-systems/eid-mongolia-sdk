// Крипто туслахууд — digest, санамсаргүй challenge, ACSP_V2 payload.
// ⚠️ ACSP_V2 payload нь Smart-ID RP-API v3 (signature_protocols.html)-тэй БАЙТ-ИЖИЛ: сервер
// (acsp.go), утас, RP SDK гурвуулаа '|'-ээр холбосон нэг мөрийг угсарна — нэг байт зөрвөл
// гарын үсэг таарахгүй.

import { createHash, randomBytes } from "node:crypto";
import type { FlowType, HashAlgorithm, Interaction } from "./types.js";

/** SHA-256 digest, base64. Текст эсвэл байтаас. Sign flow-ийн baримтын digest үүсгэхэд. */
export function sha256Base64(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("base64");
}

/** Санамсаргүй RP challenge (default 64 байт), base64. Auth flow-д replay-ээс хамгаална. */
export function randomChallenge(bytes = 64): string {
  return randomBytes(bytes).toString("base64");
}

/** "SHA-512" → node crypto нэр "sha512". */
export function nodeHash(h: HashAlgorithm | string): string {
  return h.toLowerCase().replace("-", "");
}

/** Hash-ийн байтын урт (PSS salt урт = hLen). */
export function hashLen(h: HashAlgorithm | string): number {
  return createHash(nodeHash(h)).digest().length;
}

/**
 * interactions массивыг RP-API v3-ийн base64 мөр болгоно. RP энэ МӨРИЙГ хадгалж
 * validator-т өгнө (дахин serialize хийхгүй — JSON байт зөрж болно).
 */
export function interactionsToBase64(interactions: Interaction[]): string {
  return Buffer.from(JSON.stringify(interactions), "utf8").toString("base64");
}

/** ACSP_V2 payload-ийн бүх орц (Smart-ID v3 §ACSP_V2 digest calculation). */
export interface AcspV2Params {
  /** default "smart-id" (серверийн SMARTID_ACSP_SCHEME_NAME-тэй ижил). */
  schemeName?: string;
  serverRandom: string; // base64, хариунаас, ЯГ ТЭР ХЭВЭЭР
  rpChallenge: string; // base64, RP-ийн илгээсэн
  userChallenge: string; // base64url 43 тэмдэгт, хариунаас
  relyingPartyName: string; // хүсэлтэд илгээсэн түүхий мөр
  brokeredRpName?: string; // одоогоор ""
  interactions: string; // хүсэлтэд илгээсэн base64 МӨР
  interactionTypeUsed: string; // хариунаас
  initialCallbackUrl?: string; // хүсэлтэд илгээсэн түүхий мөр, байхгүй бол ""
  flowType: FlowType | string; // хариунаас
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** ACSP_V2 payload — UTF-8 байт (гарын үсэг ЭНЭ дээр). */
export function buildAcspV2Payload(p: AcspV2Params): Buffer {
  const message = [
    p.schemeName ?? "smart-id",
    "ACSP_V2",
    p.serverRandom,
    p.rpChallenge,
    p.userChallenge,
    b64(p.relyingPartyName),
    b64(p.brokeredRpName ?? ""),
    createHash("sha256").update(p.interactions, "utf8").digest("base64"),
    p.interactionTypeUsed,
    p.initialCallbackUrl ?? "",
    p.flowType,
  ].join("|");
  return Buffer.from(message, "utf8");
}

/** HASH_{hashAlgorithm}(payload). */
export function acspV2Digest(p: AcspV2Params, hashAlgorithm: HashAlgorithm | string): Buffer {
  return createHash(nodeHash(hashAlgorithm)).update(buildAcspV2Payload(p)).digest();
}
