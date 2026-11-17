// Merging a split site: when the community list respells a site, the old row
// (delisted, with the grade, votes and screenshots) and the new row (listed)
// have the same key (pipeline/list-key.mjs). A merge moves the old row and
// everything keyed by its address into the listed row, one transaction per
// site. Run by hand: scripts/repair-respelled-sites.mjs.
//
//   - the grade: the better of the two (a real grade beats an error or none),
//     the other one goes to rubric_history; the capture: whichever is live;
//   - votes move; a moved vote that duplicates one the listed row already has
//     (same rater and pair) or a vote of the site against itself is dropped,
//     and its ELO points are taken back; ratings add up;
//   - tier and leaderboard rows move when the listed row has none; when both
//     have one the old goes and the caller recomputes (plan.needsRecompute);
//     tier membership is then set by the same trigger rule as any row change.
//
// What happens to each table is SITE_TABLES below; a test checks every table
// of lib/schema.mjs is in SITE_TABLES, LEFT_AS_IS or NO_SITE_ADDRESS, and that
// every unique constraint on a moved column survives a clash.

// What a capture measured: taken from the old row when only it is live.
const CAPTURE_COLUMNS = [
  "status", "reason", "shot_key", "meta", "checked_at", "captured_at", "final_url", "signals", "needs_review",
  "page_text", "facts", "facts_at", "capture_attempts", "retry_at",
];

/** Every table that holds a site's address, and what a merge does with it. */
export const SITE_TABLES = {
  portfolios: "the old row merges into the listed one: the better grade, the live capture",
  votes: "moved; drops only a moved vote that duplicates one of the listed row (same rater and pair) or of the site against itself",
  star_counts: "kept by the votes triggers (lib/schema.mjs); recounted only where they are missing",
  ratings: "moved; ELO points added up, less those of dropped votes",
  likes: "moved",
  list_items: "moved",
  portfolio_owner: "moved; a hidden grade or a removal from either is kept",
  claims: "moved; when an owner claimed both, the stronger claim is kept (verified, review, pending)",
  claim_log: "moved",
  regrade_requests: "moved",
  status_reviews: "moved",
  rubric_history: "moved; also records the grade the merge did not keep",
  rating_resets: "moved",
  rank_history: "moved",
  comparisons: "addresses in shown and ranking rewritten",
  quizzes: "addresses in urls rewritten",
  quiz_guesses: "moved",
  poll_options: "portfolio_url moved",
  gem_watch: "moved",
  player_visits: "moved",
  site_fingerprints: "follow the capture",
  site_freshness: "follow the capture",
  tier_ratings: "moved when the listed row has none; else dropped and recomputed (scripts/refresh-tiers.mjs)",
  site_ratings: "moved when the listed row has none; else dropped and recomputed (scripts/recompute-ratings.mjs)",
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

const CLAIM_STRENGTH = { verified: 3, review: 2, pending: 1 };
const STAR_TRIGGERS = ["votes_star_insert", "votes_star_delete", "votes_star_update"];
const JSON_COLUMNS = [["comparisons", "shown"], ["comparisons", "ranking"], ["quizzes", "urls"]];
// lib/elo.ts pairKey (a TypeScript file this module cannot import).
const pairKey = (a, b) => [a, b].sort().join("\n");

/** 3 a real grade of a portfolio (a tier, no error), 2 a real "not a portfolio", 1 an error or unreadable, 0 none. */
export function gradeRank(json) {
  if (json == null) return 0;
  let g;
  try {
    g = JSON.parse(String(json));
  } catch {
    return 1;
  }
  if (!g || typeof g !== "object" || g.error || typeof g.tier !== "string" || !g.tier) return 1;
  return g.is_portfolio === false ? 2 : 3;
}

/** A statement using ?1 (old address) and maybe ?2 (listed), with exactly those arguments (a remote server refuses extras). */
function bind(sql, from, to) {
  const used = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return { sql, args: [from, to].slice(0, used) };
}

/** The database's tables: Map(table -> { columns, unique: [Set] }) and its triggers. */
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
 * The JSON columns that name any of `froms`, read once for all pairs (a full
 * read of each table, outside any transaction): Map(from -> [{ table, col, id, value }]).
 */
export async function jsonHits(db, froms, schema) {
  const hits = new Map(froms.map((f) => [f, []]));
  const needles = froms.map((f) => [f, JSON.stringify(f)]);
  for (const [t, c] of JSON_COLUMNS) {
    if (!schema.has(t) || !schema.get(t).columns.has(c)) continue;
    for (const r of (await db.execute(`SELECT id, ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL`)).rows) {
      // One object per row, shared by every pair it names, so each plan rewrites what the last one left.
      const hit = { table: t, col: c, id: r.id, value: String(r.v) };
      for (const [f, needle] of needles) if (hit.value.includes(needle)) hits.get(f).push(hit);
    }
  }
  return hits;
}

function rewriteJson(value, from, to) {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => rewriteJson(v, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteJson(v, from, to)]));
  return value;
}

