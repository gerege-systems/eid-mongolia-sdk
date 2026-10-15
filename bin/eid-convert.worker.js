// @gerege-systems/eid-mongolia-sdk/convert — хувиргагчийн worker. `?cache=<нэр>` бол soffice.wasm / soffice.data-г
// SDK-ийн урьдчилж татсан Cache Storage-аас өгнө (дахин татахгүй, blob URL-гүй); олдохгүй бол ердийн fetch.
// Дараа нь @matbee/libreoffice-converter-ийн worker-ийг ачаална. CSP: script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'.
(function () {
  var name = new URL(self.location.href).searchParams.get("cache");
  if (!name || typeof caches === "undefined") return;
  var orig = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = typeof input === "string" ? new URL(input, self.location.href).href : input instanceof URL ? input.href : input.url;
    if (!/\/soffice\.(wasm|data)$/.test(url)) return orig(input, init);
    return caches
      .open(name)
      .then(function (c) { return c.match(url); })
      .catch(function () { return undefined; })
      .then(function (hit) { return hit || orig(input, init); });
  };
})();
importScripts("browser.worker.global.js");
