// Per-source watermarks for the discovery pipeline (docs/DISCOVERY.md): one
// row in discovery_sources per source, holding where its last run stopped
// (a GitHub created date, a Hacker News comment time, a list's commit) as
// JSON, and when the source was last read.
//
// The order that makes a run crash-safe: read the source from its cursor,
// write a discovery_sites row for every new site (lib/discovery/sites.mjs
// addFound), and only then moveWatermark. A run that dies in between reads
// the same items again next time, and the seen-set skips the ones written.

/** The source's cursor (parsed JSON) and when it was last read, or nulls for a source never read. */
export async function readWatermark(db, source) {
  const r = await db.execute({ sql: "SELECT cursor, read_at FROM discovery_sources WHERE source = ?", args: [source] });
  const row = r.rows[0];
  if (!row) return { cursor: null, readAt: null };
  let cursor = null;
  try {
    cursor = row.cursor == null ? null : JSON.parse(String(row.cursor));
  } catch {
    cursor = null;
  }
  return { cursor, readAt: row.read_at == null ? null : String(row.read_at) };
}

/** Saves the source's new cursor and the time it was read. Call it last, after the rows are written. */
export async function moveWatermark(db, source, cursor, { now = new Date() } = {}) {
  const at = now.toISOString();
  await db.execute({
    sql: `INSERT INTO discovery_sources (source, cursor, read_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, read_at = excluded.read_at, updated_at = excluded.updated_at`,
    args: [source, JSON.stringify(cursor), at, at],
  });
}

/** True when a source last read at `readAt` is due again after `everyDays` (a source never read is due). */
export function isDue(readAt, everyDays, now = new Date()) {
  if (!readAt) return true;
  const t = Date.parse(readAt);
  // A little slack, so a daily job that starts a few minutes early still reads a weekly source on day 7.
  return !Number.isFinite(t) || now.getTime() - t >= everyDays * 86400000 - 3600000;
}
