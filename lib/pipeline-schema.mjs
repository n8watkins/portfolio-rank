// The pipeline's tables (pipeline/*.mjs), part of the main schema
// (lib/schema.mjs), so every database has them from its first migration:
// production, a fresh restore and the test runs. Additive and
// idempotent; no imports, so the schema module can include them without
// loading the pipeline.
//
// The pipeline's own ensure* helpers apply the same statements
// (applyTables below), so a job pointed at a database migrated before a
// table existed still works.
//
//   night_runs           one row per end-of-day run (pipeline/night.mjs)
//   night_item_failures  items that failed several nights in a row, then parked
//   night_sites          the sites each night touched, for its summary (pipeline/night.mjs)
//   owner_alerts         alerts for the owner, one email per condition per day (pipeline/alerts.mjs)
//   gemini_requests      every Gemini request, kept raw for 90 days (pipeline/gemini-log.mjs)
//   gemini_daily         older requests rolled up per day (pipeline/retention.mjs)
//   rubric_history       grades replaced by a newer one (pipeline/rubric-history.mjs)
//   people_requests      people's grade requests and their queue (pipeline/people.mjs)
//   model_watch_runs     the weekly Gemini model watch (pipeline/model-watch.mjs)
//   health_marks         the health check's last counted failure and weeks it could not tell (pipeline/health.mjs),
//                        and the not-working pool's ladder and re-check times (pipeline/not-working.mjs)
//   health_returns       sites back from the temporary pool or the archive (pipeline/not-working.mjs)
//   capture_changes      re-captures that lost a portfolio sign or most of the text (lib/capture-problems.mjs)

export const NIGHT_TABLES = [
  `CREATE TABLE IF NOT EXISTS night_runs (
    night TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    run_id TEXT,
    summary TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS night_item_failures (
    job TEXT NOT NULL,
    item TEXT NOT NULL,
    nights INTEGER NOT NULL,
    last_night TEXT NOT NULL,
    reason TEXT,
    parked_at TEXT,
    PRIMARY KEY (job, item)
  )`,
  // The sites a night touched: one row per (night, stage, site) with that site's final outcome in the
  // stage as summary list entries (JSON [[list, entry]]), written as each happens so the summary
  // comes from what was written even when a Workflow step is retried (pipeline/night.mjs
  // recordSites). Pruned by pipeline/retention.mjs (NIGHT_SITES_DAYS).
  `CREATE TABLE IF NOT EXISTS night_sites (
    night TEXT NOT NULL,
    stage TEXT NOT NULL,
    url TEXT NOT NULL,
    entries TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (night, stage, url)
  )`,
];

export const ALERT_TABLES = [
  `CREATE TABLE IF NOT EXISTS owner_alerts (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_sent_day TEXT,
    sends INTEGER NOT NULL DEFAULT 0,
    cleared_at TEXT
  )`,
];

/**
 * owner_alerts columns added later. sent_title: the title of the last email
 * actually sent for the key, so a condition can tell what the owner was last
 * told (lib/capture-problems.mjs emails only when a count rose since then).
 */
export const ALERT_COLUMNS = [["owner_alerts", "sent_title TEXT"]];

export const GEMINI_LOG_TABLES = [
  `CREATE TABLE IF NOT EXISTS gemini_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    run_id TEXT,
    job TEXT,
    model TEXT NOT NULL,
    status INTEGER,
    reason TEXT,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    retry INTEGER NOT NULL DEFAULT 0,
    fallback INTEGER NOT NULL DEFAULT 0,
    thoughts_tokens INTEGER,
    finish_reason TEXT,
    detail TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS gemini_requests_at_idx ON gemini_requests (at)",
];

/** Columns added to gemini_requests after it was first created: thinking tokens, then the finish reason and the error detail. */
export const GEMINI_LOG_COLUMNS = [
  ["gemini_requests", "thoughts_tokens INTEGER"],
  ["gemini_requests", "finish_reason TEXT"],
  ["gemini_requests", "detail TEXT"],
  // The prompt id and version the request builder sets, such as "grade-v2".
  ["gemini_requests", "prompt TEXT"],
  // The site (its URL) a request was for, where the stage works on sites (pipeline/night.mjs).
  ["gemini_requests", "item TEXT"],
];

export const GEMINI_DAILY_TABLES = [
  `CREATE TABLE IF NOT EXISTS gemini_daily (
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    job TEXT NOT NULL,
    outcome TEXT NOT NULL,
    requests INTEGER NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    thoughts_tokens INTEGER NOT NULL DEFAULT 0,
    latency_p50 INTEGER,
    latency_p95 INTEGER,
    PRIMARY KEY (day, model, job, outcome)
  )`,
];

export const RUBRIC_HISTORY_TABLES = [
  `CREATE TABLE IF NOT EXISTS rubric_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    model TEXT,
    tier TEXT,
    is_portfolio INTEGER,
    rubric TEXT NOT NULL,
    judged_at TEXT,
    replaced_at TEXT NOT NULL,
    replaced_by_model TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS rubric_history_url_idx ON rubric_history (url)",
];

