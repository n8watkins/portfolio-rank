// Visitors' "Report a problem" notes about a site's profile (table
// problem_reports, ./schema.mjs). A visitor sends one from the button under
// the profile's screenshot (components/profile/ReportProblem.tsx, POST
// /api/problem-reports, ./intake.mjs); the owner reads the open ones on
// /admin/review grouped by site (components/admin/ProblemReports.tsx, GET and
// POST /api/admin/problem-reports) and marks them handled.
//
// A report is information for the owner only. Nothing here touches a site's
// grade, tier, rank, score, votes or listing, and nothing that does reads
// this table (tests/problem-reports.test.mjs checks the first).

/** The reasons a visitor can pick, in the order the panel lists them. */
export const REASONS = [
  { key: "screenshot", label: "The screenshot is wrong or broken", hint: "A cookie wall, a loader, a blank page or the wrong page" },
  { key: "measurement", label: "A measurement is wrong", hint: "A code check, a speed figure or a link" },
  { key: "not_portfolio", label: "This is not a portfolio", hint: "" },
  { key: "gone", label: "The site is gone or has changed", hint: "" },
  { key: "other", label: "Something else", hint: "" },
];
export const REASON_KEYS = REASONS.map((r) => r.key);
const LABELS = Object.fromEntries(REASONS.map((r) => [r.key, r.label]));
export const reasonLabel = (key) => LABELS[key] ?? String(key);

/** The Turnstile action the panel's widget uses and the route expects (./intake.mjs). */
export const TURNSTILE_ACTION = "problem-report";

/** The longest note kept, in characters (the panel stops typing there too). */
export const NOTE_MAX = 500;
/** The longest site address a report may name. */
export const URL_MAX = 2048;

// Written as escapes, never as the characters themselves, so the source has
// nothing invisible in it (tests/problem-reports.test.mjs checks the file).
/** C0 controls except the line break, DEL and the C1 controls, and the line and paragraph separators: each becomes a space. */
const CONTROLS = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
/**
 * Characters that show nothing or turn text around: the soft hyphen,
 * zero-width space and joiners, the left-to-right and right-to-left marks,
 * the embeddings and overrides, the word joiner and invisible operators, the
 * isolates and the byte order mark. Each is dropped.
 */
const INVISIBLE = new RegExp("[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "g");

/**
 * The note as stored: control characters (other than line breaks) dropped,
 * runs of blank lines and spaces folded, trimmed. null for an empty or
 * missing note; { error } when it is not text or too long.
 */
export function cleanNote(value) {
  if (value == null) return { note: null };
  if (typeof value !== "string") return { error: "bad_note" };
  const note = value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROLS, " ")
    .replace(INVISIBLE, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!note) return { note: null };
  if ([...note].length > NOTE_MAX) return { error: "note_too_long" };
  return { note };
}

/** A site address a report may name: http(s), no credentials, at most URL_MAX characters; else null. */
export function cleanSiteUrl(value) {
  if (typeof value !== "string" || !value || value.length > URL_MAX) return null;
  try {
    const u = new URL(value);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    return value;
  } catch {
    return null;
  }
}

/** The id of this visitor's open report on this site, or null. */
export async function openReportId(db, { url, reporter }) {
  const r = await db.execute({ sql: "SELECT id FROM problem_reports WHERE url = ? AND reporter = ? AND status = 'open' LIMIT 1", args: [url, reporter] });
  return r.rows.length ? Number(r.rows[0].id) : null;
}

/**
 * Stores a report. One open report per visitor and site: sending again
 * replaces that report's reason and note instead of adding a second.
 * Returns { id, updated }.
 */
export async function saveReport(db, { url, reason, note = null, reporter, now = new Date() }) {
  if (!REASON_KEYS.includes(reason)) throw new Error(`unknown reason ${reason}`);
  const at = now.toISOString();
  const r = await db.execute({
    sql: `INSERT INTO problem_reports (url, reason, note, reporter, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', ?, ?)
          ON CONFLICT(url, reporter) WHERE status = 'open'
          DO UPDATE SET reason = excluded.reason, note = excluded.note, updated_at = excluded.updated_at
          RETURNING id, created_at`,
    args: [url, reason, note, reporter, at, at],
  });
  const row = r.rows[0];
  return { id: Number(row.id), updated: String(row.created_at) !== at };
}

const rowOf = (r) => ({
  id: Number(r.id),
  url: String(r.url),
  reason: String(r.reason),
  note: r.note == null ? null : String(r.note),
  status: String(r.status),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  handledAt: r.handled_at == null ? null : String(r.handled_at),
  handledBy: r.handled_by == null ? null : String(r.handled_by),
});

