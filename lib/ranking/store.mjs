// Database side of the rating engine: additive tables (idempotent, safe on
// the live database at any time), the import of existing votes, the
// redesign hook, and reading and writing what the recompute needs.
//
// The tables are in ./schema.mjs.
import { createHash } from "node:crypto";
import { engineSettings, PROMPT_VERSION_LEGACY } from "./config.mjs";
import { toIso, weekOf } from "./views.mjs";
import { quotaDay } from "../../pipeline/quota-day.mjs";
import { HIDDEN_WHERE } from "../hidden.mjs";
import { RANKING_AFTER, RANKING_COLUMNS, RANKING_TABLES } from "./schema.mjs";

/** Applies the rating engine's tables (./schema.mjs, also in lib/schema.mjs) to a database migrated before they existed. */
export async function ensureRankingSchema(db) {
  for (const sql of RANKING_TABLES) await db.execute(sql);
  for (const [table, column] of RANKING_COLUMNS) {
    const name = column.split(" ")[0];
    if ((await columnsOf(db, table)).has(name)) continue;
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  }
  for (const sql of RANKING_AFTER) await db.execute(sql);
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function columnsOf(db, table) {
  const res = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(res.rows.map((r) => String(r.name)));
}

/**
 * Mirrors the existing vote log into comparisons, so the new boards count
 * every human and AI vote cast so far. Idempotent (keyed by source
 * "vote:<id>"): new votes are added, practice votes claimed at sign-in
 * (rater_type anon -> human) are picked up, and votes undone since are
 * removed. Practice (anon) votes never count, as in the current ELO.
 * The order shown was not recorded for these votes, so `shown` is null.
 */
export async function syncVotes(db) {
  const votes = await readVoteComparisons(db);
  if (!votes) return { imported: 0, removed: 0 };
  const stmts = votes.map((c) => ({
    sql: `INSERT INTO comparisons (created_at, rater_type, rater_id, model, prompt_version, method, shown, ranking, outcome, starred, source)
          VALUES (?, ?, ?, ?, ?, 'one_on_one', NULL, ?, 'ranked', ?, ?)
          ON CONFLICT(source) DO UPDATE SET
            created_at = excluded.created_at, rater_type = excluded.rater_type, rater_id = excluded.rater_id,
            model = excluded.model, prompt_version = excluded.prompt_version, ranking = excluded.ranking,
            starred = excluded.starred
          WHERE comparisons.created_at IS NOT excluded.created_at OR comparisons.rater_type IS NOT excluded.rater_type
            OR comparisons.rater_id IS NOT excluded.rater_id OR comparisons.model IS NOT excluded.model
            OR comparisons.ranking IS NOT excluded.ranking OR comparisons.starred IS NOT excluded.starred`,
    args: [c.created_at, c.rater_type, c.rater_id, c.model, c.prompt_version, JSON.stringify(c.ranking), c.starred, c.source],
  }));
  let imported = 0;
  for (const part of chunks(stmts, 200)) {
    const out = await db.batch(part, "write");
    imported += out.reduce((n, o) => n + o.rowsAffected, 0);
  }
  const removed = await db.execute(
    `DELETE FROM comparisons WHERE source LIKE 'vote:%'
       AND CAST(substr(source, 6) AS INTEGER) NOT IN (SELECT id FROM votes WHERE rater_type IN ('human', 'ai'))`
  );
  return { imported, removed: removed.rowsAffected };
}

/**
 * The vote log (human and AI votes; practice votes never count) as
 * comparisons, without writing anything; null when there is no votes table.
 * Used by syncVotes and by a read-only recompute.
 */
export async function readVoteComparisons(db) {
  const have = await columnsOf(db, "votes");
  if (!have.size) return null;
  const col = (name, fallback = "NULL") => (have.has(name) ? name : fallback);
  const res = await db.execute(
    `SELECT id, winner, loser, rater_type, rater_id, created_at,
            ${col("model")} AS model, ${col("starred", "0")} AS starred
     FROM votes WHERE rater_type IN ('human', 'ai') ORDER BY id`
  );
  return res.rows.map((r) => ({
    id: -Number(r.id), // ordered before the job's own rows at the same second, never colliding with them
    source: `vote:${r.id}`,
    created_at: toIso(r.created_at),
    rater_type: String(r.rater_type),
    rater_id: String(r.rater_id),
    model: r.model == null ? null : String(r.model),
    prompt_version: r.rater_type === "ai" ? PROMPT_VERSION_LEGACY : null,
    rubric_version: null,
    method: "one_on_one",
    shown: null,
    ranking: [[String(r.winner)], [String(r.loser)]],
    outcome: "ranked",
    starred: Number(r.starred) ? 1 : 0,
    experiment: null,
    match_seed: null,
    match_kind: null,
  }));
}

/**
 * A page fingerprint from the capture's diagnostics (portfolios.meta): the
 * DOM shape and the set of CSS classes (pipeline/capture.mjs domHash and
 * classHash). A redesign changes both. Some rebuilds change hashed class
 * names too; a false alarm only raises a site's uncertainty (its mean
 * stays), which costs a few extra comparisons, never its place.
 */
export function pageFingerprint(meta) {
  let m = meta;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || (!m.domHash && !m.classHash)) return null;
  return createHash("sha1").update(`${m.domHash ?? ""}:${m.classHash ?? ""}`).digest("hex").slice(0, 20);
}

