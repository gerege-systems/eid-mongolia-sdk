#!/usr/bin/env bash
# Go PAdES core → WebAssembly (`wasm/eid-pades.wasm`) + тэр Go хувилбарын `wasm_exec.js` (`src/pades/wasm_exec.js`).
#
# Бэхэлгээ: Go SDK-ийн commit ба Go toolchain. wasm_exec.js нь wasm-ыг хөрвүүлсэн Go-той ЯГ ижил хувилбарынх байх ёстой
# (runtime ABI) — тиймээс энэ скрипт хоёуланг нэг GOROOT-оос гаргана. Бэхэлгээг солиход: GO_SDK_COMMIT / GO_VERSION-ийг
# засаад `npm run build:wasm`, `src/pades/wasm_exec.js`-ийн diff-ийг commit-д оруулна.
#
# Орчин: GO_SDK_DIR=<локал clone> өгвөл clone хийхгүй (commit-ийг checkout хийхгүй, зөвхөн шалгана).
# `--vectors`: Go core-ийн албан golden (pades/testdata/golden: manifest + input + pki)-ийг test/fixtures/pades/golden-д
# хуулж, test/fixtures/pades/vectors.json-ийг НАТИВ Go core-оор дахин гаргана (scripts/pades-vectors/main.go).
set -euo pipefail

GO_SDK_REPO="https://github.com/gerege-systems/eid-mongolia-sdk-go"
GO_SDK_COMMIT="${GO_SDK_COMMIT:-5947ebbd6a42591a4b007bf71e38ae6f5f33fcf1}"
GO_VERSION="1.25.5"
WASM_PKG="./wasm"

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/wasm"

have="$(go env GOVERSION)"
if [ "$have" != "go$GO_VERSION" ]; then
  echo "build-pades-wasm: Go $GO_VERSION хэрэгтэй, одоо $have (GOTOOLCHAIN=go$GO_VERSION go version)" >&2
  exit 1
fi

src="${GO_SDK_DIR:-}"
if [ -z "$src" ]; then
  src="$(mktemp -d)"
  trap 'rm -rf "$src"' EXIT
  git -C "$src" init -q
  git -C "$src" fetch -q --depth 1 "$GO_SDK_REPO" "$GO_SDK_COMMIT"
  git -C "$src" checkout -q FETCH_HEAD
fi
got="$(git -C "$src" rev-parse HEAD)"
if [ "$got" != "$GO_SDK_COMMIT" ]; then
  echo "build-pades-wasm: Go SDK $got ≠ бэхэлсэн $GO_SDK_COMMIT" >&2
  exit 1
fi

mkdir -p "$out"
# -trimpath + хоосон buildid: байт-давтагдах build (ижил commit + Go → ижил wasm).
(cd "$src" && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o "$out/eid-pades.wasm" "$WASM_PKG")
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$root/src/pades/wasm_exec.js"
printf '%s %s\n' "$GO_SDK_COMMIT" "$have" > "$out/VERSION"

if [ "${1:-}" = "--vectors" ]; then
  mkdir -p "$src/internal/tsvec"
  cp "$root/scripts/pades-vectors/main.go" "$src/internal/tsvec/main.go"
  (cd "$src" && go run ./internal/tsvec/main.go "$root/test/fixtures/pades") > "$root/test/fixtures/pades/vectors.json"
  rm -rf "$src/internal/tsvec"
  g="$root/test/fixtures/pades/golden"
  rm -rf "$g" && mkdir -p "$g"
  cp -R "$src/pades/testdata/golden/manifest.json" "$src/pades/testdata/golden/input" "$src/pades/testdata/golden/pki" "$g/"
  echo "pades: test/fixtures/pades/vectors.json шинэчлэгдлээ"
fi

echo "pades: $(wc -c < "$out/eid-pades.wasm" | tr -d ' ') байт, gzip $(gzip -9c "$out/eid-pades.wasm" | wc -c | tr -d ' ') байт ($GO_SDK_COMMIT, $have)"
