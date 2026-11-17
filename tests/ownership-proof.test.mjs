// The owner's rule for site ownership: "only someone who can deploy to a
// site can take it down, hide its grade or otherwise change what others see
// about it". A claim proven only by a link from the page to a GitHub profile
// (github_link) is not that proof: collaborators and designers are linked
// too. These are the paths a security audit (2026-11-16) found still open:
//   a. a link-only claim could cancel the real owner's held removal
//   b. the print view showed a hidden grade to a link-only claim
//   c. /api/owner/verify skipped the account-age and MAX_VERIFIED limits and
//      opened unlimited claims; /api/recheck skipped the account age
//   d. a removal whose alert step failed was never purged from the edge cache
// Offline: a throwaway SQLite file per test, no server, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import {
  ACTIONS,
  CLAIMS_PER_HOUR,
  MAX_VERIFIED,
  PURGE_LOOKBACK_MS,
  REMOVAL_HOLD_MS,
  applyDueRemovals,
  claimHold,
  controlProof,
  isRemovalAlert,
  openClaim,
  ownerAction,
  ownerState,
  purgeRemovedProfiles,
  removalConditions,
  setClaimStatus,
  undoRemoval,
  unpurgedRemovals,
} from "../lib/games/claims.mjs";

const T0 = new Date("2026-11-16T00:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);
const HOUR = 3600e3;
const URL = "https://victim.example";

const tmpFile = (prefix) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "db.sqlite");

async function freshDb() {
  const db = createClient({ url: `file:${tmpFile("ownership-proof-")}` });
  await migrate(db);
  return db;
}

/** A verified claim on `url` for `owner`, proven by `method` (an "admin:" actor makes it a reviewed claim). */
async function verified(db, { url = URL, owner, login, method, actor = owner, now = T0 }) {
  const claim = await openClaim(db, { url, owner, login, token: `tok_${login}_aaaaaaaa`, now });
  return setClaimStatus(db, { claim, status: "verified", method, actor, now });
}

const logOf = async (db, url = URL) =>
  (await db.execute({ sql: "SELECT actor, action, detail FROM claim_log WHERE url = ? ORDER BY id", args: [url] })).rows.map((r) => ({
    actor: String(r.actor),
    action: String(r.action),
    detail: r.detail == null ? null : JSON.parse(String(r.detail)),
  }));

// ---------------------------------------------------------------------------
// a. Cancelling a held removal
// ---------------------------------------------------------------------------

test("a: a collaborator verified only by a link can't cancel the owner's removal, which applies on time", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await verified(db, { owner: "gh:2", login: "collab", method: "github_link" });
  assert.equal(await controlProof(db, { url: URL, owner: "gh:2" }), false);

  const asked = await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  const removeAfter = at(REMOVAL_HOLD_MS).toISOString();
  assert.equal(asked.state.removeAfter, removeAfter);

  assert.deepEqual(await ownerAction(db, { url: URL, owner: "gh:2", action: "cancel_remove", now: at(HOUR) }), { ok: false, error: "cancel_needs_meta" });
  assert.equal((await ownerState(db, URL)).removeAfter, removeAfter, "still held");
  assert.ok(!(await logOf(db)).some((l) => l.action === "remove_cancelled"), "no cancel logged");

  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS - 1000) }), [], "not early");
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS) }), [URL], "applied on time");
  assert.equal((await ownerState(db, URL)).removedAt, removeAfter);
});

