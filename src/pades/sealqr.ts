// Internal switch for the seal stamp with QR (APPEARANCE_SPEC.md §6.5, golden v13) — Go's unexported
// `PrepareOptions.sealQR`. NOT public. A QR promises that `/verify/<docId>/<rev>` resolves, so only a writer that
// registers the seal may emit it: the only public writer is `sealPdf(…, {qr: true})`, which reserves the position at seal
// time (`sealForDocument`) and returns the registration body; prepare stays QR-less (§6.2).
//
// The switch is the identity of an options object in a module-private WeakSet — never a property: prepare decides with
// `has(opts)` and performs no property lookup on the caller's object (or its prototype chain) for it, so a Proxy, an
// extra key, a symbol or Object.prototype pollution cannot turn it on. Only `withSealQr` adds to the set; no entry point
// (src/pades.ts, src/validate.ts, src/index.ts, …) re-exports this module, so dist callers cannot reach it; only sealPdf
// calls it (for its own options object, when the caller's own `qr` property is true); complete and state decoding never do. Tests and goldens register options through a bundle of src.

const SEAL_QR_OPTIONS = new WeakSet<object>();

/** Registers `opts` so that prepare draws the QR seal stamp for an e-Seal signer (tests / goldens only). */
export function withSealQr<T extends object>(opts: T): T {
  SEAL_QR_OPTIONS.add(opts);
  return opts;
}

/** Whether `opts` was registered by {@link withSealQr} (identity only — no property of `opts` is read). */
export function sealQrRequested(opts: object): boolean {
  return SEAL_QR_OPTIONS.has(opts);
}
