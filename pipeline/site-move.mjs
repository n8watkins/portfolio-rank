// Moving a listed site to the address the community list spells it with now.
//
// A site's address is its key in many tables (votes, ratings, likes, lists,
// owner settings, claims, review and grade history, ...). When the list only
// changes how the address is written (pipeline/list-key.mjs: the same key),
// the site's row and everything keyed by it move to the new spelling, one
// transaction per site, so the feed, the database, capture, the health check
// and the app all use the list's current spelling and the site keeps its
// history. The same code runs nightly (pipeline/roster.mjs syncRoster, for a
// new spelling with no row yet) and once by hand
// (scripts/repair-respelled-sites.mjs, also for sites split before this,
// where both spellings have a row).
//
// What happens to each table is SITE_TABLES below; a test checks every table
// of lib/schema.mjs is in SITE_TABLES, LEFT_AS_IS or NO_SITE_ADDRESS, and that
// every unique constraint on a moved column survives a clash.
//
// Screenshots: the row keeps its shot_key, so the images stored under the old
// address's key stay the row's images. Nothing derives a key from the address
// except a new capture (pipeline/capture.mjs keyOf), which writes the new
// spelling's key; the old key's files are then no longer used (R2 keeps them).

import { keysForList } from "./list-key.mjs";

// What a capture measured, and what a grade decided: taken separately when
// two rows of one site are merged.
const CAPTURE_COLUMNS = [
  "status", "reason", "shot_key", "meta", "checked_at", "captured_at", "final_url", "signals", "needs_review",
  "page_text", "facts", "facts_at", "capture_attempts", "retry_at",
];
const GRADE_COLUMNS = ["ai_rubric"];

/** Every table that holds a site's address, and what a move does with it. */
export const SITE_TABLES = {
  portfolios: "renamed; merged into an existing row: the grade from whichever has one, the capture from whichever is live",
  votes: "moved; where the move makes two votes of one rater on one pair, the earliest stays; a vote of the site against itself goes",
  star_counts: "kept by the votes triggers (lib/schema.mjs); recounted only where they are missing",
  ratings: "moved; when both addresses have one, the ELO points each won are added up, less those of dropped votes",
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
  site_fingerprints: "follow the capture: moved with it, else dropped",
  site_freshness: "follow the capture: moved with it, else dropped",
  tier_ratings: "old row dropped, the new one marked for the daily run (rebuilt by scripts/refresh-tiers.mjs)",
  site_ratings: "old rows dropped (rebuilt by scripts/recompute-ratings.mjs)",
  night_item_failures: "old rows dropped (failure counts of an address no job uses any more)",
  cache: "psi: and inspect: entries of the old address dropped",
};

/** Columns moved by a plain UPDATE (or, where a unique constraint covers it, UPDATE OR IGNORE then the leftovers deleted). */
export const MOVED_COLUMNS = [
  ["likes", "url"], ["list_items", "url"], ["claim_log", "url"], ["regrade_requests", "url"], ["status_reviews", "url"],
  ["rubric_history", "url"], ["rating_resets", "url"], ["rank_history", "url"], ["quiz_guesses", "url"],
  ["poll_options", "portfolio_url"], ["gem_watch", "url"], ["player_visits", "url"],
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
  site_moves: "the record of the moves themselves",
};

/** Tables with no site address in them (tier_undo.w and .l are packed rating deltas, lib/tiers-db.mjs pack). */
export const NO_SITE_ADDRESS = [
  "ai_image_calls", "badge_checks", "badges", "content_guidelines", "content_jobs", "content_runs", "content_settings",
  "content_topics", "discovery_sources", "email_accounts", "email_sends", "email_signin_tokens", "game_totals",
  "gemini_daily", "goal_events", "goal_progress", "grade_emails", "grade_links", "image_library",
  "image_library_considered", "image_library_overrides", "image_library_uses", "limit_snapshots", "lists",
  "model_watch_runs", "newsletter_issues", "newsletter_settings", "newsletter_switch_log", "night_runs",
  "pexels_searches", "player_counters", "poll_generations", "poll_votes", "polls", "quiz_plays", "ranking_runs",
  "rate_limits", "schema_meta", "session_revocations", "sqlite_sequence", "tavily_credits", "tier_hist", "tier_meta",
  "tier_undo", "vote_totals",
];

// Claim statuses, strongest first (lib/games/claims.mjs).
const CLAIM_STRENGTH = { verified: 3, review: 2, pending: 1 };
// The triggers that keep star_counts in step with votes (lib/schema.mjs COUNTERS).
const STAR_TRIGGERS = ["votes_star_insert", "votes_star_delete", "votes_star_update"];

