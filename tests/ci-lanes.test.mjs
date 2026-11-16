// scripts/ci-lanes.mjs: which CI jobs a pull request needs, from its files.
// Scratch repositories on disk, plus a few checks against this repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_TEST_MARK, importsOf, lanes, reachable, resolveImport, siteFiles, siteTests, unitTests } from "../scripts/ci-lanes.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

// The mark is spelled from the constant, so this file stays a unit test itself.
const SITE_TEST = `const base = process.env.${SITE_TEST_MARK}BASE_URL;`;

const TREE = {
  "app/page.tsx": 'import { a } from "@/lib/a";\nimport feed from "@/data/feed.json";\nexport default a;',
  "worker/index.ts": 'import { night } from "../pipeline/night.mjs";\nconst lazy = () => import("../lib/lazy.ts");',
  "lib/a.ts": 'export * from "./b";',
  "lib/b.ts": "export const a = 1;",
  "lib/lazy.ts": "export const z = 1;",
  "lib/only-scripts.mjs": "export const s = 1;",
  "lib/via-e2e.mjs": "export const v = 1;",
  "lib/plugins/one.mjs": "export const one = 1;",
  "lib/plugins/two.mjs": "export const two = 2;",
  "pipeline/night.mjs": 'import { budget } from "./budget.mjs";',
  "pipeline/budget.mjs": "export const budget = 1;",
  "pipeline/capture.mjs": 'import { chromium } from "playwright";\nimport { s } from "../lib/only-scripts.mjs";',
  "pipeline/spawned.mjs": "console.log(1);",
  "scripts/backup.mjs": 'import { s } from "../lib/only-scripts.mjs";',
  "scripts/rubric-docs.mjs": 'const DOC = join(here, "..", "GRADING_CRITERIA.md");',
  "data/feed.json": "[]",
  "tests/unit.test.mjs": 'import "../pipeline/capture.mjs";',
  "tests/site.test.mjs": `${SITE_TEST}\nimport "../lib/via-e2e.mjs";\nspawn("node", ["pipeline/spawned.mjs"]);\nconst load = (n) => import(\`../lib/plugins/\${n}.mjs\`);`,
  "tests/nested/deep.test.mjs": "import 'node:test';",
  "tests/helpers/session.mjs": "export const x = 1;",
  "tests/fixtures/notes.md": "a fixture",
  ".github/workflows/health.yml": "name: x",
  ".github/workflows/ci.yml": "name: CI",
  "docs/NOTES.md": "notes",
  "docs/diagram.png": "png",
  "README.md": "readme",
  "GRADING_CRITERIA.md": "| rubric |",
  "package.json": "{}",
  "wrangler.jsonc": "{}",
};

