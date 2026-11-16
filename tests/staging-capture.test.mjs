// The staging capture workflow (.github/workflows/staging-capture.yml,
// scripts/staging-capture.mjs): it must be unable to touch production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardRefusal, parseCaptureLog, summary } from "../scripts/staging-capture.mjs";

const STAGING = "libsql://portfolio-rank-staging-x.turso.io";
const ok = { STAGING_TURSO_DATABASE_URL: STAGING, TURSO_DATABASE_URL: STAGING, TURSO_AUTH_TOKEN: "t" };

test("the guard lets a staging database through and refuses everything else", () => {
  assert.equal(guardRefusal(ok), null);
  assert.match(guardRefusal({}), /not set/);
  const prod = "libsql://portfolio-rank-x.turso.io";
  assert.match(guardRefusal({ ...ok, STAGING_TURSO_DATABASE_URL: prod, TURSO_DATABASE_URL: prod }), /does not name a staging database/);
  assert.match(guardRefusal({ ...ok, TURSO_DATABASE_URL: prod }), /not staging's/);
  assert.match(guardRefusal({ STAGING_TURSO_DATABASE_URL: STAGING }), /not staging's/);
  assert.match(guardRefusal({ ...ok, R2_ACCESS_KEY_ID: "x" }), /R2_ACCESS_KEY_ID is set/);
  assert.match(guardRefusal({ ...ok, GEMINI_API_KEY: "x" }), /GEMINI_API_KEY/);
  assert.equal(guardRefusal({ ...ok, R2_BUCKET: "" }), null, "an empty variable is not a credential");
});

test("the summary counts captures, failures with reasons and seconds per site", () => {
  const log = [
    "roster: 0 delisted, 0 relisted",
    "capturing 3 site(s), concurrency 2, R2 off (local only)",
    "[1/3] https://a.dev \u2014 live \u2192 abc (motion=false dark=true overflow=false) (10.5s)",
    "[2/3] https://b.dev \u2014 dead (HTTP 404) (2.0s)",
    "[3/3] https://c.dev \u2014 error (timeout | slow) (30.0s)",
    "done: 1 captured, 2 gated out",
  ].join("\n");
  const sites = parseCaptureLog(log);
  assert.equal(sites.length, 3);
  assert.deepEqual(sites.map((s) => s.captured), [true, false, false]);
  const md = summary(sites, { requested: "3" });
  assert.match(md, /Sites captured: 1 of 3 tried/);
  assert.match(md, /Failures: 2/);
  assert.match(md, /14\.2 on average \(30\.0 slowest\)/);
  assert.match(md, /\| https:\/\/b\.dev \| dead \(HTTP 404\) \| 2\.0 \|/);
  assert.match(md, /timeout \\\| slow/, "a pipe in a reason does not break the table");
  assert.match(summary([], { requested: "5" }), /No site was captured/);
});

test("the workflow is dispatch-only, runs the ref's own code and holds only staging's secrets", () => {
  const yml = readFileSync(".github/workflows/staging-capture.yml", "utf8");
  assert.match(yml, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(yml, /^\s*(schedule|push|pull_request\w*):/m);
  assert.doesNotMatch(yml, /release-code/);
  const secrets = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ["STAGING_TURSO_AUTH_TOKEN", "STAGING_TURSO_DATABASE_URL"]);
  assert.ok(yml.indexOf("staging-capture.mjs guard") < yml.indexOf("npm ci"), "the guard runs before anything is installed or run");
});
