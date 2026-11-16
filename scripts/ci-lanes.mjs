#!/usr/bin/env node
// Decides which CI jobs a pull request needs, from the files it changes
// (.github/workflows/ci.yml, DEPLOY.md "How a change ships").
//
// The question is not "which folder is the file in" but "can this file
// change what the site does". pipeline/ and lib/ hold both: the Worker
// imports pipeline/budget.mjs, and nothing but the nightly capture imports
// pipeline/capture.mjs. So the site's files are found by following the site's
// code, and a change is sorted like this:
//
//   docs   Markdown and docs/ that no code reads         nothing to run
//   code   code the site cannot reach: a script, a       typecheck, lint and
//          pipeline step only the nightly jobs run, a    the unit tests
//          unit test, a workflow file
//   site   everything else                               everything, with the
//                                                        Worker build and the
//                                                        browser tests
//
// It errs towards "site". A file counts as the site's when the site, or a
// test that needs the running site, imports it, names its path in a string
// (a spawned script, a file it reads) or builds a path into its folder.
// data/ is the site's: pages import the list, and the site tests pick
// portfolios by their place in it. Unknown is the site's too: a config file,
// a deleted or renamed file, a test helper or fixture, a nested test.
// A release pull request changes package.json, so it always runs everything.
//
//   node scripts/ci-lanes.mjs --base origin/main      prints key=value lines
//   node scripts/ci-lanes.mjs --all                   everything on
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** A test file needs the running site when it reads one of test-e2e.sh's variables. */
export const SITE_TEST_MARK = "E2E_";

