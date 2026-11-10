// The games, badges, claims and report-link tables (owner decisions
// 2026-11-10, docs/DECISIONS.md "Games, badges and claims"). lib/schema.mjs
// applies them with the rest of the schema. Only additive, idempotent
// statements.
//
// A "player" is whoever plays: the signed-in account (gh:<id>) or, for a
// guest, the signed practice cookie's id (anon:<uuid>). A guest's rows move
// to the account at sign-in (lib/games/merge.mjs).
//
//   quizzes          one row a quiz: the Daily 5 ("daily-YYYY-MM-DD", Pacific)
//                    or a random quiz (a short random id); `urls` is the five
//                    portfolios in order, so a challenge link replays them
//   quiz_plays       one row per (quiz, player): started at the first guess,
//                    finished (score, hits) at the fifth
//   quiz_guesses     one row per guess, with the percentiles in each view at
//                    the moment of the guess (for scoring and "your eye")
//   game_totals      site-wide counters (k -> n), e.g. quizzes finished
//   player_counters  per-player counters with no other source of truth
//                    (grades requested, shares)
//   player_visits    portfolios a player opened, up to the Explorer target
//   gem_watch        a saved site's merged percentile when the badge check
//                    first saw it saved (for Hidden gem)
//   badges           earned badges; `notified` once the player was told
//   badge_checks     the last badge check per player: its counters and eye
//                    stats, so repeated reads within a minute cost one row
//   claims           a GitHub account's claim on a portfolio and how it was
//                    verified; status pending | review | verified | rejected
//   claim_log        audit log of claims, reviews and owner actions
//   portfolio_owner  what a verified owner chose: grade hidden, removal
//   regrade_requests re-grades asked for by owners, for the grade service
//   report_links     one-time report links sent by email (hash of the token)
export const GAME_TABLES = [
  `CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    day TEXT,
    urls TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quiz_plays (
    quiz_id TEXT NOT NULL,
    player TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    score INTEGER,
    hits INTEGER,
    PRIMARY KEY (quiz_id, player)
  )`,
  `CREATE INDEX IF NOT EXISTS quiz_plays_player_idx ON quiz_plays (player, started_at)`,
  `CREATE TABLE IF NOT EXISTS quiz_guesses (
    quiz_id TEXT NOT NULL,
    player TEXT NOT NULL,
    idx INTEGER NOT NULL,
    url TEXT NOT NULL,
    guess INTEGER NOT NULL,
    merged INTEGER,
    ai INTEGER,
    people INTEGER,
    points INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (quiz_id, player, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS quiz_guesses_player_idx ON quiz_guesses (player, created_at)`,
  `CREATE TABLE IF NOT EXISTS game_totals (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS player_counters (
    player TEXT NOT NULL,
    k TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (player, k)
  )`,
  `CREATE TABLE IF NOT EXISTS player_visits (
    player TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (player, url)
  )`,
  `CREATE TABLE IF NOT EXISTS gem_watch (
    player TEXT NOT NULL,
    url TEXT NOT NULL,
    pct INTEGER,
    PRIMARY KEY (player, url)
  )`,
  `CREATE TABLE IF NOT EXISTS badges (
    player TEXT NOT NULL,
    badge TEXT NOT NULL,
    earned_at TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player, badge)
  )`,
  `CREATE TABLE IF NOT EXISTS badge_checks (
    player TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    counters TEXT NOT NULL,
    eye TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    owner TEXT NOT NULL,
    login TEXT NOT NULL,
    status TEXT NOT NULL,
    method TEXT,
    token TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS claims_url_owner_idx ON claims (url, owner)`,
  `CREATE INDEX IF NOT EXISTS claims_owner_idx ON claims (owner)`,
  `CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS claim_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    url TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS claim_log_url_idx ON claim_log (url, at)`,
  `CREATE TABLE IF NOT EXISTS portfolio_owner (
    url TEXT PRIMARY KEY,
    hide_grade INTEGER NOT NULL DEFAULT 0,
    removed_at TEXT,
    removed_by TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS regrade_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    done_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS regrade_requests_status_idx ON regrade_requests (status, requested_at)`,
  `CREATE TABLE IF NOT EXISTS report_links (
    token_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  // "Votes today" on the live stats reads only today's rows.
  `CREATE INDEX IF NOT EXISTS votes_created_idx ON votes (created_at)`,
];

/** Creates the games tables when missing (safe to repeat). */
export async function ensureGamesSchema(db) {
  await db.batch(GAME_TABLES, "write");
}