test("a: the owner who asked, another account with control proof, and the admin can still cancel; each cancel is logged and alerted", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await verified(db, { owner: "gh:3", login: "cofounder", method: "meta" });
  // A claim the site owner reviewed by hand counts as control proof too.
  await verified(db, { owner: "gh:4", login: "reviewed", method: "manual", actor: "admin:n8" });

  // The account that asked.
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  const own = await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(HOUR) });
  assert.deepEqual([own.ok, own.state.removeAfter], [true, null]);

  // A different account that can also deploy to the site (any control-proof holder may cancel).
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(2 * HOUR) });
  const other = await ownerAction(db, { url: URL, owner: "gh:3", action: "cancel_remove", now: at(3 * HOUR) });
  assert.deepEqual([other.ok, other.state.removeAfter], [true, null]);
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(4 * HOUR) });
  assert.equal((await ownerAction(db, { url: URL, owner: "gh:4", action: "cancel_remove", now: at(5 * HOUR) })).ok, true, "a reviewed claim");
  assert.deepEqual(await applyDueRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) }), [], "no cancelled removal ever applies");

  const cancels = (await logOf(db)).filter((l) => l.action === "remove_cancelled");
  assert.deepEqual(
    cancels.map((l) => [l.actor, l.detail.requestedBy]),
    [["gh:1", "gh:1"], ["gh:3", "gh:1"], ["gh:4", "gh:1"]],
    "the log names who cancelled and who asked"
  );
  assert.equal(cancels[1].detail.removeAfter, at(2 * HOUR + REMOVAL_HOLD_MS).toISOString());

  // The owner of PortfolioRank hears about every cancel, like a request, for the same window.
  const alerts = (await removalConditions(db, { now: at(5 * HOUR) })).filter((c) => c.title.startsWith("Removal cancelled"));
  assert.equal(alerts.length, 3);
  assert.ok(alerts.every((c) => isRemovalAlert(c.key)), "in the removals tick's scope");
  assert.equal(new Set(alerts.map((c) => c.key)).size, 3, "one alert per cancel");
  assert.match(alerts[1].detail, /@cofounder cancelled the removal of https:\/\/victim\.example/);
  assert.match(alerts[1].detail, /@realowner, a different account/);
  assert.match(alerts[0].detail, /the same account/);
  assert.deepEqual(
    (await removalConditions(db, { now: at(5 * HOUR + REMOVAL_HOLD_MS + 1000) })).filter((c) => c.title.startsWith("Removal cancelled")).map((c) => c.detail).length,
    0,
    "cleared once the window is over"
  );

  // The admin takes a held removal back (/api/admin/removals undo).
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(6 * HOUR) });
  assert.equal((await undoRemoval(db, { url: URL, actor: "admin:n8", now: at(7 * HOUR) })).ok, true);
  assert.deepEqual(await applyDueRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) }), []);
});

test("a: a cancel that loses the race to the hourly apply changes nothing and logs nothing", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS) }), [URL]);
  const late = await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(REMOVAL_HOLD_MS + 1000) });
  assert.ok(late.state.removedAt, "too late: removed");
  assert.ok(!(await logOf(db)).some((l) => l.action === "remove_cancelled"));
});

// ---------------------------------------------------------------------------
// b. Every action and read that changes or reveals what others see
// ---------------------------------------------------------------------------

test("b: a link-only claim may only ask for a re-grade; every action that changes what others see needs control proof", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await verified(db, { owner: "gh:2", login: "collab", method: "github_link" });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "hide_grade", now: T0 });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  const refused = { remove: "remove_needs_meta", cancel_remove: "cancel_needs_meta", hide_grade: "hide_needs_meta", show_grade: "hide_needs_meta" };
  for (const action of ACTIONS) {
    const out = await ownerAction(db, { url: URL, owner: "gh:2", action, now: at(HOUR) });
    if (action === "regrade") assert.equal(out.ok, true, "a re-grade request re-measures the live site; it changes no owner decision");
    else assert.deepEqual(out, { ok: false, error: refused[action] }, action);
  }
  const state = await ownerState(db, URL);
  assert.equal(state.hideGrade, true, "the grade stays hidden");
  assert.equal(state.removeAfter, at(REMOVAL_HOLD_MS).toISOString(), "the removal stays held");
  assert.deepEqual(Object.keys(refused).concat("regrade").sort(), [...ACTIONS].sort(), "every action is covered");
});

test("b: the print view shows a hidden grade only to control proof, not to any verified claim", () => {
  const src = fs.readFileSync("app/report/print/route.ts", "utf8");
  const gate = src.slice(src.indexOf("state.hideGrade &&"), src.indexOf("Grade hidden"));
  assert.match(gate, /controlProof\(db\(\), \{ url, owner: session\.raterId \}\)/);
  assert.doesNotMatch(src, /isVerifiedOwner/);
});

test("b: the actions route answers 403 for every proof refusal ownerAction gives", () => {
  const src = fs.readFileSync("app/api/owner/actions/route.ts", "utf8");
  for (const error of ["not_owner", "remove_needs_meta", "cancel_needs_meta", "hide_needs_meta"]) assert.match(src, new RegExp(`FORBIDDEN = new Set\\([^)]*"${error}"`), error);
});

// ---------------------------------------------------------------------------
// c. The same limits on every route that opens or verifies a claim
// ---------------------------------------------------------------------------

