// The monthly pull request to the community list (pipeline/upstream-removals.mjs):
// which entries qualify, the README edit and the body format. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planUpstream, prTitle, removeFromReadme, selectCandidates } from "../pipeline/upstream-removals.mjs";

const README = `# Developer Portfolios

## Current Portfolio Count: 4

---

## A

- [Ada Dead](https://ada-dead.vercel.app) [Engineer]
- [Alan Fine](https://alan.dev)

## B

- [Bea Dead](https://www.bea.dev/) [Designer | Dev]
- [Bob Back](https://bob.dev)
`;

const confirmed = (url, over = {}) => ({
  url,
  name: url,
  reason: "HTTP 404",
  kind: "down",
  removed: "2026-11-15",
  first_failed: "2026-11-01T16:00:00Z",
  last_checked: "2026-11-15T16:00:00Z",
  checks: 3,
  ...over,
});

test("only confirmed-down exclusions with two weeks of evidence qualify", () => {
  const picked = selectCandidates([
    "https://legacy-string.example",
    confirmed("https://ok.example"),
    confirmed("https://short.example", { first_failed: "2026-11-10T00:00:00Z" }),
    confirmed("https://few.example", { checks: 2 }),
    confirmed("https://dup.example", { kind: "duplicate" }),
    confirmed("https://np.example", { kind: "not_portfolio" }),
    confirmed("https://takedown.example", { kind: "owner_request" }),
    { url: "https://no-evidence.example", kind: "down" },
  ]).map((e) => e.url);
  assert.deepEqual(picked, ["https://ok.example"]);
});

test("removeFromReadme drops the matching lines (normalized URL) and updates the count", () => {
  const r = removeFromReadme(README, ["https://ada-dead.vercel.app/", "https://bea.dev", "https://gone.example"]);
  assert.deepEqual(r.removed.map((x) => x.name), ["Ada Dead", "Bea Dead"]);
  assert.deepEqual(r.missing, ["https://gone.example"]);
  assert.match(r.readme, /## Current Portfolio Count: 2/);
  assert.ok(!r.readme.includes("Ada Dead"));
  assert.ok(r.readme.includes("- [Alan Fine](https://alan.dev)"));
  // Nothing else changes.
  assert.equal(r.readme.split("\n").length, README.split("\n").length - 2);
});

test("planUpstream re-checks each candidate, leaves sites that load in place, and caps the batch", async () => {
  const excluded = [
    confirmed("https://ada-dead.vercel.app", { name: "Ada Dead", removed: "2026-11-01" }),
    confirmed("https://bob.dev", { name: "Bob Back", removed: "2026-11-02" }),
    confirmed("https://www.bea.dev/", { name: "Bea Dead", removed: "2026-11-03", reason: "DNS resolution failed" }),
    confirmed("https://already-gone.example", { removed: "2026-11-04" }),
  ];
  const checked = [];
  const check = async (e) => {
    checked.push(e.url);
    return e.url === "https://bob.dev" ? { ok: true } : { ok: false, reason: e.url.includes("bea") ? "DNS resolution failed" : "HTTP 404" };
  };
  const plan = await planUpstream({ excluded, readme: README, check, now: new Date("2026-12-02T17:00:00Z") });
  assert.deepEqual(plan.removals.map((r) => r.name), ["Ada Dead", "Bea Dead"]);
  assert.deepEqual(plan.leftInPlace.map((l) => l.url), ["https://bob.dev"]);
  assert.deepEqual(plan.alreadyGone, ["https://already-gone.example"]);
  assert.equal(plan.title, "Remove 2 broken portfolio links");
  assert.match(plan.body, /^## Summary\n/);
  assert.match(plan.body, /\| Ada Dead \| ada-dead\.vercel\.app \| HTTP 404 \| 2026-11-01 \| 2026-12-02 \|/);
  assert.match(plan.body, /Left in place \(loaded again on the re-check\):\n- `bob\.dev`/);
  assert.match(plan.body, /Already removed from README\.md by earlier PRs: `already-gone\.example`/);
  assert.match(plan.body, /## Test plan/);
  assert.ok(!plan.body.includes("—"), "no em dashes");
  assert.match(plan.readme, /## Current Portfolio Count: 2/);

  const capped = await planUpstream({ excluded, readme: README, check, cap: 1 });
  assert.equal(capped.removals.length, 1);
  assert.equal(capped.title, prTitle(1));
  assert.equal(capped.title, "Remove 1 broken portfolio link");
});

test("a bot wall on the re-check keeps the entry", async () => {
  const plan = await planUpstream({
    excluded: [confirmed("https://alan.dev")],
    readme: README,
    check: async () => ({ ok: null, reason: "blocked by a bot check (HTTP 403)" }),
  });
  assert.equal(plan.removals.length, 0);
  assert.equal(plan.leftInPlace.length, 1);
});

test("--apply edits a README in place from plan.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-"));
  const readme = path.join(dir, "README.md");
  const planFile = path.join(dir, "plan.json");
  fs.writeFileSync(readme, README);
  fs.writeFileSync(planFile, JSON.stringify({ removals: 1, urls: ["https://alan.dev"] }));
  execFileSync(process.execPath, ["pipeline/upstream-removals.mjs", "--apply", planFile, "--readme", readme]);
  const out = fs.readFileSync(readme, "utf8");
  assert.ok(!out.includes("Alan Fine"));
  assert.match(out, /Count: 3/);
});
