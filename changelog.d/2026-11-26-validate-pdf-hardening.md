### Security — validatePdf hardening (Go validate corpus v14)

Two independent reviews of the .NET and Java ports of `validatePdf` found weaknesses that were already in this
implementation and in Go `pades.ValidatePDF`. Fixed in both; the validate corpus is vendored from Go PR 76 head
`15921a09ecdb` (`scripts/sync-pades-golden.mjs`; re-pin to the merge commit once that PR is merged). The 67 earlier
reports are unchanged; 13 new cases (README «v14» in `test/fixtures/pades/validate`).

- **Shadow attack** (`src/pades/validate/revisions.ts`): an unchanged object of the signed revision must parse completely
  inside it — a stream whose `/Length` was completed by a later (e.g. DSS-only) revision kept the signature `valid`.
- **Later-signature trust** (`extract.ts`, `appearance.ts`): only integrity-passing later signatures count as
  signature-only extensions; an own-signer stamp's `/Name` must equal that signature's certificate display name.
- **`platform_attested`** (`evaluate.ts`) only for documents covered or extended only by signatures.
- **Weak algorithms**: a SHA-1/MD5 SignerInfo signature algorithm → `weak_algorithm`; RSA-PSS certificate/CRL/OCSP
  signatures need SHA-256/384/512 with the same MGF1 hash and salt = hash length (`x509.ts`; absent parameters no longer
  default to SHA-1).
- **DoS** (no signature needed): OID ≤ 128 bytes / arcs ≤ 63 bits (`asn1.ts`, a 5 MB OID took hours); long INTEGERs
  convert in linear time; the reader (`pdf/reader.ts`) rejects xref stream rows of width 0, caps xref stream rows at
  max(`/Size`, 2^21), `/Prev` chains at 128 sections, inflation at 256 MiB per document, rejects multi-filter
  xref/object streams and indexes an object stream's header once (was: re-inflated per member); the structure pre-check
  (`pdf/nesting.ts`) applies Go's new rules (sections, `/W`, `/Index`, 32 MiB structural inflate budget incl. xref
  streams, object-stream lookup work ≤ 1 GiB); ≤ 32 CMS certificates, RSA ≤ 8192 bits / e ≤ 2^32−1, serial ≤ 160 bits;
  hash-deduplicated certificate pool; DSS ≤ 8 MiB decoded, duplicate references read once, each OCSP/CRL parsed and
  verified once per validation.
- **Errors**: every extraction/evaluation error is `PDF_INVALID`; an out-of-memory `RangeError` is rethrown instead of
  being turned into "not a PDF", "modified" or a skipped check.
- Behaviour visible to integrators: documents with more than 128 incremental updates or object streams with very many
  members are `PDF_INVALID`; an own-signer stamp whose `/Name` differs from the certificate name makes earlier
  signatures `modified_after_signing`; RSA-PSS with non-standard parameters no longer verifies.
- Checked: `npm ci && npm test` on the macmini (new `test/validate-hardening.test.ts` with time bounds;
  `validate-golden.test.ts` deep-equal with Go for all 80 cases).
