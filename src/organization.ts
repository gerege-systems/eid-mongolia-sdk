// Байгууллагын төлөөлөл — иргэний төлөөлж чадах (ACTIVE, хугацаа хүчинтэй) байгууллагууд. onBehalfOf-оос өмнө
// иргэнд сонгуулахад. Иргэн сүүлийн 24 цагт танай RP-ээр нэвтэрсэн байх ёстой (үгүй бол 403).

import { RP_ROUTES, routePath } from "./contract.js";
import type { Http } from "./http.js";
import type { PersonOrgSealGrants, PersonSealGrantsResponse, Representation, RepresentationsResponse } from "./types.js";

export class OrganizationApi {
  constructor(private readonly http: Http) {}

  /** GET /organization/representations/etsi/{personEtsi}. Сонголт нь итгэх эх биш — сервер дахин шалгана. */
  async getRepresentations(personEtsi: string): Promise<RepresentationsResponse> {
    const raw = (await this.http.get(routePath(RP_ROUTES.orgRepresentations, personEtsi))) as Record<string, unknown>;
    const list = Array.isArray(raw.representations) ? (raw.representations as Representation[]) : [];
    return { personEtsi: String(raw.personEtsi ?? personEtsi), representations: list, raw };
  }

  /**
   * GET /organization/seal-grants/etsi/{personEtsi} — иргэн улсын бүртгэлээр баталгаажсан Гүйцэтгэх захирал байгаа байгууллага
   * бүр ба түүний APPROVED / PENDING RP тамганы эрхүүд (захирлын «миний байгууллагын тамгыг хэн ашиглаж байна» харагдац).
   * PKI_READ эрх шаардана; иргэн сүүлийн 24 цагт танай RP-ээр нэвтэрсэн байх ёстой (үгүй бол 403). Энгийн RP зөвхөн өөрийн
   * эрхийг харна. Зөвхөн унших — эрх цуцлах нь eID аппаас.
   */
  async sealGrants(personEtsi: string): Promise<PersonSealGrantsResponse> {
    const raw = (await this.http.get(routePath(RP_ROUTES.orgSealGrants, personEtsi))) as Record<string, unknown>;
    const list = Array.isArray(raw.organizations) ? (raw.organizations as PersonOrgSealGrants[]) : [];
    return { personEtsi: String(raw.personEtsi ?? personEtsi), organizations: list.map((o) => ({ ...o, grants: Array.isArray(o.grants) ? o.grants : [] })), raw };
  }
}
