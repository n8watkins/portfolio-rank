// The owner's rule for site ownership: "only someone who can deploy to a
// site can take it down, hide its grade or otherwise change what others see
// about it". A claim proven only by a link from the page to a GitHub profile
// (github_link) is not that proof: collaborators and designers are linked
// too. These are the paths a security audit (2026-11-16) and the review of
// its fix found open:
//   a. a link-only claim could cancel the real owner's held removal
//   b. every action that changes what others see needs control proof
//   c. every route that opens or verifies a claim applies the same limits,
//      reads only when that is all it may do, and never demotes a claim
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
import {
  ACTIONS,
  MAX_VERIFIED,
  PROOF_ERRORS,
  PURGE_LOOKBACK_MS,
  REMOVAL_HOLD_MS,
  applyDueRemovals,
  applyProof,
  claimById,
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
  verifyReadOnly,
} from "../lib/games/claims.mjs";
import { afterProof, scheduledAction, verifyMessage } from "../components/claim/flow-rules.ts";

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

/** A claim on `url` for `owner` with `status`, proven by `method` (an "admin:" actor makes it a reviewed claim). */
async function claimWith(db, { url = URL, owner, login, method, status = "verified", actor = owner, now = T0 }) {
  const claim = await openClaim(db, { url, owner, login, token: `tok_${login}_aaaaaaaa`, now });
  return setClaimStatus(db, { claim, status, method, actor, now });
}
const verified = (db, args) => claimWith(db, { ...args, status: "verified" });

const logOf = async (db, url = URL) =>
  (await db.execute({ sql: "SELECT actor, action, detail FROM claim_log WHERE url = ? ORDER BY id", args: [url] })).rows.map((r) => ({
    actor: String(r.actor),
    action: String(r.action),
    detail: r.detail == null ? null : JSON.parse(String(r.detail)),
  }));
const logCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS n FROM claim_log")).rows[0].n);
const cancelAlerts = async (db, now) => (await removalConditions(db, { now })).filter((c) => c.title.startsWith("Removal cancelled"));

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
  for (const c of await removalConditions(db, { now: at(3 * HOUR) })) assert.doesNotMatch(c.detail, /gh:\d/, "alerts name logins, never account ids");
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
// Alerts: one per site, saying the latest state
// ---------------------------------------------------------------------------

test("alerts: asking and cancelling again and again is one alert for the site, whose text says the latest state", async () => {
  const db = await freshDb();
  await verified(db, { owner: "gh:1", login: "realowner", method: "file" });
  for (let i = 0; i < 10; i++) {
    await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now: at(i * 600e3) });
    await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(i * 600e3 + 300e3) });
  }
  const now = at(2 * HOUR);
  let alerts = await removalConditions(db, { now });
  assert.deepEqual(alerts.map((c) => c.key), [`removal:${URL}`], "one alert key per site, as before");
  assert.ok(isRemovalAlert(alerts[0].key));
  assert.equal(alerts[0].title, "Removal cancelled for victim.example");
  assert.match(alerts[0].detail, /@realowner cancelled the removal of https:\/\/victim\.example they had asked for/);
  assert.match(alerts[0].detail, /cancelled 10 times in the last day/);

  // Asked for again: the same key now says it is held, and mentions the cancels.
  await ownerAction(db, { url: URL, owner: "gh:1", action: "remove", now });
  alerts = await removalConditions(db, { now });
  assert.deepEqual(alerts.map((c) => [c.key, c.title]), [[`removal:${URL}`, "Removal requested for victim.example"]]);
  assert.match(alerts[0].detail, /@realowner asked to remove/);
  assert.match(alerts[0].detail, /cancelled 10 time\(s\) in the last day/);

  // A day after the last cancel, with nothing held, the alert clears.
  await ownerAction(db, { url: URL, owner: "gh:1", action: "cancel_remove", now: at(2 * HOUR + 1000) });
  assert.equal((await removalConditions(db, { now: at(2 * HOUR + 1000 + REMOVAL_HOLD_MS + 1) })).length, 0);
});

