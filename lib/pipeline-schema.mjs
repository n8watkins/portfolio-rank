// The pipeline's tables (pipeline/*.mjs), part of the main schema
// (lib/schema.mjs), so every database has them from its first migration:
// production, staging, a fresh restore and the test runs. Additive and
// idempotent; no imports, so the schema module can include them without
// loading the pipeline.
//
// The pipeline's own ensure* helpers apply the same statements
// (applyTables below), so a job pointed at a database migrated before a
// table existed still works.
//
//   night_runs           one row per end-of-day run (pipeline/night.mjs)
//   night_item_failures  items that failed several nights in a row, then parked
//   owner_alerts         alerts for the owner, one email per condition per day (pipeline/alerts.mjs)
//   gemini_requests      every Gemini request, kept raw for 90 days (pipeline/gemini-log.mjs)
//   gemini_daily         older requests rolled up per day (pipeline/retention.mjs)
//   rubric_history       grades replaced by a newer one (pipeline/rubric-history.mjs)
//   people_requests      people's grade requests and their queue (pipeline/people.mjs)
//   model_watch_runs     the weekly Gemini model watch (pipeline/model-watch.mjs)

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
];

/** Every column the pipeline added after its table was created (lib/schema.mjs). */
export const PIPELINE_COLUMNS = [...GEMINI_LOG_COLUMNS, ...PIPELINE_PORTFOLIO_COLUMNS];

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
