// The design tokens in app/globals.css: every text colour reaches 4.5:1 on
// every surface, in the dark theme and the light one.
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
const light = { ...dark, ...block(':root[data-theme="light"] {') };

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

for (const [name, theme] of [
  ["dark", dark],
  ["light", light],
]) {
  test(`${name} theme: every text token reaches 4.5:1 on every surface`, () => {
    for (const t of TEXT)
      for (const s of SURFACES) {
        const ratio = contrast(theme[t], theme[s]);
        assert.ok(ratio >= 4.5, `${t} ${theme[t]} on ${s} ${theme[s]}: ${ratio.toFixed(2)}:1`);
      }
  });
  test(`${name} theme: text on the amber fill reaches 4.5:1`, () => {
    assert.ok(contrast(theme["on-fill"], theme.fill) >= 4.5);
  });
}

test("the system light theme and the chosen light theme use the same colours", () => {
  const system = block(':root:not([data-theme="dark"]) {');
  for (const [k, v] of Object.entries(system)) assert.equal(light[k], v, `--color-${k}`);
});