export const PEOPLE_TABLES = [
  `CREATE TABLE IF NOT EXISTS people_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT,
    email TEXT,
    shot_key TEXT,
    page_text TEXT,
    facts TEXT,
    meta TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT,
    result TEXT,
    notified_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS people_requests_status_idx ON people_requests (status, created_at)",
];

export const MODEL_WATCH_TABLES = [
  `CREATE TABLE IF NOT EXISTS model_watch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT NOT NULL,
    status TEXT NOT NULL,
    changes INTEGER NOT NULL DEFAULT 0,
    snapshot TEXT NOT NULL,
    report TEXT NOT NULL
  )`,
];

/**
 * The health check's own memory per site (pipeline/health.mjs): when its
 * last counted failure was, and how long it could not tell (handed to the
 * owner after UNKNOWN_DAYS_TO_OWNER days); and the log of sites that came
 * back from the temporary pool or the archive.
 */
export const HEALTH_TABLES = [
  `CREATE TABLE IF NOT EXISTS health_marks (
    url TEXT PRIMARY KEY,
    last_fail_at TEXT,
    unknown_weeks INTEGER NOT NULL DEFAULT 0,
    unknown_last_at TEXT
  )`,
  // Sites that came back (pipeline/not-working.mjs): from the temporary pool (a check passed while it was
  // failing) or from the archive (the monthly check passed). Kept RETURNS_KEEP_DAYS for the owner's
  // Health pool page, and read by the bot-wall rule (lib/reviews/door.mjs): a bot-walled site that failed
  // a real check and came back is asked about once more. Not tied to portfolios: an archived site's row
  // may be gone.
  `CREATE TABLE IF NOT EXISTS health_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    at TEXT NOT NULL,
    from_where TEXT NOT NULL,
    reason TEXT,
    since TEXT,
    hidden INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS health_returns_url_idx ON health_returns (url, at)",
];

/**
 * The not-working pool's ladder per site (pipeline/not-working.mjs), kept in
 * health_marks beside the weekly check's memory: pool_stage (1 failed once,
 * 2 failed its first re-check, 3 not working), pool_started_at (the first
 * failure of this run of failures), pool_next_at (when the hourly re-check
 * looks next; NULL when none is scheduled) and pool_since (when the site
 * became not working). All NULL for a site that is not failing. And
 * unknown_since: when the check started being unable to tell (the owner's
 * alert comes after a number of days, not of runs).
 */
export const HEALTH_COLUMNS = [
  ["health_marks", "unknown_since TEXT"],
  ["health_marks", "pool_stage INTEGER"],
  ["health_marks", "pool_started_at TEXT"],
  ["health_marks", "pool_next_at TEXT"],
  ["health_marks", "pool_since TEXT"],
  // The row's health and health_checked_at when the marks were written: the marks count only while both
  // still match (pipeline/not-working.mjs VALID_MARKS), so a writer that knows nothing of the pool voids them.
  ["health_marks", "pool_health TEXT"],
  ["health_marks", "pool_checked_at TEXT"],
  // Re-checks in a row that could not tell: the next waits 1 h, 2 h, 4 h ... up to a day.
  ["health_marks", "pool_unclear INTEGER NOT NULL DEFAULT 0"],
  // 1 when a write took the profile away, 2 when it came back, until the cached copies agree (worker/index.ts).
  ["health_marks", "purge_pending INTEGER NOT NULL DEFAULT 0"],
  // Where the site answers when its listed address failed and the address it ended at before passed
  // (pipeline/health.mjs sameSiteAddress); NULL once the listed address passes on its own.
  ["health_marks", "answers_at TEXT"],
];

/**
 * Need the columns above (and portfolios): the hourly re-check reads only the
 * scheduled rows, the hourly purge only the pending ones, and a site's marks
 * go with its row when the 30-day purge deletes it (pipeline/roster.mjs
 * purgeDelisted), so a site listed again starts clean.
 */
