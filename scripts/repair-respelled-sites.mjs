#!/usr/bin/env node
// One-off repair: give back the history of sites whose address the community
// list only spelled another way (a trailing slash, www, http, upper case, a
// tracking parameter). Before pipeline/generate_feed.py kept a site's
// spelling, such an edit made the new spelling a new, ungraded site and
// delisted the old row with its grade, votes and screenshots.
//
// It finds every row that is not on data/feed.json whose site is listed
// there under exactly one other spelling (pipeline/roster.mjs sameSite), and
// moves that row's history to the listed spelling, each site in one
// transaction:
//   - the row itself: renamed when the listed spelling has no row yet; else
//     the listed row takes the old row's capture and grade when it has no
//     grade (or no capture) of its own, and the old row is deleted;
//   - votes, ratings (ELO points added up), likes, list entries, owner
//     settings and claims, review and grade history, game plays, poll
//     options and the rating engine's comparisons (SITE_TABLES below);
//   - derived rows (tier and leaderboard ratings, caches, parked night
//     items) of the old spelling are dropped and rebuilt by their jobs.
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
import { pipelineDb, siteOf, sameSite } from "../pipeline/roster.mjs";

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
 * missed.
 */
export const SITE_TABLES = {
  portfolios: "renamed, or the listed row takes the old row's capture and grade; the old row is deleted",
  votes: "winner and loser moved; pair_key recomputed (lib/elo.ts pairKey)",
  star_counts: "recounted from the moved votes",
  ratings: "moved; when both spellings have one, the ELO points each won are added up",
  likes: "moved (a rater who liked both keeps one)",
  list_items: "moved (a list that had both keeps one)",
  portfolio_owner: "moved; when both have one, a hidden grade or a removal from either is kept",
  claims: "moved (an owner who claimed both keeps one)",
  claim_log: "moved",
  regrade_requests: "moved",
  status_reviews: "moved",
  rubric_history: "moved",
  rating_resets: "moved",
  rank_history: "moved (a week that has both keeps the listed one)",
  comparisons: "addresses in shown and ranking rewritten",
  quizzes: "addresses in urls rewritten",
  quiz_guesses: "moved",
  poll_options: "portfolio_url moved",
  gem_watch: "moved",
  player_visits: "moved",
  tier_undo: "w and l moved",
  site_fingerprints: "follow the capture: moved when the listed row takes the old capture, else dropped",
  site_freshness: "follow the capture: moved when the listed row takes the old capture, else dropped",
  tier_ratings: "old row dropped, the listed one marked for the daily run (rebuilt by scripts/refresh-tiers.mjs)",
  site_ratings: "old rows dropped (rebuilt by scripts/recompute-ratings.mjs)",
  night_item_failures: "old rows dropped (failure counts of an address no job uses any more)",
  cache: "psi: and inspect: entries of the old spelling dropped",
};

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

// lib/elo.ts pairKey (a TypeScript file this script cannot import).
const pairKey = (a, b) => [a, b].sort().join("\n");

async function columnsOf(db) {
  const tables = new Map();
  const names = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  for (const t of names) {
    tables.set(t, new Set((await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name))));
  }
  return tables;
}

/**
 * The repairs to make: every row not on the feed whose site is listed under
 * exactly one other spelling. Returns [{ from, to }] and the rows it could not
 * pair (more than one listed spelling of the site).
 */
