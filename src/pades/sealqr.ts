// Internal switch for the seal stamp with QR (APPEARANCE_SPEC.md §6.5, golden v13) — Go's unexported
// `PrepareOptions.sealQR`. NOT public: no entry point (src/pades.ts, src/validate.ts, …) re-exports this module, no public
// options type declares the key, and prepare never writes it into `state`. A QR promises that `/verify/<docId>/<rev>`
// resolves, so only a writer that registers the seal may emit it; until the CA validator and the /verify bundle ship
// §6.5 no public API does (sealPdf always draws the QR-less stamp, §6.2). Only the golden/unit tests set it, through a
// bundle of src (the symbol is unique per bundle and not registered with Symbol.for, so dist callers cannot reach it).

export const SEAL_QR: unique symbol = Symbol("eid-mongolia-sdk.pades.sealQr");

/** prepare options carrying the internal switch. */
export interface SealQrOption {
  [SEAL_QR]?: boolean;
}
