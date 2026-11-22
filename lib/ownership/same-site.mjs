// One site, every spelling, for what a verified owner chose (portfolio_owner,
// lib/games/claims.mjs): a removal or a hidden grade asked for under one
// address covers every other spelling of the same site, and a removed site
// can't be added again under any of them (POST /api/add, the free tools,
// discovery's hand-off).
//
// "Same site" is the key the app already resolves a site by: the grader's
// siteKeyOf (lib/grader/url.mjs: host without www, path without the trailing
// slash, lower case; scheme, query and fragment ignored). A profile
// (lib/profile.ts), "Add your portfolio" and discovery all find a site by
// it, so a removal must cover exactly what they show as that site. The cost,
// chosen in review on 2026-11-22 and put to the owner: two addresses that differ only in the
// query, the fragment or the path's case are one site here, so a removal
// under host/p?u=alice also covers host/p?u=bob. The app already shows those
// as one profile, and no two listed addresses share a key today.
//
// portfolio_owner stays keyed by the exact address its owner asked under
// (no schema change): the rows that carry a choice are few (one per site an
// owner acted on), so reads take all of them, kept a short while per
// isolate (OWNER_TTL_MS), and match by key here.
//
// Plain JavaScript taking a libSQL client, so the tests need no server.
import { siteKeyOf } from "../grader/url.mjs";

/** The rows that carry an owner's choice: a hidden grade, a held removal or an applied one. */
export const OWNER_MARKED = "hide_grade = 1 OR removed_at IS NOT NULL OR remove_after IS NOT NULL";

/**
 * The key two spellings of one site share: siteKeyOf, https assumed when the
 * scheme is missing. An address siteKeyOf can't read is its own key, trimmed.
 * @param {unknown} url
 * @returns {string}
 */
export function ownerSiteKey(url) {
  const s = String(url ?? "").trim();
  try {
    return siteKeyOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return s;
  }
}

/**
 * @typedef {{ url: string, key: string, hideGrade: boolean, removedAt: string | null, removeAfter: string | null, removedBy: string | null }} OwnerRow
 * @typedef {{ execute: (q: any) => Promise<{ rows: Record<string, unknown>[] }> }} Db
 */

const COLS = "url, hide_grade, removed_at, remove_after, removed_by";

/** @type {(r: Record<string, unknown>) => OwnerRow} */
const rowOf = (r) => ({
  url: String(r.url),
  key: ownerSiteKey(r.url),
  hideGrade: Number(r.hide_grade ?? 0) === 1,
  removedAt: r.removed_at == null ? null : String(r.removed_at),
  removeAfter: r.remove_after == null ? null : String(r.remove_after),
  removedBy: r.removed_by == null ? null : String(r.removed_by),
});

// Only a missing table reads as "no choices": a missing column is an error,
// so a database behind its migration never shows a removed site.
/** @param {unknown} e */
const noTable = (e) => /no such table/i.test(String(/** @type {Error} */ (e)?.message ?? e));

/**
 * How long one isolate reuses the marked rows. Owner actions in the same
 * isolate drop them at once (forgetOwnerRows); other isolates and the hourly
 * apply are seen within this time.
 */
export const OWNER_TTL_MS = 60 * 1000;
/** @type {WeakMap<object, { at: number, rows: Promise<OwnerRow[]> }>} */
let cache = new WeakMap();

/** Drops every cached read of the marked rows (after an owner action, an apply or an undo). */
export function forgetOwnerRows() {
  cache = new WeakMap();
}

/**
 * Every portfolio_owner row that carries a choice, with its key. Empty
 * before the table exists. Cached per client for OWNER_TTL_MS unless `fresh`.
 * @param {Db} db
 * @param {{ fresh?: boolean, now?: number }} [o]
 * @returns {Promise<OwnerRow[]>}
 */
