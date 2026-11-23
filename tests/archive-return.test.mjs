// A site back from the archive starts completely fresh (owner, 2026-11-23:
// "It can't keep its own votes. We don't know if it's the same thing."): its
// old rows move to a closed-off key (pipeline/archive-return.mjs), on day 5
// after archiving as on day 200, and no other site's rating moves for it.
// A site back from the temporary pool keeps everything (tests/pool-and-archive.test.mjs).
// Offline: a throwaway database with the whole schema (lib/schema.mjs migrate).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { loadGrades, refreshTiers } from "../lib/tiers-store.mjs";
import { ownerVerdict, ownerKeepsSite, reviewOf, undoneRemovals } from "../lib/reviews/store.mjs";
import { archivedKey, isArchivedKey, retireArchivedSite } from "../pipeline/archive-return.mjs";
import { weeklyExport } from "../pipeline/exclusions.mjs";
import { answer } from "./helpers/door-night.mjs";

const A = "https://returning.example"; // archived, then back
const B = "https://opponent-b.example";
const C = "https://opponent-c.example";
const T0 = Date.parse("2026-11-01T00:00:00Z");
const D = 86400000;
const iso = (t) => new Date(t).toISOString();

async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-return-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  for (const u of [A, B, C]) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, health) VALUES (?, ?, 'live', ?, '2026-10-01 00:00:00', ?, 'live')",
      args: [u, `Person ${u.slice(8, 12)}`, `k-${u.length}-${u.slice(8, 11)}`, JSON.stringify({ ...answer(true), judged_at: "2026-10-01T00:00:00Z" })],
    });
  }
  // Face-offs, people's votes: A beat B three times, B beat C twice, C beat A once, A beat C once (starred).
  const votes = [[A, B], [A, B], [B, C], [A, B], [B, C], [C, A], [A, C, 1]];
  let i = 0;
  for (const [w, l, star = 0] of votes) {
    i++;
    await db.execute({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at, starred) VALUES (?, ?, ?, 'human', ?, ?, ?)",
      args: [w, l, [w, l].sort().join("\n"), `r${i}`, iso(T0 + i * 3600000), star],
    });
  }
  // What a visitor, the owner and the review queue left on A.
  await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES ('fan', ?)", args: [A] });
  await db.execute({ sql: "INSERT INTO lists (owner, name, slug, created_at) VALUES ('fan', 'Faves', 'faves-1', '2026-10-02')" }).catch(() => {});
  await db.execute({ sql: "INSERT INTO claims (url, owner, login, status, method, token, created_at, updated_at) VALUES (?, 'gh:1', 'old-owner', 'verified', 'meta', 't', '2026-10-01', '2026-10-01')", args: [A] });
  await db.execute({ sql: "INSERT INTO claim_log (at, url, actor, action) VALUES ('2026-10-01', ?, 'gh:1', 'verified')", args: [A] });
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, hide_grade, updated_at) VALUES (?, 1, '2026-10-01')", args: [A] });
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, created_at, decided_at, decided_by)
          VALUES ('old', ?, 'door_held', 'ranked', 'remove', 0, '{}', 'rejected', '2026-10-02', '2026-10-03', 'admin:owner')`,
    args: [A],
  });
  await db.execute({ sql: "INSERT INTO rubric_history (url, rubric, replaced_at) VALUES (?, '{}', '2026-10-01')", args: [A] }).catch(() => {});
  await refreshTiers(db, { now: T0 + 10 * D });
  return db;
}

/** The ratings every site has from the replay of the vote log (lib/tiers-rating.mjs), url -> { mu, sigma }. */
const ratings = async (db, now) => {
  const { ratings: r } = await loadGrades(db, { now: new Date(now) });
  return new Map([...r].map(([u, x]) => [u, { mu: x.mu, sigma: x.sigma, faceoffs: x.faceoffs }]));
};
const n = async (db, sql, args = []) => Number((await db.execute({ sql, args })).rows[0].n);

/** Archives A as the weekly export would leave it: off the list, in the pool's down state. */
const archive = (db, at) => db.execute({ sql: "UPDATE portfolios SET delisted_at = ?, health = 'down', health_reason = 'HTTP 402: deployment paused' WHERE url = ?", args: [iso(at), A] });

/** A is listed again and captured as a new site (the sync and the nightly capture). */
const comeBack = (db) =>
  db.execute({ sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at, health) VALUES (?, 'Someone New', 'live', 'k-new', '2026-12-01 00:00:00', NULL)", args: [A] });

async function startsFresh(db) {
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = ? OR loser = ?", [A, A]), 0, "no old votes");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM tier_ratings WHERE url = ?", [A]), 0, "no old rating or tier");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM likes WHERE url = ?", [A]), 0, "no old likes");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM claims WHERE url = ?", [A]), 0, "no old claim");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolio_owner WHERE url = ?", [A]), 0, "no old owner verification");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM star_counts WHERE url = ? AND n > 0", [A]), 0, "no old stars");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM status_reviews WHERE url = ?", [A]), 0, "no old review decision");
  assert.equal(await ownerVerdict(db, A), null);
  const rows = (await db.execute({ sql: "SELECT * FROM status_reviews WHERE url = ?", args: [A] })).rows.map(reviewOf);
  assert.equal(ownerKeepsSite(rows), false, "the owner's keep of the old site does not carry over");
  const row = (await db.execute({ sql: "SELECT ai_rubric, name FROM portfolios WHERE url = ?", args: [A] })).rows[0];
  assert.deepEqual([row.ai_rubric, row.name], [null, "Someone New"], "no old grade: a new site's row");
  const r = await ratings(db, T0 + 100 * D);
  assert.equal(r.get(A)?.faceoffs ?? 0, 0, "no face-off history");
}

test("an archive return on day 5: the old rows move to a closed key, the site starts fresh, and no other site's rating moves", async () => {
  const db = await world();
  const listed = await ratings(db, T0 + 20 * D);
  await archive(db, T0 + 20 * D);
  const archived = await ratings(db, T0 + 20 * D);
  // What archiving itself already does to the others (A loses its starting seed while it is off the list): measured, not caused here.
  const moved = (u) => Math.abs(archived.get(u).mu - listed.get(u).mu);
  console.log(`archiving A moved B by ${moved(B).toFixed(4)} and C by ${moved(C).toFixed(4)} mu (the replay without A's seed)`);

  const r = await retireArchivedSite(db, A, { now: new Date(T0 + 25 * D) });
  const key = archivedKey(A, "2026-11-26");
  assert.equal(r.key, key);
  assert.equal(r.moved["votes.winner"], 4);
  assert.equal(r.moved["votes.loser"], 1);
  assert.equal(r.moved["portfolios.url"], 1);
  assert.ok(r.deleted["claims.url"] && r.deleted["portfolio_owner.url"]);
  // The others' ratings are exactly what they were while A was archived: the closed key plays A's part move for move.
  const after = await ratings(db, T0 + 25 * D);
  for (const u of [B, C]) assert.deepEqual(after.get(u), archived.get(u), `${u} keeps its rating exactly`);
  assert.deepEqual(after.get(key), archived.get(A), "the old face-offs are kept, under the closed key");
  // The history is kept: the votes, the old row (delisted, the purge's), the old decision and the claim log.
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = ? OR loser = ?", [key, key]), 5);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE pair_key LIKE ?", [`%${key}%`]), 5, "pair keys follow");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ? AND delisted_at IS NOT NULL", [key]), 1);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM claim_log WHERE url = ?", [key]), 1);
  assert.ok(isArchivedKey(key));
  // A closed-key review row is never taken for an address to list again.
  assert.ok(!(await undoneRemovals(db)).some((x) => isArchivedKey(x.url)));

  await comeBack(db);
  await startsFresh(db);
  // A daily tiers run afterwards: B and C still have the same ratings.
  await refreshTiers(db, { now: T0 + 40 * D });
  const later = await ratings(db, T0 + 40 * D);
  for (const u of [B, C]) assert.equal(later.get(u).faceoffs, archived.get(u).faceoffs, u);
  // Twice is once, and the new site's own listed row is never moved.
  const again = await retireArchivedSite(db, A, { now: new Date(T0 + 26 * D), dryRun: true });
  assert.deepEqual(again.moved, {});
});

