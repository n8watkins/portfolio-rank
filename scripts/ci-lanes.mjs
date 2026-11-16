#!/usr/bin/env node
// Decides which CI jobs a pull request needs, from the files it changes
// (.github/workflows/ci.yml, DEPLOY.md "How a change ships").
//
// The question is not "which folder is the file in" but "can this file
// change what the site does". pipeline/ and lib/ hold both: the Worker
// imports pipeline/budget.mjs, and nothing but the nightly capture imports
// pipeline/capture.mjs. So the site's files are found by following imports
// from where the site starts, and a change is sorted like this:
//
//   docs      *.md, docs/, LICENSE                       nothing to run
//   site      a file the site (or a test that needs the  everything: typecheck, unit
//             running site) reaches through imports,     tests, the Worker build and
//             and anything not known to be lighter       the browser tests
//   data      data/                                      typecheck, unit tests, the data
//                                                        check and the Worker build
//   code      other code: a script, a pipeline step the  typecheck and unit tests
//             site never imports, a unit test, a
//             workflow file
//
// Unknown means site: a config file, a deleted or renamed file, a test
// helper. A release pull request changes package.json, so it always runs
// everything, which is the full check before a deploy.
//
//   node scripts/ci-lanes.mjs --base origin/main      prints key=value lines
//   node scripts/ci-lanes.mjs --all                   everything on
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** A test file needs the running site when it reads one of test-e2e.sh's variables. */
export const SITE_TEST_MARK = "E2E_";

/** Where the site starts: every file here is the site's, and so is what they import. */
const SITE_DIRS = ["app", "components", "worker", "public"];
const SITE_ROOT_FILES = ["auth.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.ts", "open-next.config.ts"];
/** Changing how CI or the tests run is proved by running all of it. */
const CI_FILES = [
  ".github/workflows/ci.yml",
  "scripts/ci-lanes.mjs",
  "scripts/test-unit.mjs",
  "scripts/test-e2e.sh",
  "scripts/check-data.mjs",
];
const CODE_DIRS = ["pipeline", "scripts", "lib", ".github"];
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];
const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/;
// import x from "a", export * from "a", import "a", import("a"), require("a")
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;

const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);
export const isDocs = (file) => file.endsWith(".md") || under(file, "docs") || file === "LICENSE";
const isTest = (file) => under(file, "tests") && file.endsWith(".test.mjs");

function walk(root, dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(root, rel, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function isFile(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** The repository file an import names, or null for a package or a missing file. */
export function resolveImport(root, importer, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(importer), spec);
  else return null;
  if (base.startsWith("..")) return null;
  for (const ext of EXTENSIONS) {
    if (isFile(root, base + ext)) return base + ext;
  }
  return null;
}

/** Every repository file reachable through imports from the given files, themselves included. */
export function reachable(root, starts) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT)) {
      const target = resolveImport(root, file, m[2]);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function needsSite(root, testFile) {
  try {
    return fs.readFileSync(path.join(root, testFile), "utf8").includes(SITE_TEST_MARK);
  } catch {
    return true;
  }
}

/** The test files that run without the site (npm run test:unit). */
export function unitTests(root) {
  return walk(root, "tests")
    .filter((f) => isTest(f) && !f.slice("tests/".length).includes("/") && !needsSite(root, f))
    .sort();
}

/** The site's files: its folders, what they import, and what the tests that need the site import. */
export function siteFiles(root) {
  const starts = [
    ...SITE_DIRS.flatMap((d) => walk(root, d)),
    ...SITE_ROOT_FILES.filter((f) => isFile(root, f)),
    ...walk(root, "tests").filter((f) => isTest(f) && needsSite(root, f)),
  ];
  return reachable(root, starts);
}

/**
 * @param {string} root the repository
 * @param {string[]} changed repository-relative paths the pull request touches (old and new names of a rename)
 * @returns {{ code: boolean, site: boolean, data: boolean, why: Record<string, string> }}
 *   code: typecheck, lint and unit tests; data: plus the data check and the Worker build;
 *   site: everything. why: the lane each file was put in.
 */
export function lanes(root, changed) {
  const site = siteFiles(root);
  const why = {};
  for (const file of changed) {
    if (isDocs(file)) why[file] = "docs";
    else if (!isFile(root, file)) why[file] = "site"; // deleted or renamed away: what read it is unknown
    else if (CI_FILES.includes(file)) why[file] = "site";
    // Before the site check: pages import the list, but new rows in it are
    // proved by the data check and a build, not by the browser tests.
    else if (under(file, "data")) why[file] = "data";
    else if (site.has(file) || SITE_DIRS.some((d) => under(file, d))) why[file] = "site";
    else if (isTest(file)) why[file] = needsSite(root, file) ? "site" : "code";
    else if (CODE_DIRS.some((d) => under(file, d))) why[file] = "code";
    else why[file] = "site"; // package.json, a config file, a test helper or fixture
  }
  const has = (lane) => Object.values(why).includes(lane);
  return { site: has("site"), data: has("data"), code: has("code") || has("data") || has("site"), why };
}

function changedSince(root, base) {
  // Both names of a rename, and deleted files too: lanes() sorts a missing file as "site".
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const root = process.cwd();
  const all = args.includes("--all");
  const base = args[args.indexOf("--base") + 1];
  if (!all && (!args.includes("--base") || !base)) {
    console.error("usage: ci-lanes.mjs --base <ref> | --all");
    process.exit(2);
  }
  const result = all ? { code: true, site: true, data: true, why: {} } : lanes(root, changedSince(root, base));
  const jobs = {
    // Typecheck, lint and the unit tests, in one job.
    typecheck: result.code,
    worker: result.site || result.data,
    e2e: result.site,
  };
  for (const [job, on] of Object.entries(jobs)) console.log(`${job}=${on}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const ran = Object.entries(jobs).filter(([, on]) => on).map(([j]) => j);
    const lines = [
      `## CI lanes`,
      all ? "Everything runs (asked for)." : `Runs: ${ran.length ? ran.join(", ") : "nothing (docs only)"}.`,
      "",
      ...Object.entries(result.why).slice(0, 200).map(([f, lane]) => `- \`${f}\`: ${lane}`),
    ];
    fs.appendFileSync(summary, `${lines.join("\n")}\n`);
  }
}