export const HEALTH_AFTER = [
  "CREATE INDEX IF NOT EXISTS health_marks_pool_next_idx ON health_marks (pool_next_at) WHERE pool_next_at IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS health_marks_purge_idx ON health_marks (url) WHERE purge_pending > 0",
  `CREATE TRIGGER IF NOT EXISTS health_marks_follow_purge AFTER DELETE ON portfolios BEGIN
    DELETE FROM health_marks WHERE url = OLD.url;
  END`,
];

/**
 * A re-capture that made a site's stored capture worse (lib/capture-problems.mjs,
 * the admin's Capture problems page, group D): written by pipeline/capture.mjs
 * when a new good capture replaces an older one and lost a portfolio sign the
 * old one had (resume, github, contact in portfolios.facts), or its stored
 * text fell under TEXT_DROP_RATIO of an old text over TEXT_DROP_MIN_OLD
 * characters. One open row per site (cleared_at NULL) until a later capture
 * gets the sign or the text back. `measuring` = 1 marks a change that came
 * with a new facts version (facts.v): the measuring code changed, not the
 * site, so it is shown apart and never counted. Times are milliseconds;
 * captured_at is the new capture's, as portfolios stores it.
 */
export const CAPTURE_CHANGE_TABLES = [
  `CREATE TABLE IF NOT EXISTS capture_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    at INTEGER NOT NULL,
    captured_at TEXT,
    old_v INTEGER,
    new_v INTEGER,
    old_signs TEXT NOT NULL,
    new_signs TEXT NOT NULL,
    old_chars INTEGER,
    new_chars INTEGER,
    lost TEXT NOT NULL,
    measuring INTEGER NOT NULL DEFAULT 0,
    cleared_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS capture_changes_open_idx ON capture_changes (url, cleared_at)",
  // A site's records go with its row when the 30-day purge deletes it, like its health marks.
  `CREATE TRIGGER IF NOT EXISTS capture_changes_follow_purge AFTER DELETE ON portfolios BEGIN
    DELETE FROM capture_changes WHERE url = OLD.url;
  END`,
  // The nightly capture-problems alert's memory (lib/capture-problems.mjs alertBaseline), one row:
  // `low` the lowest count per group since the last email (JSON), `sends` owner_alerts.sends when it was written.
  `CREATE TABLE IF NOT EXISTS capture_problem_alert (
    k TEXT PRIMARY KEY,
    low TEXT NOT NULL,
    sends INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  )`,
];

/**
 * portfolios columns only the pipeline reads (lib/schema.mjs has the ones the
 * app reads): the page's visible text (capped, pipeline/rubric.mjs
 * PAGE_TEXT_MAX) and the facts measured by code (pipeline/facts.mjs), both
 * input to the AI grade.
 */
export const PIPELINE_PORTFOLIO_COLUMNS = [
  ["portfolios", "page_text TEXT"],
  ["portfolios", "facts TEXT"],
  ["portfolios", "facts_at TEXT"],
];

/** Every pipeline table and index, in order (lib/schema.mjs). */
export const PIPELINE_TABLES = [
  ...NIGHT_TABLES,
  ...ALERT_TABLES,
  ...GEMINI_LOG_TABLES,
  ...GEMINI_DAILY_TABLES,
  ...RUBRIC_HISTORY_TABLES,
  ...PEOPLE_TABLES,
  ...MODEL_WATCH_TABLES,
  ...HEALTH_TABLES,
  ...CAPTURE_CHANGE_TABLES,
];

/** Every column the pipeline added after its table was created (lib/schema.mjs). */
export const PIPELINE_COLUMNS = [...ALERT_COLUMNS, ...GEMINI_LOG_COLUMNS,...PIPELINE_PORTFOLIO_COLUMNS, ...HEALTH_COLUMNS];

/** Every pipeline index that needs a column above (lib/schema.mjs runs them after the columns). */
export const PIPELINE_AFTER = [...HEALTH_AFTER];

/**
 * Applies `tables` (CREATE ... IF NOT EXISTS) and then `columns`
 * ([table, definition], skipped when present) to `db`: what each pipeline
 * job's ensure* helper runs before it touches its tables.
 * @param {{ execute: Function }} db
 * @param {string[]} tables
 * @param {[string, string][]} [columns]
 */
export async function applyTables(db, tables, columns = []) {
  for (const sql of tables) await db.execute(sql);
  const have = new Map();
  for (const [table, column] of columns) {
    if (!have.has(table)) {
      have.set(table, new Set((await db.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name))));
    }
    const name = column.split(" ")[0];
    if (have.get(table).has(name)) continue;
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (e) {
      // Another job added it between the check and the ALTER.
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
    have.get(table).add(name);
  }
}
