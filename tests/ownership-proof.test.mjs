// The owner's rule for site ownership: "only someone who can deploy to a
// site can take it down, hide its grade or otherwise change what others see
// about it". A claim proven only by a link from the page to a GitHub profile
// (github_link) is not that proof: collaborators and designers are linked
// too. The paths a security audit (2026-11-16) found open, and the alerts and
// edge purge around a removal:
//   a. a link-only claim could cancel the real owner's held removal
//   b. every action that changes what others see needs control proof
//   d. a removal that took effect leaves the edge cache and the quiz pool
//      whatever else the hourly tick does
// Offline: a throwaway SQLite file per test, no server, no network. The
// routes' wiring is in tests/ownership-e2e.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { reconcileAlerts } from "../pipeline/alerts.mjs";
import { runEach } from "../pipeline/hourly.mjs";
import {
  ACTIONS,
  PROOF_ERRORS,
  PURGE_LOOKBACK_MS,
  REMOVAL_HOLD_MS,
  applyDueRemovals,
  controlProof,
  isRemovalAlert,
  openClaim,
  ownerAction,
  ownerState,
  proofLevel,
  purgeRemovedProfiles,
  removalConditions,
  setClaimStatus,
  undoRemoval,
  unpurgedRemovals,
} from "../lib/games/claims.mjs";
import { afterProof, scheduledAction } from "../components/claim/flow-rules.ts";

// 10:00 in Los Angeles, so a few hours later is still the same quota day (pipeline/quota-day.mjs).
const T0 = new Date("2026-11-16T18:00:00Z");
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

test("a: the owner who asked, another account with control proof, a reviewed claim and the admin can still cancel", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await verified(db, { owner: "gh:3", login: "cofounder", method: "meta" });
  await verified(db, { owner: "gh:4", login: "reviewed", method: "manual", actor: "admin:n8" });

  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  const own = await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(HOUR) });
  assert.deepEqual([own.ok, own.state.removeAfter], [true, null]);
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(2 * HOUR) });
  const other = await ownerAction(db, { url: URL, owner: "gh:3", action: "cancel_remove", now: at(3 * HOUR) });
  assert.deepEqual([other.ok, other.state.removeAfter], [true, null], "any control-proof holder may cancel");
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(4 * HOUR) });
  assert.equal((await ownerAction(db, { url: URL, owner: "gh:4", action: "cancel_remove", now: at(5 * HOUR) })).ok, true, "a reviewed claim");
  assert.deepEqual(await applyDueRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) }), [], "no cancelled removal ever applies");

  // The admin takes a held removal back (/api/admin/removals undo).
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(6 * HOUR) });
  assert.equal((await undoRemoval(db, { url: URL, actor: "admin:n8", now: at(7 * HOUR) })).ok, true);
  assert.deepEqual(await applyDueRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) }), []);
});

test("a: the cancel log row says who cancelled and whether they asked, with no account id in its detail", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await verified(db, { owner: "gh:3", login: "cofounder", method: "meta" });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(HOUR) });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(2 * HOUR) });
  await ownerAction(db, { url: URL, owner: "gh:3", action: "cancel_remove", now: at(3 * HOUR) });
  const cancels = (await logOf(db)).filter((l) => l.action === "remove_cancelled");
  assert.deepEqual(
    cancels.map((l) => [l.actor, l.detail]),
    [
      ["gh:1", { removeAfter: at(REMOVAL_HOLD_MS).toISOString(), byRequester: true }],
      ["gh:3", { removeAfter: at(2 * HOUR + REMOVAL_HOLD_MS).toISOString(), byRequester: false }],
    ]
  );
  const raw = (await db.execute("SELECT detail FROM claim_log WHERE action = 'remove_cancelled'")).rows.map((r) => String(r.detail)).join(" ");
  assert.doesNotMatch(raw, /gh:/, "account deletion only rewrites claim_log.actor, so no id goes in the detail");
});

/** `db` with `before` run once, just before the first batch: what lands between a read and a write. */
function interleaved(db, before) {
  let fired = false;
  return {
    execute: (...a) => db.execute(...a),
    batch: async (...a) => {
      if (!fired) {
        fired = true;
        await before();
      }
      return db.batch(...a);
    },
  };
}

