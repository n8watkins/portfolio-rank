// The schema migration (lib/schema.mjs) on throwaway local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { SCHEMA_VERSION, migrate, recordedFingerprint, schemaFingerprint, schemaIsCurrent, schemaVersion } from "../lib/schema.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pr-schema-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (name) => createClient({ url: `file:${path.join(dir, name)}` });
const columns = async (db, table) =>
  (await db.execute({ sql: "SELECT name FROM pragma_table_info(?)", args: [table] })).rows.map((r) => String(r.name));

test("a fresh database gets every table and the current version, and a second run changes nothing", async () => {
  const db = fresh("fresh.db");
  assert.equal(await schemaVersion(db), 0);
  await migrate(db);
  assert.equal(await schemaVersion(db), SCHEMA_VERSION);
  for (const c of ["served", "claimed", "starred", "delta"]) assert.ok((await columns(db, "votes")).includes(c), c);
  assert.ok((await columns(db, "matchups")).includes("day_draws"));
  assert.deepEqual(await migrate(db), []);
});

test("a fresh database has every table any module creates", async () => {
  const db = fresh("all-tables.db");
  await migrate(db);
  const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name)));
  // Every CREATE TABLE in the code, wherever it is, must be in lib/schema.mjs,
  // so staging and a fresh restore have the tables production has.
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(mjs|ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const created = new Set();
  for (const f of ["lib", "pipeline", "worker", "app", "scripts"].flatMap(files)) {
    for (const m of readFileSync(f, "utf8").matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) created.add(m[1]);
  }
  for (const t of ["night_runs", "night_item_failures", "owner_alerts", "gemini_daily", "rubric_history", "comparisons"]) assert.ok(created.has(t), t);
  assert.deepEqual([...created].filter((t) => !tables.has(t)), []);
  for (const c of ["page_text", "facts", "facts_at"]) assert.ok((await columns(db, "portfolios")).includes(c), c);
  assert.ok((await columns(db, "site_ratings")).includes("shown_rank"));
  for (const c of ["thoughts_tokens", "finish_reason", "detail"]) assert.ok((await columns(db, "gemini_requests")).includes(c), c);
});

test("an older database gets the missing columns without losing rows", async () => {
  const db = fresh("old.db");
  await db.execute(`CREATE TABLE votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
    rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE matchups (rater_id TEXT PRIMARY KEY, pair_key TEXT, issued_at INTEGER,
    window_start INTEGER NOT NULL, draws INTEGER NOT NULL)`);
  await db.execute("INSERT INTO votes (winner, loser, rater_id) VALUES ('a', 'b', 'gh:1')");
  const added = await migrate(db);
  assert.ok(added.includes("votes.pair_key") && added.includes("votes.served") && added.includes("matchups.day_start"), added.join());
  const row = (await db.execute("SELECT winner, served, claimed FROM votes")).rows[0];
  assert.deepEqual([row.winner, Number(row.served), Number(row.claimed)], ["a", 0, 0]);
});

test("the fingerprint decides whether a database is current, whatever version number it records", async () => {
  const db = fresh("fingerprint.db");
  assert.equal(await schemaIsCurrent(db), false);
  assert.match(schemaFingerprint(), /^s[0-9a-f]{8}$/);
  await migrate(db);
  assert.equal(await recordedFingerprint(db), schemaFingerprint());
  assert.equal(await schemaIsCurrent(db), true);
  // Another branch's schema (a higher version, a different fingerprint) was
  // applied here: this file's schema is not current, and migrating again
  // keeps the higher version number instead of lowering it.
  await db.execute("UPDATE schema_meta SET v = 999 WHERE k = 'version'");
  await db.execute("UPDATE schema_meta SET v = 's00000000' WHERE k = 'fingerprint'");
  assert.equal(await schemaIsCurrent(db), false);
  await migrate(db);
  assert.equal(await schemaIsCurrent(db), true);
  assert.equal(await schemaVersion(db), Math.max(999, SCHEMA_VERSION));
});
