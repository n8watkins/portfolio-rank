// The database schema, applied by scripts/migrate.mjs at deploy time (before
// the new code serves) and by lib/db.ts ensureSchema() whenever a database is
// behind - a fresh local file, the end-to-end tests' throwaway database, or a
// deploy whose migration step didn't run. Plain JavaScript so both can import it.
//
// Changing the schema: add the statement or column below (only additive,
// idempotent changes), then bump SCHEMA_VERSION so every database applies it
// once. Applying is safe to repeat: tables and indexes use IF NOT EXISTS and
// an existing column is skipped.

export const SCHEMA_VERSION = 1;

/** Tables and indexes, in order. */
const CREATE = [
  // Append-only vote log: source of truth, ELO is recomputable from it.
  // pair_key = direction-independent matchup id (see lib/elo.pairKey).
  `CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winner TEXT NOT NULL,
    loser TEXT NOT NULL,
    pair_key TEXT,
    rater_type TEXT NOT NULL DEFAULT 'anon',
    rater_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS votes_rater_idx ON votes (rater_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ratings (
    url TEXT PRIMARY KEY,
    elo INTEGER NOT NULL DEFAULT 1200,
    votes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS ratings_elo_idx ON ratings (elo DESC)`,
  // Per-site pipeline state: gate result + capture artifacts + diagnostics.
  // Written by pipeline/capture.mjs; feed.json stays the roster source.
  `CREATE TABLE IF NOT EXISTS portfolios (
    url TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    shot_key TEXT,
    meta TEXT,
    checked_at TEXT,
    captured_at TEXT
  )`,
  // Generic diagnostics cache (inspect:<url>, psi:<url>).
  `CREATE TABLE IF NOT EXISTS cache (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // A "like" = a personal bookmark of a portfolio. Deliberately its own
  // table, separate from lists and from the ⭐ super-vote (lib/rater):
  // liking is a free, private signal that never touches ELO.
  `CREATE TABLE IF NOT EXISTS likes (
    rater_id TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (rater_id, url)
  )`,
  `CREATE INDEX IF NOT EXISTS likes_url_idx ON likes (url)`,
  `CREATE INDEX IF NOT EXISTS likes_rater_idx ON likes (rater_id, created_at)`,
  // Named, user-created collections. Every list gets a random slug so it
  // can be shared read-only at /list/<slug> when is_public = 1.
  `CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS lists_owner_idx ON lists (owner)`,
  // Membership rows: one (list_id, url) per entry, newest-first by added_at.
  `CREATE TABLE IF NOT EXISTS list_items (
    list_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (list_id, url)
  )`,
  `CREATE INDEX IF NOT EXISTS list_items_list_idx ON list_items (list_id, added_at)`,
  // The matchup most recently served to each rater (practice visitors too),
  // and how many they drew in the current hour and day: a vote must be for
  // this pair, and redrawing is capped so nobody can fish for a chosen site.
  `CREATE TABLE IF NOT EXISTS matchups (
    rater_id TEXT PRIMARY KEY,
    pair_key TEXT,
    issued_at INTEGER,
    window_start INTEGER NOT NULL,
    draws INTEGER NOT NULL,
    day_start INTEGER,
    day_draws INTEGER NOT NULL DEFAULT 0
  )`,
  // Which schema version this database has (see SCHEMA_VERSION).
  `CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
];

/** Columns added after a table was first created: [table, column definition]. */
const COLUMNS = [
  // Vote tables from before pair_key existed.
  ["votes", "pair_key TEXT"],
  // ELO points this vote moved, so undo reverts exactly what it applied.
  ["votes", "delta INTEGER"],
  // 1 for a Superstar super-vote (double weight, counts toward Most Loved).
  ["votes", "starred INTEGER NOT NULL DEFAULT 0"],
  // 1 for a practice vote converted at sign-in (/api/claim).
  ["votes", "claimed INTEGER NOT NULL DEFAULT 0"],
  // 1 when cast on the pair last drawn for its rater; only those can be claimed.
  ["votes", "served INTEGER NOT NULL DEFAULT 0"],
  // A list deleted moments ago, still restorable from the Undo toast.
  ["lists", "deleted_at TEXT"],
  // Written by the pipeline (pipeline/roster.mjs adds the same ones).
  ["portfolios", "ai_rubric TEXT"],
  ["portfolios", "delisted_at TEXT"],
  ["portfolios", "health TEXT"],
  ["portfolios", "health_reason TEXT"],
  ["portfolios", "health_fails INTEGER NOT NULL DEFAULT 0"],
  ["portfolios", "health_first_fail_at TEXT"],
  ["portfolios", "health_checked_at TEXT"],
  ["portfolios", "final_url TEXT"],
  ["portfolios", "capture_attempts INTEGER NOT NULL DEFAULT 0"],
  ["portfolios", "retry_at TEXT"],
  ["portfolios", "signals TEXT"],
  ["portfolios", "needs_review INTEGER NOT NULL DEFAULT 0"],
  ["matchups", "day_start INTEGER"],
  ["matchups", "day_draws INTEGER NOT NULL DEFAULT 0"],
];

/** Indexes that need the columns above. */
const AFTER = [
  // One vote per (rater, matchup), enforced by the database so concurrent
  // inserts can't slip past a check-then-insert race. NULL pair_keys (legacy
  // rows) are distinct under SQLite, so the index won't reject them.
  "CREATE UNIQUE INDEX IF NOT EXISTS votes_rater_pair_idx ON votes (rater_id, pair_key)",
];

/** The version recorded in this database; 0 when it has none yet. */
export async function schemaVersion(client) {
  try {
    const row = (await client.execute("SELECT v FROM schema_meta WHERE k = 'version'")).rows[0];
    return row ? Number(row.v) : 0;
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return 0;
    throw e;
  }
}

/** Brings a database up to SCHEMA_VERSION. Returns the columns it added. */
export async function migrate(client) {
  await client.batch(CREATE, "write");
  const added = [];
  for (const [table, column] of COLUMNS) {
    const name = column.split(" ")[0];
    const have = await client.execute({
      sql: "SELECT 1 FROM pragma_table_info(?) WHERE name = ?",
      args: [table, name],
    });
    if (have.rows.length > 0) continue;
    try {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      added.push(`${table}.${name}`);
    } catch (e) {
      // Another process added it between the check and the ALTER.
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  }
  for (const sql of AFTER) await client.execute(sql);
  await client.execute({
    sql: "INSERT INTO schema_meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    args: [SCHEMA_VERSION],
  });
  return added;
}