test("imports are followed: relative, the @/ alias, missing extensions, dynamic imports", () => {
  const root = scratch(TREE);
  assert.equal(resolveImport(root, "app/page.tsx", "@/lib/a"), "lib/a.ts");
  assert.equal(resolveImport(root, "lib/a.ts", "./b"), "lib/b.ts");
  assert.equal(resolveImport(root, "app/page.tsx", "react"), null, "a package is not a repository file");
  assert.equal(resolveImport(root, "app/page.tsx", "../../outside"), null);
  assert.deepEqual(importsOf(root, "app/page.tsx").sort(), ["data/feed.json", "lib/a.ts"]);
  const seen = reachable(root, ["worker/index.ts"]);
  assert.ok(seen.has("pipeline/budget.mjs"), "through pipeline/night.mjs");
  assert.ok(seen.has("lib/lazy.ts"), "a dynamic import counts");
  assert.ok(!seen.has("pipeline/capture.mjs"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a file reached without an import is the site's too: a spawned script, a built path", () => {
  const root = scratch(TREE);
  const site = siteFiles(root);
  assert.ok(site.has("pipeline/spawned.mjs"), "its path is in a string a site test passes to spawn");
  assert.ok(site.has("lib/plugins/one.mjs") && site.has("lib/plugins/two.mjs"), "a path built into lib/plugins/ reaches all of it");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the site's files are what it reaches, wherever they live", () => {
  const root = scratch(TREE);
  const site = siteFiles(root);
  for (const f of ["app/page.tsx", "lib/a.ts", "lib/b.ts", "pipeline/night.mjs", "pipeline/budget.mjs", "data/feed.json"]) {
    assert.ok(site.has(f), `${f} is the site's`);
  }
  assert.ok(site.has("lib/via-e2e.mjs"), "a file only a site test imports still needs the site tests");
  for (const f of ["pipeline/capture.mjs", "lib/only-scripts.mjs", "scripts/backup.mjs"]) {
    assert.ok(!site.has(f), `${f} is not the site's`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("each kind of change gets its lane", () => {
  const root = scratch(TREE);
  const lane = (file) => lanes(root, [file]).why[file];
  assert.equal(lane("README.md"), "docs");
  assert.equal(lane("docs/NOTES.md"), "docs");
  assert.equal(lane("docs/diagram.png"), "docs");
  assert.equal(lane("GRADING_CRITERIA.md"), "site", "a script reads it and a test checks it: not documentation");
  assert.equal(lane("tests/fixtures/notes.md"), "site", "a fixture is a test's input");
  assert.equal(lane("app/page.tsx"), "site");
  assert.equal(lane("pipeline/budget.mjs"), "site", "the Worker imports it");
  assert.equal(lane("pipeline/capture.mjs"), "code", "only the nightly capture runs it");
  assert.equal(lane("lib/only-scripts.mjs"), "code");
  assert.equal(lane("scripts/backup.mjs"), "code");
  assert.equal(lane(".github/workflows/health.yml"), "code");
  assert.equal(lane(".github/workflows/ci.yml"), "site", "a change to CI is proved by all of CI");
  assert.equal(lane("data/feed.json"), "site", "pages import the list and site tests pick rows from it");
  assert.equal(lane("tests/unit.test.mjs"), "code");
  assert.equal(lane("tests/site.test.mjs"), "site");
  assert.equal(lane("tests/nested/deep.test.mjs"), "site", "no runner runs a nested test, so it never passes as checked");
  assert.equal(lane("tests/helpers/session.mjs"), "site", "a helper: unknown, so everything");
  assert.equal(lane("package.json"), "site", "which a release pull request always changes");
  assert.equal(lane("wrangler.jsonc"), "site");
  assert.equal(lane("pipeline/deleted.mjs"), "site", "a deleted file: what read it is unknown");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a pull request runs the heaviest lane any of its files needs", () => {
  const root = scratch(TREE);
  const of = (...files) => {
    const { code, site } = lanes(root, files);
    return { code, site };
  };
  assert.deepEqual(of("README.md", "docs/NOTES.md"), { code: false, site: false });
  assert.deepEqual(of("pipeline/capture.mjs", "tests/unit.test.mjs", "README.md"), { code: true, site: false });
  assert.deepEqual(of("data/feed.json"), { code: true, site: true });
  assert.deepEqual(of("pipeline/capture.mjs", "pipeline/budget.mjs"), { code: true, site: true });
  assert.deepEqual(of(), { code: false, site: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test("every top-level test is run by exactly one list: unit, or needing the site", () => {
  const root = scratch(TREE);
  assert.deepEqual(unitTests(root), ["tests/unit.test.mjs"]);
  assert.deepEqual(siteTests(root), ["tests/site.test.mjs"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("in this repository: the Worker's pipeline imports are the site's, the capture is not", () => {
  const site = siteFiles(REPO);
  assert.ok(site.has("pipeline/budget.mjs"));
  assert.ok(site.has("lib/schema.mjs"));
  assert.ok(site.has("data/feed.json"));
  assert.ok(!site.has("pipeline/capture.mjs"));
  const lane = (file) => lanes(REPO, [file]).why[file];
  assert.equal(lane("GRADING_CRITERIA.md"), "site", "tests/rubric.test.mjs checks it against the rubric");
  assert.equal(lane("DEPLOY.md"), "docs");
  const units = unitTests(REPO);
  const sites = siteTests(REPO);
  assert.ok(units.includes("tests/ci-lanes.test.mjs"));
  assert.ok(units.length > 50 && sites.length > 20, `found ${units.length} and ${sites.length}`);
  const all = fs.readdirSync(path.join(REPO, "tests")).filter((f) => f.endsWith(".test.mjs")).length;
  assert.equal(units.length + sites.length, all, "no top-level test is left out of both");
});
