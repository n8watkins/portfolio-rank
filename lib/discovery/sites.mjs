// The discovery seen-set: every site PortfolioRank has come across that is
// not on the list yet, one row per normalized address (docs/DISCOVERY.md).
//
// Today its only source is the free tools ("tools": a visitor checked an
// unlisted site and left "Add my portfolio" on). The discovery pipeline
// (GitHub topics, Hacker News, community lists) will write to the same
// table, so a site found twice is judged once.
//
// Kept small on purpose (the discovery plan's "Memory" design):
// - the key is the first 64 bits of SHA-256 of the normalized address, as
//   SQLite's rowid, so a seen-check is one primary-key read;
// - the address itself is kept only while a row will be looked at again
//   (pending, or dropped for a reason that is rechecked: dead, unsure);
//   a permanent drop keeps only the hash, the reason and the dates;
//   Reads never return the id itself: the libSQL client refuses integers
//   past 2^53 unless it runs in bigint mode, so look rows up by it only;
// - nothing here is public. A site shows on PortfolioRank only once it is
//   graded and joins the list, never while it is pending or dropped.
import { createHash } from "node:crypto";
import { siteKeyOf } from "../grader/url.mjs";

export const DISCOVERY_TABLES = [
  `CREATE TABLE IF NOT EXISTS discovery_sites (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT,
    source TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    recheck_at TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    url TEXT
  )`,
  // The recheck queue and the grading queue read only their due slice.
  `CREATE INDEX IF NOT EXISTS discovery_sites_recheck_idx ON discovery_sites (recheck_at) WHERE recheck_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS discovery_sites_pending_idx ON discovery_sites (first_seen) WHERE status = 'pending'`,
];

/** pending: waiting to be graded; graded: graded and handed to the list; dropped: judged and left out (see reason). */
export const STATUSES = ["pending", "graded", "dropped"];

/** Drop reasons that are looked at again, so their row keeps the address. Any other reason is permanent. */
export const RECHECKED_REASONS = new Set(["dead", "empty", "parked", "blocked", "unsure"]);

/** Where a site was found. */
export const SOURCES = new Set(["tools", "github", "hn", "personalsites", "uses", "devto", "upstream", "owner"]);

/**
 * The seen-set key of an address: the first 64 bits of SHA-256 of its site
 * key (host without www, path without the trailing slash, lower case, no
 * query or fragment; lib/grader/url.mjs siteKeyOf), as a signed 64-bit
 * integer for SQLite's rowid.
 * @param {string | URL} url
 * @returns {bigint}
 */
export function seenId(url) {
  const digest = createHash("sha256").update(siteKeyOf(url)).digest();
  return digest.readBigInt64BE(0);
}

/**
 * One primary-key read: the row for an address, or null.
 * @param {any} db
 * @param {string} url
 */
export async function seen(db, url) {
  const r = await db.execute({
    sql: "SELECT status, reason, source, first_seen, checked_at FROM discovery_sites WHERE id = ?",
    args: [seenId(url)],
  });
  const row = r.rows[0];
  return row ? { status: String(row.status), reason: row.reason == null ? null : String(row.reason), source: String(row.source), firstSeen: String(row.first_seen), checkedAt: String(row.checked_at) } : null;
}

/**
 * Adds an address as pending (to be graded when the quota allows), or
 * refreshes the check date of one already pending. A site already graded
 * or dropped is left as it is: the seen-set decides once. Returns the
 * row's status after the call and whether it was new.
 * @param {any} db
 * @param {{ url: string, source: string, now?: Date }} o
 */
export async function addPending(db, { url, source, now = new Date() }) {
  if (!SOURCES.has(source)) throw new Error(`unknown discovery source: ${source}`);
  const at = now.toISOString();
  const r = await db.execute({
    sql: `INSERT INTO discovery_sites (id, status, source, first_seen, checked_at, url)
          VALUES (?, 'pending', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at WHERE discovery_sites.status = 'pending'
          RETURNING status, first_seen`,
    args: [seenId(url), source, at, at, url],
  });
  const row = r.rows[0];
  if (row) return { status: String(row.status), added: String(row.first_seen) === at };
  const existing = await seen(db, url);
  return { status: existing?.status ?? "pending", added: false };
}

/**
 * Marks a row dropped. A rechecked reason keeps the address and sets when to
 * look again; any other reason forgets the address for good.
 * @param {any} db
 * @param {{ url: string, reason: string, recheckAt?: Date | null, now?: Date }} o
 */
export async function drop(db, { url, reason, recheckAt = null, now = new Date() }) {
  const keep = RECHECKED_REASONS.has(reason);
  await db.execute({
    sql: `UPDATE discovery_sites SET status = 'dropped', reason = ?, checked_at = ?, tries = tries + 1,
            recheck_at = ?, url = CASE WHEN ? THEN url ELSE NULL END
          WHERE id = ?`,
    args: [reason, now.toISOString(), keep && recheckAt ? recheckAt.toISOString() : null, keep ? 1 : 0, seenId(url)],
  });
}
