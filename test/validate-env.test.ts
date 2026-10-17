// validatePdf: Web Crypto алга (хөтчийн insecure context — http хуудас, хуучин хөтөч) → UNSUPPORTED_ENVIRONMENT
// (өмнө нь PDF_INVALID). Тусдаа процесс: globalThis.crypto-г арилгаж node:crypto import-ыг хаана.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const dist = new URL("../dist/validate.js", import.meta.url).href;
const hook = `export async function resolve(s, c, n) { if (s === "node:crypto") throw new Error("blocked"); return n(s, c); }`;
const child = `
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hook)}));
Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
const { validatePdf, ValidatePdfError } = await import(${JSON.stringify(dist)});
try {
  await validatePdf(new TextEncoder().encode("%PDF-1.7\\n%%EOF\\n"));
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.log(JSON.stringify({ isErr: e instanceof ValidatePdfError, code: e.code, message: e.message }));
}
`;

test("validatePdf: crypto.subtle алга → UNSUPPORTED_ENVIRONMENT", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" }).trim());
  assert.equal(out.isErr, true);
  assert.equal(out.code, "UNSUPPORTED_ENVIRONMENT");
  assert.match(out.message, /https хуудас эсвэл шинэ хөтөч шаардлагатай/);
});