test("c: claimHold sends a too-new account and one past MAX_VERIFIED to review; upgrading a claim doesn't count against itself", async () => {
  const db = await freshDb();
  const claim = await openClaim(db, { url: URL, owner: "gh:9", login: "n", token: "tok_n_aaaaaaaa", now: T0 });
  assert.match(await claimHold(db, { claim, proof: "file", tooNew: true, minAccountAgeDays: 30 }), /younger than 30 days/);
  assert.equal(await claimHold(db, { claim, proof: "file", tooNew: false }), null);
  for (let i = 0; i < MAX_VERIFIED; i++) await verified(db, { url: `https://other${i}.example`, owner: "gh:9", login: "n", method: "file" });
  assert.match(await claimHold(db, { claim, proof: "file", tooNew: false }), new RegExp(`over the automatic limit of ${MAX_VERIFIED}`));
  // A claim already verified by its link, upgraded to the file, is one of the MAX_VERIFIED, not one more.
  const db2 = await freshDb();
  for (let i = 0; i < MAX_VERIFIED - 1; i++) await verified(db2, { url: `https://other${i}.example`, owner: "gh:9", login: "n", method: "file" });
  const link = await verified(db2, { owner: "gh:9", login: "n", method: "github_link" });
  assert.equal(await claimHold(db2, { claim: link, proof: "file", tooNew: false }), null);
});

/** The handler body of `export async function <name>` in a route file. */
const handler = (file, name) => {
  const src = fs.readFileSync(file, "utf8");
  return src.slice(src.indexOf(`export async function ${name}(`));
};

test("c: /api/owner/verify rate-limits before it writes a claim, and verifies only through claimHold", () => {
  const post = handler("app/api/owner/verify/route.ts", "POST");
  const limit = post.indexOf("await overLimit(");
  assert.ok(limit > 0, "rate-limited");
  assert.ok(limit < post.indexOf("openClaim("), "before the claim (and its claim_log row) is written");
  assert.ok(limit < post.indexOf('method === "start"'), "start too");
  assert.match(post, /key: `claim:\$\{owner\}`, limit: CLAIMS_PER_HOUR/, "opening a claim shares /api/owner/claims' limit");
  assert.match(post, /accountTooNew\(/);
  assert.match(post, /claimHold\(/);
  // Every write of a new status goes through the hold.
  const writes = [...post.matchAll(/setClaimStatus\(/g)].length;
  assert.equal(writes, 1, "one place verifies");
  assert.match(post, /status: hold \? "review" : "verified"/);
  assert.equal(CLAIMS_PER_HOUR, 10);
});

test("c: /api/owner/claims holds every proof it verifies, the meta upgrade included", () => {
  const post = handler("app/api/owner/claims/route.ts", "POST");
  assert.equal([...post.matchAll(/claimHold\(/g)].length, 2, "first proof and the meta upgrade");
  assert.doesNotMatch(post, /status: "verified", method: "meta"/, "no unconditional upgrade");
  assert.ok(post.indexOf("await overLimit(") < post.indexOf("openClaim("));
});

test("c: /api/recheck refuses a GitHub account younger than MIN_GITHUB_ACCOUNT_AGE_DAYS", () => {
  const src = fs.readFileSync("app/api/recheck/route.ts", "utf8");
  assert.match(src, /accountTooNew\(\{ type: "human", id: owner, accountCreatedAt: session\?\.accountCreatedAt \}\)/);
  const post = handler("app/api/recheck/route.ts", "POST");
  assert.ok(post.indexOf('fail("account_too_new"') > 0);
  assert.ok(post.indexOf('fail("account_too_new"') < post.indexOf("INSERT INTO cache"), "before the hourly lease is taken");
});

// ---------------------------------------------------------------------------
// d. Every removal that took effect leaves the edge cache, retried until it does
// ---------------------------------------------------------------------------

test("d: a removed profile is purged once; a failed purge is tried again next hour", async () => {
  const db = await freshDb();
  for (const [url, owner] of [["https://a.example", "gh:1"], ["https://b.example", "gh:2"]]) {
    await verified(db, { url, owner, login: `x${owner.slice(3)}`, method: "file" });
    await ownerAction(db, { url, owner, action: "remove", now: T0 });
  }
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS) }), ["https://a.example", "https://b.example"]);

  const calls = [];
  const failing = async (urls) => (calls.push(urls), false);
  assert.deepEqual(await purgeRemovedProfiles(db, { purge: failing, now: at(REMOVAL_HOLD_MS) }), { purged: [], failed: ["https://a.example", "https://b.example"] });
  const throwing = async () => {
    throw new Error("cache down");
  };
  assert.deepEqual((await purgeRemovedProfiles(db, { purge: throwing, now: at(REMOVAL_HOLD_MS + HOUR) })).failed.length, 2);
  // The next hour: nothing new is due, and both are still purged.
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS + 2 * HOUR) }), []);
  const ok = async (urls) => (calls.push(urls), true);
  assert.deepEqual((await purgeRemovedProfiles(db, { purge: ok, now: at(REMOVAL_HOLD_MS + 2 * HOUR) })).purged, ["https://a.example", "https://b.example"]);
  assert.deepEqual(await unpurgedRemovals(db, { now: at(REMOVAL_HOLD_MS + 3 * HOUR) }), [], "once");
  assert.deepEqual(calls.length, 2);

  // Listed again by the admin and removed again later: purged again.
  await undoRemoval(db, { url: "https://a.example", actor: "admin:n8", now: at(2 * REMOVAL_HOLD_MS) });
  await ownerAction(db, { url: "https://a.example", owner: "gh:1", action: "remove", now: at(2 * REMOVAL_HOLD_MS) });
  await applyDueRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) });
  assert.deepEqual(await unpurgedRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) }), ["https://a.example"]);
  // Older than the lookback, the edge cache has long dropped it.
  assert.deepEqual(await unpurgedRemovals(db, { now: at(3 * REMOVAL_HOLD_MS + PURGE_LOOKBACK_MS + 1) }), []);
});

