// The quiz pool: every graded portfolio the site shows, with its place in
// each leaderboard view, built in one pass and cached (lib/games/server.ts)
// so a quiz, a guess or a badge check never reads the board itself
// (docs/COSTS.md section C).
//
// Percentiles come from the ranking views (lib/ranking, site_ratings): a
// site's "top X%" is its shown rank over the number of sites shown in that
// view. Before the first recompute (no ratings), every view falls back to
// the AI grade: sites are ranked by the rating their grade seeds
// (lib/ranking/engine.mjs seedFromGrade), and People has no percentile.
//
// Plain JavaScript taking a libSQL client, so the tests use it without a
// server.
import { seedFromGrade } from "../ranking/engine.mjs";
import { HIDDEN_WHERE } from "../hidden.mjs";

/** A guess within this many points counts as a hit. */
export const HIT = 15;
/** Portfolios in a quiz. */
export const ROUNDS = 5;

/**
 * Points for a guess (owner decision 2026-11-10): 100 when exact, 2.5 fewer
 * per point off, never below 20, so every answer earns something.
 */
export const points = (guess, actual) => Math.max(20, Math.round(100 - Math.abs(guess - actual) * 2.5));

/** "Top X%" for a rank among n sites (1 = the very top), 1 to 100. */
export function topPct(rank, n) {
  if (!(rank > 0) || !(n > 0)) return null;
  return Math.max(1, Math.min(100, Math.ceil((rank / n) * 100)));
}

const noTable = (e) => /no such (table|column)/i.test(String(e?.message ?? e));

/** Sites a verified owner removed or whose grade they hid: never in a quiz. */
async function ownerHidden(db) {
  try {
    const rows = (await db.execute("SELECT url FROM portfolio_owner WHERE removed_at IS NOT NULL OR hide_grade = 1")).rows;
    return new Set(rows.map((r) => String(r.url)));
  } catch (e) {
    if (noTable(e)) return new Set();
    throw e;
  }
}

/**
 * Builds the pool: { source: "ratings" | "grades", totals: { merged, ai,
 * people }, sites: [{ u, m, a, p, t }] } where m, a and p are the shown
 * ranks in each view (p null without a People board) and t the AI tier.
 * Sites are graded ones only, best merged rank first.
 */
export async function buildPool(db) {
  const skip = await ownerHidden(db);
  let rows = [];
  try {
    rows = (
      await db.execute("SELECT view, url, shown_rank, tier FROM site_ratings WHERE shown_rank IS NOT NULL AND view IN ('merged', 'ai', 'people')")
    ).rows;
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  const byView = { merged: new Map(), ai: new Map(), people: new Map() };
  const tiers = new Map();
  for (const r of rows) {
    const url = String(r.url);
    byView[String(r.view)]?.set(url, Number(r.shown_rank));
    if (r.view === "merged" && r.tier != null) tiers.set(url, String(r.tier));
  }
  if (byView.merged.size > 0) {
    const max = (m) => (m.size ? Math.max(...m.values()) : 0);
    const totals = { merged: max(byView.merged), ai: max(byView.ai), people: max(byView.people) };
    const sites = [...tiers]
      .filter(([u]) => !skip.has(u))
      .map(([u, t]) => ({ u, m: byView.merged.get(u), a: byView.ai.get(u) ?? null, p: byView.people.get(u) ?? null, t }))
      .sort((x, y) => x.m - y.m);
    return { source: "ratings", totals, sites };
  }
  return gradePool(db, skip);
}

/** The fallback before any recompute: ranks by the rating each AI grade seeds. */
async function gradePool(db, skip) {
  let rows = [];
  try {
    rows = (
      await db.execute(
        `SELECT url, ai_rubric FROM portfolios
         WHERE ai_rubric IS NOT NULL AND delisted_at IS NULL AND NOT (${HIDDEN_WHERE})`
      )
    ).rows;
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  const scored = [];
  for (const r of rows) {
    const url = String(r.url);
    if (skip.has(url)) continue;
    let g;
    try {
      g = JSON.parse(String(r.ai_rubric));
    } catch {
      continue;
    }
    if (!g || g.error || g.is_portfolio === false) continue;
    const seed = seedFromGrade(g);
    if (seed.basis !== "grade") continue;
    scored.push({ u: url, mu: seed.mu, t: seed.tier });
  }
  scored.sort((x, y) => y.mu - x.mu || (x.u < y.u ? -1 : 1));
  // Equal ratings share a rank (1, 2, 2, 4), so ties are never split by name.
  let rank = 0;
  const sites = scored.map((s, i) => {
    if (i === 0 || s.mu !== scored[i - 1].mu) rank = i + 1;
    return { u: s.u, m: rank, a: rank, p: null, t: s.t };
  });
  const n = sites.length;
  return { source: "grades", totals: { merged: n, ai: n, people: 0 }, sites };
}

/** A site's "top X%" in each view, or null when it is not in the pool. */
export function percentilesOf(pool, url) {
  const s = pool.sites.find((x) => x.u === url);
  if (!s) return null;
  return {
    merged: topPct(s.m, pool.totals.merged),
    ai: s.a == null ? null : topPct(s.a, pool.totals.ai),
    people: s.p == null ? null : topPct(s.p, pool.totals.people),
    tier: s.t ?? null,
  };
}

/** url -> pool entry, for many lookups at once. */
export const poolIndex = (pool) => new Map(pool.sites.map((s) => [s.u, s]));

/**
 * Five portfolios spread across the board: the pool (best first) is cut
 * into five bands and one site is drawn from each, then the order is
 * shuffled so the bands don't run top to bottom. `rng` returns floats in
 * [0, 1); the same rng sequence gives the same five. Fewer than five sites
 * in the pool gives them all.
 */
export function pickFive(pool, rng) {
  const sites = pool.sites;
  const n = sites.length;
  if (n <= ROUNDS) return shuffle(sites.map((s) => s.u), rng);
  const out = [];
  for (let band = 0; band < ROUNDS; band++) {
    const lo = Math.floor((band / ROUNDS) * n);
    const hi = Math.max(lo + 1, Math.floor(((band + 1) / ROUNDS) * n));
    out.push(sites[lo + Math.floor(rng() * (hi - lo))].u);
  }
  return shuffle(out, rng);
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