test("a: a cancel that loses the race to the hourly apply changes nothing and logs nothing", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  // The cancel reads the held removal, then the hourly apply lands, then the cancel's statements run.
  const raced = interleaved(db, async () => assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS) }), [URL]));
  const late = await ownerAction(raced, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(REMOVAL_HOLD_MS) });
  assert.equal(late.ok, true);
  assert.equal(late.state.removedAt, at(REMOVAL_HOLD_MS).toISOString(), "the removal stays applied");
  assert.ok(!(await logOf(db)).some((l) => l.action === "remove_cancelled"), "no cancel logged");
});

test("d: a removal that a cancel withdrew underneath the apply leaves the quiz pool alone", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES ('games:pool', '[]', ?)", args: [T0.getTime()] });
  // The apply reads the due removal, then a cancel lands, then the apply's statements run.
  const raced = interleaved(db, async () => assert.equal((await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(REMOVAL_HOLD_MS) })).ok, true));
  assert.deepEqual(await applyDueRemovals(raced, { now: at(REMOVAL_HOLD_MS) }), []);
  assert.equal((await ownerState(db, URL)).removedAt, null);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM cache WHERE k = 'games:pool'")).rows[0].n), 1, "the pool stays");
});

// ---------------------------------------------------------------------------
// Alerts: every held removal is emailed when it is asked for; a cancel isn't
// ---------------------------------------------------------------------------

/** One hourly alert pass (worker/owner-removals.ts), with an email sender that records what it sends. */
async function alertTick(db, now, sent) {
  return reconcileAlerts(db, {
    conditions: await removalConditions(db, { now }),
    scope: isRemovalAlert,
    now,
    email: { send: async (m) => void sent.push(m) },
    to: "owner@example.test",
  });
}

test("alerts: a removal asked for again the same day after a cancel is emailed that day; a cancel sends nothing", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  const sent = [];

  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  await alertTick(db, at(0.1 * HOUR), sent);
  assert.deepEqual(sent.map((m) => m.subject), ["[PortfolioRank] Removal requested for victim.example"]);
  assert.doesNotMatch(sent[0].text, /asked for again/);

  await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(HOUR) });
  const cleared = await alertTick(db, at(1.1 * HOUR), sent);
  assert.equal(sent.length, 1, "a cancel by itself sends no email");
  assert.deepEqual(cleared.cleared, [`removal:${URL}`], "the held removal's alert clears");

  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(2 * HOUR) });
  await alertTick(db, at(2.1 * HOUR), sent);
  assert.equal(sent.length, 2, "the second request is emailed the same day");
  assert.match(sent[1].text, /This removal was cancelled and asked for again 1 time\(s\) in the last day\./);
  assert.doesNotMatch(sent[1].text, /stays listed/);

  // Flipping on: still one alert per held removal, and no more email today.
  for (let i = 3; i < 10; i++) {
    await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(i * HOUR) });
    await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(i * HOUR + 600e3) });
    await alertTick(db, at(i * HOUR + 1200e3), sent);
  }
  assert.equal(sent.length, 2, "at most two emails a day for a site, however often it flips");
  const now = await removalConditions(db, { now: at(10 * HOUR) });
  assert.equal(now.length, 1);
  assert.match(now[0].detail, /asked for again 8 time\(s\)/);
});

