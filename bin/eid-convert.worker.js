// @gerege-systems/eid-mongolia-sdk/convert — хувиргагчийн worker. `?cache=<нэр>` бол soffice.wasm / soffice.data-г
// SDK-ийн урьдчилж татсан Cache Storage-аас өгнө (дахин татахгүй, blob URL-гүй); олдохгүй бол ердийн fetch.
// `?verbose=1` үгүй бол хувиргагчийн оношилгооны лог (console.log/info/debug, LibreOffice-ийн stdout/stderr) консолд
// гарахгүй — `wordToPdf({ verbose: true })`. `?v=<rev>` — manifest-ийн rev (immutable кэшийг шинэчлэх).
// Дараа нь @matbee/libreoffice-converter-ийн worker-ийг ачаална. CSP: script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'.
(function () {
  var q = new URL(self.location.href).searchParams;
  // browser.worker.global.js (eid-mongolia-convert-assets-ийн patch) print/printErr, SAL_LOG-ийг үүгээр сонгоно.
  self.EID_CONVERT_VERBOSE = q.get("verbose") === "1";
  if (!self.EID_CONVERT_VERBOSE) {
    var off = function () {};
    // console.error/warn үлдэнэ (жинхэнэ алдаа); upstream-ийн «[Worker] …», «[FS OPEN CALL] …» нь console.log.
    self.console.log = off;
    self.console.info = off;
    self.console.debug = off;
  }
  var name = q.get("cache");
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
(function () {
  var v = new URL(self.location.href).searchParams.get("v");
  importScripts("browser.worker.global.js" + (v ? "?v=" + encodeURIComponent(v) : ""));
})();