export function markedOwnerRows(db, { fresh = false, now = Date.now() } = {}) {
  const hit = cache.get(db);
  if (!fresh && hit && now - hit.at < OWNER_TTL_MS) return hit.rows;
  /** @type {Promise<OwnerRow[]>} */
  const rows = db.execute(`SELECT ${COLS} FROM portfolio_owner WHERE ${OWNER_MARKED}`).then(
    (r) => r.rows.map(rowOf),
    (e) => {
      if (noTable(e)) return [];
      throw e;
    }
  );
  const entry = { at: now, rows };
  cache.set(db, entry);
  // A failed read is not kept: the next call asks again.
  rows.catch(() => {
    if (cache.get(db) === entry) cache.delete(db);
  });
  return rows;
}

/**
 * The portfolio_owner rows of `url`'s site, under any spelling: its own row
 * (even when it carries no choice) first, then the others that carry one.
 * @param {Db} db
 * @param {string} url
 * @param {{ fresh?: boolean }} [o] fresh for a decision that writes (ownerAction, undoRemoval)
 * @returns {Promise<OwnerRow[]>}
 */
export async function sameSiteRows(db, url, { fresh = false } = {}) {
  const key = ownerSiteKey(url);
  const [own, marked] = await Promise.all([db.execute({ sql: `SELECT ${COLS} FROM portfolio_owner WHERE url = ?`, args: [url] }), markedOwnerRows(db, { fresh })]);
  return [...own.rows.map(rowOf), ...marked.filter((r) => r.url !== url && r.key === key)];
}

/**
 * The marked sites, by key: removed (applied), held (waiting out the hold,
 * lib/games/claims.mjs REMOVAL_HOLD_MS) and hideGrade, each a Set of
 * ownerSiteKey; removedUrls, the addresses the applied removals were asked
 * under; and the checks on one address.
 * @param {Db} db
 * @param {{ fresh?: boolean }} [o]
 */
export async function ownerMarks(db, o = {}) {
  /** @type {Set<string>} */
  const removed = new Set();
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Set<string>} */
  const hideGrade = new Set();
  /** @type {string[]} */
  const removedUrls = [];
  for (const row of await markedOwnerRows(db, o)) {
    if (row.removedAt) {
      removed.add(row.key);
      removedUrls.push(row.url);
    } else if (row.removeAfter) held.add(row.key);
    if (row.hideGrade) hideGrade.add(row.key);
  }
  /** @param {string} url */
  const isRemoved = (url) => removed.has(ownerSiteKey(url));
  /** @param {string} url */
  const isHeld = (url) => !isRemoved(url) && held.has(ownerSiteKey(url));
  /** Removed, or its grade hidden: never shown with its grade. @param {string} url */
  const gradeHidden = (url) => isRemoved(url) || hideGrade.has(ownerSiteKey(url));
  return { removed, held, hideGrade, removedUrls, isRemoved, isHeld, gradeHidden };
}

/** The message a visitor gets for an address whose owner removed it. */
export const OWNER_REMOVED_MESSAGE = "The owner of this site asked for it to be removed from PortfolioRank, so it can't be added again.";

/**
 * What an owner's removal says about adding any of `urls` (spellings of one
 * site): "removed" (applied), "held" (asked for, still in its hold) or null.
 * Always a fresh read. Writes nothing.
 * @param {Db} db
 * @param {string[]} urls
 * @returns {Promise<"removed" | "held" | null>}
 */
export async function removalOf(db, urls) {
  const list = urls.filter(Boolean);
  if (!list.length) return null;
  const marks = await ownerMarks(db, { fresh: true });
  if (list.some(marks.isRemoved)) return "removed";
  if (list.some(marks.isHeld)) return "held";
  return null;
}

/**
 * The refusal for adding a removed site, applied or held, or null when it
 * may be added: { error: "owner_removed", message }. Writes nothing.
 * @param {Db} db
 * @param {string[]} urls
 */
export async function addRefusal(db, urls) {
  return (await removalOf(db, urls)) ? { error: "owner_removed", message: OWNER_REMOVED_MESSAGE } : null;
}
