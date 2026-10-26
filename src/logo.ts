// eID Mongolia emblem (2026-10-26; developer-eidmongolia-mn site/brand/eid-mark.svg ба eid-mark-dark.svg) — товчинд
// inline SVG (гадны файл, сүлжээ, inline style үгүй). Theme-ээс хамаарах хоёр өнгө (зүүн тал, цагираг/хүрээ) нь
// элементийн class-аар shadow CSS-ээс (button.ts: light — #0A1631 / #fff, dark — #fff / #0A1631); бусад нь тогтмол.
export const EID_LOGO_VIEWBOX = "0 0 64 64";

type Shape = readonly [tag: "path" | "circle", attrs: Readonly<Record<string, string>>];

/** `m-a`: theme-ийн fill (зүүн тал); `m-l`: theme-ийн stroke (цагираг, төвийн дугуйн хүрээ). */
export const EID_LOGO_SHAPES: ReadonlyArray<Shape> = [
  ["path", { class: "m-a", d: "M18 4H30V60H18A14 14 0 0 1 4 46V18A14 14 0 0 1 18 4Z" }],
  ["path", { d: "M34 4H46A14 14 0 0 1 60 18V46A14 14 0 0 1 46 60H34Z", fill: "#2457E6" }],
  ["path", { class: "m-l", d: "M14 32H50A18 18 0 0 0 14 32A18 18 0 0 0 50 32", fill: "none", "stroke-width": "4.8", "stroke-linejoin": "round" }],
  ["circle", { class: "m-l", cx: "32", cy: "32", r: "12", fill: "#1564E1", "stroke-width": "1.4" }],
  ["path", { d: "M23.5 23.5L40.5 40.5M40.5 23.5L23.5 40.5", stroke: "#FFFFFF", "stroke-width": "1.8" }],
  ["circle", { cx: "32", cy: "32", r: "4.4", fill: "#FFFFFF" }],
  ["circle", { cx: "32", cy: "32", r: "3", fill: "#1564E1" }],
];