export async function findRespelled(db, feed) {
  const listed = feed.map((p) => p.url);
  const onFeed = new Set(listed);
  const bySite = new Map();
  for (const u of listed) {
    const s = siteOf(u);
    if (!bySite.has(s.site)) bySite.set(s.site, []);
    bySite.get(s.site).push({ url: u, s });
  }
  const pairs = [];
  const ambiguous = [];
  const rows = (await db.execute("SELECT url FROM portfolios ORDER BY delisted_at IS NULL, delisted_at, url")).rows;
  for (const r of rows) {
    const from = String(r.url);
    if (onFeed.has(from)) continue;
    const s = siteOf(from);
    const hits = (bySite.get(s.site) ?? []).filter((t) => sameSite(s, t.s));
    if (hits.length === 1) pairs.push({ from, to: hits[0].url });
    else if (hits.length > 1) ambiguous.push({ from, candidates: hits.map((h) => h.url) });
  }
  return { pairs, ambiguous };
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
export async function planMove(db, { from, to }, cols = null) {
  cols ??= await columnsOf(db);
  const has = (t, ...c) => cols.has(t) && c.every((x) => cols.get(t).has(x));
  const count = async (sql, args = [from, to]) => Number((await db.execute({ sql, args })).rows[0].n);
  const stmts = [];
  const counts = {};
  const orphanShots = [];
  const A = [from, to];

  // portfolios
  const row = async (u) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [u] })).rows[0];
  const old = await row(from);
  const cur = await row(to);
  let portfolios;
  let captureMoves;
  if (!cur) {
    portfolios = "renamed";
    captureMoves = true;
    stmts.push({ sql: "UPDATE portfolios SET url = ?2, delisted_at = NULL WHERE url = ?1", args: A });
  } else {
    captureMoves = (cur.ai_rubric == null && old.ai_rubric != null) || (cur.status !== "live" && old.status === "live");
    const shot = (r) => (r.shot_key == null ? null : String(r.shot_key));
    if (captureMoves) {
      portfolios = "the listed row takes the old capture and grade";
      const c = CAPTURE_COLUMNS.filter((x) => cols.get("portfolios").has(x));
      stmts.push({
        sql: `UPDATE portfolios SET (${c.join(", ")}) = (SELECT ${c.join(", ")} FROM portfolios WHERE url = ?1) WHERE url = ?2`,
        args: A,
      });
      if (shot(cur) && shot(cur) !== shot(old)) orphanShots.push(shot(cur));
    } else {
      portfolios = "the listed row keeps its own capture and grade";
      if (shot(old) && shot(old) !== shot(cur)) orphanShots.push(shot(old));
    }
    stmts.push({ sql: "DELETE FROM portfolios WHERE url = ?1", args: A });
  }

  // votes, their pair keys and the star counts
  if (has("votes", "winner", "loser")) {
    const votes = (await db.execute({ sql: "SELECT id, winner, loser FROM votes WHERE winner = ?1 OR loser = ?1", args: [from] })).rows;
    counts.votes = votes.length;
    if (votes.length) {
      stmts.push({ sql: "UPDATE votes SET winner = ?2 WHERE winner = ?1", args: A });
      stmts.push({ sql: "UPDATE votes SET loser = ?2 WHERE loser = ?1", args: A });
      if (has("votes", "pair_key")) {
        for (const v of votes) {
          const w = String(v.winner) === from ? to : String(v.winner);
          const l = String(v.loser) === from ? to : String(v.loser);
          // OR IGNORE: a rater who voted on the same pair under both spellings keeps the first.
          stmts.push({ sql: "UPDATE OR IGNORE votes SET pair_key = ? WHERE id = ?", args: [pairKey(w, l), v.id] });
        }
      }
    }
    if (has("star_counts", "url", "n") && has("votes", "starred")) {
      stmts.push({ sql: "DELETE FROM star_counts WHERE url IN (?1, ?2)", args: A });
      stmts.push({
        sql: "INSERT INTO star_counts (url, n) SELECT winner, COUNT(*) FROM votes WHERE starred = 1 AND winner = ?2 GROUP BY winner",
        args: A,
      });
    }
  }

  // ratings: ELO is 1200 plus the points each vote moved, so two histories add up.
  if (has("ratings", "url", "elo", "votes")) {
    counts.ratings = await count("SELECT COUNT(*) AS n FROM ratings WHERE url = ?1");
    stmts.push({
      sql: `UPDATE ratings SET elo = elo + (SELECT elo - 1200 FROM ratings WHERE url = ?1),
              votes = votes + (SELECT votes FROM ratings WHERE url = ?1)
            WHERE url = ?2 AND EXISTS (SELECT 1 FROM ratings WHERE url = ?1)`,
      args: A,
    });
    stmts.push({ sql: "UPDATE OR IGNORE ratings SET url = ?2 WHERE url = ?1", args: A });
    stmts.push({ sql: "DELETE FROM ratings WHERE url = ?1", args: A });
  }

  // portfolio_owner: the owner's choices on either spelling hold for the site.
  if (has("portfolio_owner", "url", "hide_grade", "removed_at", "removed_by")) {
    counts.portfolio_owner = await count("SELECT COUNT(*) AS n FROM portfolio_owner WHERE url = ?1");
    const after = has("portfolio_owner", "remove_after")
      ? ", remove_after = CASE WHEN removed_at IS NULL THEN (SELECT remove_after FROM portfolio_owner WHERE url = ?1) ELSE remove_after END"
      : "";
    stmts.push({
      sql: `UPDATE portfolio_owner SET
              hide_grade = MAX(hide_grade, (SELECT hide_grade FROM portfolio_owner WHERE url = ?1)),
              removed_by = CASE WHEN removed_at IS NULL THEN (SELECT removed_by FROM portfolio_owner WHERE url = ?1) ELSE removed_by END
              ${after},
              removed_at = COALESCE(removed_at, (SELECT removed_at FROM portfolio_owner WHERE url = ?1))
            WHERE url = ?2 AND EXISTS (SELECT 1 FROM portfolio_owner WHERE url = ?1)`,
      args: A,
    });
    stmts.push({ sql: "UPDATE OR IGNORE portfolio_owner SET url = ?2 WHERE url = ?1", args: A });
    stmts.push({ sql: "DELETE FROM portfolio_owner WHERE url = ?1", args: A });
  }

  // Plain moves, and moves where the listed spelling's row wins a clash.
  const plain = [
    ["claim_log", "url"], ["regrade_requests", "url"], ["status_reviews", "url"], ["rubric_history", "url"],
    ["rating_resets", "url"], ["quiz_guesses", "url"], ["poll_options", "portfolio_url"], ["tier_undo", "w"], ["tier_undo", "l"],
  ];
  for (const [t, c] of plain) {
    if (!has(t, c)) continue;
    const n = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?1`);
    counts[t] = (counts[t] ?? 0) + n;
    if (n) stmts.push({ sql: `UPDATE ${t} SET ${c} = ?2 WHERE ${c} = ?1`, args: A });
  }
  for (const t of ["likes", "list_items", "claims", "rank_history", "gem_watch", "player_visits"]) {
    if (!has(t, "url")) continue;
    const n = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE url = ?1`);
    counts[t] = n;
    if (!n) continue;
    stmts.push({ sql: `UPDATE OR IGNORE ${t} SET url = ?2 WHERE url = ?1`, args: A });
    stmts.push({ sql: `DELETE FROM ${t} WHERE url = ?1`, args: A });
  }

  // State that belongs to a capture.
  for (const t of ["site_fingerprints", "site_freshness"]) {
    if (!has(t, "url")) continue;
    counts[t] = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE url = ?1`);
    if (!counts[t]) continue;
    if (captureMoves) {
      stmts.push({ sql: `DELETE FROM ${t} WHERE url = ?2`, args: A });
      stmts.push({ sql: `UPDATE ${t} SET url = ?2 WHERE url = ?1`, args: A });
    } else {
      stmts.push({ sql: `DELETE FROM ${t} WHERE url = ?1`, args: A });
    }
  }

  // Addresses inside JSON.
  for (const [t, c] of [["comparisons", "shown"], ["comparisons", "ranking"], ["quizzes", "urls"]]) {
    if (!has(t, "id", c)) continue;
    const needle = JSON.stringify(from);
    const hits = (await db.execute({ sql: `SELECT id, ${c} AS v FROM ${t} WHERE instr(${c}, ?) > 0`, args: [needle] })).rows;
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
    stmts.push({ sql: "DELETE FROM tier_ratings WHERE url = ?1", args: A });
    stmts.push({ sql: "UPDATE tier_ratings SET dirty = 1 WHERE url = ?2", args: A });
  }
  if (has("site_ratings", "url")) {
    counts.site_ratings = await count("SELECT COUNT(*) AS n FROM site_ratings WHERE url = ?1");
    stmts.push({ sql: "DELETE FROM site_ratings WHERE url = ?1", args: A });
  }
  if (has("night_item_failures", "item")) {
    counts.night_item_failures = await count("SELECT COUNT(*) AS n FROM night_item_failures WHERE item = ?1");
    stmts.push({ sql: "DELETE FROM night_item_failures WHERE item = ?1", args: A });
  }
  if (has("cache", "k")) {
    stmts.push({ sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi:${from}`, `inspect:${from}`] });
  }

  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  return { from, to, portfolios, counts, orphanShots, statements: stmts };
}

