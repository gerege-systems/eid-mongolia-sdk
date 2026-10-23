// Иргэний PKI самбар (CA docs/EID_PERSON_PKI.md): гэрчилгээ, төхөөрөмж, үйл ажиллагаа, нэгдсэн тоо, асран хамгаалж буй
// хүүхдүүд. RP-д PKI_READ эрх (админ тухайлан олгоно) БА иргэн сүүлийн 24 цагт танай RP-ээр амжилттай нэвтэрсэн байх
// ёстой — эс бөгөөс ForbiddenError (403); иргэн олдохгүй бол ApiError 404. Хариу бүрийн `raw` — серверийн түүхий JSON.

import { RP_ROUTES, routePath } from "./contract.js";
import type { Http } from "./http.js";
import { ApiError } from "./errors.js";
import type { EidImage } from "./types.js";

/** Токенд холбогдсон байгууллага. */
export interface TokenOrganization {
  etsi: string;
  name: string;
}

/** Иргэний нэг гэрчилгээ. */
export interface PersonCertificate {
  documentNumber: string;
  /** AUTH | SIGN | SEAL. */
  type: string;
  /** MOBILE | TOKEN | HSM. */
  keyMedium: string;
  serialNumber: string;
  certificateLevel: string;
  /** VALID | REVOKED | EXPIRED | SUSPENDED. */
  status: string;
  /** RFC 3339. */
  notBefore: string;
  notAfter: string;
  issuerDn: string;
  /** Олгосон мөч (RFC 3339). Хуучин CA-д байхгүй. */
  issuedAt?: string;
  /**
   * Цуцалсан мөч (RFC 3339) — REVOKED-д, мөн сунгалт/дахин бүртгэлээр солигдсон (status SUSPENDED,
   * `revocationReason: "superseded"`) мөрд (CA !377-оос).
   */
  revokedAt?: string;
  /**
   * RFC 5280 CRLReason-ийн нэр: keyCompromise, cACompromise, affiliationChanged, superseded, cessationOfOperation,
   * certificateHold, privilegeWithdrawn г.м. `status` өөрчлөгдөхгүй — солигдсоныг (SUSPENDED) `superseded`-ээр ялга.
   */
  revocationReason?: string;
  /** base64 DER (нийтийн артефакт). */
  certValue?: string;
  /** TOKEN мөрөнд токенд холбогдсон байгууллага; хувийн токенд алга. */
  organization?: TokenOrganization;
  /**
   * TOKEN мөрөнд: гэрчилгээ олгогдсон USB токены серийн дугаар (`/mobile/tokens`-ийн `tokenSerial`-тай ижил). Нэг
   * токены AUTH + SIGN-ийг үүгээр бүлэглэ; сунгалтаар солигдсон (SUSPENDED) мөр ч өөрийн токены дугаартай. MOBILE/HSM
   * мөрөнд болон хуучин CA-д алга.
   */
  tokenSerial?: string;
}

export interface CertCounts {
  valid: number;
  revoked: number;
  expired: number;
  suspended: number;
  total: number;
}

/** GET /certificates/etsi/{personEtsi}. */
export interface PersonCertificates {
  personEtsi: string;
  counts: CertCounts;
  certificates: PersonCertificate[];
  raw: unknown;
}

export interface PersonDevice {
  deviceId?: string;
  documentNumber: string;
  /** APNS | FCM. */
  platform?: string;
  pushTopic?: string;
  enrolledAt: string;
  active: boolean;
  deactivatedAt?: string | null;
}

/** GET /devices/etsi/{personEtsi}. */
export interface PersonDevices {
  personEtsi: string;
  devices: PersonDevice[];
  activeCount: number;
  total: number;
  raw: unknown;
}

/** Үйл ажиллагааны нэг бичлэг (kind/reason: EID_PERSON_PKI §Activity kind/reason; шинэ код нэмэгдэж болно). */
export interface ActivityItem {
  id?: string;
  sessionId?: string;
  /** AUTH | SIGN | PIN_CHECK | ENROLL | TOKEN_AUTH | … */
  kind: string;
  /** AUTHENTICATION | SIGNATURE (зөвхөн AUTH/SIGN). */
  flow?: string;
  /** OK | DENIED | FAILED. */
  outcome: string;
  reason?: string;
  pinSlot?: string;
  endResult?: string;
  rpName?: string;
  subsystemName?: string;
  docText?: string;
  interactionType?: string;
  documentNumber?: string;
  clientIp?: string;
  timestamp: string;
  onBehalfOfName?: string;
}

