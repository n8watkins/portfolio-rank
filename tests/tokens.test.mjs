// The design tokens in app/globals.css: every text colour reaches 4.5:1 on
// every surface. The site is dark only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** The --color-* values declared in the first block that starts with `opener`. */
function block(opener) {
  const start = css.indexOf(opener);
  assert.ok(start >= 0, `no ${opener} block in globals.css`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

const dark = block("@theme {");

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ["ink", "mute", "accent", "up", "down"];
const SURFACES = ["bg", "card", "raised"];

test("every text token reaches 4.5:1 on every surface", () => {
  for (const t of TEXT)
    for (const s of SURFACES) {
      const ratio = contrast(dark[t], dark[s]);
      assert.ok(ratio >= 4.5, `${t} ${dark[t]} on ${s} ${dark[s]}: ${ratio.toFixed(2)}:1`);
    }
});
test("text on the amber fill reaches 4.5:1", () => {
  assert.ok(contrast(dark["on-fill"], dark.fill) >= 4.5);
});

test("there is no light theme: no theme switch, no light scheme outside print", () => {
  assert.ok(!/data-theme/.test(css), "globals.css still mentions data-theme");
  const screen = css.slice(0, css.indexOf("@media print"));
  assert.ok(!/prefers-color-scheme/.test(css), "globals.css still follows the system scheme");
  assert.ok(!/color-scheme:\s*light/.test(screen), "a light colour-scheme outside print");
  assert.match(screen, /:root\s*{\s*color-scheme:\s*dark/);
});
