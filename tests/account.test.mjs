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
import { accountData, deleteAccount } from "../lib/account.mjs";

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
