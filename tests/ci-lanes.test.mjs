// scripts/ci-lanes.mjs: which CI jobs a pull request needs, from its files.
// Scratch repositories on disk, plus a few checks against this repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_TEST_MARK, lanes, reachable, resolveImport, siteFiles, unitTests } from "../scripts/ci-lanes.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const TREE = {
  "app/page.tsx": 'import { a } from "@/lib/a";\nimport feed from "@/data/feed.json";\nexport default a;',
  "worker/index.ts": 'import { night } from "../pipeline/night.mjs";\nconst lazy = () => import("../lib/lazy.ts");',
  "lib/a.ts": 'export * from "./b";',
  "lib/b.ts": "export const a = 1;",
  "lib/lazy.ts": "export const z = 1;",
  "lib/only-scripts.mjs": "export const s = 1;",
  "lib/via-e2e.mjs": "export const v = 1;",
  "pipeline/night.mjs": 'import { budget } from "./budget.mjs";',
  "pipeline/budget.mjs": "export const budget = 1;",
  "pipeline/capture.mjs": 'import { chromium } from "playwright";\nimport { s } from "../lib/only-scripts.mjs";',
  "scripts/backup.mjs": 'import { s } from "../lib/only-scripts.mjs";',
  "data/feed.json": "[]",
  "tests/unit.test.mjs": 'import "../pipeline/capture.mjs";',
  // The mark is spelled from the constant, so this file stays a unit test itself.
  "tests/site.test.mjs": `const base = process.env.${SITE_TEST_MARK}BASE_URL;\nimport "../lib/via-e2e.mjs";`,
  "tests/helpers/session.mjs": "export const x = 1;",
  ".github/workflows/health.yml": "name: x",
  ".github/workflows/ci.yml": "name: CI",
  "docs/NOTES.md": "notes",
  "README.md": "readme",
  "package.json": "{}",
  "wrangler.jsonc": "{}",
};

test("imports are followed: relative, the @/ alias, missing extensions, dynamic imports", () => {
  const root = scratch(TREE);
  assert.equal(resolveImport(root, "app/page.tsx", "@/lib/a"), "lib/a.ts");
  assert.equal(resolveImport(root, "lib/a.ts", "./b"), "lib/b.ts");
  assert.equal(resolveImport(root, "app/page.tsx", "react"), null, "a package is not a repository file");
  assert.equal(resolveImport(root, "app/page.tsx", "../../outside"), null);
  const seen = reachable(root, ["worker/index.ts"]);
  assert.ok(seen.has("pipeline/budget.mjs"), "through pipeline/night.mjs");
  assert.ok(seen.has("lib/lazy.ts"), "a dynamic import counts");
  assert.ok(!seen.has("pipeline/capture.mjs"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the site's files are what it imports, wherever they live", () => {
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
  assert.equal(lane("app/page.tsx"), "site");
  assert.equal(lane("pipeline/budget.mjs"), "site", "the Worker imports it");
  assert.equal(lane("pipeline/capture.mjs"), "code", "only the nightly capture runs it");
  assert.equal(lane("lib/only-scripts.mjs"), "code");
  assert.equal(lane("scripts/backup.mjs"), "code");
  assert.equal(lane(".github/workflows/health.yml"), "code");
  assert.equal(lane(".github/workflows/ci.yml"), "site", "a change to CI is proved by all of CI");
  assert.equal(lane("data/feed.json"), "data", "although a page imports it");
  assert.equal(lane("tests/unit.test.mjs"), "code");
  assert.equal(lane("tests/site.test.mjs"), "site");
  assert.equal(lane("tests/helpers/session.mjs"), "site", "a helper: unknown, so everything");
  assert.equal(lane("package.json"), "site", "which a release pull request always changes");
  assert.equal(lane("wrangler.jsonc"), "site");
  assert.equal(lane("pipeline/deleted.mjs"), "site", "a deleted file: what read it is unknown");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a pull request runs the heaviest lane any of its files needs", () => {
  const root = scratch(TREE);
  const of = (...files) => {
    const { code, data, site } = lanes(root, files);
    return { code, data, site };
  };
  assert.deepEqual(of("README.md", "docs/NOTES.md"), { code: false, data: false, site: false });
  assert.deepEqual(of("pipeline/capture.mjs", "tests/unit.test.mjs", "README.md"), { code: true, data: false, site: false });
  assert.deepEqual(of("data/feed.json"), { code: true, data: true, site: false });
  assert.deepEqual(of("pipeline/capture.mjs", "pipeline/budget.mjs"), { code: true, data: false, site: true });
  assert.deepEqual(of(), { code: false, data: false, site: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test("unit tests are the top-level test files that read none of the site run's variables", () => {
  const root = scratch(TREE);
  assert.deepEqual(unitTests(root), ["tests/unit.test.mjs"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("in this repository: the Worker's pipeline imports are the site's, the capture is not", () => {
  const site = siteFiles(REPO);
  assert.ok(site.has("pipeline/budget.mjs"));
  assert.ok(site.has("lib/schema.mjs"));
  assert.ok(site.has("data/feed.json"));
  assert.ok(!site.has("pipeline/capture.mjs"));
  const units = unitTests(REPO);
  assert.ok(units.includes("tests/ci-lanes.test.mjs"));
  assert.ok(units.length > 50, `found ${units.length}`);
});
