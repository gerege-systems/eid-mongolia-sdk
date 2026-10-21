// Stamp suggestion without signing — PLACEMENT_SPEC.md §6b, a 1:1 port of the Go reference
// pades/internal/core/suggest.go (SuggestVisible). Same code path as prepareSignature: page resolution (§1a) → geometry
// → visibleRect → scan → choose (placeOnPage).

import { Incremental } from "../pdf/incremental.js";
import { AppearanceError, lastNonVerifyPage, pageGeometry, pageList, visibleRect } from "./appearance.js";
import { placeOnPage, type PlaceStatus } from "./occupancy.js";

/** A page's visible size (CropBox, else MediaBox, after /Rotate), h100; undefined = geometry unreadable. */
export type PageSize = { w: number; h: number } | undefined;

export interface Suggestion {
  /** 1-based, resolved. */
  page: number;
  placement: { x: number; y: number; status: PlaceStatus };
  /** Every page in /Pages tree order. */
  pages: PageSize[];
}

/**
 * Go core.SuggestVisible — the placement prepareSignature would choose (PLACEMENT_SPEC.md §6, §6a) without writing
 * anything. page 0 = the last page that is not a verify page of verifyUri ("" = skip nothing → the last page); x, y, w,
 * h in h100. The rect must lie inside the page (AppearanceError otherwise), exactly as for prepare. Any other throw =
 * the PDF could not be read.
 */
export function suggestVisible(doc: Uint8Array, verifyUri: string, page: number, x: number, y: number, w: number, h: number, exact: boolean): Suggestion {
  const pages = pageList(new Incremental(doc).root().key("Pages"));
  const n = pages.length;
  if (page === 0) page = lastNonVerifyPage(pages, verifyUri);
  if (page < 1 || page > n) throw new AppearanceError(`page ${page} > хуудасны тоо ${n}`);
  const sizes: PageSize[] = pages.map((p) => {
    try {
      const { box, rot } = pageGeometry(p);
      const vw = box[2]! - box[0]!;
      const vh = box[3]! - box[1]!;
      return rot === 90 || rot === 270 ? { w: vh, h: vw } : { w: vw, h: vh };
    } catch (e) {
      if (e instanceof AppearanceError) return undefined; // Go: pageGeometry error → {0, 0}; anything else fails the call
      throw e;
    }
  });
  const target = pages[page - 1]!;
  const { box, rot } = pageGeometry(target);
  visibleRect(box, rot, x, y, w, h);
  return { page, placement: placeOnPage(target, box, rot, x, y, w, h, exact), pages: sizes };
}
