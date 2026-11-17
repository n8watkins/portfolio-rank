// The roster in the database: which `portfolios` rows are still on the list
// (data/feed.json), which are healthy, and cleanup of rows that left it.
//
// Owner decisions (2026-11-10): background jobs only work on sites on the
// current list, and PortfolioRank runs its own cleanup instead of trusting the
// community list to be right.
//
//   delisted_at   set when a row's URL is no longer in feed.json; cleared when
//                 it comes back. Rows delisted for PURGE_AFTER_DAYS lose their
//                 screenshots and their row (votes and ratings stay).
//   health        weekly health check state: live -> suspect -> down
//                 (pipeline/health.mjs). NULL until first checked.
//   retry_at      when capture may try a site again after a failed capture
//                 (backoff), so one transient error never hides a site forever.
//
// A row's url is its key in many tables (votes, ratings, likes, lists, owner
// settings, review history...). When the list spells a site's address another
// way (a trailing slash, www, http, upper case, the default port, a dropped
// query; pipeline/list-key.mjs), nothing is lost: the feed build keeps the
// stored address in the feed, syncRoster does the same for the entries a job
// hands it (so no job delists the row or inserts a second one), and
// purgeDelisted never deletes a row whose site is listed under another
// address. Moving a row to the new spelling is done by hand after that
// spelling is deployed (scripts/repair-respelled-sites.mjs).

import { createClient } from "@libsql/client";
import path from "path";
import { HIDDEN_INDEX } from "../lib/hidden.mjs";
import { feedKeyer, listKey, pinWaiting, waitingSummary } from "./list-key.mjs";
import { CLEANUP_SHARE_ENV, allowedShare, cleanupShare, jobSummary } from "./list-util.mjs";

export const PURGE_AFTER_DAYS = 30;
// Refuse to purge when this share of all rows would go at once: something
// upstream of the purge (a broken feed) is more likely than a real cleanup.
export const PURGE_MAX_SHARE = 0.2;
// A roster this small is a broken feed, not a real list.
export const MIN_ROSTER = 500;
// Refuse to delist more than this share of the list in one sync: the feed
// keeps its length when upstream rewrites every address, so only this
// notices. Above the weekly exclusions' own 10% cap (pipeline/exclusions.mjs),
// so a full exclusions week plus the day's upstream removals still passes.
// A real upstream cleanup that is bigger is let through once by setting
// CLEANUP_SHARE_ENV (also read by the feed build's --max-shrink).
export const DELIST_MAX_SHARE = 0.15;
export { CLEANUP_SHARE_ENV, allowedShare, cleanupShare };

/** Pipeline DB client: Turso when TURSO_DATABASE_URL is set, else a local file. */
export function pipelineDb(root) {
  return process.env.TURSO_DATABASE_URL
    ? createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      })
    : createClient({
        url: `file:${process.env.LOCAL_DB_FILE ?? path.join(root, "data", "portfoliorank.db")}`,
        timeout: 5000, // wait for another connection's lock instead of SQLITE_BUSY
      });
}

// Additive and idempotent: safe to run against the live database on every
// start, by every job and by the app (lib/db.ts adds the same columns).
const COLUMNS = [
  "ai_rubric TEXT",
  "delisted_at TEXT",
  "health TEXT",
  "health_reason TEXT",
  "health_fails INTEGER NOT NULL DEFAULT 0",
  "health_first_fail_at TEXT",
  "health_checked_at TEXT",
  "final_url TEXT",
  "capture_attempts INTEGER NOT NULL DEFAULT 0",
  "retry_at TEXT",
  "signals TEXT",
  "needs_review INTEGER NOT NULL DEFAULT 0",
  // Pipeline-only (the app never reads them; lib/schema.mjs adds them too,
  // from lib/pipeline-schema.mjs): the page's visible text (capped, pipeline/rubric.mjs
  // PAGE_TEXT_MAX) and the facts measured by code (pipeline/facts.mjs),
  // both input to the AI grade.
  "page_text TEXT",
  "facts TEXT",
  "facts_at TEXT",
];