/** Where the site starts: every file here is the site's, and so is what they reach. */
const SITE_DIRS = ["app", "components", "worker", "public", "data"];
const SITE_ROOT_FILES = ["auth.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.ts", "open-next.config.ts"];
/** Changing how CI or the tests run is proved by running all of it. */
const CI_FILES = [".github/workflows/ci.yml", "scripts/ci-lanes.mjs", "scripts/test-unit.mjs", "scripts/test-e2e.sh"];
const CODE_DIRS = ["pipeline", "scripts", "lib", ".github"];
/** Where code lives, for finding the Markdown files that code reads. */
const SOURCE_DIRS = ["app", "components", "worker", "lib", "pipeline", "scripts", "tests"];
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];
const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/;
// import x from "a", export * from "a", import "a", import("a"), require("a")
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
// Any quoted text that looks like a path to a file: "scripts/x.mjs", "../pipeline/judge.mjs".
const PATH_TEXT = /(["'`])((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)+\.[a-z]{1,5})\1/g;
// The fixed start of a built path: `../lib/${name}.mjs` reaches all of lib/.
const PATH_PREFIX = /`((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*)\/\$\{/g;
const MARKDOWN_NAME = /(["'`])([^"'`\n]*?([\w.-]+\.md))\1/g;
const READS_A_FILE = /readFile|readdir|\bjoin\(|\bresolve\(|new URL\(|import\.meta/;

const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);
/** Top-level test files only: those are what both runners run. */
const isTest = (file) => /^tests\/[^/]+\.test\.mjs$/.test(file);

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

function isDir(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** A path as written in `importer`, as a repository path: relative to the file, or "@/" from the root. */
function fromFile(importer, spec) {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (!spec.startsWith(".")) return null;
  const rel = path.posix.join(path.posix.dirname(importer), spec);
  return rel.startsWith("..") ? null : rel;
}

/** The repository file an import names, or null for a package or a missing file. */
export function resolveImport(root, importer, spec) {
  const base = fromFile(importer, spec);
  if (base === null) return null;
  for (const ext of EXTENSIONS) {
    if (isFile(root, base + ext)) return base + ext;
  }
  return null;
}

/** The repository files a source file imports. */
export function importsOf(root, file) {
  const text = SOURCE.test(file) ? read(root, file) : null;
  if (text === null) return [];
  const found = new Set();
  for (const m of text.matchAll(IMPORT)) {
    const target = resolveImport(root, file, m[2]);
    if (target) found.add(target);
  }
  return [...found];
}

/**
 * The files a source file reaches without importing them: a path in a string
 * (a script it spawns, a file it reads), tried from the file's folder and from
 * the root; and every file under a folder it builds a path into.
 */
function pathsNamedIn(root, file) {
  const text = SOURCE.test(file) ? read(root, file) : null;
  if (text === null) return [];
  const found = new Set();
  for (const m of text.matchAll(PATH_TEXT)) {
    for (const candidate of [fromFile(file, m[2].startsWith(".") ? m[2] : `./${m[2]}`), m[2].replace(/^(\.{1,2}\/)+/, "")]) {
      if (candidate && isFile(root, candidate)) found.add(candidate);
    }
  }
  for (const m of text.matchAll(PATH_PREFIX)) {
    for (const candidate of [fromFile(file, m[1].startsWith(".") ? m[1] : `./${m[1]}`), m[1].replace(/^(\.{1,2}\/)+/, "")]) {
      if (candidate && SOURCE_DIRS.some((d) => under(candidate, d)) && isDir(root, candidate)) {
        for (const f of walk(root, candidate)) found.add(f);
      }
    }
  }
  return [...found];
}

/** Every repository file reachable from the given files, themselves included. */
export function reachable(root, starts) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of [...importsOf(root, file), ...pathsNamedIn(root, file)]) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function needsSite(root, testFile) {
  return (read(root, testFile) ?? SITE_TEST_MARK).includes(SITE_TEST_MARK);
}

const topLevelTests = (root) => walk(root, "tests").filter(isTest).sort();

/** The test files that run without the site (npm run test:unit). */
export const unitTests = (root) => topLevelTests(root).filter((f) => !needsSite(root, f));

/** The test files that need the running site (the rest of npm run test:e2e). */
export const siteTests = (root) => topLevelTests(root).filter((f) => needsSite(root, f));

/** The site's files: its folders, what they reach, and what the tests that need the site reach. */
export function siteFiles(root) {
  return reachable(root, [
    ...SITE_DIRS.flatMap((d) => walk(root, d)),
    ...SITE_ROOT_FILES.filter((f) => isFile(root, f)),
    ...siteTests(root),
  ]);
}

/**
 * Names of Markdown files some code reads: named in a string on a line that
 * builds a path or reads a file (a mention in a message or a comment does not
 * count, or every edit to DEPLOY.md would run everything).
 */
function markdownReadByCode(root) {
  const names = new Set();
  for (const file of SOURCE_DIRS.flatMap((d) => walk(root, d))) {
    const text = SOURCE.test(file) ? read(root, file) : null;
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!READS_A_FILE.test(line)) continue;
      for (const m of line.matchAll(MARKDOWN_NAME)) names.add(m[3]);
    }
  }
  return names;
}

/**
 * @param {string} root the repository
 * @param {string[]} changed repository-relative paths the pull request touches (old and new names of a rename)
 * @returns {{ code: boolean, site: boolean, why: Record<string, string> }}
 *   code: typecheck, lint and unit tests; site: everything. why: the lane each file was put in.
 */
export function lanes(root, changed) {
  const site = siteFiles(root);
  const readMarkdown = markdownReadByCode(root);
  // Documentation is Markdown and docs/ that no code reads. A fixture under
  // tests/ is an input to a test, and so is GRADING_CRITERIA.md.
  const isDocs = (file) =>
    file === "LICENSE" ||
    (!under(file, "tests") &&
      (under(file, "docs") || file.endsWith(".md")) &&
      !(file.endsWith(".md") && readMarkdown.has(path.posix.basename(file))));
  const why = {};
  for (const file of changed) {
    if (isDocs(file)) why[file] = "docs";
    else if (!isFile(root, file)) why[file] = "site"; // deleted or renamed away: what read it is unknown
    else if (CI_FILES.includes(file)) why[file] = "site";
    else if (site.has(file) || SITE_DIRS.some((d) => under(file, d))) why[file] = "site";
    else if (isTest(file)) why[file] = needsSite(root, file) ? "site" : "code";
    else if (CODE_DIRS.some((d) => under(file, d))) why[file] = "code";
    else why[file] = "site"; // package.json, a config file, a test helper, fixture or nested test
  }
  const has = (lane) => Object.values(why).includes(lane);
  return { site: has("site"), code: has("code") || has("site"), why };
}

function changedSince(root, base) {
  // Both names of a rename, and deleted files too: lanes() sorts a missing file as "site".
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
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
  const result = all ? { code: true, site: true, why: {} } : lanes(root, changedSince(root, base));
  const jobs = {
    // Typecheck, lint and the unit tests, in one job.
    typecheck: result.code,
    worker: result.site,
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
