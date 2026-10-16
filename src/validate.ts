// `@gerege-systems/eid-mongolia-sdk/validate` — гарын үсэгтэй PDF-ийг хөтөч эсвэл Node дотор (файлыг серверт илгээлгүй)
// шалгах. CA-ийн /v3/validate/pdf (Go SDK pades.ValidatePDF)-тэй ижил дүрэм, ижил JSON тайлан.

import { EidError } from "./errors.js";
import { NATIONAL_ROOT, INTERMEDIATES, EID_ISSUERS } from "./pades/assets/chain.js";
import { fromB64 } from "./pades/bytes.js";
import { Fetcher, isBrowser, type FetchFn } from "./pades/fetch.js";
import { parseCertificate, type Certificate } from "./pades/x509.js";
import { DSSStatus, Evaluator, OnlineStatus, signLevelOf, type PdfReport, type SignatureReport, type StatusSource } from "./pades/validate/evaluate.js";
import { ExtractError, MAX_PDF_BYTES, extract } from "./pades/validate/extract.js";
import { fromDate } from "./pades/validate/gofmt.js";

export type { CertInfo, Indication, LTVInfo, PdfReport, Revocation, SignatureReport, TimestampInfo } from "./pades/validate/evaluate.js";

/** validatePdf-ийн алдааны кодууд (CA: too_large / not_pdf / no_signature / too_many_signatures). */
export type ValidatePdfErrorCode = "PDF_TOO_LARGE" | "PDF_INVALID" | "PDF_NO_SIGNATURE" | "PDF_TOO_MANY_SIGNATURES" | "REQUEST_INVALID";

export class ValidatePdfError extends EidError {
  constructor(
    readonly code: ValidatePdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ValidatePdfError";
  }
}

export interface ValidatePdfOptions {
  /** Итгэлийн тулгуур (DER); хоосон бол шигтгэсэн Mongolian National Root CA (01). */
  roots?: Uint8Array[];
  /** Нэмэлт завсрын CA (DER) — шигтгэсэн 02–05-аас гадна. */
  intermediates?: Uint8Array[];
  /** eID олгогч гэж үзэх нэмэлт CA (DER) — шигтгэсэн 04/05-аас гадна (тест). */
  issuers?: Uint8Array[];
  /** Шалгах цаг (цагийн тэмдэггүй гарын үсэгт); анхдагч одоо. */
  time?: Date;
  /**
   * Сүлжээ рүү гарахгүй: цуцлалтыг зөвхөн баримтын DSS-ийн OCSP/CRL-ээс. Анхдагч false — eID-ийн гэрчилгээний AIA
   * OCSP (эс бөгөөс CDP CRL)-ээс одоогийн төлөв; хариугүй бол DSS. Хөтөчид http:// AIA/CDP-г https болгоно
   * (ocsp./crl.eidmongolia.mn — CORS `*`). Сүлжээгээр зөвхөн гэрчилгээний serial (OCSP хүсэлт) явна, баримт биш.
   */
  offline?: boolean;
  /** fetch (тест/proxy). Анхдагч globalThis.fetch. */
  fetch?: FetchFn;
  /** Цуцлах — явж буй OCSP/CRL таталтыг тасална. */
  signal?: AbortSignal;
}

function ders(list: Uint8Array[] | undefined, what: string): Certificate[] {
  try {
    return (list ?? []).map((d) => parseCertificate(d));
  } catch (e) {
    throw new ValidatePdfError("REQUEST_INVALID", `${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const embedded = (b64: string[]): Certificate[] => b64.map((x) => parseCertificate(fromB64(x)));

/**
 * PDF доторх бүх PAdES/CMS гарын үсгийг шалгана: ByteRange/messageDigest-ийн бүрэн бүтэн байдал, CMS гарын үсэг, гинж
 * (үндэсний Root CA хүртэл), KU/EKU, хугацаа, RFC 3161 цагийн тэмдэг, гарын үсгийн дараах revision
 * (modified_after_signing; харагдах гарын үсэг — APPEARANCE_SPEC §5), LTV, гэрчилгээний түвшин (certificate_level).
 * Тайлан нь CA-ийн `/v3/validate/pdf`-ийн JSON (snake_case) — `session_id` / `doc_id` / `on_behalf_of_*` (CA-ийн
 * бүртгэлээс) байхгүй.
 */
export async function validatePdf(pdf: Uint8Array | ArrayBuffer, opts: ValidatePdfOptions = {}): Promise<PdfReport> {
  const doc = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf);
  if (doc.length > MAX_PDF_BYTES) throw new ValidatePdfError("PDF_TOO_LARGE", "PDF 10 MiB-аас их");
  const roots = opts.roots && opts.roots.length > 0 ? ders(opts.roots, "roots") : embedded(NATIONAL_ROOT);
  const extraInter = ders(opts.intermediates, "intermediates");
  const issuers = [...embedded(EID_ISSUERS), ...ders(opts.issuers, "issuers")];
  let ex;
  try {
    ex = await extract(doc);
  } catch (e) {
    if (e instanceof ExtractError) {
      if (e.code === "no_signature") throw new ValidatePdfError("PDF_NO_SIGNATURE", e.message);
      if (e.code === "too_many") throw new ValidatePdfError("PDF_TOO_MANY_SIGNATURES", e.message);
    }
    throw new ValidatePdfError("PDF_INVALID", "PDF задарсангүй");
  }
  const now = fromDate(opts.time ?? new Date());
  const dss = ex.sigs.find((s) => s.dss)?.dss;
  let status: StatusSource = new DSSStatus(dss, issuers);
  if (!opts.offline) {
    const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    status = await OnlineStatus.create(new Fetcher(fetchFn, isBrowser(), opts.signal), ex.sigs, issuers, status, now);
  }
  const ev = new Evaluator({ roots, intermediates: [...embedded(INTERMEDIATES), ...extraInter], issuers, status, now });
  const rep: PdfReport = { indication: "valid", signatures: [] };
  for (const r of ex.sigs) {
    const s = await ev.evaluateSignature(r);
    if (s.chain_trusted && r.leaf) {
      const lvl = signLevelOf(parseCertificate(r.leaf));
      if (lvl) s.certificate_level = lvl;
    }
    s.key_medium = keyMedium(s);
    rep.signatures.push(s);
  }
  for (const s of rep.signatures) {
    if (s.indication === "invalid") {
      rep.indication = "invalid";
      break;
    }
    if (s.indication === "indeterminate") rep.indication = "indeterminate";
  }
  return rep;
}

/**
 * key_medium (CA !377): CA нь бүртгэлээс (pdf_signatures.medium / certificates.key_medium) тогтооно. Локал шалгалтад
 * зөвхөн гэрчилгээнээс: eID-ийн олгосон SIGN гэрчилгээ qcStatements QcCompliance-тэй (QUALIFIED/QSCD) бол «phone»
 * (USB токены P-CITIZEN-SIGN-TOKEN нь qcStatements-гүй); бусад (токен ба хуучин утасны гэрчилгээг ялгах боломжгүй) «unknown».
 */
function keyMedium(s: SignatureReport): SignatureReport["key_medium"] {
  const c = s.certificate;
  if (c?.issued_by_eid && c.usage === "sign" && (s.certificate_level === "QUALIFIED" || s.certificate_level === "QSCD")) return "phone";
  return "unknown";
}