/**
 * The change-detection hook: records a site's page fingerprint and, when it
 * differs from the last one seen, adds an uncertainty reset at `at` (so the
 * next recompute lets the site move fast). The first fingerprint of a site
 * is its baseline, never a reset. Returns true when a reset was added.
 */
export async function recordFingerprint(db, url, fingerprint, at = new Date().toISOString()) {
  if (!fingerprint) return false;
  const iso = toIso(at);
  const prev = await db.execute({ sql: "SELECT fingerprint FROM site_fingerprints WHERE url = ?", args: [url] });
  const old = prev.rows[0]?.fingerprint == null ? null : String(prev.rows[0].fingerprint);
  if (old === fingerprint) {
    await db.execute({ sql: "UPDATE site_fingerprints SET last_seen = ? WHERE url = ? AND last_seen < ?", args: [iso, url, iso] });
    return false;
  }
  const stmts = [
    {
      sql: `INSERT INTO site_fingerprints (url, fingerprint, first_seen, last_seen) VALUES (?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET fingerprint = excluded.fingerprint, first_seen = excluded.first_seen, last_seen = excluded.last_seen`,
      args: [url, fingerprint, iso, iso],
    },
  ];
  if (old) {
    stmts.push({
      sql: "INSERT INTO rating_resets (url, at, reason, detail) VALUES (?, ?, 'page_changed', ?)",
      args: [url, iso, JSON.stringify({ from: old, to: fingerprint })],
    });
  }
  await db.batch(stmts, "write");
  return Boolean(old);
}

/** Runs the hook over every captured site (the recompute does this first). Returns the number of resets added. */
export async function detectPageChanges(db) {
  const res = await db.execute("SELECT url, meta, captured_at FROM portfolios WHERE meta IS NOT NULL");
  let resets = 0;
  for (const r of res.rows) {
    const fp = pageFingerprint(r.meta);
    if (fp && (await recordFingerprint(db, String(r.url), fp, r.captured_at ? String(r.captured_at) : undefined))) resets++;
  }
  return resets;
}