export async function ensureRosterSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS portfolios (
    url TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    shot_key TEXT,
    meta TEXT,
    checked_at TEXT,
    captured_at TEXT
  )`);
  // The app creates this too (lib/db.ts); the purge deletes from it.
  await db.execute(`CREATE TABLE IF NOT EXISTS cache (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  const have = new Set(
    (await db.execute("PRAGMA table_info(portfolios)")).rows.map((r) => String(r.name))
  );
  for (const col of COLUMNS) {
    if (have.has(col.split(" ")[0])) continue;
    try {
      await db.execute(`ALTER TABLE portfolios ADD COLUMN ${col}`);
    } catch (e) {
      // Another job added it between the PRAGMA and here.
      if (!/duplicate column/i.test(String(e?.message))) throw e;
    }
  }
  // Needs the health column above (lib/hidden.mjs).
  await db.execute(HIDDEN_INDEX);}

/**
 * SQL condition for rows background jobs may work on: on the list and not
 * confirmed down. `p` is the table alias.
 */
export const ACTIVE = (p = "portfolios") =>
  `${p}.delisted_at IS NULL AND COALESCE(${p}.health, '') != 'down'`;

/** SQL condition (never NULL): the AI rubric said this is not a portfolio. */
export const NOT_PORTFOLIO = (p = "portfolios") =>
  `COALESCE(json_valid(${p}.ai_rubric) AND json_extract(${p}.ai_rubric, '$.is_portfolio') = 0, 0)`;

const chunks = (arr, n = 400) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * First gives every entry the list now spells another way, while exactly one
 * stored row has its key, that row's address, IN PLACE (pipeline/list-key.mjs
 * pinWaiting; the feed build does the same when it has the database). The job
 * goes on with the same entries, so its inserters (pipeline/capture.mjs
 * captureSite via dueForCapture, pipeline/health.mjs runHealthCheck) work on
 * that row and never insert a second one, and the row is never delisted.
 * Each such site is logged and listed under "Waiting for an address move" in
 * the job summary. Then marks rows whose address left the roster as delisted
 * (with the date), and restores rows that came back.
 *
 * Refuses (throws) to delist more than DELIST_MAX_SHARE of the list at once,
 * unless the owner set CLEANUP_SHARE_ENV for a real upstream cleanup.
 * Returns { delisted, relisted, listed, waiting }.
 */
