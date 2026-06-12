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
    ready = db()
      .batch(
        [
          // Append-only vote log: source of truth, ELO is recomputable from it.
          `CREATE TABLE IF NOT EXISTS votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            winner TEXT NOT NULL,
            loser TEXT NOT NULL,
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
          // Generic diagnostics cache (inspect:<url>, psi:<url>).
          `CREATE TABLE IF NOT EXISTS cache (
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL,
            at INTEGER NOT NULL
          )`,
        ],
        "write"
      )
      .then(() => {});
  }
  return ready;
}
