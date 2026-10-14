// QR encoder — jsQR (devDependency) decoder-оор буцааж уншина: хувилбар бүрийн бүсэд (1, 7+, 10+ — 16 битийн урт).
import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";

import { encodeQr, qrSvgPath } from "../src/qr.ts";

function decode(text: string): string | null {
  const q = encodeQr(text);
  const scale = 4;
  const border = 4;
  const w = (q.size + border * 2) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + border) * scale + dy) * w + (x + border) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, w, w)?.data ?? null;
}

test("encodeQr: jsQR буцааж уншина (богино, v3 холбоос, урт, кирилл)", () => {
  const link =
    "https://ca.eidmongolia.mn/dl?deviceLinkType=QR&elapsedSeconds=12&sessionToken=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH" +
    "&sessionType=auth&version=1.0&lang=mon&authCode=ZXhhbXBsZS1hdXRoLWNvZGUtdmFsdWUtNDMtY2hhcnMtbG9uZw";
  for (const s of ["eID", link, link + link, "Өө Үү — нэвтрэх", "x".repeat(700)]) {
    assert.equal(decode(s), s, `${s.length} тэмдэгт`);
  }
});

test("encodeQr: хэмжээ = 4·хувилбар + 17, svg path", () => {
  assert.equal(encodeQr("a").size, 21);
  assert.ok(qrSvgPath(encodeQr("a")).startsWith("M"));
  assert.throws(() => encodeQr("x".repeat(3000)), /хэт урт/);
});
