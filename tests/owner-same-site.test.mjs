// The owner's rule for removals and hidden grades (lib/ownership/same-site.mjs):
// "when an owner removes their site, it is gone under every spelling and
// cannot be put back by a stranger". A choice is stored under the exact
// address it was asked under (portfolio_owner); every read treats another
// spelling of the same site (scheme, host case, "www.", trailing slashes) as
// that site, and never a different query or path. Adding a removed site
// again (POST /api/add, the free tools, discovery's hand-off) is refused.
// Offline: a throwaway SQLite file per test, no server, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { REMOVAL_HOLD_MS, applyDueRemovals, openClaim, ownerAction, ownerState, setClaimStatus, undoRemoval } from "../lib/games/claims.mjs";
import { buildPool } from "../lib/games/pool.mjs";
import { OWNER_REMOVED_MESSAGE, addRefusal, ownerMarks, ownerRemovedAny, ownerSiteKey } from "../lib/ownership/same-site.mjs";
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

test("same site: scheme, host case, www and trailing slashes only; query, fragment, port and path case stay apart", () => {
  const k = ownerSiteKey("https://jane.dev");
  for (const u of ["http://jane.dev", "https://www.jane.dev/", "HTTPS://WWW.Jane.DEV//", "jane.dev", "https://jane.dev./", "https://jane.dev/?", "https://jane.dev/#"]) {
    assert.equal(ownerSiteKey(u), k, u);
  }
  assert.equal(ownerSiteKey("https://jane.dev/work/"), ownerSiteKey("http://www.jane.dev/work"));
  assert.equal(ownerSiteKey("https://Amanbuilds.me"), ownerSiteKey("https://amanbuilds.me/"), "an upstream respelling of the host's case");
  for (const other of ["https://jane.dev/?u=bob", "https://jane.dev/#bob", "https://jane.dev:8443/", "https://jane.dev/Work", "https://jane.dev/work", "https://bob.jane.dev/"]) {
    assert.notEqual(ownerSiteKey(other), k, other);
  }
  assert.notEqual(ownerSiteKey("https://host.dev/p?u=alice"), ownerSiteKey("https://host.dev/p?u=bob"), "two people on one host and path");
  assert.notEqual(ownerSiteKey("https://jane.dev/work"), ownerSiteKey("https://jane.dev/Work"));
});

test("a removal under one spelling hides the site under every other spelling, and nothing else", async () => {
  const db = await freshDb();
  await removed(db, "https://Jane.dev");
  for (const u of ["https://jane.dev/", "http://www.jane.dev", "https://JANE.DEV//"]) {
    assert.ok((await ownerState(db, u)).removedAt, u);
  }
  assert.equal((await ownerState(db, "https://jane.dev/?u=bob")).removedAt, null, "a different query is a different site");
  assert.equal((await ownerState(db, "https://jane.dev/blog")).removedAt, null, "a different path is a different site");
  assert.equal((await ownerState(db, "https://bob.dev")).removedAt, null);
  const marks = await ownerMarks(db);
  assert.ok(marks.removed.has(ownerSiteKey("https://www.jane.dev/")));
});

