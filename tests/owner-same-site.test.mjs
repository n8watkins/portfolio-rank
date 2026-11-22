// The owner's rule for removals and hidden grades (lib/ownership/same-site.mjs):
// "when an owner removes their site, it is gone under every spelling and
// cannot be put back by a stranger". A choice is stored under the exact
// address it was asked under (portfolio_owner); every read treats another
// spelling of the same site as that site, by the key the app resolves a site
// by (siteKeyOf: scheme, www, case, trailing slash, query and fragment
// ignored). Adding a removed site again (POST /api/add, the free tools,
// discovery's hand-off) is refused.
// Offline: a throwaway SQLite file per test, no server, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import {
  AGAIN_SUFFIX,
  REMOVAL_ALERT,
  REMOVAL_HOLD_MS,
  applyDueRemovals,
  openClaim,
  ownerAction,
  ownerState,
  removalConditions,
  setClaimStatus,
  undoRemoval,
  undoneRemovals,
} from "../lib/games/claims.mjs";
import { buildPool } from "../lib/games/pool.mjs";
import { siteKeyOf } from "../lib/grader/url.mjs";
import { OWNER_REMOVED_MESSAGE, OWNER_TTL_MS, addRefusal, forgetOwnerRows, markedOwnerRows, ownerMarks, ownerSiteKey, removalOf } from "../lib/ownership/same-site.mjs";
import { addFound, queue, seen, seenKey, settle } from "../lib/discovery/sites.mjs";
import { handoff } from "../pipeline/discovery/handoff.mjs";

const T0 = new Date("2026-11-16T18:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);

async function freshDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "owner-same-site-")), "db.sqlite")}` });
  await migrate(db);
  return db;
}

/** A claim on `url` proven by the verification file (control proof). */
async function owner(db, url, { id = "gh:1", login = "owner" } = {}) {
  const claim = await openClaim(db, { url, owner: id, login, token: `tok_${login}_aaaaaaaa`, now: T0 });
  await setClaimStatus(db, { claim, status: "verified", method: "file", actor: id, now: T0 });
  return id;
}

/** An owner's removal that has taken effect, asked under `url`. */
async function removed(db, url) {
  const id = await owner(db, url);
  assert.equal((await ownerAction(db, { url, owner: id, action: "remove", now: T0 })).ok, true);
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS + 1) }), [url]);
  return id;
}

/** A removal asked under `url`, still in its hold. */
async function held(db, url, id = "gh:3") {
  await owner(db, url, { id, login: id.replace(":", "") });
  assert.ok((await ownerAction(db, { url, owner: id, action: "remove", now: T0 })).state.removeAfter);
}

test("same site is the app's siteKeyOf: scheme, www, case, trailing slashes, query and fragment; another host or path is another site", () => {
  const k = ownerSiteKey("https://jane.dev");
  assert.equal(k, siteKeyOf("https://jane.dev"));
  for (const u of ["http://jane.dev", "https://www.jane.dev/", "HTTPS://WWW.Jane.DEV//", "jane.dev", "https://jane.dev/?x=1", "https://jane.dev/#home", "https://jane.dev/?"]) {
    assert.equal(ownerSiteKey(u), k, u);
  }
  assert.equal(ownerSiteKey("https://jane.dev/Work/"), ownerSiteKey("http://www.jane.dev/work"));
  assert.equal(ownerSiteKey("https://host.dev/p?u=alice"), ownerSiteKey("https://host.dev/p?u=bob"), "accepted: the app shows these as one profile");
  for (const other of ["https://jane.dev/blog", "https://bob.jane.dev/", "https://janedev.dev/"]) assert.notEqual(ownerSiteKey(other), k, other);
  assert.equal(ownerSiteKey("  not a url  "), "not a url", "an address siteKeyOf can't read is its own key");
});

test("a removal under one spelling hides the site under every other spelling, and nothing else", async () => {
  const db = await freshDb();
  await removed(db, "https://Jane.dev/#home");
  for (const u of ["https://jane.dev/", "http://www.jane.dev", "https://JANE.DEV//", "https://jane.dev/?x=1"]) {
    assert.ok((await ownerState(db, u)).removedAt, u);
  }
  assert.equal((await ownerState(db, "https://jane.dev/blog")).removedAt, null, "a different path is a different site");
  assert.equal((await ownerState(db, "https://bob.dev")).removedAt, null);
  assert.equal((await ownerMarks(db)).isRemoved("https://www.jane.dev/?ref=a"), true);
});

test("a hidden grade under one spelling is hidden under the others; showing it again from any spelling shows it everywhere", async () => {
  const db = await freshDb();
  const id = await owner(db, "https://jane.dev");
  assert.equal((await ownerAction(db, { url: "https://jane.dev", owner: id, action: "hide_grade", now: T0 })).state.hideGrade, true);
  for (const u of ["http://www.jane.dev/", "https://jane.dev/?u=bob", "https://jane.dev/#x"]) assert.equal((await ownerState(db, u)).hideGrade, true, u);
  assert.equal((await ownerState(db, "https://jane.dev/blog")).hideGrade, false, "another path is not covered");
  assert.equal((await ownerMarks(db)).gradeHidden("https://WWW.jane.dev"), true);

  const other = await owner(db, "https://www.jane.dev/");
  const shown = await ownerAction(db, { url: "https://www.jane.dev/", owner: other, action: "show_grade", now: at(1000) });
  assert.equal(shown.state.hideGrade, false);
  assert.equal((await ownerState(db, "https://jane.dev")).hideGrade, false);
});

test("a held removal is seen under every spelling; the owner's cancel from another spelling withdraws it and is logged under the held address", async () => {
  const db = await freshDb();
  const id = await owner(db, "https://jane.dev");
  const asked = await ownerAction(db, { url: "https://jane.dev", owner: id, action: "remove", now: T0 });
  assert.equal((await ownerState(db, "https://www.jane.dev/")).removeAfter, asked.state.removeAfter);

  const other = await owner(db, "https://www.jane.dev/");
  const again = await ownerAction(db, { url: "https://www.jane.dev/", owner: other, action: "remove", now: at(1000) });
  assert.equal(again.state.removeAfter, asked.state.removeAfter, "already held: nothing new");
  const cancel = await ownerAction(db, { url: "https://www.jane.dev/", owner: other, action: "cancel_remove", now: at(2000) });
  assert.deepEqual(cancel.state, { hideGrade: false, removedAt: null, removeAfter: null });
  const log = (await db.execute("SELECT url, action, detail FROM claim_log WHERE action = 'remove_cancelled'")).rows;
  assert.deepEqual(log.map((r) => [r.url, JSON.parse(String(r.detail))]), [["https://jane.dev", { removeAfter: asked.state.removeAfter, byRequester: true }]]);
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS + 1) }), [], "nothing left to apply");

  // Asked for again the same day under the held address: the alert says so (removal:<url>#again).
  await ownerAction(db, { url: "https://jane.dev", owner: id, action: "remove", now: at(3000) });
  const alerts = await removalConditions(db, { now: at(4000) });
  assert.deepEqual(alerts.map((a) => a.key), [`${REMOVAL_ALERT}https://jane.dev${AGAIN_SUFFIX}`]);
});

