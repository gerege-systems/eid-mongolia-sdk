// wasm/eid-pades.wasm (scripts/build-pades-wasm.sh-ийн гаралт) → dist/. `--require`: байхгүй бол унана (publish-ийн өмнө).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const src = new URL("../wasm/eid-pades.wasm", import.meta.url);
const dst = new URL("../dist/eid-pades.wasm", import.meta.url);
if (existsSync(src)) {
  mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
  copyFileSync(src, dst);
  console.log("pades: wasm/eid-pades.wasm → dist/");
} else if (process.argv.includes("--require") && !existsSync(dst)) {
  console.error("pades: dist/eid-pades.wasm алга — эхлээд `npm run build:wasm && npm run build`");
  process.exit(1);
} else {
  console.warn("pades: wasm/eid-pades.wasm алга — /pades WASM-гүй build (npm run build:wasm)");
}
