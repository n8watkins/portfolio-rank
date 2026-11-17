#!/usr/bin/env node
// One-off repair: give back the history of sites whose address the community
// list only spelled another way (a trailing slash, www, http, upper case, a
// tracking parameter). Before the feed build kept a site's stored address
// (pipeline/build-feed.mjs), such an edit made the new spelling a new,
// ungraded site and delisted the old row with its grade, votes and
// screenshots.
//
// For every feed entry, every other row with the same list key
// (pipeline/list-key.mjs) is merged into the entry's address, each row in its
// own transaction:
//   - the row itself: renamed when the entry's address has no row yet; else
//     the listed row takes the old row's capture and grade when it has no
//     grade (or no live capture) of its own, and the old row is deleted;
//   - votes: moved, one vote kept per rater and pair (the earliest), a vote
//     of the site against itself deleted, ELO points of deleted votes taken
//     back, star counts recounted;
//   - ratings (ELO points added up), likes, list entries, owner settings,
//     claims (the strongest per owner), review and grade history, game rows,
//     poll options and the rating engine's comparisons (SITE_TABLES below).
//     Where a unique constraint clashes, the listed address's row is kept;
//   - derived rows (tier and leaderboard ratings, caches, parked night items)
//     of the old address are dropped and rebuilt by their jobs.
// A row that fails is reported and the run goes on with the next one.
//
// Dry run by default: prints what it would do and changes nothing.
//
//   node scripts/repair-respelled-sites.mjs                   dry run, local database
//   pass-env run -- node scripts/repair-respelled-sites.mjs   dry run, production (TURSO_DATABASE_URL)
//   ... --write                                               apply it
//   ... --feed FILE                                           another feed.json
//   ... --only URL                                            one old address only
//
// After --write: node scripts/recompute-ratings.mjs and node scripts/refresh-tiers.mjs
// rebuild the leaderboards and the tiers from the moved votes. Screenshots
// no row refers to any more are listed at the end (R2 keeps them until they
// are deleted by hand; nothing reads them).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listKey } from "../pipeline/list-key.mjs";
import { pipelineDb } from "../pipeline/roster.mjs";

const ROOT = path.join(import.meta.dirname, "..");

// The capture and grade a listed row takes over from the old row.
const CAPTURE_COLUMNS = [
  "status", "reason", "shot_key", "meta", "checked_at", "captured_at", "ai_rubric", "final_url",
  "signals", "needs_review", "page_text", "facts", "facts_at",
];

/**
 * Every table that holds a site's address, and what the repair does with it.
 * tests/roster-address-edit.test.mjs checks that each table of lib/schema.mjs
 * is here, in LEFT_AS_IS or in NO_SITE_ADDRESS, so a new table cannot be
 * missed, and that every unique constraint on a moved column survives a clash.
 */
export const SITE_TABLES = {
  portfolios: "renamed, or the listed row takes the old row's capture and grade; the old row is deleted",
  votes: "moved; one vote per rater and pair (the earliest), none of a site against itself; pair_key recomputed",
  star_counts: "recounted from the votes",
  ratings: "moved; when both addresses have one, the ELO points each won are added up, less those of deleted votes",
  likes: "moved",
  list_items: "moved",
  portfolio_owner: "moved; when both have one, a hidden grade or a removal from either is kept",
  claims: "moved; when an owner claimed both, the stronger claim is kept (verified, review, pending)",
  claim_log: "moved",
  regrade_requests: "moved",
  status_reviews: "moved",
  rubric_history: "moved",
  rating_resets: "moved",
  rank_history: "moved",
  comparisons: "addresses in shown and ranking rewritten",
  quizzes: "addresses in urls rewritten",
  quiz_guesses: "moved",
  poll_options: "portfolio_url moved",
  gem_watch: "moved",
  player_visits: "moved",
  tier_undo: "w and l moved; rows of deleted votes dropped",
  site_fingerprints: "follow the capture: moved when the listed row takes the old capture, else dropped",
  site_freshness: "follow the capture: moved when the listed row takes the old capture, else dropped",
  tier_ratings: "old row dropped, the listed one marked for the daily run (rebuilt by scripts/refresh-tiers.mjs)",
  site_ratings: "old rows dropped (rebuilt by scripts/recompute-ratings.mjs)",
  night_item_failures: "old rows dropped (failure counts of an address no job uses any more)",
  cache: "psi: and inspect: entries of the old address dropped",
};