test("the owner's own undo still works the existing way: cancel under the spelling they asked with", async () => {
  const db = await freshDb();
  const id = await owner(db, "https://jane.dev");
  await ownerAction(db, { url: "https://jane.dev", owner: id, action: "remove", now: T0 });
  const cancel = await ownerAction(db, { url: "https://jane.dev", owner: id, action: "cancel_remove", now: at(1000) });
  assert.deepEqual(cancel.state, { hideGrade: false, removedAt: null, removeAfter: null });
  const log = (await db.execute("SELECT action FROM claim_log WHERE url = 'https://jane.dev' AND action LIKE 'remove_%' ORDER BY id")).rows.map((r) => r.action);
  assert.deepEqual(log, ["remove_requested", "remove_cancelled"]);
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS + 1) }), []);
});

test("the admin's undo posted under another spelling lists the site again, logged under the stored address, so the weekly restore finds it", async () => {
  const db = await freshDb();
  await removed(db, "https://jane.dev");
  const out = await undoRemoval(db, { url: "https://www.jane.dev/", actor: "admin:me", now: at(REMOVAL_HOLD_MS + 2) });
  assert.equal(out.ok, true);
  assert.equal(out.wasRemoved, true);
  assert.equal((await ownerState(db, "https://jane.dev")).removedAt, null);
  const log = (await db.execute("SELECT url FROM claim_log WHERE action = 'removal_undone'")).rows.map((r) => r.url);
  assert.deepEqual(log, ["https://jane.dev"]);
  assert.deepEqual((await undoneRemovals(db)).map((u) => u.url), ["https://jane.dev"]);
});

