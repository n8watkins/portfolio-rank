// One site, every spelling, for what a verified owner chose (portfolio_owner,
// lib/games/claims.mjs): a removal or a hidden grade asked for under one
// address covers every other spelling of the same site, and a removed site
// can't be added again under any of them (POST /api/add, the free tools,
// discovery's hand-off).
//
// "Same site" is deliberately narrower than the list's key (pipeline/list-key.mjs
// listKey) and the grader's (lib/grader/url.mjs siteKeyOf): both drop the
// query and the fragment, and siteKeyOf also folds the path's case, so two
// different people's pages on one host and path could share their key.
// Removing must never hide someone else's site, so ownerSiteKey treats as
// the same only what can't change which page is served:
//   - the scheme (http or https),
//   - the host's case and a trailing dot,
//   - a leading "www.",
//   - trailing slashes on the path (and so "/" or no path at all),
//   - an empty "?" or "#" (the URL parser drops them).
// The port, the path's case, the query and the fragment are kept: a
// different one is a different address, and is not covered.
//
// portfolio_owner stays keyed by the exact address its owner asked under
// (no schema change): the rows that carry a choice are few (one per site an
// owner acted on), so reads take all of them and match by key here.
//
// Plain JavaScript taking a libSQL client, so the tests need no server.

/** The rows that carry an owner's choice: a hidden grade, a held removal or an applied one. */
export const OWNER_MARKED = "hide_grade = 1 OR removed_at IS NOT NULL OR remove_after IS NOT NULL";

/**
 * The key two spellings of one site share (see the top of this file). An
 * address that isn't an http(s) URL is its own key, trimmed.
 * @param {unknown} url
 * @returns {string}
 */
export function ownerSiteKey(url) {
  const s = String(url ?? "").trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return s;
    const host = u.hostname.replace(/\.$/, "").replace(/^www\./, "");
    const port = u.port ? `:${u.port}` : "";
    return `${host}${port}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`;
  } catch {
    return s;
  }
}

// Only a missing table reads as "no choices": a missing column is an error,
// so a database behind its migration never shows a removed site.
const noTable = (e) => /no such table/i.test(String(e?.message ?? e));

/**
 * @typedef {{ url: string, key: string, hideGrade: boolean, removedAt: string | null, removeAfter: string | null, removedBy: string | null }} OwnerRow
 * @typedef {{ execute: (q: any) => Promise<{ rows: Record<string, unknown>[] }> }} Db
 */

/** @type {(r: Record<string, unknown>) => OwnerRow} */
const rowOf = (r) => ({
  url: String(r.url),
  key: ownerSiteKey(r.url),
  hideGrade: Number(r.hide_grade ?? 0) === 1,
  removedAt: r.removed_at == null ? null : String(r.removed_at),
  removeAfter: r.remove_after == null ? null : String(r.remove_after),
  removedBy: r.removed_by == null ? null : String(r.removed_by),
});

/**
 * Every portfolio_owner row that carries a choice, with its key:
 * [{ url, key, hideGrade, removedAt, removeAfter, removedBy }]. Empty before
 * the table exists.
 * @param {Db} db
 * @returns {Promise<OwnerRow[]>}
 */
export async function markedOwnerRows(db) {
  try {
    const r = await db.execute(`SELECT url, hide_grade, removed_at, remove_after, removed_by FROM portfolio_owner WHERE ${OWNER_MARKED}`);
    return r.rows.map(rowOf);
  } catch (e) {
    if (noTable(e)) return [];
    throw e;
  }
}

/**
 * The portfolio_owner rows of `url`'s site, under any spelling: its own row
 * (even when it carries no choice) first, then the others that carry one.
 * @param {{ execute: Function }} db
 * @param {string} url
 */
export async function sameSiteRows(db, url) {
  const key = ownerSiteKey(url);
  const r = await db.execute({
    sql: `SELECT url, hide_grade, removed_at, remove_after, removed_by FROM portfolio_owner WHERE url = ? OR ${OWNER_MARKED}`,
    args: [url],
  });
  const rows = r.rows.map(rowOf).filter((row) => row.url === url || row.key === key);
  return [...rows.filter((row) => row.url === url), ...rows.filter((row) => row.url !== url)];
}

/**
 * The site keys owners marked: { removed, held, hideGrade }, each a Set of
 * ownerSiteKey. removed: the removal took effect; held: it waits out its
 * hold (lib/games/claims.mjs REMOVAL_HOLD_MS); hideGrade: the grade is hidden.
 * @param {{ execute: Function }} db
 */
export async function ownerMarks(db) {
  const out = { removed: new Set(), held: new Set(), hideGrade: new Set() };
  for (const row of await markedOwnerRows(db)) {
    if (row.removedAt) out.removed.add(row.key);
    else if (row.removeAfter) out.held.add(row.key);
    if (row.hideGrade) out.hideGrade.add(row.key);
  }
  return out;
}

/** The message a visitor gets for an address whose owner removed it. */
export const OWNER_REMOVED_MESSAGE = "The owner of this site asked for it to be removed from PortfolioRank, so it can't be added again.";

/**
 * Whether any of `urls` is a spelling of a site whose owner removed it, the
 * removal applied or still held (a held removal counts: it is the owner's
 * word, and adding the site in the meantime would undo it).
 * @param {{ execute: Function }} db
 * @param {string[]} urls
 */
export async function ownerRemovedAny(db, urls) {
  const keys = new Set(urls.filter(Boolean).map(ownerSiteKey));
  if (!keys.size) return false;
  for (const row of await markedOwnerRows(db)) {
    if ((row.removedAt || row.removeAfter) && keys.has(row.key)) return true;
  }
  return false;
}

/**
 * The refusal for adding a removed site, or null when it may be added:
 * { error: "owner_removed", message }. Nothing is written either way.
 * @param {{ execute: Function }} db
 * @param {string[]} urls every spelling the request names (as typed, as checked, the listed one)
 */
export async function addRefusal(db, urls) {
  return (await ownerRemovedAny(db, urls)) ? { error: "owner_removed", message: OWNER_REMOVED_MESSAGE } : null;
}
