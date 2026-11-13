// The tier tables (lib/tiers-db.mjs), part of the main schema (lib/schema.mjs).
// Additive and idempotent; no imports, so the schema module can include them
// without loading the rating engine.

/** A portfolio row (NEW) belongs in the library: listed, not down, graded by Gemini, and a portfolio. */
const MEMBER_SQL = `(CASE WHEN NEW.delisted_at IS NULL AND COALESCE(NEW.health, '') != 'down'
  AND json_valid(NEW.ai_rubric) AND json_extract(NEW.ai_rubric, '$.tier') IS NOT NULL AND json_extract(NEW.ai_rubric, '$.error') IS NULL
  AND COALESCE(json_extract(NEW.ai_rubric, '$.is_portfolio'), 1) != 0 THEN 1 ELSE 0 END)`;

export const TIER_SCHEMA = [
  // One row per portfolio with a rating: library members (listed, graded, a portfolio) and any other site with face-offs.
  `CREATE TABLE IF NOT EXISTS tier_ratings (
    url TEXT PRIMARY KEY,
    mu REAL NOT NULL,
    sigma REAL NOT NULL,
    rating REAL NOT NULL,
    bucket INTEGER NOT NULL,
    faceoffs REAL NOT NULL DEFAULT 0,
    votes INTEGER NOT NULL DEFAULT 0,
    member INTEGER NOT NULL DEFAULT 0,
    seeded INTEGER NOT NULL DEFAULT 0,
    points REAL,
    gkey INTEGER,
    first REAL,
    tier TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`,
  // The board's order and the cutoffs' range reads.
  "CREATE INDEX IF NOT EXISTS tier_ratings_rank_idx ON tier_ratings (member, rating DESC)",
  // A cutoff's place inside its histogram bucket.
  "CREATE INDEX IF NOT EXISTS tier_ratings_bucket_idx ON tier_ratings (member, bucket, rating DESC)",
  // The portfolios that got votes since the last daily run.
  "CREATE INDEX IF NOT EXISTS tier_ratings_dirty_idx ON tier_ratings (dirty) WHERE dirty = 1",
  // Members per rating bucket, kept by the triggers below: the daily run reads this, never the whole table.
  "CREATE TABLE IF NOT EXISTS tier_hist (bucket INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
  `CREATE TRIGGER IF NOT EXISTS tier_hist_ins AFTER INSERT ON tier_ratings WHEN NEW.member = 1 BEGIN
     INSERT INTO tier_hist (bucket, n) VALUES (NEW.bucket, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_hist_del AFTER DELETE ON tier_ratings WHEN OLD.member = 1 BEGIN
     UPDATE tier_hist SET n = n - 1 WHERE bucket = OLD.bucket;
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_hist_out AFTER UPDATE OF bucket, member ON tier_ratings
     WHEN OLD.member = 1 AND (NEW.member != 1 OR NEW.bucket != OLD.bucket) BEGIN
     UPDATE tier_hist SET n = n - 1 WHERE bucket = OLD.bucket;
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_hist_in AFTER UPDATE OF bucket, member ON tier_ratings
     WHEN NEW.member = 1 AND (OLD.member != 1 OR NEW.bucket != OLD.bucket) BEGIN
     INSERT INTO tier_hist (bucket, n) VALUES (NEW.bucket, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1;
   END`,
  // The daily run's cutoffs and histogram, read by every page that shows a tier.
  "CREATE TABLE IF NOT EXISTS tier_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)",
  // What each person's vote changed, so Undo can take it back.
  "CREATE TABLE IF NOT EXISTS tier_undo (vote_id INTEGER PRIMARY KEY, w TEXT NOT NULL, l TEXT NOT NULL)",
];

/**
 * Membership follows the portfolio at once: delisted, marked down or graded "not a portfolio" leaves the library
 * (and so the histogram and the cutoffs); recovering brings a site with a starting rank back. The same test as
 * the rebuild's library (pipeline/roster.mjs ACTIVE and NOT_PORTFOLIO, a usable grade). The next daily run
 * rewrites its letter (dirty). Only where the app's portfolios table exists.
 */
export const MEMBER_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS tier_member_sync AFTER UPDATE OF delisted_at, health, ai_rubric ON portfolios BEGIN
     UPDATE tier_ratings SET member = ${MEMBER_SQL}, dirty = 1, updated_at = datetime('now')
     WHERE url = NEW.url AND seeded = 1 AND member != ${MEMBER_SQL};
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_member_gone AFTER DELETE ON portfolios BEGIN
     UPDATE tier_ratings SET member = 0, dirty = 1 WHERE url = OLD.url AND member = 1;
   END`,
];
