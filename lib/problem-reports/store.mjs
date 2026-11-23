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
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
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

/** Whether PortfolioRank has a record of this site (a capture or a grade request); the route adds the roster. */
export async function siteOnRecord(db, url) {
  const r = await db.execute({ sql: "SELECT 1 FROM portfolios WHERE url = ? LIMIT 1", args: [url] });
  return r.rows.length > 0;
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

/** Reports by site: { url, count, reasons: [{ key, label, count }] (most first), reports (newest first), first, last }. */
function bySite(rows) {
  const sites = new Map();
  for (const r of rows) {
    const s = sites.get(r.url) ?? { url: r.url, count: 0, reports: [], first: r.createdAt, last: r.updatedAt, handledAt: r.handledAt, handledBy: r.handledBy };
    s.count++;
    s.reports.push(r);
    if (r.createdAt < s.first) s.first = r.createdAt;
    if (r.updatedAt > s.last) s.last = r.updatedAt;
    if (r.handledAt && (!s.handledAt || r.handledAt > s.handledAt)) {
      s.handledAt = r.handledAt;
      s.handledBy = r.handledBy;
    }
    sites.set(r.url, s);
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
 * latest), and the latest handled ones grouped by site (latest handled first).
 */
export async function listReports(db, { handledLimit = 100 } = {}) {
  const [open, handled] = await Promise.all([
    db.execute({ sql: "SELECT * FROM problem_reports WHERE status = 'open' ORDER BY updated_at DESC LIMIT ?", args: [LIST_LIMIT] }),
    db.execute({ sql: "SELECT * FROM problem_reports WHERE status = 'handled' ORDER BY handled_at DESC LIMIT ?", args: [handledLimit] }),
  ]);
  const openSites = bySite(open.rows.map(rowOf)).sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
  const handledSites = bySite(handled.rows.map(rowOf)).sort((a, b) => ((a.handledAt ?? "") < (b.handledAt ?? "") ? 1 : -1));
  return { open: openSites, handled: handledSites };
}

/** How many reports are open, for a count on the admin page. */
export async function openCount(db) {
  const r = await db.execute("SELECT COUNT(*) AS n FROM problem_reports WHERE status = 'open'");
  return Number(r.rows[0]?.n ?? 0);
}

const placeholders = (n) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Marks open reports handled, recording who and when. The reporter's hash is
 * cleared then (it only kept a visitor to one open report per site). Returns
 * how many changed.
 */
export async function markHandled(db, { ids, actor, now = new Date() }) {
  if (!ids.length) return 0;
  const r = await db.execute({
    sql: `UPDATE problem_reports SET status = 'handled', handled_at = ?, handled_by = ?, reporter = NULL WHERE status = 'open' AND id IN (${placeholders(ids.length)})`,
    args: [now.toISOString(), actor, ...ids],
  });
  return r.rowsAffected;
}

/** Puts handled reports back in the open list (the owner's Undo). Returns how many changed. */
export async function reopenReports(db, { ids }) {
  if (!ids.length) return 0;
  const r = await db.execute({
    sql: `UPDATE problem_reports SET status = 'open', handled_at = NULL, handled_by = NULL WHERE status = 'handled' AND id IN (${placeholders(ids.length)})`,
    args: ids,
  });
  return r.rowsAffected;
}
