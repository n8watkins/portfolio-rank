// The polls tables (owner decision 2026-11-10, docs/DECISIONS.md "Polls").
// lib/schema.mjs applies them with the rest of the schema; the end-of-day
// run (pipeline/night.mjs) applies them too, so a night never meets a
// database without them. Only additive, idempotent statements.
//
//   polls             one row a poll; each poll owns one Pacific week
//                     (Monday 00:00 to the next Monday 00:00), id = that
//                     Monday "YYYY-MM-DD"
//   poll_options      the choices; `votes` is the running total, kept by a
//                     trigger in the same transaction as each vote, so
//                     reading results never scans poll_votes
//   poll_votes        one row per vote, only for the one-vote rule: never
//                     returned by any API; pruned 30 days after a poll
//                     closes (docs/COSTS.md section C, item 8), the totals
//                     stay in poll_options
//   poll_generations  every nightly attempt to write polls with Gemini, for
//                     the weekly request cap and the admin view
//   rate_limits       fixed-window counters (key -> window start, count)
export const POLL_TABLES = [
  `CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    question TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    topic TEXT,
    opens_at TEXT NOT NULL,
    closes_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    source TEXT NOT NULL,
    generation_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS polls_opens_idx ON polls (opens_at)`,
  `CREATE TABLE IF NOT EXISTS poll_options (
    poll_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    label TEXT NOT NULL,
    portfolio_url TEXT,
    votes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (poll_id, idx)
  )`,
  `CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL,
    voter TEXT NOT NULL,
    browser TEXT NOT NULL,
    option_idx INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  // One vote per person: per signed-in account (or practice id), and per
  // browser (the signed cookie), whichever is hit first.
  `CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_voter_idx ON poll_votes (poll_id, voter)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_browser_idx ON poll_votes (poll_id, browser)`,
  `CREATE TRIGGER IF NOT EXISTS poll_votes_count AFTER INSERT ON poll_votes BEGIN
     UPDATE poll_options SET votes = votes + 1 WHERE poll_id = NEW.poll_id AND idx = NEW.option_idx;
   END`,
  `CREATE TABLE IF NOT EXISTS poll_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    night TEXT NOT NULL,
    at TEXT NOT NULL,
    model TEXT,
    requests INTEGER NOT NULL DEFAULT 0,
    proposed INTEGER NOT NULL DEFAULT 0,
    accepted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS poll_generations_at_idx ON poll_generations (at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    k TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    n INTEGER NOT NULL
  )`,
];

/** Creates the polls tables when missing (safe to repeat). */
export async function ensurePollsSchema(db) {
  await db.batch(POLL_TABLES, "write");
}