/**
 * What merging the old row `from` into the listed row `to` takes:
 * { from, to, portfolios, counts, orphanShots, needsRecompute, guard, statements }.
 * Reads only. `guard` is the first statement of the transaction: it aborts it
 * when the votes or claims of the two addresses changed since this plan.
 */
export async function planMove(db, { from, to, now = new Date() }, { schema, json = null } = {}) {
  const has = (t, ...c) => schema.has(t) && c.every((x) => schema.get(t).columns.has(x));
  const uniqueOn = (t, c) => schema.get(t).unique.some((u) => u.has(c));
  const S = (sql) => bind(sql, from, to);
  const count = async (sql) => Number((await db.execute(S(sql))).rows[0].n);
  const stmts = [];
  const counts = {};
  const orphanShots = [];
  let needsRecompute = false;

  const row = async (u) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [u] })).rows[0];
  const old = await row(from);
  const cur = await row(to);
  if (!old || !cur) throw new Error(`${!old ? from : to} has no row`);
  const takeGrade = gradeRank(old.ai_rubric) > gradeRank(cur.ai_rubric);
  const captureMoves = cur.status !== "live" && old.status === "live";
  const lost = takeGrade ? cur.ai_rubric : old.ai_rubric;
  if (lost != null && has("rubric_history", "url", "rubric", "replaced_at")) {
    let g = {};
    try {
      g = JSON.parse(String(lost)) ?? {};
    } catch {
      // Kept as text.
    }
    stmts.push({
      sql: "INSERT INTO rubric_history (url, model, tier, is_portfolio, rubric, judged_at, replaced_at, replaced_by_model) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      args: [to, g.model ?? null, g.tier ?? null, g.is_portfolio == null ? null : g.is_portfolio ? 1 : 0, String(lost), g.judged_at ?? null, now.toISOString()],
    });
  }
  const cols = [...(takeGrade ? ["ai_rubric"] : []), ...(captureMoves ? CAPTURE_COLUMNS : [])].filter((x) => schema.get("portfolios").columns.has(x));
  if (cols.length) stmts.push(S(`UPDATE portfolios SET (${cols.join(", ")}) = (SELECT ${cols.join(", ")} FROM portfolios WHERE url = ?1) WHERE url = ?2`));
  const shot = (r) => (r.shot_key == null ? null : String(r.shot_key));
  if (captureMoves && shot(cur) && shot(cur) !== shot(old)) orphanShots.push(shot(cur));
  if (!captureMoves && shot(old) && shot(old) !== shot(cur)) orphanShots.push(shot(old));
  stmts.push(S("DELETE FROM portfolios WHERE url = ?1"));
  const portfolios = `the row keeps ${takeGrade ? "the old grade" : "its own grade"} and ${captureMoves ? "the old capture" : "its own capture"}`;

  // votes
  let voteCount = 0;
  const ratingFixes = [];
  if (has("votes", "id", "winner", "loser", "rater_id")) {
    const withDelta = has("votes", "delta");
    const votes = (await db.execute(S(`SELECT id, winner, loser, rater_id${withDelta ? ", delta" : ""} FROM votes WHERE winner IN (?1, ?2) OR loser IN (?1, ?2) ORDER BY id`))).rows;
    voteCount = votes.length;
    const map = (u) => (String(u) === from ? to : String(u));
    const isMoved = (v) => String(v.winner) === from || String(v.loser) === from;
    const groups = new Map();
    for (const v of votes) {
      const k = `${v.rater_id}\n${pairKey(map(v.winner), map(v.loser))}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    const drop = [];
    for (const group of groups.values()) {
      const self = group.filter((v) => map(v.winner) === map(v.loser));
      const rest = group.filter((v) => !self.includes(v));
      drop.push(...self);
      if (rest.some((v) => !isMoved(v))) drop.push(...rest.filter(isMoved));
    }
    counts.votes = votes.filter(isMoved).length;
    if (drop.length) counts["votes dropped"] = drop.length;
    for (const v of drop) {
      stmts.push({ sql: "DELETE FROM votes WHERE id = ?", args: [v.id] });
      if (has("tier_undo", "vote_id")) stmts.push({ sql: "DELETE FROM tier_undo WHERE vote_id = ?", args: [v.id] });
      if (withDelta && v.delta != null) ratingFixes.push({ winner: map(v.winner), loser: map(v.loser), delta: Number(v.delta) });
    }
    if (counts.votes) {
      stmts.push(S("UPDATE votes SET winner = ?2 WHERE winner = ?1"));
      stmts.push(S("UPDATE votes SET loser = ?2 WHERE loser = ?1"));
      // OR IGNORE: an old duplicate that shares a pair key keeps its old key rather than being dropped.
      if (has("votes", "pair_key")) for (const v of votes) if (isMoved(v) && !drop.includes(v)) stmts.push({ sql: "UPDATE OR IGNORE votes SET pair_key = ? WHERE id = ?", args: [pairKey(map(v.winner), map(v.loser)), v.id] });
    }
    if (has("star_counts", "url", "n") && has("votes", "starred") && !STAR_TRIGGERS.every((t) => schema.triggers?.has(t))) {
      for (const w of new Set([to, ...votes.map((v) => String(v.winner))])) {
        stmts.push({ sql: "DELETE FROM star_counts WHERE url = ?", args: [w] });
        stmts.push({ sql: "INSERT INTO star_counts (url, n) SELECT winner, COUNT(*) FROM votes WHERE starred = 1 AND winner = ? GROUP BY winner", args: [w] });
      }
    }
  }

  // ratings: ELO is 1200 plus the points each vote moved, so two histories add up.
  if (has("ratings", "url", "elo", "votes")) {
    counts.ratings = await count("SELECT COUNT(*) AS n FROM ratings WHERE url = ?1");
    if (counts.ratings) {
      stmts.push(S("UPDATE ratings SET elo = elo + (SELECT elo - 1200 FROM ratings WHERE url = ?1), votes = votes + (SELECT votes FROM ratings WHERE url = ?1) WHERE url = ?2 AND EXISTS (SELECT 1 FROM ratings WHERE url = ?1)"));
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
  let claimCount = 0;
  if (has("claims", "id", "url", "owner", "status")) {
    const claims = (await db.execute(S("SELECT id, url, owner, status FROM claims WHERE url IN (?1, ?2) ORDER BY id"))).rows;
    claimCount = claims.length;
    counts.claims = claims.filter((c) => String(c.url) === from).length;
    const strength = (c) => CLAIM_STRENGTH[String(c.status)] ?? 0;
    for (const c of claims.filter((x) => String(x.url) === from)) {
      const other = claims.find((x) => String(x.url) === to && String(x.owner) === String(c.owner));
      if (other) stmts.push({ sql: "DELETE FROM claims WHERE id = ?", args: [(strength(c) > strength(other) ? other : c).id] });
    }
    if (counts.claims) stmts.push(S("UPDATE claims SET url = ?2 WHERE url = ?1"));
  }

  // Plain moves; where a unique constraint covers the column, the listed row's wins a clash.
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
    if (captureMoves) {
      stmts.push(S(`DELETE FROM ${t} WHERE url = ?2 AND EXISTS (SELECT 1 FROM ${t} WHERE url = ?1)`));
      stmts.push(S(`UPDATE ${t} SET url = ?2 WHERE url = ?1`));
    } else {
      stmts.push(S(`DELETE FROM ${t} WHERE url = ?1`));
    }
  }

  // Addresses inside JSON (read once for all pairs: jsonHits).
  for (const h of json?.get(from) ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(h.value);
    } catch {
      continue;
    }
    const next = JSON.stringify(rewriteJson(parsed, from, to));
    if (next === JSON.stringify(parsed)) continue;
    counts[`${h.table}.${h.col}`] = (counts[`${h.table}.${h.col}`] ?? 0) + 1;
    stmts.push({ sql: `UPDATE ${h.table} SET ${h.col} = ? WHERE id = ?`, args: [next, h.id] });
    h.value = next;
  }

  // Tier and leaderboard rows: moved when the listed row has none; else the caller recomputes.
  for (const t of ["tier_ratings", "site_ratings"]) {
    if (!has(t, "url")) continue;
    counts[t] = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE url = ?1`);
    if (!counts[t]) continue;
    if (await count(`SELECT COUNT(*) AS n FROM ${t} WHERE url = ?2`)) needsRecompute = true;
    stmts.push(S(`UPDATE OR IGNORE ${t} SET url = ?2 WHERE url = ?1`));
    stmts.push(S(`DELETE FROM ${t} WHERE url = ?1`));
  }
  if (has("night_item_failures", "item")) stmts.push(S("DELETE FROM night_item_failures WHERE item = ?1"));
  if (has("cache", "k")) stmts.push({ sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi:${from}`, `inspect:${from}`] });
  // Last: touch the listed row so lib/tiers-db.mjs tier_member_sync sets its tier
  // membership from the final state (the moved tier row may carry member = 0 from its delisted days).
  stmts.push(S("UPDATE portfolios SET delisted_at = delisted_at WHERE url = ?2"));

  // The guard: aborts the transaction (a NOT NULL failure) when what the plan read has changed.
  const guard = {
    sql: `INSERT INTO cache (k, v, at) SELECT 'repair:stale-plan', NULL, 0
          WHERE NOT EXISTS (SELECT 1 FROM portfolios WHERE url = ?1) OR NOT EXISTS (SELECT 1 FROM portfolios WHERE url = ?2)
             ${has("votes", "winner") ? "OR (SELECT COUNT(*) FROM votes WHERE winner IN (?1, ?2) OR loser IN (?1, ?2)) != ?3" : "OR ?3 IS NULL"}
             ${has("claims", "url") ? "OR (SELECT COUNT(*) FROM claims WHERE url IN (?1, ?2)) != ?4" : "OR ?4 IS NULL"}`,
    args: [from, to, voteCount, claimCount],
  };
  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  return { from, to, portfolios, counts, orphanShots, needsRecompute, guard, statements: stmts };
}

/** A plan whose guard found the database changed since it was planned. */
export class StalePlan extends Error {}

/** Runs a plan as one transaction, its guard first: all of it, or nothing (StalePlan when the guard tripped). */
export async function applyMove(db, plan) {
  try {
    await db.batch([plan.guard, ...plan.statements], "write");
  } catch (e) {
    if (/NOT NULL constraint failed: cache\.v/.test(String(e?.message ?? e))) throw new StalePlan(`${plan.from} changed since it was planned; skipped`);
    throw e;
  }
}

/** One line for logs. */
export function describeMove(plan) {
  const what = Object.entries(plan.counts).map(([t, n]) => `${t} ${n}`).join(", ") || "no other rows";
  return `${plan.from} -> ${plan.to}: ${plan.portfolios}; ${what}`;
}
