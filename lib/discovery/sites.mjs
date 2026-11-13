// The discovery seen-set: every site PortfolioRank has come across that is
// not on the list yet, one row per normalized address (docs/DISCOVERY.md).
//
// Two writers share it, so a site found twice is judged once: the free
// tools ("tools": a visitor checked an unlisted site and left "Add my
// portfolio" on) and the discovery pipeline (pipeline/discovery: GitHub
// topics, Hacker News, community lists).
//
// Kept small on purpose (the discovery plan's "Memory" design):
// - the key is the first 64 bits of SHA-256 of the normalized address, as
//   SQLite's rowid, so a seen-check is one primary-key read;
// - the address itself is kept only while a row will be looked at again
//   (in a queue, graded, or dropped for a reason that is rechecked: dead,
//   unsure); a permanent drop keeps only the hash, the reason and the dates;
//   Reads never return the id itself: the libSQL client refuses integers
//   past 2^53 unless it runs in bigint mode, so look rows up by it, or read
//   it as text (seenKey, CAST(id AS TEXT));
// - nothing here is public. A site shows on PortfolioRank only once it is
//   graded, never while it is waiting or dropped.
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
  // The recheck queue and every stage's queue read only their due slice.
  `CREATE INDEX IF NOT EXISTS discovery_sites_recheck_idx ON discovery_sites (recheck_at) WHERE recheck_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS discovery_sites_pending_idx ON discovery_sites (first_seen) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS discovery_sites_found_idx ON discovery_sites (first_seen) WHERE status = 'found'`,
  `CREATE INDEX IF NOT EXISTS discovery_sites_screen_idx ON discovery_sites (first_seen) WHERE status = 'screen'`,
  `CREATE INDEX IF NOT EXISTS discovery_sites_queued_idx ON discovery_sites (first_seen) WHERE status = 'queued'`,
  // A row's working data while it moves through the pipeline: the source's
  // context (a repo whose README is read), then the page evidence the AI
  // screen reads, then the screen's answer. Deleted when the row is dropped
  // or handed to the grader, so it never grows past the queues.
  `CREATE TABLE IF NOT EXISTS discovery_work (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  // One row per source: where its last run stopped (pipeline/discovery/watermark.mjs).
  `CREATE TABLE IF NOT EXISTS discovery_sources (
    source TEXT PRIMARY KEY,
    cursor TEXT,
    read_at TEXT,
    updated_at TEXT NOT NULL
  )`,
];

/**
 * found: collected, waiting for the page fetch and the code checks;
 * screen: passed them, waiting for the AI screen;
 * pending: waiting to be graded (screened, or added by the free tools);
 * queued: handed to the grader's queue (lib/grader/jobs.mjs, visitor "discovery");
 * graded: graded; dropped: judged and left out (see reason).
 */
export const STATUSES = ["found", "screen", "pending", "queued", "graded", "dropped"];

/** The statuses that are a stage's queue (queue() below). */
export const QUEUES = ["found", "screen", "pending", "queued"];

/** Drop reasons that are looked at again, so their row keeps the address. Any other reason is permanent. */
export const RECHECKED_REASONS = new Set(["dead", "empty", "parked", "blocked", "unsure"]);

/** Days until a rechecked reason is looked at again, times the failures so far (the discovery plan's table). */
export const RECHECK_DAYS = { dead: 90, empty: 90, parked: 90, blocked: 30, unsure: 180 };

/** A rechecked row that has failed this many checks in all is dropped for good (its address forgotten). */
export const MAX_TRIES = 3;

/** Where a site was found. */
export const SOURCES = new Set(["tools", "github", "hn", "personalsites", "uses", "devto", "curated", "upstream", "owner"]);

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

/** seenId as a decimal string, the form reads return (CAST(id AS TEXT)), safe past 2^53. */
export const seenKey = (url) => seenId(url).toString();

/**
 * The seen-check for many addresses: one primary-key read per address, 500
 * to a query. Returns a Map of seenKey to status for the ones seen.
 * @param {any} db
 * @param {string[]} urls
 */
export async function seenMany(db, urls) {
  const ids = [...new Set(urls.map(seenKey))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const r = await db.execute({
      sql: `SELECT CAST(id AS TEXT) AS k, status FROM discovery_sites WHERE id IN (${part.map(() => "?").join(",")})`,
      args: part.map((k) => BigInt(k)),
    });
    for (const row of r.rows) out.set(String(row.k), String(row.status));
  }
  return out;
}

/**
 * Adds addresses never seen before as `found` (a site already in the table
 * is left alone), with their source's context in discovery_work. One write
 * transaction per 200 addresses. Returns how many were new.
 * @param {any} db
 * @param {{ url: string, source: string, context?: object | null }[]} items
 * @param {{ now?: Date }} [o]
 */
export async function addFound(db, items, { now = new Date() } = {}) {
  const at = now.toISOString();
  let added = 0;
  for (let i = 0; i < items.length; i += 200) {
    const stmts = [];
    const isRow = [];
    for (const it of items.slice(i, i + 200)) {
      if (!SOURCES.has(it.source)) throw new Error(`unknown discovery source: ${it.source}`);
      const id = seenId(it.url);
      stmts.push({
        sql: `INSERT INTO discovery_sites (id, status, source, first_seen, checked_at, url) VALUES (?, 'found', ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [id, it.source, at, at, it.url],
      });
      isRow.push(true);
      if (it.context) {
        stmts.push({ sql: "INSERT INTO discovery_work (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", args: [id, JSON.stringify(it.context)] });
        isRow.push(false);
      }
    }
    const res = await db.batch(stmts, "write");
    res.forEach((r, j) => {
      if (isRow[j]) added += r.rowsAffected;
    });
  }
  return added;
}