test("d: the hourly edge purge reads removals from the database, not from the removals task's result", () => {
  const src = fs.readFileSync("worker/index.ts", "utf8");
  const hourly = src.slice(src.indexOf("cron === PEOPLE_QUEUE_CRON"), src.indexOf("cron === MODEL_WATCH_CRON"));
  assert.match(hourly, /\["edge purge", \(\) => purgeAfterHour\(ctx, at\)\]/);
  assert.doesNotMatch(hourly, /removed =/);
  const purge = src.slice(src.indexOf("async function purgeAfterHour("), src.indexOf("const ASSETS"));
  assert.match(purge, /purgeRemovedProfiles\(database\(\)/);
});

// Lets this file import worker/*.ts, whose relative imports leave out ".ts" (the Worker's bundler adds it).
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND" || !/^\\.\\.?\\//.test(specifier) || !context.parentURL?.endsWith(".ts")) throw e;
    return next(specifier + ".ts", context);
  }
}`)
);

test("d: removalsTick returns every removal it applied even when the alert step throws, and the purge still happens", async (t) => {
  if (process.env.TURSO_DATABASE_URL) return t.skip("a real database is configured");
  const file = tmpFile("ownership-tick-");
  process.env.LOCAL_DB_FILE = file;
  const setup = createClient({ url: `file:${file}` });
  await migrate(setup);
  for (const [url, owner, when] of [["https://a.example", "gh:1", T0], ["https://b.example", "gh:2", at(20 * HOUR)]]) {
    await verified(setup, { url, owner, login: `x${owner.slice(3)}`, method: "file" });
    await ownerAction(setup, { url, owner, action: "remove", now: when });
  }
  // Break the alerts table the way any failure inside reconcileAlerts would (a Turso hiccup, say).
  await setup.execute("DROP TABLE IF EXISTS owner_alerts");
  await setup.execute("CREATE TABLE owner_alerts (key TEXT PRIMARY KEY)");

  const { removalsTick } = await import("../worker/owner-removals.ts");
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));
  const out = await removalsTick({}, at(REMOVAL_HOLD_MS + HOUR).getTime());
  t.mock.restoreAll();
  assert.deepEqual(out.applied, ["https://a.example"], "the applied removal is reported");
  assert.deepEqual(out.failed, ["alerts"]);
  assert.ok(logged.some((l) => /removals\.tick\.failed/.test(l) && /alerts/.test(l)));

  // The hourly edge purge, as worker/index.ts runs it, finds it whatever the tick returned.
  const purged = [];
  const res = await purgeRemovedProfiles(setup, { purge: async (urls) => (purged.push(...urls), true), now: at(REMOVAL_HOLD_MS + HOUR) });
  assert.deepEqual(res.purged, ["https://a.example"]);
  assert.deepEqual(purged, ["https://a.example"]);
  setup.close();
});
