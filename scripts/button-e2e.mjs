#!/usr/bin/env node
// <eid-login-button> жинхэнэ хөтөчид: backdrop-filter-тай sticky header дотор байсан ч цонх top layer-д, viewport-ийн
// төвд, бүтэн хэмжээгээр гарна. Урьдчилан `npm run build`; BROWSER=webkit — WebKit; CHROMIUM=<зам> — өөр хөтөч.
import { chromium, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const js = readFileSync(new URL("../dist/button.js", import.meta.url));
const page = `<!doctype html><html><body style="margin:0;height:2000px">
<header style="position:sticky;top:0;height:56px;backdrop-filter:blur(4px);transform:translateZ(0);overflow:hidden;contain:paint">
<eid-login-button id="b" start-url="/start" status-url="/status" mode="web" lang="mn"></eid-login-button></header>
<script type="module" src="/button.js"></script></body></html>`;
const server = createServer((req, res) => {
  if (req.url === "/button.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(js);
  if (req.url === "/start") return res.writeHead(500, { "Content-Type": "application/json" }).end("{}");
  res.writeHead(200, { "Content-Type": "text/html" }).end(page);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const browser = await (process.env.BROWSER === "webkit" ? webkit : chromium).launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failed = 0;
const check = (c, m) => {
  if (!c) {
    failed++;
    console.error("FAIL", m);
  } else console.log("ok  ", m);
};
try {
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.waitForFunction(() => customElements.get("eid-login-button"));
  await p.evaluate(() => document.getElementById("b").shadowRoot.querySelector("button.trigger").click());
  await p.waitForFunction(() => document.getElementById("b").shadowRoot.querySelector("dialog[open]"));
  const r = await p.evaluate(() => {
    const d = document.getElementById("b").shadowRoot.querySelector("dialog");
    const b = d.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height, modal: d.matches(":modal"), vw: innerWidth, vh: innerHeight };
  });
  check(r.modal, "dialog :modal (top layer)");
  check(r.h > 100, `dialog 56px header-д clip-логдоогүй (h=${Math.round(r.h)})`);
  check(Math.abs(r.l + r.w / 2 - r.vw / 2) < 2, "хэвтээ төвд");
  check(Math.abs(r.t + r.h / 2 - r.vh / 2) < 2, "босоо төвд");
  check(Math.abs(r.w - 416) < 2, `өргөн 26rem (w=${r.w})`);
  await p.keyboard.press("Escape");
  check(await p.evaluate(() => !document.getElementById("b").shadowRoot.querySelector("dialog")), "Esc хаана");
  await p.close();

  // QR цонх (push хэсэг хаалттай): намхан laptop дэлгэцэд дотоод scroll-гүй, доод ирмэг viewport дотор;
  // өндөр дэлгэцэд QR 256px хэвээр (өмнөх харагдац).
  const json = (o) => ({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  for (const [w, h] of [[1280, 700], [1366, 650], [1920, 1080]]) {
    const q = await browser.newPage({ viewport: { width: w, height: h } });
    await q.route("**/start", (r) => r.fulfill(json({ state: "PENDING", qr: "https://eidmongolia.mn/l/e2e-0123456789abcdef", vc: "12345", expiresIn: 300 })));
    await q.route("**/status", (r) => r.fulfill(json({ state: "PENDING", expiresIn: 300 })));
    await q.goto(`http://127.0.0.1:${server.address().port}/`);
    await q.waitForFunction(() => customElements.get("eid-login-button"));
    await q.evaluate(() => document.getElementById("b").shadowRoot.querySelector("button.trigger").click());
    await q.waitForFunction(() => {
      const d = document.getElementById("b").shadowRoot.querySelector("dialog[open]");
      return d && d.querySelector(".qr svg") && d.querySelector(".qr-vc") && !d.querySelector(".meta").hidden && d.querySelector(".disc-btn");
    });
    const m = await q.evaluate(() => {
      const d = document.getElementById("b").shadowRoot.querySelector("dialog");
      const b = d.getBoundingClientRect();
      return { sh: d.scrollHeight, ch: d.clientHeight, top: b.top, bottom: b.bottom, vh: innerHeight, qr: d.querySelector(".qr").getBoundingClientRect().width };
    });
    const at = `${w}×${h}`;
    check(m.sh <= m.ch, `${at}: дотоод scroll-гүй (scrollHeight=${m.sh}, clientHeight=${m.ch})`);
    check(m.top >= 8 && m.bottom <= m.vh - 8, `${at}: цонх viewport дотор ≥8px (top=${Math.round(m.top)}, bottom=${Math.round(m.bottom)}, vh=${m.vh})`);
    if (h >= 1000) check(Math.abs(m.qr - 256) < 0.5, `${at}: QR 256px хэвээр (w=${m.qr})`);
    else check(m.qr >= 200, `${at}: QR ≥200px (w=${m.qr})`);
    if (w === 1366) {
      // Push хэсэг дэлгэгдсэн: scroll зөвшөөрөгдөнө, гэхдээ төгсгөлд нь товчны доор padding харагдана (тасархай биш).
      await q.evaluate(() => document.getElementById("b").shadowRoot.querySelector(".disc-btn").click());
      await q.waitForTimeout(500);
      const e = await q.evaluate(() => {
        const d = document.getElementById("b").shadowRoot.querySelector("dialog");
        d.scrollTop = d.scrollHeight;
        const btn = d.querySelector(".disc form button[type=submit]").getBoundingClientRect();
        return { gap: d.getBoundingClientRect().bottom - btn.bottom, end: d.scrollHeight - d.scrollTop - d.clientHeight };
      });
      check(e.end <= 1 && e.gap >= 12, `${at}: дэлгэгдсэн үед төгсгөлд доод padding харагдана (gap=${Math.round(e.gap)})`);
    }
    await q.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