test("the quiz pool leaves out a removed site and a hidden grade under another spelling, and keeps another path", async () => {
  const db = await freshDb();
  const rate = (url, rank) =>
    db.execute({ sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, shown_rank, tier) VALUES ('merged', ?, ?, 25, 3, 'high', ?, 'A')", args: [url, rank, rank] });
  const sites = ["https://jane.dev/#home", "https://www.bob.dev", "https://host.dev/carol", "https://keep.dev"];
  for (const [i, u] of sites.entries()) await rate(u, i + 1);
  await removed(db, "http://jane.dev");
  const id = await owner(db, "https://bob.dev/?ref=x", { id: "gh:2", login: "bob" });
  await ownerAction(db, { url: "https://bob.dev/?ref=x", owner: id, action: "hide_grade", now: T0 });
  await removed(db, "https://host.dev/alice");
  const pool = await buildPool(db);
  assert.deepEqual(pool.sites.map((s) => s.u), ["https://host.dev/carol", "https://keep.dev"]);
});

test("/api/add's checks: an applied removal under the same or another spelling, a stored query or fragment too; a held one says held; a never-removed site is accepted; nothing is written", async () => {
  const db = await freshDb();
  // The reviewer's repro: the listed address carries a fragment, the visitor adds the bare one.
  await removed(db, "https://ethanlanting.dev/#home");
  for (const u of ["https://ethanlanting.dev/", "https://www.ethanlanting.dev", "http://ETHANLANTING.dev/?utm=x"]) {
    assert.equal(await removalOf(db, [u]), "removed", u);
    assert.deepEqual(await addRefusal(db, [u]), { error: "owner_removed", message: OWNER_REMOVED_MESSAGE }, u);
  }
  await held(db, "https://held.dev/?ref=a");
  assert.equal(await removalOf(db, ["https://www.held.dev/"]), "held");
  assert.ok(await addRefusal(db, ["https://held.dev"]), "the free tools never add a held one either");

  assert.equal(await removalOf(db, ["https://fresh.dev/"]), null, "a never-removed site is accepted");
  assert.equal(await addRefusal(db, ["https://ethanlanting.dev/blog"]), null, "another path is another site");
  assert.equal(await removalOf(db, []), null);

  const count = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM portfolio_owner")).rows[0].n);
  const before = await count();
  await addRefusal(db, ["https://www.ethanlanting.dev/"]);
  assert.equal(await count(), before);
  assert.equal(await seen(db, "https://ethanlanting.dev/"), null);
});

test("owner reads are cached a minute per client; an owner action, an apply and an undo drop the cache at once", async () => {
  const db = await freshDb();
  const id = await owner(db, "https://jane.dev");
  assert.equal((await ownerState(db, "https://www.jane.dev")).hideGrade, false);
  await ownerAction(db, { url: "https://jane.dev", owner: id, action: "hide_grade", now: T0 });
  assert.equal((await ownerState(db, "https://www.jane.dev")).hideGrade, true, "seen at once after the action");

  // A write from elsewhere (another isolate, the hourly job) is seen within the minute.
  const t = Date.now();
  await markedOwnerRows(db, { now: t });
  await db.execute("UPDATE portfolio_owner SET hide_grade = 0");
  assert.equal((await markedOwnerRows(db, { now: t + 1000 })).length, 1, "still cached");
  assert.equal((await markedOwnerRows(db, { now: t + OWNER_TTL_MS + 1 })).length, 0, "read again after the TTL");
  assert.equal((await markedOwnerRows(db, { fresh: true })).length, 0);
  await db.execute("UPDATE portfolio_owner SET hide_grade = 1");
  forgetOwnerRows();
  assert.equal((await markedOwnerRows(db)).length, 1);
});

test("a database without the owner table has no removals; a broken read is an error, never 'nothing removed'", async () => {
  const empty = createClient({ url: ":memory:" });
  assert.equal(await removalOf(empty, ["https://jane.dev"]), null);
  const broken = { execute: async () => Promise.reject(new Error("SQLITE_ERROR: no such column: remove_after")) };
  await assert.rejects(removalOf(broken, ["https://jane.dev"]));
});

test("discovery's hand-off: an applied removal (stored with a fragment) is dropped for good; a held one stays pending; others are handed off", async () => {
  const db = await freshDb();
  await removed(db, "https://jane.dev/#home");
  await held(db, "https://held.dev");
  const urls = ["https://www.jane.dev/", "https://held.dev/", "https://ok.dev/"];
  for (const [i, url] of urls.entries()) await addFound(db, [{ url, source: "github" }], { now: new Date(T0.getTime() + i) });
  await settle(db, urls.map((u) => ({ key: seenKey(u), status: "pending" })), { now: T0 });
  const out = await handoff(db, { perDay: 10, waiting: 10, reserve: 0, now: T0 });
  assert.deepEqual([out.handed, out.ownerRemoved, out.ownerHeld], [1, 1, 1]);
  assert.deepEqual((await db.execute("SELECT url FROM grade_jobs")).rows.map((r) => r.url), ["https://ok.dev/"]);
  assert.equal((await seen(db, "https://jane.dev"))?.reason, "owner_removed");
  assert.equal((await seen(db, "https://held.dev"))?.status, "pending", "the owner may still cancel");
  assert.deepEqual((await queue(db, "pending", 10)).map((r) => r.url), ["https://held.dev/"]);
});