const parseJson = (v) => {
  if (v == null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

/** Only the parts of a grade the seed uses (what an export publishes). */
export const gradeForSeed = (g) =>
  g && !g.error && g.tier
    ? {
        tier: g.tier,
        quality_score: g.quality_score ?? null,
        visual_design: g.visual_design ?? null,
        five_second_test: g.five_second_test ?? null,
        storytelling: g.storytelling ?? null,
        writing: g.writing ?? null,
        memorability: g.memorability ?? null,
        rubric_version: g.rubric_version ?? 1,
        model: g.model ?? null,
        is_portfolio: g.is_portfolio ?? null,
      }
    : null;

/**
 * Everything a recompute needs, as plain data (also the export format):
 * sites with their grade and whether they are listed (on the list, not
 * confirmed down, not graded "not a portfolio"), every comparison, every reset.
 */
export async function loadInput(db, { readOnly = false } = {}) {
  const have = await columnsOf(db, "portfolios");
  const listedSql = [
    have.has("delisted_at") ? "delisted_at IS NULL" : "1",
    have.has("health") ? "COALESCE(health, '') != 'down'" : "1",
  ].join(" AND ");
  const sites = (
    await db.execute(`SELECT url, ${have.has("ai_rubric") ? "ai_rubric" : "NULL AS ai_rubric"}, (${listedSql}) AS listed FROM portfolios`)
  ).rows.map((r) => {
    const grade = gradeForSeed(parseJson(r.ai_rubric));
    return { url: String(r.url), grade, listed: Boolean(Number(r.listed)) && grade?.is_portfolio !== false };
  });
  const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name)));
  const stored = tables.has("comparisons")
    ? (await db.execute(`SELECT * FROM comparisons ${readOnly ? "WHERE source IS NULL OR source NOT LIKE 'vote:%'" : ""} ORDER BY created_at, id`)).rows
    : [];
  const comparisons = stored.map((r) => ({
    id: Number(r.id),
    created_at: String(r.created_at),
    rater_type: String(r.rater_type),
    rater_id: r.rater_id == null ? null : String(r.rater_id),
    model: r.model == null ? null : String(r.model),
    prompt_version: r.prompt_version == null ? null : String(r.prompt_version),
    rubric_version: r.rubric_version == null ? null : Number(r.rubric_version),
    method: String(r.method),
    shown: parseJson(r.shown),
    ranking: parseJson(r.ranking),
    outcome: String(r.outcome),
    starred: Number(r.starred) ? 1 : 0,
    experiment: r.experiment == null ? null : String(r.experiment),
    match_seed: r.match_seed == null ? null : String(r.match_seed),
    match_kind: r.match_kind == null ? null : String(r.match_kind),
  }));
  // Read-only (no write access, e.g. a read-only token): the votes are
  // converted in memory instead of being mirrored into comparisons first.
  if (readOnly) comparisons.push(...((await readVoteComparisons(db)) ?? []));
  comparisons.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  const resetRows = tables.has("rating_resets") ? (await db.execute("SELECT url, at, reason FROM rating_resets ORDER BY at, id")).rows : [];
  const resets = resetRows.map((r) => ({
    url: String(r.url),
    at: String(r.at),
    reason: String(r.reason),
  }));
  return { sites, comparisons, resets };
}

/** A digest of the input, recorded with each run: the same digest and settings give the same boards. */
export function inputDigest({ sites, comparisons, resets }) {
  const h = createHash("sha256");
  for (const s of [...sites].sort((a, b) => (a.url < b.url ? -1 : 1))) h.update(JSON.stringify([s.url, s.grade, s.listed]));
  for (const c of comparisons)
    h.update(JSON.stringify([c.id, c.created_at, c.rater_type, c.method, c.ranking, c.outcome, c.starred, c.experiment]));
  for (const r of resets) h.update(JSON.stringify([r.url, r.at]));
  return h.digest("hex");
}

/**
 * Writes a recompute: replaces site_ratings for every view computed, writes
 * the weekly snapshots (by default only the latest stored week onwards,
 * since earlier weeks don't change unless the vote log is rewritten; `full`
 * rewrites them all), and records the run.
 */