/**
 * Reports in groups (by site, or by site and the moment they were handled):
 * { key, url, count, reasons: [{ key, label, count }] (most first), reports
 * (newest first), first, last, handledAt, handledBy }.
 */
function grouped(rows, keyOf) {
  const sites = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    const s = sites.get(key) ?? { key, url: r.url, count: 0, reports: [], first: r.createdAt, last: r.updatedAt, handledAt: r.handledAt, handledBy: r.handledBy };
    s.count++;
    s.reports.push(r);
    if (r.createdAt < s.first) s.first = r.createdAt;
    if (r.updatedAt > s.last) s.last = r.updatedAt;
    if (r.handledAt && (!s.handledAt || r.handledAt > s.handledAt)) {
      s.handledAt = r.handledAt;
      s.handledBy = r.handledBy;
    }
    sites.set(key, s);
  }
  return [...sites.values()].map((s) => {
    const counts = new Map();
    for (const r of s.reports) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    const reasons = [...counts]
      .map(([key, count]) => ({ key, label: reasonLabel(key), count }))
      .sort((a, b) => b.count - a.count || REASON_KEYS.indexOf(a.key) - REASON_KEYS.indexOf(b.key));
    s.reports.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { ...s, reasons };
  });
}

/** Rows read per list: enough for the owner to work through; more waits for the next look. */
export const LIST_LIMIT = 500;

/**
 * For the admin: open reports grouped by site (most reports first, then the
 * latest), and the latest handled ones grouped by site and by the moment they
 * were handled together (latest first), so Reopen puts back exactly the
 * reports one "Mark handled" closed.
 */
export async function listReports(db, { handledLimit = 100 } = {}) {
  const [open, handled] = await Promise.all([
    db.execute({ sql: "SELECT * FROM problem_reports WHERE status = 'open' ORDER BY updated_at DESC LIMIT ?", args: [LIST_LIMIT] }),
    db.execute({ sql: "SELECT * FROM problem_reports WHERE status = 'handled' ORDER BY handled_at DESC LIMIT ?", args: [handledLimit] }),
  ]);
  const openSites = grouped(open.rows.map(rowOf), (r) => r.url).sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
  const handledSites = grouped(handled.rows.map(rowOf), (r) => `${r.url}\n${r.handledAt}`).sort((a, b) => ((a.handledAt ?? "") < (b.handledAt ?? "") ? 1 : -1));
  return { open: openSites, handled: handledSites };
}

/** How many reports are open, for a count on the admin page. */
export async function openCount(db) {
  const r = await db.execute("SELECT COUNT(*) AS n FROM problem_reports WHERE status = 'open'");
  return Number(r.rows[0]?.n ?? 0);
}

const placeholders = (n) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Marks open reports handled, recording who and when, but only those the
 * owner saw as they are: each item carries the updatedAt his page showed,
 * and a report the visitor has resent since (a new reason or note, a newer
 * updated_at) stays open, so a note is never closed unread. The reporter's
 * hash is cleared on handling (it only kept a visitor to one open report per
 * site). Returns { changed, stale: ids left open }.
 */
export async function markHandled(db, { items, actor, now = new Date() }) {
  if (!items.length) return { changed: 0, stale: [] };
  const at = now.toISOString();
  const res = await db.batch(
    items.map(({ id, updatedAt }) => ({
      sql: "UPDATE problem_reports SET status = 'handled', handled_at = ?, handled_by = ?, reporter = NULL WHERE id = ? AND status = 'open' AND updated_at = ?",
      args: [at, actor, id, updatedAt],
    })),
    "write"
  );
  const stale = items.filter((_, i) => res[i].rowsAffected === 0).map((x) => x.id);
  return { changed: items.length - stale.length, stale };
}

/**
 * Puts handled reports back in the open list (the owner's Undo). The page
 * sends the ids of one handled group, so only the reports that one "Mark
 * handled" closed come back. Their visitor hash was cleared on handling, so
 * a reopened report no longer holds its visitor to one open report: if the
 * same visitor reports the site again, that is a second open report. Rare,
 * and the owner sees both; kept simple on purpose. Returns how many changed.
 */
export async function reopenReports(db, { ids }) {
  if (!ids.length) return 0;
  const r = await db.execute({
    sql: `UPDATE problem_reports SET status = 'open', handled_at = NULL, handled_by = NULL WHERE status = 'handled' AND id IN (${placeholders(ids.length)})`,
    args: ids,
  });
  return r.rowsAffected;
}
