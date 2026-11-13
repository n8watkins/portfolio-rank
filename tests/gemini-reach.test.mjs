// No visitor action spends our Gemini key (owner, 2026-11-12). Checked
// statically: from every route, page and layout under app/, and every Worker
// entry, follow the imports and list the ones that can reach code calling
// Gemini (createGemini or Google's API address). Anything outside the
// allowed list fails, so a new path has to be looked at.
//
// The one Gemini call a visitor may cause is on their own key
// (lib/grader/own-key.mjs: checking it, or grading on it), so that module is
// a leaf the walk does not count or follow. A visitor who asks for the free
// tier only joins the people queue (lib/grader/queue.mjs), and the Worker's
// hourly drain grades it (fresh-eyes audit H3).
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

/** The visitor's own key: checked or graded on their key, never ours. */
const OWN_KEY = join(ROOT, "lib/grader/own-key.mjs");

/** Files that call Gemini themselves (the client's definition excluded). */
const callsGemini = (file) => {
  if (file.endsWith("pipeline/gemini.mjs")) return false;
  const src = readFileSync(file, "utf8");
  return /\bcreateGemini\s*\(/.test(src) || /generativelanguage\.googleapis\.com/.test(src);
};

/** Every file `entry` imports, directly or not, stopping at the own-key module. */
function reachable(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || f === OWN_KEY) continue;
    seen.add(f);
    stack.push(...imports(f));
  }
  return seen;
}

const reaches = (entry) => {
  for (const f of reachable(entry)) if (callsGemini(f)) return relative(ROOT, f);
  return null;
};

// Allowed: the admin's tools (requireAdmin on every route) and the scheduled
// Workers (cron and Workflows, no visitor).
const ALLOWED = [/^app\/api\/admin\//, /^app\/admin\//, /^worker\//];

test("only the admin and the scheduled jobs can reach Gemini on our key", () => {
  const entries = [
    ...walk(join(ROOT, "app")).filter((f) => /\/(route|page|layout)\.tsx?$/.test(f)),
    ...walk(join(ROOT, "worker")).filter((f) => /\.ts$/.test(f)),
  ];
  const reaching = entries.map((e) => [relative(ROOT, e), reaches(e)]).filter(([, via]) => via);
  const visitor = reaching.filter(([e]) => !ALLOWED.some((r) => r.test(e)));
  assert.deepEqual(visitor, [], `visitor entry points that can reach Gemini:\n${visitor.map(([e, v]) => `${e} -> ${v}`).join("\n")}`);
  // The walk works: the scheduled Worker reaches Gemini.
  const names = reaching.map(([e]) => e);
  assert.ok(names.includes("worker/night.ts"), names.join("\n"));
  if (process.env.GEMINI_REACH_LIST) console.log(reaching.map(([e, v]) => `${e} -> ${v}`).join("\n"));
});

test("the free tier only enqueues: the finish route reaches the people queue's table, never its grader", () => {
  const files = [...reachable(join(ROOT, "app/api/grade/[id]/finish/route.ts"))].map((f) => relative(ROOT, f));
  assert.ok(files.includes("lib/grader/queue.mjs"), files.join("\n"));
  assert.ok(files.includes("pipeline/people-store.mjs"), files.join("\n"));
  for (const grader of ["pipeline/people.mjs", "lib/grader/free-grade.mjs", "pipeline/night.mjs"]) {
    assert.ok(!files.includes(grader), `${grader} is reachable from the finish route`);
  }
});
