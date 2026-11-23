// A site back from the archive starts completely fresh (owner, 2026-11-23:
// "It shouldn't keep its old votes because if they're uploading a new thing
// and it was deleted before ... It can't keep its own votes. We don't know if
// it's the same thing."). Whenever it comes back after it was archived, day 5
// or day 200: no old votes, rating, tier, grade, face-off history, likes,
// claim, owner verification or review decisions. It is captured, measured and
// ranked from code exactly like a site listed for the first time.
// (A site back from the temporary POOL, never archived, keeps everything:
// the same site having a bad week, pipeline/not-working.mjs.)
//
// How: every row about the old site moves to a closed-off key,
//   archived:<YYYY-MM-DD>:<address>
// which is never a web address, so no list, roster sync, sitemap or page ever
// reads it, and the returning site, under its address, has nothing to
// inherit. The history stays, as history. Moving one side of a face-off to the
// closed key leaves the other site's rating exactly as it was: the ratings are
// replayed from the vote log (lib/tiers-rating.mjs rateFaceoffs), and the
// closed key plays the old site's part in that replay move for move (an
// archived site is off the list, so it has no starting seed either way);
// tests/archive-return.test.mjs measures it.
//
// Per table (RETIRE below), for the old address and every spelling of it with
// the same list key (pipeline/list-key.mjs) that still has a row:
//   moved to the closed key (history, never read for the new site):
//     portfolios (its old grade, captures and facts; delisted, so the 30-day
//     purge deletes the row and its screenshots), votes (winner, loser and
//     pair_key; the star counts follow through their trigger), tier_ratings
//     (out of the library), tier_undo, ratings (the old ELO board),
//     site_ratings, rank_history, rating_resets, site_fingerprints,
//     comparisons (the address inside its ranking), likes, list_items (lists
//     show only listed sites, so it drops out of them), claim_log,
//     status_reviews (the owner's and the rules' decisions on the old site; a
//     waiting row is closed first), rubric_history, capture_changes,
//     player_visits, gem_watch, quiz_guesses
//   deleted: state about the old site (health_marks, refresh_failures,
//     site_freshness, night_item_failures, its cache entries, an emptied
//     star_counts row), and rows that pages list without asking for a listed
//     site: claims and portfolio_owner (a verified owner's claim does not carry
//     over; claim_log keeps the history), regrade_requests, problem_reports
//   left as they are (records of what happened, never read for a listed
//     site's standing): health_returns (the log of this return), night_sites,
//     gemini_requests, quizzes (past games), poll_options (a past poll keeps
//     its option), people_requests and grade_jobs (visitors' own grade
//     requests), discovery_sites, matchups (one served pair per rater)

import { columnsOf } from "./not-working.mjs";
import { listKey } from "./list-key.mjs";

/** The closed-off key the old site's rows move to on an archive return on `day` (YYYY-MM-DD). */
export const archivedKey = (url, day) => `archived:${day}:${url}`;
/** Whether an address is such a key (never a site). */
export const isArchivedKey = (url) => String(url ?? "").startsWith("archived:");
/** SQL (never NULL): the column `col` is not such a key. */
export const NOT_ARCHIVED_KEY_SQL = (col) => `substr(COALESCE(${col}, ''), 1, 9) != 'archived:'`;

/** [table, column]: rows moved to the closed key. */
export const RETIRE_RENAME = [
  ["portfolios", "url"],
  ["votes", "winner"],
  ["votes", "loser"],
  ["tier_ratings", "url"],
  ["tier_undo", "w"],
  ["tier_undo", "l"],
  ["ratings", "url"],
  ["site_ratings", "url"],
  ["rank_history", "url"],
  ["rating_resets", "url"],
  ["site_fingerprints", "url"],
  ["likes", "url"],
  ["list_items", "url"],
  ["claim_log", "url"],
  ["status_reviews", "url"],
  ["rubric_history", "url"],
  ["capture_changes", "url"],
  ["player_visits", "url"],
  ["gem_watch", "url"],
  ["quiz_guesses", "url"],
];
/**
 * [table, column]: rows deleted. State about the old site, and the rows whose
 * readers list them without asking for a listed site (claims counted on /me
 * and in the claims review, an owner's verification, a waiting re-grade, open
 * visitor reports on the admin page): kept, they would show under the closed
 * key; their history stays in claim_log and the review rows.
 */
export const RETIRE_DELETE = [
  ["health_marks", "url"],
  ["refresh_failures", "url"],
  ["site_freshness", "url"],
  ["night_item_failures", "item"],
  ["claims", "url"],
  ["portfolio_owner", "url"],
  ["regrade_requests", "url"],
  ["problem_reports", "url"],
];

/**
 * Retires the old site behind an address that came back from the archive, so
 * the returning site starts fresh (see the header). `url`: the archived
 * entry's address. Idempotent: a second call finds nothing under the address.
 * `dryRun` counts and writes nothing. Returns { key, urls, moved: { "table.column": n },
 * deleted: { "table.column": n } } (only the non-zero counts).
 */
