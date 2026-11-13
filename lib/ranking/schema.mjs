// The rating engine's tables (lib/ranking/store.mjs), part of the main
// schema (lib/schema.mjs). Additive and idempotent; no imports, so the
// schema module can include them without loading the engine.
//
//   comparisons        every judgement, human or AI, with who judged, which
//                      model and prompt, the method, the order shown, the
//                      result and the time: the source of truth for the
//                      new boards (anyone can recompute them from it)
//   site_ratings       the current boards, one row per (view, site);
//                      shown_rank is the rank among the sites the app
//                      shows (assignShownRanks), so a page of the board
//                      is one indexed range read
//   rank_history       weekly rank snapshots per view, for rank movement
//   site_fingerprints  the last page fingerprint seen per site
//   rating_resets      uncertainty resets (a site's page changed)
//   ranking_runs       one row per recompute: when, settings, input digest
export const RANKING_TABLES = [
  `CREATE TABLE IF NOT EXISTS comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    rater_type TEXT NOT NULL,
    rater_id TEXT,
    model TEXT,
    prompt_version TEXT,
    rubric_version INTEGER,
    method TEXT NOT NULL,
    shown TEXT,
    ranking TEXT,
    outcome TEXT NOT NULL DEFAULT 'ranked',
    reason TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    experiment TEXT,
    match_seed TEXT,
    match_kind TEXT,
    run_id TEXT,
    source TEXT UNIQUE
  )`,
  "CREATE INDEX IF NOT EXISTS comparisons_time_idx ON comparisons (created_at, id)",
  "CREATE INDEX IF NOT EXISTS comparisons_rater_idx ON comparisons (rater_type, method, created_at)",
  `CREATE TABLE IF NOT EXISTS site_ratings (
    view TEXT NOT NULL,
    url TEXT NOT NULL,
    rank INTEGER NOT NULL,
    mu REAL NOT NULL,
    sigma REAL NOT NULL,
    confidence TEXT NOT NULL,
    tied_with_next INTEGER NOT NULL DEFAULT 0,
    comparisons INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    seed_mu REAL,
    seed_sigma REAL,
    seed_basis TEXT,
    tier TEXT,
    run_id INTEGER,
    PRIMARY KEY (view, url)
  )`,
  "CREATE INDEX IF NOT EXISTS site_ratings_rank_idx ON site_ratings (view, rank)",
  // The shown_rank index is in RANKING_AFTER, after its column.
  `CREATE TABLE IF NOT EXISTS rank_history (
    view TEXT NOT NULL,
    week TEXT NOT NULL,
    url TEXT NOT NULL,
    rank INTEGER NOT NULL,
    mu REAL NOT NULL,
    sigma REAL NOT NULL,
    PRIMARY KEY (view, week, url)
  )`,
  `CREATE TABLE IF NOT EXISTS site_fingerprints (
    url TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rating_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    at TEXT NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS rating_resets_url_idx ON rating_resets (url, at)",
  `CREATE TABLE IF NOT EXISTS ranking_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    settings TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    comparisons INTEGER NOT NULL,
    summary TEXT
  )`,
];

/** Columns added after a table was first created: [table, column definition]. */
export const RANKING_COLUMNS = [["site_ratings", "shown_rank INTEGER"]];

/** Indexes that need the columns above. */
export const RANKING_AFTER = ["CREATE INDEX IF NOT EXISTS site_ratings_shown_idx ON site_ratings (view, shown_rank)"];