test("alerts: the cancel text is right when the same account cancelled, another did, or it isn't recorded who asked", async () => {
  const db = await freshDb();
  const sites = { same: "https://same.example", other: "https://other.example", unknown: "https://unknown.example" };
  for (const url of Object.values(sites)) {
    await verified(db, { url, owner: "gh:1", login: "asker", method: "file" });
    await verified(db, { url, owner: "gh:2", login: "partner", method: "meta" });
    await ownerAction(db, { url, owner: "gh:1", action: "remove", now: T0 });
  }
  await ownerAction(db, { url: sites.same, owner: "gh:1", action: "cancel_remove", now: at(HOUR) });
  await ownerAction(db, { url: sites.other, owner: "gh:2", action: "cancel_remove", now: at(HOUR) });
  // A cancel logged before this change: no detail at all.
  await db.execute({ sql: "UPDATE portfolio_owner SET remove_after = NULL, removed_by = NULL WHERE url = ?", args: [sites.unknown] });
  await db.execute({ sql: "INSERT INTO claim_log (at, url, actor, action, detail) VALUES (?, ?, 'gh:2', 'remove_cancelled', NULL)", args: [at(HOUR).toISOString(), sites.unknown] });

  const text = Object.fromEntries((await cancelAlerts(db, at(2 * HOUR))).map((c) => [c.key.slice("removal:".length), c.detail]));
  assert.match(text[sites.same], /^@asker cancelled the removal of https:\/\/same\.example they had asked for/);
  assert.doesNotMatch(text[sites.same], /Both accounts/);
  assert.match(text[sites.other], /^@partner cancelled the removal of https:\/\/other\.example that another account had asked for/);
  assert.match(text[sites.other], /Both accounts proved they can deploy to the site/);
  assert.match(text[sites.unknown], /^@partner cancelled the removal of https:\/\/unknown\.example, at .*Which account had asked for it isn't recorded/);
  assert.doesNotMatch(text[sites.unknown], /Both accounts|they had asked/);
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
});

test("b: AUTOMATION.md documents every proof refusal and the rules around a held removal", () => {
  const doc = fs.readFileSync("AUTOMATION.md", "utf8");
  for (const error of PROOF_ERRORS) assert.ok(doc.includes(`\`${error}\``), error);
  assert.match(doc, /cancel/i);
  assert.match(doc, /purged_at/);
  assert.match(doc, /only reads/);
});

// ---------------------------------------------------------------------------
// c. Opening and verifying a claim
// ---------------------------------------------------------------------------

test("c: a new claim's proof waits for review for a too-new account or one past MAX_VERIFIED", async () => {
  const db = await freshDb();
  const fresh = await openClaim(db, { url: URL, owner: "gh:9", login: "n", token: "tok_n_aaaaaaaa", now: T0 });
  const young = await applyProof(db, { claim: fresh, proof: "file", tooNew: true, minAccountAgeDays: 30, actor: "gh:9", now: T0 });
  assert.deepEqual([young.claim.status, young.reason], ["review", "review"]);
  assert.match(young.claim.note, /younger than 30 days/);

  const db2 = await freshDb();
  for (let i = 0; i < MAX_VERIFIED; i++) await verified(db2, { url: `https://other${i}.example`, owner: "gh:9", login: "n", method: "file" });
  const fourth = await openClaim(db2, { url: URL, owner: "gh:9", login: "n", token: "tok_n_aaaaaaaa", now: T0 });
  const out = await applyProof(db2, { claim: fourth, proof: "file", tooNew: false, actor: "gh:9", now: T0 });
  assert.deepEqual([out.claim.status, out.reason], ["review", "review"]);
  assert.match(out.claim.note, new RegExp(`over the automatic limit of ${MAX_VERIFIED}`));
});

test("c: an upgrade never demotes a verified claim: past MAX_VERIFIED it upgrades, and a too-new account's is held with the claim untouched", async () => {
  // Four verified claims (three approved by the admin); the meta tag on the first.
  const db = await freshDb();
  const link = await verified(db, { owner: "gh:9", login: "n", method: "github_link" });
  for (let i = 0; i < MAX_VERIFIED; i++) await verified(db, { url: `https://other${i}.example`, owner: "gh:9", login: "n", method: "file", actor: "admin:n8" });
  const up = await applyProof(db, { claim: link, proof: "meta", tooNew: false, actor: "gh:9", now: at(HOUR) });
  assert.deepEqual([up.claim.status, up.claim.method, up.reason], ["verified", "meta", undefined]);

  // A too-new account: the link claim stays verified by its link, and nothing is written.
  const db2 = await freshDb();
  const link2 = await verified(db2, { owner: "gh:9", login: "n", method: "github_link" });
  const rows = await logCount(db2);
  const held = await applyProof(db2, { claim: link2, proof: "meta", tooNew: true, minAccountAgeDays: 30, actor: "gh:9", now: at(HOUR) });
  assert.equal(held.reason, "account_too_new");
  const after = await claimById(db2, link2.id);
  assert.deepEqual([after.status, after.method, after.updatedAt], ["verified", "github_link", link2.updatedAt]);
  assert.equal(await logCount(db2), rows);

  // A claim the admin approved for a too-new account keeps its approval and its control proof.
  const db3 = await freshDb();
  const approved = await verified(db3, { owner: "gh:9", login: "n", method: "manual", actor: "admin:n8" });
  await applyProof(db3, { claim: approved, proof: "meta", tooNew: true, minAccountAgeDays: 30, actor: "gh:9", now: at(HOUR) });
  assert.equal((await claimById(db3, approved.id)).status, "verified");
  assert.equal(await controlProof(db3, { url: URL, owner: "gh:9" }), true);
});

test("c: a claim held for review or rejected changes only by the admin: repeating the proof writes nothing", async () => {
  const db = await freshDb();
  const held = await claimWith(db, { owner: "gh:9", login: "n", method: "file", status: "review" });
  const again = await applyProof(db, { claim: held, proof: "file", tooNew: true, minAccountAgeDays: 30, actor: "gh:9", now: at(HOUR) });
  assert.deepEqual([again.claim.status, again.reason], ["review", "review"]);
  assert.equal((await claimById(db, held.id)).updatedAt, held.updatedAt, "keeps its place in the oldest-first queue");
  const rejected = await claimWith(db, { url: "https://r.example", owner: "gh:9", login: "n", method: "manual", status: "rejected", actor: "admin:n8" });
  const before = await logCount(db);
  for (const tooNew of [true, false]) {
    const out = await applyProof(db, { claim: rejected, proof: "file", tooNew, actor: "gh:9", now: at(HOUR) });
    assert.deepEqual([out.claim.status, out.reason], ["rejected", "rejected"]);
  }
  assert.equal(await logCount(db), before);
  // Once the hold is gone, a real proof verifies a claim held for review (once).
  const ok = await applyProof(db, { claim: held, proof: "file", tooNew: false, actor: "gh:9", now: at(2 * HOUR) });
  assert.equal(ok.claim.status, "verified");
  const same = await applyProof(db, { claim: ok.claim, proof: "file", tooNew: false, actor: "gh:9", now: at(3 * HOUR) });
  assert.equal(same.claim.updatedAt, ok.claim.updatedAt, "the same proof again writes nothing");
});

test("c: /api/owner/verify only reads on a page load of an existing claim and on settled claims", async () => {
  const db = await freshDb();
  const args = { tooNew: true, minAccountAgeDays: 30 };
  assert.equal(await verifyReadOnly(db, { claim: null, method: "start", ...args }), null, "a new claim is opened (under the claim limit)");
  const pending = await openClaim(db, { url: URL, owner: "gh:9", login: "n", token: "tok_n_aaaaaaaa", now: T0 });
  assert.deepEqual(await verifyReadOnly(db, { claim: pending, method: "start", ...args }), { reason: null }, "a reload of a pending claim");
  assert.equal(await verifyReadOnly(db, { claim: pending, method: "file", ...args }), null, "a real check goes on");
  const held = await setClaimStatus(db, { claim: pending, status: "review", method: "github_pages", note: "young", actor: "gh:9", now: T0 });
  assert.deepEqual(await verifyReadOnly(db, { claim: held, method: "start", ...args }), { reason: "review" });
  assert.deepEqual(await verifyReadOnly(db, { claim: held, method: "file", ...args }), { reason: "review" }, "held again: no fetch, no write");
  assert.equal(await verifyReadOnly(db, { claim: held, method: "file", tooNew: false }), null, "the hold is gone: it may verify");
  const rejected = await setClaimStatus(db, { claim: held, status: "rejected", actor: "admin:n8", now: T0 });
  for (const method of ["start", "file", "meta"]) assert.deepEqual(await verifyReadOnly(db, { claim: rejected, method, tooNew: false }), { reason: "rejected" }, method);
  const proven = await setClaimStatus(db, { claim: rejected, status: "verified", method: "file", actor: "admin:n8", now: T0 });
  assert.deepEqual(await verifyReadOnly(db, { claim: proven, method: "meta", tooNew: false }), { reason: null });
});

test("c: the claim pages show a held or rejected claim on load, and offer cancelling only to an account that can", () => {
  assert.match(verifyMessage("review"), /check this one by hand/);
  assert.match(verifyMessage("rejected"), /wasn't accepted/);
  assert.match(verifyMessage("account_too_new"), /too new/);
  assert.equal(verifyMessage(undefined), "");
  assert.equal(scheduledAction({ removable: true }), "cancel");
  assert.equal(scheduledAction({ removable: false }), "prove", "a link-only account proves control first");
  assert.equal(afterProof({ removedAt: null, removeAfter: "2026-11-17T00:00:00.000Z" }), "scheduled", "then comes back to the held removal");
  assert.equal(afterProof({ removedAt: null, removeAfter: null }), "confirm-remove");
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
  assert.equal(String(row.purged_at), at(REMOVAL_HOLD_MS + 2 * HOUR).toISOString(), "a column, not audit-log rows");

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

test("d: removalsTick reports every removal it applied even when the alert step throws, and the purge and pool still follow", async (t) => {
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
  assert.equal(Number((await setup.execute("SELECT COUNT(*) AS n FROM cache WHERE k = 'games:pool'")).rows[0].n), 0, "the pool was dropped");

  // The hourly edge purge, as worker/index.ts runs it, finds it whatever the tick returned.
  const purged = [];
  const res = await purgeRemovedProfiles(setup, { purge: async (urls) => (purged.push(...urls), true), now: at(REMOVAL_HOLD_MS + HOUR) });
  assert.deepEqual(res.purged, ["https://a.example"]);
  assert.deepEqual(purged, ["https://a.example"]);
  setup.close();
});
