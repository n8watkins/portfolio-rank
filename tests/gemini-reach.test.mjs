// No visitor action spends Gemini (owner, 2026-11-12), except someone asking
// for their own grade. Checked statically: from every route, page and layout
// under app/, and every Worker entry, follow the imports and list the ones
// that can reach code calling Gemini (createGemini or the own-key check).
// Anything outside the allowed list fails, so a new path has to be looked at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EXTS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const e of EXTS) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const importsOf = new Map();
function imports(file) {
  if (!importsOf.has(file)) {
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);
    importsOf.set(file, specs.map((s) => resolveImport(file, s)).filter(Boolean));
  }
  return importsOf.get(file);
}

/** Files that call Gemini themselves (the client's definition excluded). */
const callsGemini = (file) => {
  if (file.endsWith("pipeline/gemini.mjs")) return false;
  const src = readFileSync(file, "utf8");
  return /\bcreateGemini\s*\(/.test(src) || /generativelanguage\.googleapis\.com/.test(src);
};

function reaches(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (callsGemini(f)) return relative(ROOT, f);
    stack.push(...imports(f));
  }
  return null;
}

// Allowed: "grade my portfolio" (the visitor's own grade: our key queued or
// their own key), the admin's tools (requireAdmin on every route), and the
// scheduled Workers (cron, no visitor).
const ALLOWED = [
  /^app\/api\/grade\/route\.ts$/,
  /^app\/api\/grade\/\[id\]\/finish\/route\.ts$/,
  /^app\/api\/admin\//,
  /^app\/admin\//,
  /^worker\//,
];

test("only grading your own portfolio, the admin and the scheduled jobs can reach Gemini", () => {
  const entries = [
    ...walk(join(ROOT, "app")).filter((f) => /\/(route|page|layout)\.tsx?$/.test(f)),
    ...walk(join(ROOT, "worker")).filter((f) => /\.ts$/.test(f)),
  ];
  const reaching = entries.map((e) => [relative(ROOT, e), reaches(e)]).filter(([, via]) => via);
  const visitor = reaching.filter(([e]) => !ALLOWED.some((r) => r.test(e)));
  assert.deepEqual(visitor, [], `visitor entry points that can reach Gemini:\n${visitor.map(([e, v]) => `${e} -> ${v}`).join("\n")}`);
  // The grade routes are found at all (the walk works).
  const names = reaching.map(([e]) => e);
  assert.ok(names.includes("app/api/grade/[id]/finish/route.ts"), names.join("\n"));
  if (process.env.GEMINI_REACH_LIST) console.log(reaching.map(([e, v]) => `${e} -> ${v}`).join("\n"));
});
