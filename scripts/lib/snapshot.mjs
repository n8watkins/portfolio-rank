// The database snapshot behind the nightly backup (scripts/backup-db.mjs)
// and the restore (scripts/restore-db.mjs). Format 2 holds every table the
// site needs to be rebuilt, every column, and the schema itself (tables,
// indexes and triggers as SQLite stored them), so a restore recreates the
// database exactly, counters and their triggers included.
//
// Left out, on purpose:
//   cache     PageSpeed and inspect results with a TTL, and refresh leases:
//             refetched on demand.
//   matchups  the pair each rater was last served and their draw counts:
//             a few minutes of state, rebuilt on the next visit.
//   rate_limits  poll vote rate-limit windows: an hour of state.
//   grade_caps   the grader's daily cap counters: a day of state.
//   email_outbox emails kept by test runs instead of being sent.
//   badge_checks the last badge check per player: a minute of state, redone
//             from the tables it summarises.
//   email_signin_tokens  one-time sign-in links: 15 minutes of state, and
//             a backup has no use for a sign-in link.
// Everything else is in, including the polls (lib/polls/schema.mjs: polls,
// their totals, the vote rows behind the one-vote rule and the generation
// log), comparisons (the source of truth for
// ranking v2), likes and lists (people's own data), the Gemini request log
// and its daily roll-up, grade history, the end-of-day runs and the people
// queue. A table added later is included automatically.

export const SNAPSHOT_FORMAT = 2;
export const SKIP_TABLES = new Set(["cache", "matchups", "rate_limits", "grade_caps", "email_outbox", "badge_checks", "email_signin_tokens"]);

const internal = (name) => name.startsWith("sqlite_") || name.startsWith("libsql_") || name.startsWith("_litestream");

/** Every table to back up, with its CREATE statement, and the indexes and triggers. */
export async function schemaOf(db) {
  const rows = (await db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name")).rows;
  return rows
    .map((r) => ({ type: String(r.type), name: String(r.name), table: String(r.tbl_name), sql: String(r.sql) }))
    .filter((s) => !internal(s.name) && !internal(s.table) && !SKIP_TABLES.has(s.table));
}

/** The snapshot object: { format, exported_at, schema, tables: { name: { columns, rows } } }. */
export async function takeSnapshot(db, { now = new Date() } = {}) {
  const schema = await schemaOf(db);
  const tables = {};
  for (const t of schema.filter((s) => s.type === "table")) {
    const res = await db.execute(`SELECT * FROM "${t.name}"`);
    tables[t.name] = { columns: res.columns, rows: res.rows.map((r) => res.columns.map((c) => r[c] ?? null)) };
  }
  return { format: SNAPSHOT_FORMAT, exported_at: now.toISOString(), schema, tables };
}

/** "votes:12 ratings:3 ..." for the log line and the restore check. */
export const countsOf = (snap) => Object.fromEntries(Object.entries(snap.tables).map(([name, t]) => [name, t.rows.length]));

/**
 * A format 1 snapshot (votes, ratings and part of portfolios, before
 * 2026-11-10) as format 2, without a schema: the restore migrates first.
 */
export function upgradeSnapshot(snap) {
  if (snap.format === SNAPSHOT_FORMAT) return snap;
  const tables = {};
  for (const name of ["votes", "ratings", "portfolios"]) {
    const rows = snap[name] ?? [];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    tables[name] = { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
  }
  return { format: SNAPSHOT_FORMAT, exported_at: snap.exported_at, schema: [], tables };
}

/**
 * Loads a snapshot into an EMPTY database: the tables first, then every row
 * in batches, then the indexes and triggers (so the vote counters are
 * restored as saved, never counted a second time by their triggers).
 * `migrate` (lib/schema.mjs) runs afterwards when given, to add anything
 * newer than the snapshot. Returns the row counts written.
 */
export async function restoreSnapshot(db, raw, { migrate = null, batchSize = 200 } = {}) {
  const snap = upgradeSnapshot(raw);
  const existing = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name)).filter((n) => !internal(n));
  if (existing.length) throw new Error(`the target database is not empty (${existing.slice(0, 5).join(", ")}): restore only into a new, empty database`);
  const tables = snap.schema.filter((s) => s.type === "table");
  const rest = snap.schema.filter((s) => s.type !== "table");
  if (tables.length) await db.batch(tables.map((s) => s.sql), "write");
  else if (migrate) await migrate(db); // a format 1 snapshot carries no schema
  const counts = {};
  for (const [name, t] of Object.entries(snap.tables)) {
    const cols = t.columns.map((c) => `"${c}"`).join(", ");
    const marks = t.columns.map(() => "?").join(", ");
    for (let i = 0; i < t.rows.length; i += batchSize) {
      const part = t.rows.slice(i, i + batchSize).map((args) => ({ sql: `INSERT INTO "${name}" (${cols}) VALUES (${marks})`, args }));
      await db.batch(part, "write");
    }
    counts[name] = t.rows.length;
  }
  if (rest.length) await db.batch(rest.map((s) => s.sql), "write");
  if (migrate && tables.length) await migrate(db);
  return counts;
}