export interface ActivityCounts {
  authentication: number;
  signature: number;
}

/** GET /rp/activity/etsi/{personEtsi} (RP-scoped; eID портал — бүрэн түүх). */
export interface PersonActivity {
  personEtsi: string;
  counts: ActivityCounts;
  sessions: ActivityItem[];
  total: number;
  limit: number;
  offset: number;
  raw: unknown;
}

/** activity-ийн шүүлт. Өгөөгүй = серверийн анхдагч (limit 20, offset 0, бүх flow). */
export interface ActivityQuery {
  flow?: "AUTHENTICATION" | "SIGNATURE";
  /** 1–200. */
  limit?: number;
  offset?: number;
}

/** GET /person/summary/etsi/{personEtsi}. `lastName` = ЭЦГИЙН нэр, `familyName` = УРГИЙН овог. */
export interface PersonSummary {
  personEtsi: string;
  firstName?: string;
  lastName?: string;
  familyName?: string;
  certificates: CertCounts;
  activity: ActivityCounts;
  devicesActive: number;
  devicesTotal: number;
  representationCount: number;
  raw: unknown;
}

export interface PersonChild {
  etsi: string;
  regNo: string;
  /** «Овог Нэр». */
  name: string;
  /** YYYY-MM-DD. */
  birthDate?: string;
  registered: boolean;
  /** 18 нас хүрэх өдөр; бүртгэлгүй бол алга. */
  certNotAfter?: string;
}

/** GET /person/children/etsi/{personEtsi}. */
export interface PersonChildren {
  children: PersonChild[];
  raw: unknown;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export class PersonApi {
  constructor(private readonly http: Http) {}

  private async get<T>(path: string): Promise<T & { raw: unknown }> {
    const raw = await this.http.get(path);
    return { ...(rec(raw) as T), raw };
  }

  /** Иргэний бүх гэрчилгээ + статусын тоолол. */
  certificates(personEtsi: string): Promise<PersonCertificates> {
    return this.get<PersonCertificates>(routePath(RP_ROUTES.personCertificates, personEtsi));
  }

  /** Иргэний холбоотой төхөөрөмжүүд (идэвхтэй + идэвхгүй). */
  devices(personEtsi: string): Promise<PersonDevices> {
    return this.get<PersonDevices>(routePath(RP_ROUTES.personDevices, personEtsi));
  }

  /** Иргэний үйл ажиллагааны түүх. */
  activity(personEtsi: string, query?: ActivityQuery): Promise<PersonActivity> {
    const q = new URLSearchParams();
    if (query?.flow) q.set("flow", query.flow);
    if (query?.limit && query.limit > 0) q.set("limit", String(query.limit));
    if (query?.offset && query.offset > 0) q.set("offset", String(query.offset));
    const qs = q.toString();
    return this.get<PersonActivity>(routePath(RP_ROUTES.personActivity, personEtsi) + (qs ? `?${qs}` : ""));
  }

  /** Самбарын нэгдсэн тоо. */
  summary(personEtsi: string): Promise<PersonSummary> {
    return this.get<PersonSummary>(routePath(RP_ROUTES.personSummary, personEtsi));
  }

  /** Асран хамгаалж буй хүүхдүүд (зөвхөн унших). */
  children(personEtsi: string): Promise<PersonChildren> {
    return this.get<PersonChildren>(routePath(RP_ROUTES.personChildren, personEtsi));
  }

  /**
   * GET /person/etsi/{personEtsi}/signature-image — иргэний гарын үсгийн зураг (харагдах гарын үсэгт:
   * `appearance.signatureImage = img.pdfImage`). PKI_READ биш, **SIGN** эрх; иргэн сүүлийн 24 цагт танай RP-ээр
   * нэвтэрсэн байх ёстой (эс бөгөөс `ForbiddenError`). Иргэн зураг хадгалаагүй (404) бол `null`.
   */
  async signatureImage(personEtsi: string): Promise<EidImage | null> {
    try {
      return rec(await this.http.get(routePath(RP_ROUTES.personSignatureImage, personEtsi))) as unknown as EidImage;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
}