/** Columns moved by a plain UPDATE (or, where a unique constraint covers it, UPDATE OR IGNORE then the leftovers deleted). */
export const MOVED_COLUMNS = [
  ["likes", "url"], ["list_items", "url"], ["claim_log", "url"], ["regrade_requests", "url"], ["status_reviews", "url"],
  ["rubric_history", "url"], ["rating_resets", "url"], ["rank_history", "url"], ["quiz_guesses", "url"],
  ["poll_options", "portfolio_url"], ["gem_watch", "url"], ["player_visits", "url"], ["tier_undo", "w"], ["tier_undo", "l"],
];

/** Tables that hold an address but are records of what someone typed or saw, not a site's history. */
export const LEFT_AS_IS = {
  people_requests: "what a person asked to have graded, as they typed it",
  grade_jobs: "a visitor's grade request, as typed; keyed by site_key, which a respelling does not change",
  grade_caps: "keyed by site key, which a respelling does not change",
  discovery_sites: "addresses discovery found, not the list",
  discovery_work: "discovery's own queue",
  gemini_requests: "a log of requests made",
  matchups: "the pair a rater was shown a moment ago; it expires",
  owner_alerts: "alerts already sent",
  posts: "published blog text",
  email_outbox: "emails already written",
};

/** Tables with no site address in them. */
export const NO_SITE_ADDRESS = [
  "ai_image_calls", "badge_checks", "badges", "content_guidelines", "content_jobs", "content_runs", "content_settings",
  "content_topics", "discovery_sources", "email_accounts", "email_sends", "email_signin_tokens", "game_totals",
  "gemini_daily", "goal_events", "goal_progress", "grade_emails", "grade_links", "image_library",
  "image_library_considered", "image_library_overrides", "image_library_uses", "limit_snapshots", "lists",
  "model_watch_runs", "newsletter_issues", "newsletter_settings", "newsletter_switch_log", "night_runs",
  "pexels_searches", "player_counters", "poll_generations", "poll_votes", "polls", "quiz_plays", "ranking_runs",
  "rate_limits", "schema_meta", "session_revocations", "sqlite_sequence", "tavily_credits", "tier_hist", "tier_meta",
  "vote_totals",
];

// Claim statuses, strongest first (lib/games/claims.mjs).
const CLAIM_STRENGTH = { verified: 3, review: 2, pending: 1 };

// lib/elo.ts pairKey (a TypeScript file this script cannot import).
const pairKey = (a, b) => [a, b].sort().join("\n");

/**
 * A statement that uses ?1 (the old address) and maybe ?2 (the listed one),
 * with exactly the arguments it uses: a remote libSQL server (Turso, sqld)
 * rejects extra ones ("too many parameters").
 */
function bind(sql, from, to) {
  const used = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return { sql, args: [from, to].slice(0, used) };
}

/** The database's tables: Map(table -> { columns: Set, unique: [Set of columns] }). */
export async function schemaOf(db) {
  const tables = new Map();
  const names = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  for (const t of names) {
    const info = (await db.execute(`PRAGMA table_info("${t}")`)).rows;
    const unique = [];
    const pk = info.filter((r) => Number(r.pk) > 0).map((r) => String(r.name));
    if (pk.length) unique.push(new Set(pk));
    for (const ix of (await db.execute(`PRAGMA index_list("${t}")`)).rows) {
      if (Number(ix.unique) !== 1) continue;
      const cols = (await db.execute(`PRAGMA index_info("${String(ix.name)}")`)).rows.map((r) => String(r.name));
      unique.push(new Set(cols));
    }
    tables.set(t, { columns: new Set(info.map((r) => String(r.name))), unique });
  }
  return tables;
}

/**
 * The repairs to make: for each feed entry, every other row with its list
 * key. Returns { pairs: [{ from, to }], skipped: [{ key, entries }] } (a key
 * that more than one feed entry has).
 */
export async function findRespelled(db, feed) {
  const entries = new Map();
  for (const p of feed) {
    const key = listKey(p.url);
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push(p.url);
  }
  const pairs = [];
  const skipped = [];
  const rows = (await db.execute("SELECT url FROM portfolios ORDER BY delisted_at IS NULL, delisted_at, url")).rows.map((r) => String(r.url));
  const seen = new Set();
  for (const from of rows) {
    const key = listKey(from);
    const to = entries.get(key);
    if (!to || to.includes(from)) continue;
    if (to.length > 1) {
      if (!seen.has(key)) skipped.push({ key, entries: to });
      seen.add(key);
      continue;
    }
    pairs.push({ from, to: to[0] });
  }
  return { pairs, skipped };
}

/** Rewrites every string equal to `from` inside parsed JSON. */
function rewriteJson(value, from, to) {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => rewriteJson(v, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteJson(v, from, to)]));
  return value;
}

