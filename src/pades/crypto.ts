// Web Crypto (хөтөч, Node ≥ 19 global; Node 18 — node:crypto.webcrypto).

import type { webcrypto as wc } from "node:crypto";

type Subtle = wc.SubtleCrypto;

let subtlePromise: Promise<Subtle> | undefined;

// Bundler-ууд node:* модулийг браузерийн bundle-д татахгүйн тулд specifier хувьсагчаар.
const nodeImport = (m: string): Promise<{ webcrypto?: { subtle: Subtle; getRandomValues<T extends ArrayBufferView>(a: T): T } }> =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ m);

interface CryptoLike {
  subtle: Subtle;
  getRandomValues<T extends ArrayBufferView>(a: T): T;
}

async function webcrypto(): Promise<CryptoLike> {
  const g = (globalThis as { crypto?: CryptoLike }).crypto;
  if (g?.subtle) return g;
  const m = await nodeImport("node:crypto");
  if (!m.webcrypto) throw new Error("Web Crypto алга");
  return m.webcrypto;
}

export function subtle(): Promise<Subtle> {
  subtlePromise ??= webcrypto().then((c) => c.subtle);
  return subtlePromise;
}

export async function randomBytes(n: number): Promise<Uint8Array> {
  return (await webcrypto()).getRandomValues(new Uint8Array(n));
}

export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (await subtle()).digest("SHA-256", b));
}

export async function sha1(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (await subtle()).digest("SHA-1", b));
}

export async function digest(alg: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (await subtle()).digest(alg, b));
}