export async function writeResults(db, { boards, history, digest, config, counted, summary = null, full = false, now = new Date() }) {
  const run = await db.execute({
    sql: "INSERT INTO ranking_runs (at, settings, input_digest, comparisons, summary) VALUES (?, ?, ?, ?, ?) RETURNING id",
    args: [now.toISOString(), JSON.stringify(engineSettings(config)), digest, Object.values(counted).reduce((a, b) => Math.max(a, b), 0), summary ? JSON.stringify(summary) : null],
  });
  const runId = Number(run.rows[0].id);
  const views = Object.keys(boards);
  const stmts = [{ sql: `DELETE FROM site_ratings WHERE view IN (${views.map(() => "?").join(",")})`, args: views }];
  for (const [view, rows] of Object.entries(boards)) {
    for (const r of rows) {
      stmts.push({
        sql: `INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, seed_mu, seed_sigma, seed_basis, tier, run_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [view, r.url, r.rank, r.mu, r.sigma, r.confidence, r.tiedWithNext ? 1 : 0, r.comparisons, r.wins, r.losses, r.seedMu, r.seedSigma, r.seedBasis, r.tier ?? null, runId],
      });
    }
  }
  // One write transaction, so readers never see a half-written board.
  const tx = await db.transaction("write");
  try {
    for (const part of chunks(stmts, 500)) await tx.batch(part);
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }

  let since = "";
  if (!full) {
    const last = await db.execute("SELECT MAX(week) AS w FROM rank_history");
    since = last.rows[0]?.w == null ? "" : String(last.rows[0].w);
  }
  const weeks = [...new Set(history.map((h) => h.week))].filter((w) => w >= since);
  const hist = [];
  for (const w of weeks) hist.push({ sql: "DELETE FROM rank_history WHERE week = ?", args: [w] });
  if (full) hist.unshift({ sql: "DELETE FROM rank_history", args: [] });
  for (const h of history) {
    if (h.week < since) continue;
    hist.push({ sql: "INSERT INTO rank_history (view, week, url, rank, mu, sigma) VALUES (?, ?, ?, ?, ?, ?)", args: [h.view, h.week, h.url, h.rank, h.mu, h.sigma] });
  }
  for (const part of chunks(hist, 500)) await db.batch(part, "write");
  await assignShownRanks(db);
  return { runId, historyWeeks: weeks.length };
}

/**
 * Numbers each view's sites 1, 2, 3... among the ones the app shows (on the
 * list, not hidden by lib/hidden.mjs), in rank order, into
 * site_ratings.shown_rank; hidden sites get NULL. Done once per recompute so
 * a request reads one page of the board by index instead of the whole view
 * (docs/COSTS.md section C). Run it again after the health check hides or
 * shows sites to apply that before the next recompute.
 */
export async function assignShownRanks(db) {
  const have = await columnsOf(db, "portfolios");
  if (!have.size) return { shown: 0 };
  const conds = [have.has("delisted_at") ? "delisted_at IS NULL" : "1", have.has("health") ? `NOT (${HIDDEN_WHERE})` : "status NOT IN ('dead', 'parked', 'error')"];
  const visible = new Set((await db.execute(`SELECT url FROM portfolios WHERE ${conds.join(" AND ")}`)).rows.map((r) => String(r.url)));
  const rows = (await db.execute("SELECT view, url, shown_rank FROM site_ratings ORDER BY view, rank")).rows;
  const next = new Map();
  const stmts = [];
  let shown = 0;
  for (const r of rows) {
    const view = String(r.view);
    let rank = null;
    if (visible.has(String(r.url))) {
      rank = (next.get(view) ?? 0) + 1;
      next.set(view, rank);
      shown++;
    }
    const old = r.shown_rank == null ? null : Number(r.shown_rank);
    if (old !== rank) stmts.push({ sql: "UPDATE site_ratings SET shown_rank = ? WHERE view = ? AND url = ?", args: [rank, view, String(r.url)] });
  }
  // One transaction, so a reader never sees two sites with the same rank.
  const tx = await db.transaction("write");
  try {
    for (const part of chunks(stmts, 500)) await tx.batch(part);
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
  return { shown, updated: stmts.length };
}

/**
 * Today's AI comparisons per method, for the daily budget. "Today" is the
 * Gemini quota day (midnight to midnight Pacific, pipeline/budget.mjs).
 */
export async function comparisonsToday(db, { now = new Date(), model } = {}) {
  const { start, end } = quotaDay(now);
  const range = [start.toISOString(), end.toISOString()];
  const res = await db.execute({
    sql: `SELECT method, COUNT(*) AS n FROM comparisons
          WHERE rater_type = 'ai' AND created_at >= ? AND created_at < ? ${model ? "AND model = ?" : ""}
          GROUP BY method`,
    args: model ? [...range, model] : range,
  });
  const out = { one_on_one: 0, batched: 0 };
  for (const r of res.rows) out[String(r.method)] = Number(r.n);
  return out;
}

/**
 * Stores one comparison made by the AI. A `source` makes it idempotent: a
 * second insert with the same source (a retried Workflow step) is ignored.
 */
export async function insertComparison(db, c) {
  await db.execute({
    sql: `INSERT INTO comparisons (created_at, rater_type, rater_id, model, prompt_version, rubric_version, method, shown, ranking, outcome, reason, starred, experiment, match_seed, match_kind, run_id, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
          ON CONFLICT(source) DO NOTHING`,
    args: [
      toIso(c.created_at ?? new Date()),
      c.rater_type,
      c.rater_id ?? null,
      c.model ?? null,
      c.prompt_version ?? null,
      c.rubric_version ?? null,
      c.method,
      c.shown ? JSON.stringify(c.shown) : null,
      c.ranking ? JSON.stringify(c.ranking) : null,
      c.outcome ?? (c.ranking ? "ranked" : "skip"),
      c.reason ?? null,
      c.experiment ?? null,
      c.match_seed ?? null,
      c.match_kind ?? null,
      c.run_id ?? null,
      c.source ?? null,
    ],
  });
}

export { weekOf };