// lib/elo.ts pairKey (a TypeScript file this module cannot import).
const pairKey = (a, b) => [a, b].sort().join("\n");

/**
 * A statement that uses ?1 (the old address) and maybe ?2 (the new one),
 * with exactly the arguments it uses: a remote libSQL server (Turso, sqld)
 * rejects extra ones ("too many parameters").
 */
function bind(sql, from, to) {
  const used = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return { sql, args: [from, to].slice(0, used) };
}

/** The database's tables: Map(table -> { columns: Set, unique: [Set of columns] }) and its triggers. */
export async function schemaOf(db) {
  const tables = new Map();
  const master = (await db.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger')")).rows;
  for (const t of master.filter((r) => r.type === "table").map((r) => String(r.name))) {
    const info = (await db.execute(`PRAGMA table_info("${t}")`)).rows;
    const unique = [];
    const pk = info.filter((r) => Number(r.pk) > 0).map((r) => String(r.name));
    if (pk.length) unique.push(new Set(pk));
    for (const ix of (await db.execute(`PRAGMA index_list("${t}")`)).rows) {
      if (Number(ix.unique) !== 1) continue;
      unique.push(new Set((await db.execute(`PRAGMA index_info("${String(ix.name)}")`)).rows.map((r) => String(r.name))));
    }
    tables.set(t, { columns: new Set(info.map((r) => String(r.name))), unique });
  }
  tables.triggers = new Set(master.filter((r) => r.type === "trigger").map((r) => String(r.name)));
  return tables;
}

/**
 * The moves a feed asks for. For each entry, the stored rows with its key
 * (keysForList over the feed) that are not themselves on the feed:
 *   moves   the entry has no row and exactly one stored row has its key:
 *           move that row to the entry's spelling (the nightly case);
 *   merges  the entry has a row and other rows have its key (sites split
 *           before moves existed; the one-off repair);
 *   skipped more than one row could be the entry's, or more than one entry
 *           has the key: nothing is moved, the rows wait for a person.
 */
export async function findRespellings(db, feed) {
  const urls = feed.map((p) => p.url);
  const keyOf = keysForList(urls);
  const onFeed = new Set(urls);
  const rows = (await db.execute("SELECT url FROM portfolios ORDER BY delisted_at IS NULL, delisted_at, url")).rows.map((r) => String(r.url));
  const stored = new Set(rows);
  const offFeed = new Map();
  for (const u of rows) {
    if (onFeed.has(u)) continue;
    const k = keyOf(u);
    if (!offFeed.has(k)) offFeed.set(k, []);
    offFeed.get(k).push(u);
  }
  const entries = new Map();
  for (const u of urls) {
    const k = keyOf(u);
    if (!entries.has(k)) entries.set(k, []);
    entries.get(k).push(u);
  }
  const moves = [];
  const merges = [];
  const skipped = [];
  for (const [k, list] of entries) {
    const cands = offFeed.get(k) ?? [];
    if (!cands.length) continue;
    if (list.length > 1) {
      skipped.push({ key: k, entries: list, rows: cands });
      continue;
    }
    const to = list[0];
    if (stored.has(to)) for (const from of cands) merges.push({ from, to });
    else if (cands.length === 1) moves.push({ from: cands[0], to });
    else skipped.push({ key: k, entries: list, rows: cands });
  }
  return { moves, merges, skipped };
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
 * Reads only; `statements` is the transaction applyMove runs. `from` may have
 * no portfolios row (history left on an address after its row moved).
 */
export async function planMove(db, { from, to, now = new Date() }, schema = null) {
  schema ??= await schemaOf(db);
  const has = (t, ...c) => schema.has(t) && c.every((x) => schema.get(t).columns.has(x));
  const uniqueOn = (t, c) => schema.get(t).unique.some((u) => u.has(c));
  const S = (sql) => bind(sql, from, to);
  const count = async (sql) => Number((await db.execute(S(sql))).rows[0].n);
  const stmts = [];
  const counts = {};
  const orphanShots = [];

  // portfolios: one row per site.
  const row = async (u) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [u] })).rows[0];
  const old = await row(from);
  const cur = await row(to);
  let portfolios;
  let captureMoves = false;
  const shot = (r) => (r?.shot_key == null ? null : String(r.shot_key));
  if (!old) {
    portfolios = "no row (history left on the old address)";
  } else if (!cur) {
    portfolios = "renamed";
    captureMoves = true;
    stmts.push(S("UPDATE portfolios SET url = ?2 WHERE url = ?1"));
  } else {
    // Decided apart: the grade from whichever row has one (the new row's first), the capture from whichever is live.
    const takeGrade = cur.ai_rubric == null && old.ai_rubric != null;
    captureMoves = cur.status !== "live" && old.status === "live";
    const cols = [...(takeGrade ? GRADE_COLUMNS : []), ...(captureMoves ? CAPTURE_COLUMNS : [])].filter((x) => schema.get("portfolios").columns.has(x));
    if (cols.length) stmts.push(S(`UPDATE portfolios SET (${cols.join(", ")}) = (SELECT ${cols.join(", ")} FROM portfolios WHERE url = ?1) WHERE url = ?2`));
    const parts = [takeGrade ? "the old grade" : "its own grade", captureMoves ? "the old capture" : "its own capture"];
    portfolios = `merged: the row keeps ${parts.join(" and ")}`;
    if (captureMoves && shot(cur) && shot(cur) !== shot(old)) orphanShots.push(shot(cur));
    if (!captureMoves && shot(old) && shot(old) !== shot(cur)) orphanShots.push(shot(old));
    stmts.push(S("DELETE FROM portfolios WHERE url = ?1"));
  }

  // votes: moved; only duplicates the move itself makes are collapsed.
  const ratingFixes = [];
  const winners = new Set([to]);
  if (has("votes", "id", "winner", "loser", "rater_id")) {
    const withDelta = has("votes", "delta");
    const votes = (
      await db.execute(S(`SELECT id, winner, loser, rater_id${withDelta ? ", delta" : ""} FROM votes
                          WHERE winner IN (?1, ?2) OR loser IN (?1, ?2) ORDER BY id`))
    ).rows;
    const map = (u) => (String(u) === from ? to : String(u));
    const isMoved = (v) => String(v.winner) === from || String(v.loser) === from;
    const groups = new Map();
    for (const v of votes) {
      const k = `${v.rater_id}\n${pairKey(map(v.winner), map(v.loser))}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    const drop = [];
    const rekey = [];
    for (const group of groups.values()) {
      // A group with no moved vote is left exactly as it is (old duplicates included).
      if (!group.some(isMoved)) continue;
      // A vote that did not move is never touched. A moved vote goes when it
      // would be the site against itself, or when the rater already has a vote
      // on that pair; among moved votes alone, the earliest stays.
      const valid = group.filter((v) => map(v.winner) !== map(v.loser));
      drop.push(...group.filter((v) => !valid.includes(v)));
      const stays = valid.find((v) => !isMoved(v)) ?? valid[0];
      for (const v of valid) if (v !== stays && isMoved(v)) drop.push(v);
      if (stays && isMoved(stays)) rekey.push({ id: stays.id, key: pairKey(map(stays.winner), map(stays.loser)) });
    }
    counts.votes = votes.filter(isMoved).length;
    if (drop.length) counts["votes dropped (made duplicate or self-vote by the move)"] = drop.length;
    for (const v of votes) winners.add(String(v.winner));
    for (const v of drop) {
      stmts.push({ sql: "DELETE FROM votes WHERE id = ?", args: [v.id] });
      if (has("tier_undo", "vote_id")) stmts.push({ sql: "DELETE FROM tier_undo WHERE vote_id = ?", args: [v.id] });
      if (withDelta && v.delta != null) ratingFixes.push({ winner: map(v.winner), loser: map(v.loser), delta: Number(v.delta) });
    }
    if (counts.votes) {
      stmts.push(S("UPDATE votes SET winner = ?2 WHERE winner = ?1"));
      stmts.push(S("UPDATE votes SET loser = ?2 WHERE loser = ?1"));
      if (has("votes", "pair_key")) for (const r of rekey) stmts.push({ sql: "UPDATE votes SET pair_key = ? WHERE id = ?", args: [r.key, r.id] });
    }
    // The triggers keep star_counts in this same transaction; without them, recount.
    if (has("star_counts", "url", "n") && has("votes", "starred") && !STAR_TRIGGERS.every((t) => schema.triggers?.has(t))) {
      for (const w of winners) {
        stmts.push({ sql: "DELETE FROM star_counts WHERE url = ?", args: [w] });
        stmts.push({ sql: "INSERT INTO star_counts (url, n) SELECT winner, COUNT(*) FROM votes WHERE starred = 1 AND winner = ? GROUP BY winner", args: [w] });
      }
    }
  }

  // ratings: ELO is 1200 plus the points each vote moved, so two histories add up.
  if (has("ratings", "url", "elo", "votes")) {
    counts.ratings = await count("SELECT COUNT(*) AS n FROM ratings WHERE url = ?1");
    if (counts.ratings) {
      stmts.push(
        S(`UPDATE ratings SET elo = elo + (SELECT elo - 1200 FROM ratings WHERE url = ?1),
             votes = votes + (SELECT votes FROM ratings WHERE url = ?1)
           WHERE url = ?2 AND EXISTS (SELECT 1 FROM ratings WHERE url = ?1)`)
      );
      stmts.push(S("UPDATE OR IGNORE ratings SET url = ?2 WHERE url = ?1"));
      stmts.push(S("DELETE FROM ratings WHERE url = ?1"));
    }
    for (const f of ratingFixes) {
      stmts.push({ sql: "UPDATE ratings SET elo = elo - ?, votes = MAX(votes - 1, 0) WHERE url = ?", args: [f.delta, f.winner] });
      stmts.push({ sql: "UPDATE ratings SET elo = elo + ?, votes = MAX(votes - 1, 0) WHERE url = ?", args: [f.delta, f.loser] });
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
      if (other) stmts.push({ sql: "DELETE FROM claims WHERE id = ?", args: [(strength(c) > strength(other) ? other : c).id] });
    }
    if (counts.claims) stmts.push(S("UPDATE claims SET url = ?2 WHERE url = ?1"));
  }

  // Plain moves; where a unique constraint covers the column, the new address's row wins a clash.
  for (const [t, c] of MOVED_COLUMNS) {
    if (!has(t, c)) continue;
    const n = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?1`);
    if (!n) continue;
    counts[t] = n;
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
    if (counts.tier_ratings) stmts.push(S("DELETE FROM tier_ratings WHERE url = ?1"));
    stmts.push(S("UPDATE tier_ratings SET dirty = 1 WHERE url = ?2"));
  }
  if (has("site_ratings", "url")) {
    counts.site_ratings = await count("SELECT COUNT(*) AS n FROM site_ratings WHERE url = ?1");
    if (counts.site_ratings) stmts.push(S("DELETE FROM site_ratings WHERE url = ?1"));
  }
  if (has("night_item_failures", "item")) {
    counts.night_item_failures = await count("SELECT COUNT(*) AS n FROM night_item_failures WHERE item = ?1");
    if (counts.night_item_failures) stmts.push(S("DELETE FROM night_item_failures WHERE item = ?1"));
  }
  if (has("cache", "k")) stmts.push({ sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi:${from}`, `inspect:${from}`] });

  // The record, so history cast on the old address later follows (sweepMoves).
  if (has("site_moves", "from_url", "to_url", "moved_at")) {
    stmts.push(S("DELETE FROM site_moves WHERE from_url = ?2"));
    stmts.push({ sql: "INSERT INTO site_moves (from_url, to_url, moved_at) VALUES (?, ?, ?) ON CONFLICT(from_url) DO UPDATE SET to_url = excluded.to_url, moved_at = excluded.moved_at", args: [from, to, now.toISOString()] });
  }

  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  const history = Object.keys(counts).length > 0;
  return { from, to, portfolios, counts, orphanShots, statements: stmts, needed: Boolean(old) || history };
}

/** Runs one site's move as a single transaction: all of it or none of it. */
export async function applyMove(db, plan) {
  await db.batch(plan.statements, "write");
}

/** One line for logs and the run summary. */
export function describeMove(plan) {
  const what = Object.entries(plan.counts).map(([t, n]) => `${t} ${n}`).join(", ") || "no other rows";
  return `${plan.from} -> ${plan.to}: ${plan.portfolios}; ${what}`;
}

// A move's old address is watched this long for history cast on it while the
// site still showed it (the app serves the feed it was deployed with).
export const SWEEP_DAYS = 14;

/**
 * Moves history that landed on an old address after its site moved (a vote
 * or a like from a page still showing it). Only for recent moves whose old
 * address has no row and is not on the feed, and whose new address has a row.
 */
export async function sweepMoves(db, feed, { now = new Date(), log = console.warn } = {}) {
  const schema = await schemaOf(db);
  if (!schema.has("site_moves")) return [];
  const onFeed = new Set(feed.map((p) => p.url));
  const since = new Date(now.getTime() - SWEEP_DAYS * 86400000).toISOString();
  const recent = (
    await db.execute({
      sql: `SELECT m.from_url, m.to_url FROM site_moves m
            WHERE m.moved_at >= ? AND EXISTS (SELECT 1 FROM portfolios WHERE url = m.to_url)
              AND NOT EXISTS (SELECT 1 FROM portfolios WHERE url = m.from_url)`,
      args: [since],
    })
  ).rows.map((r) => ({ from: String(r.from_url), to: String(r.to_url) }));
  const swept = [];
  for (const pair of recent.filter((p) => !onFeed.has(p.from))) {
    const plan = await planMove(db, { ...pair, now }, schema);
    if (!plan.needed) continue;
    await applyMove(db, plan);
    swept.push(plan);
    log(`moved history left on ${describeMove(plan)}`);
  }
  return swept;
}
