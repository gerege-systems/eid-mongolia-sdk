// Байгууллагын төлөөлөл — иргэний төлөөлж чадах (ACTIVE, хугацаа хүчинтэй) байгууллагууд. onBehalfOf-оос өмнө
// иргэнд сонгуулахад. Иргэн сүүлийн 24 цагт танай RP-ээр нэвтэрсэн байх ёстой (үгүй бол 403).

import type { Http } from "./http.js";
import type { Representation, RepresentationsResponse } from "./types.js";

export class OrganizationApi {
  constructor(private readonly http: Http) {}

  /** GET /organization/representations/etsi/{personEtsi}. Сонголт нь итгэх эх биш — сервер дахин шалгана. */
  async getRepresentations(personEtsi: string): Promise<RepresentationsResponse> {
    const raw = (await this.http.get(`/organization/representations/etsi/${encodeURIComponent(personEtsi)}`)) as Record<string, unknown>;
    const list = Array.isArray(raw.representations) ? (raw.representations as Representation[]) : [];
    return { personEtsi: String(raw.personEtsi ?? personEtsi), representations: list };
  }
}