/**
 * What moving `from` to `to` takes: { from, to, portfolios, counts, orphanShots, statements }.
 * Reads only; `statements` is the transaction applyMove runs.
 */
export async function planMove(db, { from, to }, schema = null) {
  schema ??= await schemaOf(db);
  const has = (t, ...c) => schema.has(t) && c.every((x) => schema.get(t).columns.has(x));
  const uniqueOn = (t, c) => schema.get(t).unique.some((u) => u.has(c));
  const S = (sql) => bind(sql, from, to);
  const count = async (sql) => Number((await db.execute(S(sql))).rows[0].n);
  const stmts = [];
  const counts = {};
  const orphanShots = [];

  // portfolios
  const row = async (u) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [u] })).rows[0];
  const old = await row(from);
  const cur = await row(to);
  let portfolios;
  let captureMoves;
  if (!cur) {
    portfolios = "renamed";
    captureMoves = true;
    stmts.push(S("UPDATE portfolios SET url = ?2, delisted_at = NULL WHERE url = ?1"));
  } else {
    captureMoves = (cur.ai_rubric == null && old.ai_rubric != null) || (cur.status !== "live" && old.status === "live");
    const shot = (r) => (r.shot_key == null ? null : String(r.shot_key));
    if (captureMoves) {
      portfolios = "the listed row takes the old capture and grade";
      const c = CAPTURE_COLUMNS.filter((x) => schema.get("portfolios").columns.has(x));
      stmts.push(S(`UPDATE portfolios SET (${c.join(", ")}) = (SELECT ${c.join(", ")} FROM portfolios WHERE url = ?1) WHERE url = ?2`));
      if (shot(cur) && shot(cur) !== shot(old)) orphanShots.push(shot(cur));
    } else {
      portfolios = "the listed row keeps its own capture and grade";
      if (shot(old) && shot(old) !== shot(cur)) orphanShots.push(shot(old));
    }
    stmts.push(S("DELETE FROM portfolios WHERE url = ?1"));
  }

  // votes: moved, then one per rater and pair, none of the site against itself.
  const ratingFixes = [];
  const winners = new Set([from, to]);
  if (has("votes", "id", "winner", "loser", "rater_id")) {
    const withDelta = has("votes", "delta");
    const votes = (
      await db.execute(S(`SELECT id, winner, loser, rater_id${withDelta ? ", delta" : ""} FROM votes
                          WHERE winner IN (?1, ?2) OR loser IN (?1, ?2) ORDER BY id`))
    ).rows;
    const map = (u) => (String(u) === from ? to : String(u));
    const keep = new Map();
    const drop = [];
    const repair = [];
    for (const v of votes) {
      const w = map(v.winner);
      const l = map(v.loser);
      const moved = String(v.winner) === from || String(v.loser) === from;
      winners.add(String(v.winner));
      if (w === l) {
        drop.push(v);
        continue;
      }
      const k = `${v.rater_id}\n${pairKey(w, l)}`;
      if (keep.has(k)) drop.push(v);
      else {
        keep.set(k, v);
        if (moved) repair.push({ id: v.id, key: pairKey(w, l) });
      }
    }
    counts.votes = votes.filter((v) => String(v.winner) === from || String(v.loser) === from).length;
    if (drop.length) counts["votes dropped (same rater and pair, or the site against itself)"] = drop.length;
    for (const v of drop) {
      stmts.push({ sql: "DELETE FROM votes WHERE id = ?", args: [v.id] });
      if (has("tier_undo", "vote_id")) stmts.push({ sql: "DELETE FROM tier_undo WHERE vote_id = ?", args: [v.id] });
      if (withDelta && v.delta != null) ratingFixes.push({ winner: map(v.winner), loser: map(v.loser), delta: Number(v.delta) });
    }
    if (counts.votes) {
      stmts.push(S("UPDATE votes SET winner = ?2 WHERE winner = ?1"));
      stmts.push(S("UPDATE votes SET loser = ?2 WHERE loser = ?1"));
      if (has("votes", "pair_key")) for (const r of repair) stmts.push({ sql: "UPDATE votes SET pair_key = ? WHERE id = ?", args: [r.key, r.id] });
    }
  }

  // ratings: ELO is 1200 plus the points each vote moved, so two histories add up.
  if (has("ratings", "url", "elo", "votes")) {
    counts.ratings = await count("SELECT COUNT(*) AS n FROM ratings WHERE url = ?1");
    stmts.push(
      S(`UPDATE ratings SET elo = elo + (SELECT elo - 1200 FROM ratings WHERE url = ?1),
           votes = votes + (SELECT votes FROM ratings WHERE url = ?1)
         WHERE url = ?2 AND EXISTS (SELECT 1 FROM ratings WHERE url = ?1)`)
    );
    stmts.push(S("UPDATE OR IGNORE ratings SET url = ?2 WHERE url = ?1"));
    stmts.push(S("DELETE FROM ratings WHERE url = ?1"));
    // A deleted vote's points go back.
    for (const f of ratingFixes) {
      stmts.push({ sql: "UPDATE ratings SET elo = elo - ?, votes = MAX(votes - 1, 0) WHERE url = ?", args: [f.delta, f.winner] });
      stmts.push({ sql: "UPDATE ratings SET elo = elo + ?, votes = MAX(votes - 1, 0) WHERE url = ?", args: [f.delta, f.loser] });
    }
  }
  if (has("star_counts", "url", "n") && has("votes", "starred")) {
    for (const w of winners) {
      stmts.push({ sql: "DELETE FROM star_counts WHERE url = ?", args: [w] });
      stmts.push({ sql: "INSERT INTO star_counts (url, n) SELECT winner, COUNT(*) FROM votes WHERE starred = 1 AND winner = ? GROUP BY winner", args: [w] });
    }
  }

  // portfolio_owner: the owner's choices on either address hold for the site.
  if (has("portfolio_owner", "url", "hide_grade", "removed_at", "removed_by")) {
    counts.portfolio_owner = await count("SELECT COUNT(*) AS n FROM portfolio_owner WHERE url = ?1");
    if (counts.portfolio_owner) {
      const after = has("portfolio_owner", "remove_after")
        ? ", remove_after = CASE WHEN removed_at IS NULL THEN (SELECT remove_after FROM portfolio_owner WHERE url = ?1) ELSE remove_after END"
        : "";
      stmts.push(
        S(`UPDATE portfolio_owner SET
             hide_grade = MAX(hide_grade, (SELECT hide_grade FROM portfolio_owner WHERE url = ?1)),
             removed_by = CASE WHEN removed_at IS NULL THEN (SELECT removed_by FROM portfolio_owner WHERE url = ?1) ELSE removed_by END
             ${after},
             removed_at = COALESCE(removed_at, (SELECT removed_at FROM portfolio_owner WHERE url = ?1))
           WHERE url = ?2 AND EXISTS (SELECT 1 FROM portfolio_owner WHERE url = ?1)`)
      );
      stmts.push(S("UPDATE OR IGNORE portfolio_owner SET url = ?2 WHERE url = ?1"));
      stmts.push(S("DELETE FROM portfolio_owner WHERE url = ?1"));
    }
  }

  // claims: one per owner and site; the stronger one stays.
  if (has("claims", "id", "url", "owner", "status")) {
    const claims = (await db.execute(S("SELECT id, url, owner, status FROM claims WHERE url IN (?1, ?2) ORDER BY id"))).rows;
    counts.claims = claims.filter((c) => String(c.url) === from).length;
    const strength = (c) => CLAIM_STRENGTH[String(c.status)] ?? 0;
    for (const c of claims.filter((x) => String(x.url) === from)) {
      const other = claims.find((x) => String(x.url) === to && String(x.owner) === String(c.owner));
      if (!other) continue;
      const loser = strength(c) > strength(other) ? other : c;
      stmts.push({ sql: "DELETE FROM claims WHERE id = ?", args: [loser.id] });
    }
    if (counts.claims) stmts.push(S("UPDATE claims SET url = ?2 WHERE url = ?1"));
  }

  // Plain moves; where a unique constraint covers the column, the listed address's row wins a clash.
  for (const [t, c] of MOVED_COLUMNS) {
    if (!has(t, c)) continue;
    const n = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?1`);
    if (!n) continue;
    counts[t] = (counts[t] ?? 0) + n;
    if (uniqueOn(t, c)) {
      stmts.push(S(`UPDATE OR IGNORE ${t} SET ${c} = ?2 WHERE ${c} = ?1`));
      stmts.push(S(`DELETE FROM ${t} WHERE ${c} = ?1`));
    } else {
      stmts.push(S(`UPDATE ${t} SET ${c} = ?2 WHERE ${c} = ?1`));
    }
  }

  // State that belongs to a capture.
  for (const t of ["site_fingerprints", "site_freshness"]) {
    if (!has(t, "url")) continue;
    counts[t] = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE url = ?1`);
    if (!counts[t]) continue;
    if (captureMoves) {
      stmts.push(S(`DELETE FROM ${t} WHERE url = ?2`));
      stmts.push(S(`UPDATE ${t} SET url = ?2 WHERE url = ?1`));
    } else {
      stmts.push(S(`DELETE FROM ${t} WHERE url = ?1`));
    }
  }

  // Addresses inside JSON.
  for (const [t, c] of [["comparisons", "shown"], ["comparisons", "ranking"], ["quizzes", "urls"]]) {
    if (!has(t, "id", c)) continue;
    const hits = (await db.execute({ sql: `SELECT id, ${c} AS v FROM ${t} WHERE instr(${c}, ?) > 0`, args: [JSON.stringify(from)] })).rows;
    let n = 0;
    for (const h of hits) {
      let parsed;
      try {
        parsed = JSON.parse(String(h.v));
      } catch {
        continue;
      }
      const next = JSON.stringify(rewriteJson(parsed, from, to));
      if (next === JSON.stringify(parsed)) continue;
      n++;
      stmts.push({ sql: `UPDATE ${t} SET ${c} = ? WHERE id = ?`, args: [next, h.id] });
    }
    counts[`${t}.${c}`] = n;
  }

  // Derived rows, rebuilt by their own jobs.
  if (has("tier_ratings", "url", "dirty")) {
    counts.tier_ratings = await count("SELECT COUNT(*) AS n FROM tier_ratings WHERE url = ?1");
    stmts.push(S("DELETE FROM tier_ratings WHERE url = ?1"));
    stmts.push(S("UPDATE tier_ratings SET dirty = 1 WHERE url = ?2"));
  }
  if (has("site_ratings", "url")) {
    counts.site_ratings = await count("SELECT COUNT(*) AS n FROM site_ratings WHERE url = ?1");
    stmts.push(S("DELETE FROM site_ratings WHERE url = ?1"));
  }
  if (has("night_item_failures", "item")) {
    counts.night_item_failures = await count("SELECT COUNT(*) AS n FROM night_item_failures WHERE item = ?1");
    stmts.push(S("DELETE FROM night_item_failures WHERE item = ?1"));
  }
  if (has("cache", "k")) {
    stmts.push({ sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi:${from}`, `inspect:${from}`] });
  }

  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  return { from, to, portfolios, counts, orphanShots, statements: stmts };
}

/** Runs one row's move as a single transaction: all of it or none of it. */
export async function applyMove(db, plan) {
  await db.batch(plan.statements, "write");
}

/**
 * The whole repair: plans every pair and, with `write`, applies each in its
 * own transaction. A pair that fails is reported and the rest go on.
 * Returns { plans, failed, skipped, orphanShots }.
 */
export async function repairRespelled(db, feed, { write = false, only = null, log = console.log } = {}) {
  const { pairs, skipped } = await findRespelled(db, feed);
  const schema = await schemaOf(db);
  const todo = only ? pairs.filter((p) => p.from === only) : pairs;
  const plans = [];
  const failed = [];
  for (const pair of todo) {
    try {
      // Planned against the database as the moves before it left it.
      const plan = await planMove(db, pair, schema);
      const what = Object.entries(plan.counts).map(([t, n]) => `${t} ${n}`).join(", ") || "no other rows";
      if (write) await applyMove(db, plan);
      plans.push(plan);
      log(`${write ? "moved" : "would move"} ${plan.from} -> ${plan.to}: ${plan.portfolios}; ${what}`);
    } catch (e) {
      failed.push({ ...pair, error: String(e?.message ?? e) });
      log(`FAILED ${pair.from} -> ${pair.to}: ${String(e?.message ?? e).slice(0, 200)} (nothing of it changed)`);
    }
  }
  for (const s of skipped) log(`skipped ${s.key}: more than one feed entry has it (${s.entries.join(", ")})`);
  const orphanShots = plans.flatMap((p) => p.orphanShots);
  log(
    `${plans.length} row(s) ${write ? "merged" : "to merge (dry run; --write applies it)"}, ${failed.length} failed, ${skipped.length} skipped.` +
      (orphanShots.length ? ` Screenshots no row refers to${write ? "" : " after --write"}: ${orphanShots.join(", ")}.` : "")
  );
  if (write && plans.length) log("Next: node scripts/recompute-ratings.mjs and node scripts/refresh-tiers.mjs");
  return { plans, failed, skipped, orphanShots };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const feedPath = flag("--feed") ?? path.join(ROOT, "data", "feed.json");
  const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  const db = pipelineDb(ROOT);
  console.log(`database: ${process.env.TURSO_DATABASE_URL ? "Turso (TURSO_DATABASE_URL)" : "local file"}; feed: ${feedPath} (${feed.length} entries)`);
  const r = await repairRespelled(db, feed, { write: args.includes("--write"), only: flag("--only") });
  process.exitCode = r.failed.length ? 1 : 0;
}