test("a held removal is seen under every spelling; a second request under another spelling is no second removal, and the owner's cancel withdraws it", async () => {
  const db = await freshDb();
  const id = await owner(db, "https://jane.dev");
  const asked = await ownerAction(db, { url: "https://jane.dev", owner: id, action: "remove", now: T0 });
  assert.ok(asked.state.removeAfter);
  assert.equal((await ownerState(db, "https://www.jane.dev/")).removeAfter, asked.state.removeAfter);

  // The same owner, verified under the other spelling too, cancels from there: the held removal is gone everywhere.
  const other = await owner(db, "https://www.jane.dev/", { id: "gh:1", login: "owner" });
  const again = await ownerAction(db, { url: "https://www.jane.dev/", owner: other, action: "remove", now: at(1000) });
  assert.equal(again.state.removeAfter, asked.state.removeAfter, "already held: nothing new");
  const cancel = await ownerAction(db, { url: "https://www.jane.dev/", owner: other, action: "cancel_remove", now: at(2000) });
  assert.equal(cancel.ok, true);
  assert.deepEqual(cancel.state, { hideGrade: false, removedAt: null, removeAfter: null });
  assert.deepEqual(await applyDueRemovals(db, { now: at(REMOVAL_HOLD_MS + 1) }), [], "nothing left to apply");
  assert.equal((await ownerState(db, "https://jane.dev")).removedAt, null);
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

test("the admin's undo lists the site again under every spelling", async () => {
  const db = await freshDb();
  await removed(db, "https://jane.dev");
  const out = await undoRemoval(db, { url: "https://www.jane.dev/", actor: "admin:me", now: at(REMOVAL_HOLD_MS + 2) });
  assert.equal(out.ok, true);
  assert.equal(out.wasRemoved, true);
  assert.equal((await ownerState(db, "https://jane.dev")).removedAt, null);
});

test("a hidden grade under one spelling is hidden under the others; showing it again from any spelling shows it everywhere", async () => {
  const db = await freshDb();
  const id = await owner(db, "https://jane.dev");
  assert.equal((await ownerAction(db, { url: "https://jane.dev", owner: id, action: "hide_grade", now: T0 })).state.hideGrade, true);
  assert.equal((await ownerState(db, "http://www.jane.dev/")).hideGrade, true);
  assert.equal((await ownerState(db, "https://jane.dev/?u=bob")).hideGrade, false, "a different query is not covered");
  assert.ok((await ownerMarks(db)).hideGrade.has(ownerSiteKey("https://WWW.jane.dev")));

  const other = await owner(db, "https://www.jane.dev/");
  const shown = await ownerAction(db, { url: "https://www.jane.dev/", owner: other, action: "show_grade", now: at(1000) });
  assert.equal(shown.state.hideGrade, false);
  assert.equal((await ownerState(db, "https://jane.dev")).hideGrade, false);
});

test("the quiz pool leaves out a removed site and a hidden grade under another spelling, and keeps a different query", async () => {
  const db = await freshDb();
  const rate = (view, url, rank, tier) =>
    db.execute({ sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, shown_rank, tier) VALUES (?, ?, ?, 25, 3, 'high', ?, ?)", args: [view, url, rank, rank, tier] });
  const sites = ["https://jane.dev/", "https://www.bob.dev", "https://host.dev/p?u=carol", "https://keep.dev"];
  for (const [i, u] of sites.entries()) await rate("merged", u, i + 1, "A");
  await removed(db, "http://jane.dev");
  const id = await owner(db, "https://bob.dev/", { id: "gh:2", login: "bob" });
  await ownerAction(db, { url: "https://bob.dev/", owner: id, action: "hide_grade", now: T0 });
  await removed(db, "https://host.dev/p?u=alice");
  const pool = await buildPool(db);
  assert.deepEqual(pool.sites.map((s) => s.u), ["https://host.dev/p?u=carol", "https://keep.dev"]);
});

test("/api/add's refusal: a removed site under the same and another spelling, a held one too; never-removed and different-query sites are accepted", async () => {
  const db = await freshDb();
  await removed(db, "https://jane.dev");
  for (const u of ["https://jane.dev", "https://www.jane.dev/", "http://JANE.dev"]) {
    assert.deepEqual(await addRefusal(db, [u]), { error: "owner_removed", message: OWNER_REMOVED_MESSAGE }, u);
  }
  // The route passes the address as checked and the listed one: either is enough.
  assert.ok(await addRefusal(db, ["https://new.dev/", "https://www.jane.dev"]));

  const id = await owner(db, "https://held.dev", { id: "gh:3", login: "held" });
  await ownerAction(db, { url: "https://held.dev", owner: id, action: "remove", now: T0 });
  assert.ok(await addRefusal(db, ["https://www.held.dev/"]), "a held removal counts");

  assert.equal(await addRefusal(db, ["https://fresh.dev/"]), null, "a never-removed site is accepted");
  assert.equal(await addRefusal(db, ["https://jane.dev/?u=bob"]), null, "a different query is a different site");
  assert.equal(await addRefusal(db, []), null);

  // Nothing is written by the check: no owner row, no claim, no discovery row.
  const before = (await db.execute("SELECT COUNT(*) AS n FROM portfolio_owner")).rows[0].n;
  await addRefusal(db, ["https://www.jane.dev/"]);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM portfolio_owner")).rows[0].n, before);
  assert.equal(await seen(db, "https://www.jane.dev/"), null);
});

test("a database without the owner table has no removals; a broken read is an error, never 'nothing removed'", async () => {
  const empty = createClient({ url: ":memory:" });
  assert.equal(await ownerRemovedAny(empty, ["https://jane.dev"]), false);
  const broken = { execute: async () => Promise.reject(new Error("SQLITE_ERROR: no such column: remove_after")) };
  await assert.rejects(ownerRemovedAny(broken, ["https://jane.dev"]));
});

test("discovery's hand-off never grades a removed site back in, under any spelling; others are handed off", async () => {
  const db = await freshDb();
  await removed(db, "https://jane.dev");
  const id = await owner(db, "https://held.dev", { id: "gh:3", login: "held" });
  await ownerAction(db, { url: "https://held.dev", owner: id, action: "remove", now: T0 });
  const urls = ["https://www.jane.dev/", "https://held.dev/", "https://ok.dev/"];
  for (const [i, url] of urls.entries()) await addFound(db, [{ url, source: "github" }], { now: new Date(T0.getTime() + i) });
  await settle(db, urls.map((u) => ({ key: seenKey(u), status: "pending" })), { now: T0 });
  const out = await handoff(db, { perDay: 10, waiting: 10, reserve: 0, now: T0 });
  assert.equal(out.handed, 1);
  assert.equal(out.ownerRemoved, 2);
  assert.deepEqual((await db.execute("SELECT url FROM grade_jobs")).rows.map((r) => r.url), ["https://ok.dev/"]);
  assert.deepEqual([(await seen(db, "https://jane.dev"))?.reason, (await seen(db, "https://held.dev"))?.reason], ["owner_removed", "owner_removed"]);
  assert.equal((await queue(db, "pending", 10)).length, 0);
});
