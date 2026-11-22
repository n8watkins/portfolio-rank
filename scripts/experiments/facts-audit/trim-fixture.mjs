#!/usr/bin/env node
// A saved rendered page (probe.mjs A-before.html) made small enough to keep
// as a unit-test fixture: scripts, styles, SVG path data, inline styles and
// class lists and data- attributes (but data-href, data-url, data-link)
// removed; tags, ids, hrefs, aria-labels, titles and text kept.
//
//   node scripts/experiments/facts-audit/trim-fixture.mjs <in.html> <out.html>
import fs from "node:fs";

const [src, dst] = process.argv.slice(2);
const html = fs
  .readFileSync(src, "utf8")
  .replace(/<script\b[\s\S]*?<\/script>/gi, "")
  .replace(/<style\b[\s\S]*?<\/style>/gi, "")
  .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
  .replace(/<(path|circle|rect|line|polyline|polygon|ellipse|g|defs|use|mask|clipPath|linearGradient|radialGradient|stop)\b[^>]*\/?>(<\/\1>)?/gi, "")
  .replace(/<link\b[^>]*>/gi, "")
  .replace(/<meta\b(?![^>]*name=["'](?:generator|description)["'])[^>]*>/gi, "")
  .replace(/\s(?:class|style|srcset|sizes|data-(?!href|url|link)[\w-]+|d|viewBox|fill|stroke[\w-]*|xmlns(?::\w+)?)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
  .replace(/\s{2,}/g, " ");
fs.writeFileSync(dst, html);
console.log(`${src}: ${fs.statSync(src).size} -> ${html.length} characters`);
