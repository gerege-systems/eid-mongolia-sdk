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
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