/**
 * The oldest rows of one status with their working data: a stage's queue.
 * Reads only that status's partial index.
 * @param {any} db
 * @param {"found" | "screen" | "pending" | "queued"} status
 * @param {number} limit
 */
export async function queue(db, status, limit) {
  if (!QUEUES.includes(status)) throw new Error(`not a queue: ${status}`);
  const r = await db.execute({
    sql: `SELECT CAST(s.id AS TEXT) AS k, s.url, s.source, s.tries, w.data
          FROM discovery_sites s LEFT JOIN discovery_work w ON w.id = s.id
          WHERE s.status = ? ORDER BY s.first_seen LIMIT ?`,
    args: [status, limit],
  });
  return r.rows.map((row) => ({
    key: String(row.k),
    url: row.url == null ? null : String(row.url),
    source: String(row.source),
    tries: Number(row.tries ?? 0),
    work: row.data == null ? null : JSON.parse(String(row.data)),
  }));
}

/**
 * Moves rows on after a stage, in one write transaction per 100. Each
 * outcome is { key, status, reason?, work? }. A drop with a rechecked
 * reason keeps the address and gets a recheck date, until its MAX_TRIES-th
 * failed check makes it final; any other drop forgets the address. `work`
 * replaces the row's working data; a row that leaves the pipeline
 * (dropped, queued, graded) loses it.
 * @param {any} db
 * @param {{ key: string, status: string, reason?: string | null, work?: object | null }[]} outcomes
 * @param {{ now?: Date }} [o]
 */
export async function settle(db, outcomes, { now = new Date() } = {}) {
  const at = now.toISOString();
  for (let i = 0; i < outcomes.length; i += 100) {
    const stmts = [];
    for (const o of outcomes.slice(i, i + 100)) {
      if (!STATUSES.includes(o.status)) throw new Error(`unknown discovery status: ${o.status}`);
      const id = BigInt(o.key);
      if (o.status === "dropped") {
        const again = RECHECKED_REASONS.has(String(o.reason)) ? 1 : 0;
        // The wait grows with each failure: 3 months, then 6, for a dead site.
        const days = again ? RECHECK_DAYS[String(o.reason)] : 0;
        stmts.push({
          sql: `UPDATE discovery_sites SET status = 'dropped', reason = ?, checked_at = ?, tries = tries + 1,
                  recheck_at = CASE WHEN ? = 1 AND tries + 1 < ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || (? * (tries + 1)) || ' days') ELSE NULL END,
                  url = CASE WHEN ? = 1 AND tries + 1 < ? THEN url ELSE NULL END
                WHERE id = ?`,
          args: [o.reason ?? null, at, again, MAX_TRIES, at, days, again, MAX_TRIES, id],
        });
      } else {
        stmts.push({ sql: "UPDATE discovery_sites SET status = ?, reason = NULL, checked_at = ?, recheck_at = NULL WHERE id = ?", args: [o.status, at, id] });
      }
      if (["dropped", "queued", "graded"].includes(o.status)) stmts.push({ sql: "DELETE FROM discovery_work WHERE id = ?", args: [id] });
      else if (o.work) {
        stmts.push({
          sql: "INSERT INTO discovery_work (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
          args: [id, JSON.stringify(o.work)],
        });
      }
    }
    await db.batch(stmts, "write");
  }
}

/**
 * Rechecked drops whose date has come go back to `found`, oldest first, at
 * most `limit`. Reads only the recheck index's due slice.
 * @param {any} db
 * @param {{ now?: Date, limit?: number }} [o]
 */
export async function reopenDue(db, { now = new Date(), limit = 200 } = {}) {
  const r = await db.execute({
    sql: `UPDATE discovery_sites SET status = 'found', recheck_at = NULL
          WHERE id IN (SELECT id FROM discovery_sites WHERE recheck_at IS NOT NULL AND recheck_at <= ? ORDER BY recheck_at LIMIT ?)
            AND url IS NOT NULL`,
    args: [now.toISOString(), limit],
  });
  return r.rowsAffected;
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
