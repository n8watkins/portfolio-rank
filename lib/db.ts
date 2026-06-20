import { createClient, type Client } from "@libsql/client";
import path from "path";

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), a local
// libSQL file in dev — same client, same SQL.
let client: Client | null = null;
let ready: Promise<void> | null = null;

export function db(): Client {
  if (!client) {
    client = process.env.TURSO_DATABASE_URL
      ? createClient({
          url: process.env.TURSO_DATABASE_URL,
          authToken: process.env.TURSO_AUTH_TOKEN,
        })
      : createClient({
          url: `file:${path.join(process.cwd(), "data", "portfoliorank.db")}`,
        });
  }
  return client;
}

export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db().batch(
        [
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
        ],
        "write"
      );
      // Migrate vote tables that predate pair_key (no-op once the column exists).
      try {
        await db().execute("ALTER TABLE votes ADD COLUMN pair_key TEXT");
      } catch {
        /* column already present */
      }
      // delta = ELO points this vote moved (winner +delta, loser -delta), stored
      // so a vote can be undone by reverting exactly what it applied.
      try {
        await db().execute("ALTER TABLE votes ADD COLUMN delta INTEGER");
      } catch {
        /* column already present */
      }
      // starred = 1 if this vote was a "Superstar" super-vote (double ELO weight).
      // Per-site ⭐ count and per-rater spend both derive from this column, so
      // deleting a vote (undo) cleanly removes its star too — no separate table.
      try {
        await db().execute(
          "ALTER TABLE votes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"
        );
      } catch {
        /* column already present */
      }
      // One vote per (rater, matchup), enforced by the DB so concurrent inserts
      // can't slip past a check-then-insert race. NULL pair_keys (legacy rows)
      // are distinct under SQLite, so the index won't reject them.
      await db().execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS votes_rater_pair_idx ON votes (rater_id, pair_key)"
      );
    })();
  }
  return ready;
}