test("an archive return on day 200, after the purge took the old row: the votes and rating still move out of the way", async () => {
  const db = await world();
  await archive(db, T0 + 20 * D);
  const archived = await ratings(db, T0 + 20 * D);
  // The 30-day purge deleted the row and its screenshots; votes and tier_ratings stay (pipeline/roster.mjs purgeDelisted).
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [A] });
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = ? OR loser = ?", [A, A]), 5);
  const r = await retireArchivedSite(db, A, { now: new Date(T0 + 220 * D) });
  assert.equal(r.moved["portfolios.url"], undefined);
  assert.equal(r.moved["votes.winner"] + r.moved["votes.loser"], 5);
  const after = await ratings(db, T0 + 220 * D);
  for (const u of [B, C]) assert.deepEqual(after.get(u), archived.get(u), `${u} keeps its rating exactly`);
  await comeBack(db);
  await startsFresh(db);
});

test("the weekly export retires an archived site that passes its check; the old spelling's rows go too", async () => {
  const db = await world();
  await archive(db, T0 + 20 * D);
  // An older spelling of the same site, also off the list, with its own vote.
  await db.execute({ sql: "INSERT INTO portfolios (url, name, status, delisted_at) VALUES ('https://www.returning.example/', 'Old spelling', 'live', '2026-10-01')" });
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES ('https://www.returning.example/', ?, 'x', 'human', 'old', '2026-10-05')", args: [B] });
  const entry = { url: A, name: "Person", kind: "down", reason: "HTTP 402: deployment paused", removed: "2026-11-21" };
  const now = new Date(Date.parse("2026-12-01T12:00:00Z"));
  const ex = await weeklyExport({ db, excluded: [entry], feed: [], additions: [], answers: async () => true, now });
  assert.deepEqual(ex.plan.back, [A]);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url IN (?, 'https://www.returning.example/')", [A]), 0, "both spellings' rows moved");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE winner IN (?, 'https://www.returning.example/') OR loser IN (?, 'https://www.returning.example/')", [A, A]), 0);
  await comeBack(db);
  await startsFresh(db);
});
