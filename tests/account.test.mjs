// lib/account.mjs: an account's data downloads whole and deletes at once,
// leaving other people's rows and the anonymous totals alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { accountData, deleteAccount, gradeShotKeys } from "../lib/account.mjs";
import { ensurePeopleSchema } from "../pipeline/people.mjs";

const ME = "gh:101";
const YOU = "gh:202";

async function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  await ensureRankingSchema(db);
  const now = new Date().toISOString();
  for (const who of [ME, YOU]) {
    await db.batch(
      [
        { sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('https://a.dev', 'https://b.dev', 'k', 'human', ?)", args: [who] },
        { sql: "INSERT INTO likes (rater_id, url) VALUES (?, 'https://a.dev')", args: [who] },
        { sql: "INSERT INTO lists (owner, name, slug) VALUES (?, 'Faves', ?)", args: [who, `s-${who}`] },
        { sql: "INSERT INTO list_items (list_id, url) SELECT id, 'https://a.dev' FROM lists WHERE owner = ?", args: [who] },
        { sql: "INSERT INTO matchups (rater_id, pair_key, issued_at, window_start, draws) VALUES (?, 'k', 1, 1, 1)", args: [who] },
        { sql: "INSERT INTO badges (player, badge, earned_at) VALUES (?, 'vote', ?)", args: [who, now] },
        { sql: "INSERT INTO player_counters (player, k, n) VALUES (?, 'shares', 2)", args: [who] },
        { sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES ('https://a.dev', ?, 'me', 'verified', 't', ?, ?)", args: [who, now, now] },
        { sql: "INSERT INTO claim_log (at, url, actor, action) VALUES (?, 'https://a.dev', ?, 'verify')", args: [now, who] },
      ],
      "write"
    );
  }
  await db.execute("INSERT OR REPLACE INTO vote_totals (k, n) VALUES ('all', 2)");
  return db;
}

const count = async (db, sql, args) => Number((await db.execute({ sql, args })).rows[0].n);

test("download: everything held about the account, nobody else's", async () => {
  const db = await seeded();
  const data = await accountData(db, ME, { login: "me" });
  assert.equal(data.account.id, ME);
  for (const t of ["votes", "likes", "lists", "list_items", "matchups", "badges", "player_counters", "claims", "claim_log"]) assert.equal(data.tables[t]?.length, 1, t);
  assert.ok(!JSON.stringify(data).includes(YOU));
});

test("delete: the account's rows are gone in one go; others stay; audit rows lose the name", async () => {
  const db = await seeded();
  const totals = await db.execute("SELECT k, n FROM vote_totals ORDER BY k");
  const deleted = await deleteAccount(db, ME);
  assert.equal(deleted.votes, 1);
  for (const [table, col] of [
    ["votes", "rater_id"],
    ["likes", "rater_id"],
    ["lists", "owner"],
    ["matchups", "rater_id"],
    ["badges", "player"],
    ["player_counters", "player"],
    ["claims", "owner"],
    ["claim_log", "actor"],
  ]) {
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [ME]), 0, table);
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [YOU]), 1, `${table} (someone else)`);
  }
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM list_items", []), 1, "only the other list's item");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM claim_log WHERE actor = 'deleted-account'", []), 1);
  // The running vote count follows the log (a trigger), so it drops the deleted vote.
  assert.equal(await count(db, "SELECT n FROM vote_totals WHERE k = 'all'", []), Number(totals.rows.find((r) => r.k === "all").n) - 1);
  assert.deepEqual((await accountData(db, ME)).tables, {});
  await assert.rejects(deleteAccount(db, "anon:x"), /not an account id/);
});

// The grader keys a signed-in request by an HMAC of the account id (lib/grader/server.ts keyed).
const MY_VISITOR = "kMyVisitorHash000000a";
const YOUR_VISITOR = "kYourVisitorHash00000b";

async function withGrades(db) {
  await ensurePeopleSchema(db);
  const now = new Date().toISOString();
  for (const [job, visitor] of [["job-me", MY_VISITOR], ["job-you", YOUR_VISITOR]]) {
    await db.batch(
      [
        { sql: "INSERT INTO grade_jobs (id, url, site_key, status, visitor, network, shot_key, created_at, updated_at) VALUES (?, 'https://me.dev', 'me.dev', 'done', ?, 'net', ?, ?, ?)", args: [job, visitor, `private/grades/${job}`, now, now] },
        { sql: "INSERT INTO grade_emails (job_id, email, email_hash, status, created_at) VALUES (?, 'a@example.com', ?, 'waiting', ?)", args: [job, `h-${job}`, now] },
        { sql: "INSERT INTO grade_links (nonce_hash, job_id, expires_at) VALUES (?, ?, ?)", args: [`n-${job}`, job, now] },
        { sql: "INSERT INTO people_requests (kind, url, email, meta, status, created_at, updated_at) VALUES ('grade', 'https://me.dev', 'a@example.com', ?, 'queued', ?, ?)", args: [JSON.stringify({ grade_job: job }), now, now] },
      ],
      "write"
    );
  }
  // An owner's re-grade request, not a grade job's: never the account's to delete.
  await db.execute({ sql: "INSERT INTO people_requests (kind, url, meta, status, created_at, updated_at) VALUES ('regrade', 'https://me.dev', 'not json', 'queued', ?, ?)", args: [now, now] });
}

test("download and delete: grade requests made while signed in are the account's too", async () => {
  const db = await seeded();
  await withGrades(db);
  const data = await accountData(db, ME, { gradeVisitor: MY_VISITOR });
  for (const t of ["grade_jobs", "grade_emails", "grade_links", "people_requests"]) assert.equal(data.tables[t]?.length, 1, t);
  assert.equal(data.tables.grade_jobs[0].id, "job-me");
  assert.ok(!JSON.stringify(data).includes("job-you"));

  // The screenshots to delete from the bucket, read before the rows go.
  assert.deepEqual(await gradeShotKeys(db, MY_VISITOR), ["private/grades/job-me"]);
  const deleted = await deleteAccount(db, ME, { gradeVisitor: MY_VISITOR });
  assert.equal(deleted.grade_jobs, 1);
  for (const [table, col] of [
    ["grade_jobs", "id"],
    ["grade_emails", "job_id"],
    ["grade_links", "job_id"],
    ["people_requests", "CASE WHEN json_valid(meta) THEN json_extract(meta, '$.grade_job') END"],
  ]) {
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'job-me'`, []), 0, table);
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'job-you'`, []), 1, `${table} (someone else)`);
  }
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM people_requests WHERE kind = 'regrade'", []), 1);
  assert.deepEqual((await accountData(db, ME, { gradeVisitor: MY_VISITOR })).tables, {});
});

test("delete: Most Loved star counts drop the deleted account's starred votes", async () => {
  const db = await seeded();
  await db.batch(
    [
      { sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES ('https://c.dev', 'https://b.dev', 'k2', 'human', ?, 1)", args: [ME] },
      { sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES ('https://c.dev', 'https://a.dev', 'k3', 'human', ?, 1)", args: [YOU] },
    ],
    "write"
  );
  assert.equal(await count(db, "SELECT n FROM star_counts WHERE url = 'https://c.dev'", []), 2);
  await deleteAccount(db, ME);
  assert.equal(await count(db, "SELECT n FROM star_counts WHERE url = 'https://c.dev'", []), 1);
});