export async function syncRoster(db, feed, { now = new Date(), maxDelistShare = allowedShare(DELIST_MAX_SHARE), log = console.warn } = {}) {
  if (!Array.isArray(feed) || feed.length < MIN_ROSTER) {
    throw new Error(
      `syncRoster: refusing a roster of ${feed?.length ?? 0} entries (minimum ${MIN_ROSTER}); the feed looks broken`
    );
  }
  await ensureRosterSchema(db);
  const rows = (await db.execute("SELECT url, delisted_at FROM portfolios")).rows;
  const pins = pinWaiting(feed, rows.map((r) => String(r.url)), feedKeyer(feed));
  for (const w of pins.waiting) log(`syncRoster: ${w.stored} is listed as ${w.spelled}; it keeps its row until the address move`);
  const section = waitingSummary(pins);
  if (section) jobSummary(section);
  const roster = new Set(feed.map((p) => p.url));
  const toDelist = [];
  const toRelist = [];
  let listed = 0;
  let listedBefore = 0;
  for (const r of rows) {
    const url = String(r.url);
    const onList = roster.has(url);
    if (onList) listed++;
    if (r.delisted_at == null) listedBefore++;
    if (!onList && r.delisted_at == null) toDelist.push(url);
    else if (onList && r.delisted_at != null) toRelist.push(url);
  }
  const base = Math.max(feed.length, listedBefore);
  if (toDelist.length > base * maxDelistShare) {
    throw new Error(
      `syncRoster: ${toDelist.length} of ${base} listed sites would be delisted at once, more than ` +
        `${Math.round(maxDelistShare * 100)}%; refusing (check data/feed.json: did upstream rewrite the addresses?). ` +
        `For a real upstream cleanup, run the sync once with ${CLEANUP_SHARE_ENV} set to the share to allow (for example 0.3).`
    );
  }
  const stamp = now.toISOString();
  const stmts = [];
  for (const part of chunks(toDelist)) {
    stmts.push({
      sql: `UPDATE portfolios SET delisted_at = ? WHERE url IN (${part.map(() => "?").join(",")})`,
      args: [stamp, ...part],
    });
  }
  for (const part of chunks(toRelist)) {
    stmts.push({
      sql: `UPDATE portfolios SET delisted_at = NULL WHERE url IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
  }
  if (stmts.length) await db.batch(stmts, "write");
  return { delisted: toDelist.length, relisted: toRelist.length, listed, waiting: pins.waiting.length };
}

/**
 * Delete rows delisted for at least `days` days, and their screenshots.
 * Votes and ratings are kept: the vote log is the source of truth for ELO and
 * the leaderboard only shows roster URLs, so rankings stay consistent.
 * `deleteShots(shotKey)` removes a capture's files from R2; when it throws,
 * that row is kept and retried on the next run.
 *
 * A row whose site is still listed under another address (the feed's rule,
 * pipeline/list-key.mjs feedKeyer, when `feed` is given; rule 1 alone
 * without it, which only ever keeps more) holds that site's grade, votes and
 * screenshots and is never purged; scripts/repair-respelled-sites.mjs merges it.
 */
export async function purgeDelisted(
  db,
  { now = new Date(), days = PURGE_AFTER_DAYS, deleteShots, dryRun = false, log = console.log, feed = null } = {}
) {
  await ensureRosterSchema(db);
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const due = (
    await db.execute({
      sql: "SELECT url, shot_key FROM portfolios WHERE delisted_at IS NOT NULL AND delisted_at <= ?",
      args: [cutoff],
    })
  ).rows.map((r) => ({ url: String(r.url), shotKey: r.shot_key == null ? null : String(r.shot_key) }));
  if (due.length) {
    const keyOf = feed ? feedKeyer(feed) : listKey;
    const listedKeys = new Set(
      (await db.execute("SELECT url FROM portfolios WHERE delisted_at IS NULL")).rows.map((r) => keyOf(String(r.url)))
    );
    for (let i = due.length - 1; i >= 0; i--) {
      if (listedKeys.has(keyOf(due[i].url))) {
        log(`kept ${due[i].url}: the same site is listed under another spelling (run scripts/repair-respelled-sites.mjs)`);
        due.splice(i, 1);
      }
    }
  }
  const total = Number((await db.execute("SELECT COUNT(*) AS n FROM portfolios")).rows[0].n);
  if (due.length && due.length > total * PURGE_MAX_SHARE) {
    throw new Error(
      `purgeDelisted: ${due.length} of ${total} rows are due, more than ${PURGE_MAX_SHARE * 100}%; refusing (check data/feed.json)`
    );
  }
  let purged = 0;
  let failed = 0;
  for (const row of due) {
    if (dryRun) {
      log(`would purge ${row.url}`);
      continue;
    }
    try {
      if (row.shotKey && deleteShots) await deleteShots(row.shotKey);
      await db.batch(
        [
          { sql: "DELETE FROM portfolios WHERE url = ? AND delisted_at IS NOT NULL", args: [row.url] },
          { sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi:${row.url}`, `inspect:${row.url}`] },
        ],
        "write"
      );
      purged++;
    } catch (e) {
      failed++;
      log(`purge failed for ${row.url}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  return { due: due.length, purged, failed };
}

// Capture retry backoff after an `error`: 1, 2, 4, 8, 16 days, then 30 days.
export function captureRetryAt(attempts, now = new Date()) {
  const days = Math.min(30, 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + days * 86400000).toISOString();
}

/**
 * The feed entries capture.mjs should work on: new sites, and failed captures
 * whose retry date has come. Skips sites already captured, delisted or
 * confirmed down. A failed capture with no retry date waits for the health
 * check to pass it (which sets retry_at).
 *
 * A retry counts as due when it falls within RETRY_SLACK_MS of now: the
 * nightly run starts at the same time each night, so a retry set while
 * last night's run was in progress lands minutes after tonight's start and
 * would otherwise wait a whole extra night.
 */
const RETRY_SLACK_MS = 6 * 3600000;

export async function dueForCapture(db, entries, now = new Date()) {
  const notDue = await db.execute({
    sql: `SELECT url FROM portfolios
          WHERE status = 'live'
             OR NOT (${ACTIVE()})
             OR (status != 'pending' AND (retry_at IS NULL OR retry_at > ?))`,
    args: [new Date(now.getTime() + RETRY_SLACK_MS).toISOString()],
  });
  const skip = new Set(notDue.rows.map((r) => String(r.url)));
  return entries.filter((p) => !skip.has(p.url));
}

/** Load data/feed.json. */
export async function loadFeed(root) {
  const fs = await import("fs");
  return JSON.parse(fs.readFileSync(path.join(root, "data", "feed.json"), "utf8"));
}