export async function retireArchivedSite(db, url, { now = new Date(), dryRun = false } = {}) {
  const day = now.toISOString().slice(0, 10);
  const have = new Map();
  const cols = async (t) => {
    if (!have.has(t)) have.set(t, await columnsOf(db, t));
    return have.get(t);
  };
  // The address and every spelling of the same site that still has a row.
  const key = listKey(url);
  const urls = new Set([url]);
  if ((await cols("portfolios")).has("url")) {
    for (const r of (await db.execute("SELECT url FROM portfolios")).rows) {
      const u = String(r.url);
      if (!/^archived:/.test(u) && listKey(u) === key) urls.add(u);
    }
  }
  const moved = {};
  const deleted = {};
  const stmts = [];
  // A listed row under the address is never the old site's (an archived address is kept off the list until
  // this has run): it is never moved.
  const count = async (t, c, u) =>
    Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?${t === "portfolios" ? " AND delisted_at IS NOT NULL" : ""}`, args: [u] })).rows[0].n);
  for (const u of urls) {
    const to = archivedKey(u, day);
    for (const [t, c] of RETIRE_RENAME) {
      if (!(await cols(t)).has(c)) continue;
      const n = await count(t, c, u);
      if (!n) continue;
      moved[`${t}.${c}`] = (moved[`${t}.${c}`] ?? 0) + n;
      if (t === "status_reviews") {
        // A row still waiting is about the old site: closed with the reason, then moved with the rest.
        stmts.push({
          sql: "UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = 'rule:archive-return', applied = ? WHERE url = ? AND status = 'pending'",
          args: [now.toISOString(), JSON.stringify({ closed: "the site came back from the archive as a new site" }), u],
        });
        stmts.push({ sql: "UPDATE status_reviews SET url = ? WHERE url = ?", args: [to, u] });
      } else if (t === "portfolios") {
        // Off the list for good under the closed key (the 30-day purge takes it and its screenshots).
        stmts.push({ sql: "UPDATE portfolios SET url = ? WHERE url = ? AND delisted_at IS NOT NULL", args: [to, u] });
      } else if (t === "tier_ratings") {
        // Out of the library first (its histogram follows through the trigger), then moved.
        stmts.push({ sql: "UPDATE tier_ratings SET member = 0, dirty = 1 WHERE url = ? AND member = 1", args: [u] });
        stmts.push({ sql: "UPDATE tier_ratings SET url = ? WHERE url = ?", args: [to, u] });
      } else {
        stmts.push({ sql: `UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`, args: [to, u] });
      }
    }
    // The vote log's direction-free pair key (lib/elo.ts pairKey: the two addresses sorted, a newline between).
    if ((await cols("votes")).has("pair_key")) {
      stmts.push({
        sql: "UPDATE votes SET pair_key = CASE WHEN winner < loser THEN winner || char(10) || loser ELSE loser || char(10) || winner END WHERE winner = ? OR loser = ?",
        args: [to, to],
      });
    }
    // The address inside the stored rankings (JSON text) of the ranking job's comparisons.
    if ((await cols("comparisons")).has("ranking")) {
      const quoted = JSON.stringify(u);
      const n = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM comparisons WHERE instr(ranking, ?) > 0 OR instr(COALESCE(shown, ''), ?) > 0", args: [quoted, quoted] })).rows[0].n);
      if (n) {
        moved["comparisons.ranking"] = (moved["comparisons.ranking"] ?? 0) + n;
        stmts.push({
          sql: "UPDATE comparisons SET ranking = replace(ranking, ?1, ?2), shown = replace(shown, ?1, ?2) WHERE instr(ranking, ?1) > 0 OR instr(COALESCE(shown, ''), ?1) > 0",
          args: [quoted, JSON.stringify(to)],
        });
      }
    }
    for (const [t, c] of RETIRE_DELETE) {
      if (!(await cols(t)).has(c)) continue;
      const n = await count(t, c, u);
      if (!n) continue;
      deleted[`${t}.${c}`] = (deleted[`${t}.${c}`] ?? 0) + n;
      stmts.push({ sql: `DELETE FROM ${t} WHERE ${c} = ?`, args: [u] });
    }
    if ((await cols("cache")).has("k")) {
      const n = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM cache WHERE k IN (?, ?)", args: [`psi:${u}`, `inspect:${u}`] })).rows[0].n);
      if (n) {
        deleted["cache.k"] = (deleted["cache.k"] ?? 0) + n;
        stmts.push({ sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi:${u}`, `inspect:${u}`] });
      }
    }
    // The star count the votes' trigger moved to the closed key leaves an emptied row behind.
    if ((await cols("star_counts")).has("url")) stmts.push({ sql: "DELETE FROM star_counts WHERE url = ? AND n <= 0", args: [u] });
  }
  if (!dryRun && stmts.length) await db.batch(stmts, "write");
  return { key: archivedKey(url, day), urls: [...urls], moved, deleted };
}
