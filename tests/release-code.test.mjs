// The "Release code" action (.github/actions/release-code): scheduled jobs and
// the production deploy run the last release's code over main's data.
// Runs the real script against scratch git repositories; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/actions/release-code/release-code.sh"
);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

/**
 * An "origin" with a release and a newer main, and a shallow clone of main
 * like actions/checkout makes.
 *   release: code "old", pipeline/gone.mjs, data "old", workflow "old"
 *   main:    code "new", pipeline/added.mjs, data "new", workflow "new"
 */
function scratch({ tags = ["v0.1.0"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-code-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  write(origin, "pipeline/a.mjs", "old\n");
  write(origin, "pipeline/gone.mjs", "only in the release\n");
  write(origin, "data/feed.json", '["old"]\n');
  write(origin, ".github/workflows/w.yml", "old\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "release");
  for (const t of tags) git(origin, "tag", "-a", t, "-m", t);
  const releaseSha = git(origin, "rev-parse", "HEAD");

  write(origin, "pipeline/a.mjs", "new\n");
  fs.rmSync(path.join(origin, "pipeline/gone.mjs"));
  write(origin, "pipeline/added.mjs", "only on main\n");
  write(origin, "data/feed.json", '["new"]\n');
  write(origin, ".github/workflows/w.yml", "new\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "main moves on");

  const work = path.join(root, "work");
  git(root, "clone", "-q", "--depth", "1", "--no-tags", `file://${origin}`, work);
  return { root, origin, work, releaseSha, mainSha: git(work, "rev-parse", "HEAD") };
}

function run(work, code) {
  const out = path.join(work, "..", "out.txt");
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: work,
    env: { ...GIT_ENV, CODE: code, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: "/dev/null" },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const exists = (dir, file) => fs.existsSync(path.join(dir, file));

test("the release's code runs over main's data and workflows", () => {
  const s = scratch();
  const r = run(s.work, "release");
  assert.equal(r.status, 0, r.stderr);

  assert.equal(read(s.work, "pipeline/a.mjs"), "old\n", "code is the release's");
  assert.ok(exists(s.work, "pipeline/gone.mjs"), "a file main deleted since comes back");
  assert.ok(!exists(s.work, "pipeline/added.mjs"), "a file the release does not have is gone");
  assert.equal(read(s.work, "data/feed.json"), '["new"]\n', "data stays main's");
  assert.equal(read(s.work, ".github/workflows/w.yml"), "new\n", "workflows stay main's");

  assert.equal(r.outputs.tag, "v0.1.0");
  assert.equal(r.outputs.sha, s.releaseSha);
  assert.equal(git(s.work, "rev-parse", "HEAD"), s.mainSha, "HEAD stays on main");
  fs.rmSync(s.root, { recursive: true, force: true });
});

test("a data commit made afterwards holds data only, on top of main", () => {
  const s = scratch();
  assert.equal(run(s.work, "release").status, 0);
  // What the nightly sync does: change the list, add those files, commit.
  write(s.work, "data/feed.json", '["new","newer"]\n');
  git(s.work, "switch", "-q", "-c", "data/sync");
  git(s.work, "add", "data/feed.json");
  git(s.work, "commit", "-q", "-m", "chore(data): sync");
  assert.equal(git(s.work, "diff", "--name-only", "HEAD~1", "HEAD"), "data/feed.json");
  assert.equal(git(s.work, "rev-parse", "HEAD~1"), s.mainSha);
  // The committed tree still has main's code, not the release's.
  assert.equal(git(s.work, "show", "HEAD:pipeline/a.mjs"), "new");
  fs.rmSync(s.root, { recursive: true, force: true });
});

test("the newest release is picked by version, and only plain vX.Y.Z tags count", () => {
  const s = scratch({ tags: ["v0.2.0", "v0.10.0", "v0.9.9", "v1.0.0-rc.1", "vnext"] });
  const r = run(s.work, "release");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.tag, "v0.10.0");
  fs.rmSync(s.root, { recursive: true, force: true });
});

test("an exact tag can be asked for (a rollback)", () => {
  const s = scratch({ tags: ["v0.1.0", "v0.2.0"] });
  const r = run(s.work, "v0.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.tag, "v0.1.0");
  assert.equal(read(s.work, "pipeline/a.mjs"), "old\n");
  fs.rmSync(s.root, { recursive: true, force: true });
});

test("with no release yet, and with \"checkout\", the tree is left as checked out", () => {
  for (const [tags, code] of [[[], "release"], [["v0.1.0"], "checkout"]]) {
    const s = scratch({ tags });
    const r = run(s.work, code);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.tag, "");
    assert.equal(r.outputs.sha, s.mainSha);
    assert.equal(read(s.work, "pipeline/a.mjs"), "new\n");
    assert.equal(git(s.work, "status", "--porcelain"), "");
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("anything else is refused, and a tag that does not exist fails", () => {
  const s = scratch();
  const bad = run(s.work, "main");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /not a release tag/);
  assert.notEqual(run(s.work, "v9.9.9").status, 0);
  assert.equal(read(s.work, "pipeline/a.mjs"), "new\n", "nothing was changed");
  fs.rmSync(s.root, { recursive: true, force: true });
});