test("alerts: a cancel with nothing held is no alert, and the cancel counts come from the held sites' log only", async () => {
  const db = await freshDb();
  for (const url of ["https://a.example", "https://b.example"]) {
    await verified(db, { url, owner: "gh:1", login: "realowner", method: "file" });
    await ownerAction(db, { url, owner: "gh:1", action: "remove", now: T0 });
    await ownerAction(db, { url, owner: "gh:1", action: "cancel_remove", now: at(HOUR) });
  }
  assert.deepEqual(await removalConditions(db, { now: at(2 * HOUR) }), [], "the site stays listed; nothing for the admin to do");
  await ownerAction(db, { url: "https://a.example", owner: "gh:1", action: "remove", now: at(2 * HOUR) });
  const alerts = await removalConditions(db, { now: at(3 * HOUR) });
  assert.deepEqual(alerts.map((c) => c.key), ["removal:https://a.example#again"]);
  assert.ok(isRemovalAlert(alerts[0].key));
  assert.match(alerts[0].detail, /^@realowner asked to remove https:\/\/a\.example from PortfolioRank\. It takes effect at /);
  // A cancel logged a moment after the cron's nominal time still counts on that tick.
  await ownerAction(db, { url: "https://b.example", owner: "gh:1", action: "remove", now: at(2 * HOUR) });
  await ownerAction(db, { url: "https://b.example", owner: "gh:1", action: "cancel_remove", now: at(3 * HOUR + 1000) });
  await ownerAction(db, { url: "https://b.example", owner: "gh:1", action: "remove", now: at(3 * HOUR + 2000) });
  assert.match((await removalConditions(db, { now: at(3 * HOUR) })).find((c) => c.key.includes("b.example")).detail, /asked for again 2 time\(s\)/);
  // Once the cancel is more than a day old, the held removal's alert is the plain one again.
  assert.deepEqual((await removalConditions(db, { now: at(HOUR + REMOVAL_HOLD_MS + 1) })).map((c) => c.key), ["removal:https://a.example", "removal:https://b.example#again"]);
});

// ---------------------------------------------------------------------------
// b. Every action that changes what others see
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
    else {
      assert.deepEqual(out, { ok: false, error: refused[action] }, action);
      assert.ok(PROOF_ERRORS.includes(out.error), `${out.error} answers 403`);
    }
  }
  const state = await ownerState(db, URL);
  assert.equal(state.hideGrade, true, "the grade stays hidden");
  assert.equal(state.removeAfter, at(REMOVAL_HOLD_MS).toISOString(), "the removal stays held");
  assert.deepEqual(Object.keys(refused).concat("regrade").sort(), [...ACTIONS].sort(), "every action is covered");
  assert.deepEqual(await ownerAction(db, { url: URL, owner: "gh:9", action: "regrade", now: T0 }), { ok: false, error: "not_owner" });
});

test("b: proofLevel reads a claim as none, link or control", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "a", method: "file" });
  await verified(db, { owner: "gh:2", login: "b", method: "github_link" });
  await verified(db, { owner: "gh:3", login: "c", method: "manual", actor: "admin:n8" });
  await verified(db, { owner: "gh:4", login: "d", method: "github_blog" });
  const pending = await openClaim(db, { url: URL, owner: "gh:5", login: "e", token: "tok_e_aaaaaaaa", now: T0 });
  assert.equal(pending.status, "pending");
  const levels = {};
  for (const owner of ["gh:1", "gh:2", "gh:3", "gh:4", "gh:5", "gh:6"]) levels[owner] = await proofLevel(db, { url: URL, owner });
  assert.deepEqual(levels, { "gh:1": "control", "gh:2": "link", "gh:3": "control", "gh:4": "none", "gh:5": "none", "gh:6": "none" });
});

test("b: the claim page offers cancelling a held removal only to an account that can, and proving control leads back to it", () => {
  assert.equal(scheduledAction({ removable: true }), "cancel");
  assert.equal(scheduledAction({ removable: false }), "prove", "a link-only account proves control first");
  assert.equal(afterProof({ removedAt: null, removeAfter: "2026-11-17T18:00:00.000Z" }), "scheduled");
  assert.equal(afterProof({ removedAt: null, removeAfter: null }), "confirm-remove");
  assert.equal(afterProof({ removedAt: "2026-11-17T18:00:00.000Z", removeAfter: null }), "removed");
});

