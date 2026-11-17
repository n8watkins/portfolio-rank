// The "Release code" action (.github/actions/release-code): scheduled jobs and
// the production deploy run production's release over main's data. Production
// is the commit the `production` branch points at, which only a successful
// deploy moves.
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

function commit(origin, code, { gone = false, added = false } = {}) {
  write(origin, "pipeline/a.mjs", `${code}\n`);
  write(origin, "data/feed.json", `["${code}"]\n`);
  write(origin, ".github/workflows/w.yml", `${code}\n`);
  if (gone) write(origin, "pipeline/gone.mjs", "only in the first release\n");
  else fs.rmSync(path.join(origin, "pipeline/gone.mjs"), { force: true });
  if (added) write(origin, "pipeline/added.mjs", "only on main\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", code);
  return git(origin, "rev-parse", "HEAD");
}

/**
 * An "origin" with two releases and a newer main, and a shallow clone of main
 * like actions/checkout makes.
 *   v0.1.0: code "one", pipeline/gone.mjs
 *   v0.2.0: code "two"
 *   main:   code "main", pipeline/added.mjs
 * `production` says which release is live: "v0.1.0", "v0.2.0" or null (none yet).
 */
function scratch({ production = "v0.2.0", extraTags = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-code-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  const one = commit(origin, "one", { gone: true });
  git(origin, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
  const two = commit(origin, "two");
  git(origin, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
  for (const t of extraTags) git(origin, "tag", "-a", t, "-m", t);
  commit(origin, "main", { added: true });
  const shas = { "v0.1.0": one, "v0.2.0": two };
  if (production) git(origin, "branch", "production", shas[production]);

  const work = path.join(root, "work");
  git(root, "clone", "-q", "--depth", "1", "--no-tags", "--single-branch", `file://${origin}`, work);
  return { root, origin, work, shas, mainSha: git(work, "rev-parse", "HEAD") };
}

function run(work, code, env = {}) {
  const out = path.join(work, "..", "out.txt");
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: work,
    env: { ...GIT_ENV, CODE: code, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: "/dev/null", ...env },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const exists = (dir, file) => fs.existsSync(path.join(dir, file));
const done = (s) => fs.rmSync(s.root, { recursive: true, force: true });

test("production's release runs over main's data and workflows", () => {
  const s = scratch({ production: "v0.1.0" });
  const r = run(s.work, "release");
  assert.equal(r.status, 0, r.stderr);

  assert.equal(read(s.work, "pipeline/a.mjs"), "one\n", "code is the release's");
  assert.ok(exists(s.work, "pipeline/gone.mjs"), "a file main deleted since comes back");
  assert.ok(!exists(s.work, "pipeline/added.mjs"), "a file the release does not have is gone");
  assert.equal(read(s.work, "data/feed.json"), '["main"]\n', "data stays main's");
  assert.equal(read(s.work, ".github/workflows/w.yml"), "main\n", "workflows stay main's");

  assert.equal(r.outputs.tag, "v0.1.0");
  assert.equal(r.outputs.sha, s.shas["v0.1.0"]);
  assert.equal(git(s.work, "rev-parse", "HEAD"), s.mainSha, "HEAD stays on main");
  done(s);
});

test("an empty code input means the release, like a scheduled run", () => {
  const s = scratch();
  const r = run(s.work, "");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.tag, "v0.2.0");
  done(s);
});

test("production is what was deployed, not the newest tag: a newer tag waits, a rollback sticks", () => {
  // v0.2.0 is tagged but its deploy has not succeeded (or the owner went back to v0.1.0).
  const s = scratch({ production: "v0.1.0", extraTags: ["v0.3.0"] });
  const r = run(s.work, "release");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.tag, "v0.1.0");
  assert.equal(read(s.work, "pipeline/a.mjs"), "one\n");
  done(s);
});

test("a data commit made afterwards holds data only, on top of main", () => {
  const s = scratch();
  assert.equal(run(s.work, "release").status, 0);
  // What the nightly sync does: change the list, add those files, commit.
  write(s.work, "data/feed.json", '["main","newer"]\n');
  git(s.work, "switch", "-q", "-c", "data/sync");
  git(s.work, "add", "data/feed.json");
  git(s.work, "commit", "-q", "-m", "chore(data): sync");
  assert.equal(git(s.work, "diff", "--name-only", "HEAD~1", "HEAD"), "data/feed.json");
  assert.equal(git(s.work, "rev-parse", "HEAD~1"), s.mainSha);
  // The committed tree still has main's code, not the release's.
  assert.equal(git(s.work, "show", "HEAD:pipeline/a.mjs"), "main");
  done(s);
});

test("an exact tag can be asked for (the deploy of a new release, or going back)", () => {
  const s = scratch({ production: "v0.2.0" });
  const r = run(s.work, "v0.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.tag, "v0.1.0");
  assert.equal(r.outputs.sha, s.shas["v0.1.0"]);
  assert.equal(read(s.work, "pipeline/a.mjs"), "one\n");
  done(s);
});

test("before the first deploy, and with \"checkout\", the tree is left as checked out", () => {
  for (const [production, code] of [[null, "release"], ["v0.2.0", "checkout"]]) {
    const s = scratch({ production });
    const r = run(s.work, code);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.tag, "");
    assert.equal(r.outputs.sha, s.mainSha);
    assert.equal(read(s.work, "pipeline/a.mjs"), "main\n");
    assert.equal(git(s.work, "status", "--porcelain"), "");
    done(s);
  }
});

test("a remote that cannot be reached is an error, never \"no release yet\"", () => {
  const s = scratch();
  const r = run(s.work, "release", { RELEASE_REMOTE: `file://${path.join(s.root, "nowhere")}` });
  assert.notEqual(r.status, 0, "the step fails");
  assert.equal(r.outputs.tag, undefined, "nothing was decided");
  assert.equal(read(s.work, "pipeline/a.mjs"), "main\n", "nothing was changed");
  done(s);
});

test("anything else is refused whole, and a tag that does not exist fails", () => {
  const s = scratch();
  for (const bad of ["main", "v1.0.0-rc.1", "junk\nv0.1.0", "v0.1.0\n--upload-pack=x"]) {
    const r = run(s.work, bad);
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.match(r.stdout, /must be "release", "checkout" or one release tag/);
  }
  assert.notEqual(run(s.work, "v9.9.9").status, 0);
  assert.equal(read(s.work, "pipeline/a.mjs"), "main\n", "nothing was changed");
  done(s);
});
