// The monthly community-list report (pipeline/upstream-removals.mjs): which
// entries the list's own checker misses, the README edit, the report and the
// optional pull request body. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  missedByTheirChecker,
  planUpstream,
  prTitle,
  removeFromReadme,
  reportMarkdown,
  selectCandidates,
} from "../pipeline/upstream-removals.mjs";

const README = `# Developer Portfolios

## Current Portfolio Count: 5

---

## A

- [Ada Blank](https://ada-blank.vercel.app) [Engineer]
- [Alan Fine](https://alan.dev)

## B

- [Bea Blank](https://www.bea.dev/) [Designer | Dev]
- [Bob Back](https://bob.dev)
- [Bo Broken](https://bo-broken.dev)
`;

const confirmed = (url, over = {}) => ({
  url,
  name: url,
  reason: "renders blank",
  kind: "down",
  removed: "2026-11-15",
  first_failed: "2026-11-01T16:00:00Z",
  last_checked: "2026-11-15T16:00:00Z",
  checks: 3,
  ...over,
});

test("only what a link checker can't see is ours to report", () => {
  for (const reason of ["HTTP 404", "HTTP 402", "DNS resolution failed", "does not load (TLS error)", "redirects to hugedomains.com", 'parking phrase: "buy this domain"']) {
    assert.equal(missedByTheirChecker({ kind: "down", reason }), false, reason);
  }
  for (const reason of ["renders blank", "redirects to linkedin.com, not a portfolio"]) {
    assert.equal(missedByTheirChecker({ kind: "down", reason }), true, reason);
  }
  assert.equal(missedByTheirChecker({ kind: "not_portfolio", reason: "AI grading says this is not a portfolio" }), true);
  assert.equal(missedByTheirChecker({ kind: "duplicate", reason: "duplicate of x" }), false);
  assert.equal(missedByTheirChecker({ kind: "owner_request" }), false);
});

test("only confirmed exclusions with two weeks of evidence qualify, never suspect ones", () => {
  const picked = selectCandidates([
    "https://legacy-string.example",
    confirmed("https://ok.example"),
    confirmed("https://http404.example", { reason: "HTTP 404" }),
    confirmed("https://short.example", { first_failed: "2026-11-10T00:00:00Z" }),
    confirmed("https://few.example", { checks: 2 }),
    confirmed("https://dup.example", { kind: "duplicate" }),
    confirmed("https://np.example", { kind: "not_portfolio", reason: "AI grading says this is not a portfolio" }),
    confirmed("https://takedown.example", { kind: "owner_request" }),
    { url: "https://no-evidence.example", kind: "down", reason: "renders blank" },
  ]).map((e) => e.url);
  assert.deepEqual(picked, ["https://ok.example", "https://np.example"]);
});

test("removeFromReadme drops the matching lines (normalized URL) and updates the count", () => {
  const r = removeFromReadme(README, ["https://ada-blank.vercel.app/", "https://bea.dev", "https://gone.example"]);
  assert.deepEqual(r.removed.map((x) => x.name), ["Ada Blank", "Bea Blank"]);
  assert.deepEqual(r.missing, ["https://gone.example"]);
  assert.match(r.readme, /## Current Portfolio Count: 3/);
  assert.ok(!r.readme.includes("Ada Blank"));
  assert.ok(r.readme.includes("- [Alan Fine](https://alan.dev)"));
  // Nothing else changes.
  assert.equal(r.readme.split("\n").length, README.split("\n").length - 2);
});

test("planUpstream: re-checks candidates, sends AI grades and hijacks to review, counts what their checker catches", async () => {
  const excluded = [
    confirmed("https://ada-blank.vercel.app", { name: "Ada Blank", removed: "2026-11-01" }),
    confirmed("https://bob.dev", { name: "Bob Back", removed: "2026-11-02" }),
    confirmed("https://www.bea.dev/", { name: "Bea Blank", removed: "2026-11-03" }),
    confirmed("https://alan.dev", { name: "Alan Fine", kind: "not_portfolio", reason: "AI grading says this is not a portfolio" }),
    confirmed("https://bo-broken.dev", { name: "Bo Broken", reason: "HTTP 404" }),
    confirmed("https://already-gone.example", { removed: "2026-11-04" }),
  ];
  const checked = [];
  const check = async (e) => {
    checked.push(e.url);
    return e.url === "https://bob.dev" ? { ok: true } : { ok: false, reason: "renders blank" };
  };
  const plan = await planUpstream({
    excluded,
    readme: README,
    check,
    hijacks: [{ url: "https://bob.dev", to: "https://casino.example/" }, { url: "https://not-listed.example", to: "x" }],
    now: new Date("2026-12-02T17:00:00Z"),
  });
  assert.deepEqual(checked, ["https://ada-blank.vercel.app", "https://bob.dev", "https://www.bea.dev/"]);
  assert.deepEqual(plan.removals.map((r) => r.name), ["Ada Blank", "Bea Blank"]);
  assert.deepEqual(plan.leftInPlace.map((l) => l.url), ["https://bob.dev"]);
  assert.deepEqual(plan.review.map((r) => r.url), ["https://alan.dev"]);
  assert.deepEqual(plan.hijacks, [{ url: "https://bob.dev", to: "https://casino.example/" }]);
  assert.equal(plan.caughtByThem, 1);
  assert.deepEqual(plan.alreadyGone, ["https://already-gone.example"]);
  assert.equal(plan.title, "Remove 2 broken portfolio links");
  assert.match(plan.body, /^## Summary\n/);
  assert.match(plan.body, /Saturday link checker passes them/);
  assert.match(plan.body, /\| Ada Blank \| ada-blank\.vercel\.app \| renders blank \| 2026-11-01 \| 2026-12-02 \|/);
  assert.match(plan.body, /Left in place \(loaded again on the re-check\):\n- `bob\.dev`/);
  assert.match(plan.body, /## Test plan/);
  assert.ok(!plan.body.includes("—"), "no em dashes");

  const md = reportMarkdown(plan);
  assert.match(md, /runs a link checker every Saturday/);
  assert.match(md, /1 entry we removed for a broken link or parking are still listed upstream/);
  assert.match(md, /### Graded not a portfolio \(for a person to review\)\n\n\| Name \| URL \|/);
  assert.match(md, /\| bob\.dev \| https:\/\/casino\.example\/ \|/);

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
  assert.match(out, /Count: 4/);
});