// ---------------------------------------------------------------------------
// d. Every removal that took effect leaves the edge cache and the quiz pool
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
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS + 2 * HOUR) }), [], "nothing new is due");
  const ok = async (urls) => (calls.push(urls), true);
  assert.deepEqual((await purgeRemovedProfiles(db, { purge: ok, now: at(REMOVAL_HOLD_MS + 2 * HOUR) })).purged, ["https://a.example", "https://b.example"]);
  assert.deepEqual(await unpurgedRemovals(db, { now: at(REMOVAL_HOLD_MS + 3 * HOUR) }), [], "once");
  assert.equal(calls.length, 2);
  const row = (await db.execute({ sql: "SELECT purged_at FROM portfolio_owner WHERE url = ?", args: ["https://a.example"] })).rows[0];
  assert.equal(String(row.purged_at), at(REMOVAL_HOLD_MS + 2 * HOUR).toISOString());

  // Listed again by the admin and removed again later: purged again.
  await undoRemoval(db, { url: "https://a.example", actor: "admin:n8", now: at(2 * REMOVAL_HOLD_MS) });
  await ownerAction(db, { url: "https://a.example", owner: "gh:1", action: "remove", now: at(2 * REMOVAL_HOLD_MS) });
  await applyDueRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) });
  assert.deepEqual(await unpurgedRemovals(db, { now: at(3 * REMOVAL_HOLD_MS) }), ["https://a.example"]);
  // Older than the lookback, the edge cache has long dropped it.
  assert.deepEqual(await unpurgedRemovals(db, { now: at(3 * REMOVAL_HOLD_MS + PURGE_LOOKBACK_MS + 1) }), []);
});

test("d: a removal drops the cached quiz pool in the same transaction that applies it", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: T0 });
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES ('games:pool', '[]', ?)", args: [T0.getTime()] });
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS) }), [URL]);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM cache WHERE k = 'games:pool'")).rows[0].n), 0);
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

test("d: the hourly removal tasks migrate first, apply on their own, and a failing alert step is reported; the purge and pool still follow", async (t) => {
  if (process.env.TURSO_DATABASE_URL) return t.skip("a real database is configured");
  const file = tmpFile("ownership-tick-");
  process.env.LOCAL_DB_FILE = file;
  const setup = createClient({ url: `file:${file}` });
  await migrate(setup);
  for (const [url, owner, when] of [["https://a.example", "gh:1", T0], ["https://b.example", "gh:2", at(20 * HOUR)]]) {
    await verified(setup, { url, owner, login: `x${owner.slice(3)}`, method: "file" });
    await ownerAction(setup, { url, owner, action: "remove", now: when });
  }
  await setup.execute({ sql: "INSERT INTO cache (k, v, at) VALUES ('games:pool', '[]', ?)", args: [T0.getTime()] });
  // A database whose deploy migration didn't run: no purged_at yet.
  await setup.execute("ALTER TABLE portfolio_owner DROP COLUMN purged_at");
  await setup.execute("DELETE FROM schema_meta WHERE k = 'fingerprint'");
  // Break the alerts table the way any failure inside reconcileAlerts would (a Turso hiccup, say).
  await setup.execute("DROP TABLE IF EXISTS owner_alerts");
  await setup.execute("CREATE TABLE owner_alerts (key TEXT PRIMARY KEY)");

  // The two tasks as worker/index.ts runs them.
  const { applyRemovalsTick, removalAlertsTick } = await import("../worker/owner-removals.ts");
  const when = at(REMOVAL_HOLD_MS + HOUR).getTime();
  let applied = null;
  const reported = [];
  t.mock.method(console, "log", () => {});
  const out = await runEach(
    [
      ["owner removals", async () => (applied = await applyRemovalsTick(when))],
      ["removal alerts", () => removalAlertsTick({}, when)],
    ],
    { report: (e, task) => reported.push(task) }
  );
  t.mock.restoreAll();
  assert.deepEqual(applied, ["https://a.example"], "the removal applied, after the schema caught up");
  assert.deepEqual(out.failed, ["removal alerts"]);
  assert.deepEqual(reported, ["removal alerts"], "the failure reaches the reporter (Sentry in the Worker)");
  assert.equal(Number((await setup.execute("SELECT COUNT(*) AS n FROM cache WHERE k = 'games:pool'")).rows[0].n), 0, "the pool was dropped");

  // The hourly edge purge, as worker/index.ts runs it, finds it whatever the tick returned.
  const purged = [];
  const res = await purgeRemovedProfiles(setup, { purge: async (urls) => (purged.push(...urls), true), now: at(REMOVAL_HOLD_MS + HOUR) });
  assert.deepEqual(res.purged, ["https://a.example"]);
  assert.deepEqual(purged, ["https://a.example"]);
  setup.close();
});