/** Runs one site's move as a single transaction: all of it or none of it. */
export async function applyMove(db, plan) {
  await db.batch(plan.statements, "write");
}

/** The whole repair: plans every pair, and with `write` applies each in its own transaction. */
export async function repairRespelled(db, feed, { write = false, only = null, log = console.log } = {}) {
  const { pairs, ambiguous } = await findRespelled(db, feed);
  const cols = await columnsOf(db);
  const todo = only ? pairs.filter((p) => p.from === only) : pairs;
  const plans = [];
  for (const pair of todo) {
    // Plan each against the database as the moves before it left it.
    const plan = await planMove(db, pair, cols);
    plans.push(plan);
    const what = Object.entries(plan.counts).map(([t, n]) => `${t} ${n}`).join(", ") || "no other rows";
    log(`${write ? "moving" : "would move"} ${plan.from} -> ${plan.to}: ${plan.portfolios}; ${what}`);
    if (write) await applyMove(db, plan);
  }
  for (const a of ambiguous) log(`skipped ${a.from}: listed under more than one spelling (${a.candidates.join(", ")})`);
  const orphanShots = plans.flatMap((p) => p.orphanShots);
  log(
    `${plans.length} site(s) ${write ? "repaired" : "to repair (dry run; --write applies it)"}, ${ambiguous.length} skipped.` +
      (orphanShots.length ? ` Screenshots no row refers to${write ? "" : " after --write"}: ${orphanShots.join(", ")}.` : "")
  );
  if (write && plans.length) log("Next: node scripts/recompute-ratings.mjs and node scripts/refresh-tiers.mjs");
  return { plans, ambiguous, orphanShots };
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
  await repairRespelled(db, feed, { write: args.includes("--write"), only: flag("--only") });
}
