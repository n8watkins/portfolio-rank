// The three leaderboards, rebuilt from scratch from the stored comparisons:
//
//   people  human votes only; everyone starts equal and unsure (no AI seed)
//   ai      the AI's one-on-one comparisons, seeded from the AI grade
//   merged  (default) both evidence sets in one rating, seeded from the AI
//           grade, AI comparisons at a lower weight (config AI_WEIGHT_MERGED)
//
// plus, while batched comparisons are experiment only, an "ai_experiment"
// view (the AI view with batched results counted), so the two can be
// compared before the flag turns batched on for real.
//
// Pure and deterministic: the same sites, comparisons and resets always give
// the same boards. OpenSkill is an online method, so order matters: events
// are replayed by time, then by id.
import { buildBoard, neutralSeed, rateRanking, seedFromGrade, validRanking } from "./engine.mjs";
import { SIGMA_UNSURE, STARRED_WEIGHT } from "./config.mjs";

export const VIEW_NAMES = ["merged", "people", "ai"];
export const EXPERIMENT_VIEW = "ai_experiment";

/** "2026-11-10 13:00:00" (SQLite datetime) or any ISO string -> ISO UTC string. */
export function toIso(at) {
  if (at instanceof Date) return at.toISOString();
  const s = String(at ?? "");
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) return `${s.replace(" ", "T")}.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** The Monday (UTC) starting the week of an ISO time, as YYYY-MM-DD. */
export function weekOf(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const isHuman = (c) => c.rater_type === "human";
const isAi = (c) => c.rater_type === "ai";
const humanWeight = (c) => (c.starred ? STARRED_WEIGHT : 1);

/**
 * Which comparisons each view counts, with what weight, and how it seeds.
 * Comparisons tagged with an experiment never count in the public views.
 */
export function viewDefinitions({ aiWeight, batchedCounts }) {
  const aiCounts = (c) => isAi(c) && (c.method === "one_on_one" || (batchedCounts && c.method === "batched"));
  return {
    merged: {
      seed: "grade",
      weight: (c) => (isHuman(c) ? humanWeight(c) : aiCounts(c) ? aiWeight : 0),
    },
    people: { seed: "neutral", weight: (c) => (isHuman(c) ? humanWeight(c) : 0) },
    ai: { seed: "grade", weight: (c) => (aiCounts(c) ? 1 : 0) },
    [EXPERIMENT_VIEW]: {
      seed: "grade",
      experiment: true,
      weight: (c) => (isAi(c) && (c.method === "one_on_one" || c.method === "batched") ? 1 : 0),
    },
  };
}

/** A stored comparison's ranking (JSON text or array), or null. */
export function parseRanking(ranking) {
  if (ranking == null) return null;
  let r = ranking;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  return validRanking(r) ? r : null;
}

/**
 * Rebuilds every view.
 *   sites        [{url, grade, listed}]: grade is the stored AI rubric (or
 *                null); listed sites are the ones shown on the boards
 *   comparisons  [{id, created_at, rater_type, method, ranking, outcome,
 *                starred, experiment, ...}]
 *   resets       [{url, at, reason}]: uncertainty resets (a redesign)
 *   options      {aiWeight, batchedCounts, history}
 * Returns {boards: {view: rows}, history: [{view, week, url, rank, mu,
 * sigma}], counted: {view: n}}.
 */
export function recompute({ sites, comparisons, resets = [], aiWeight, batchedCounts = false, history = true }) {
  const defs = viewDefinitions({ aiWeight, batchedCounts });
  const hasBatched = !batchedCounts && comparisons.some((c) => c.method === "batched" && isAi(c) && !c.experiment);
  const names = [...VIEW_NAMES, ...(hasBatched ? [EXPERIMENT_VIEW] : [])];

  const gradeSeeds = new Map(sites.map((s) => [s.url, seedFromGrade(s.grade)]));
  const listed = sites.filter((s) => s.listed !== false).map((s) => s.url);

  const states = new Map(); // view -> Map(url -> state)
  for (const name of names) {
    const seedOf = defs[name].seed === "grade" ? (u) => gradeSeeds.get(u) ?? neutralSeed() : () => neutralSeed();
    const m = new Map();
    const make = (url) => {
      const seed = seedOf(url);
      // The tier is shown in every view for reference, even where it doesn't seed.
      return { mu: seed.mu, sigma: seed.sigma, comparisons: 0, wins: 0, losses: 0, seedMu: seed.mu, seedSigma: seed.sigma, seedBasis: seed.basis, tier: gradeSeeds.get(url)?.tier ?? null };
    };
    for (const url of listed) m.set(url, make(url));
    m.make = make;
    states.set(name, m);
  }
  const stateOf = (view, url) => {
    const m = states.get(view);
    let s = m.get(url);
    if (!s) {
      s = m.make(url);
      m.set(url, s);
    }
    return s;
  };

  const events = [
    ...resets.map((r, i) => ({ kind: "reset", at: toIso(r.at), order: 0, id: i, r })),
    ...comparisons
      .filter((c) => c.outcome !== "skip" && !c.experiment)
      .map((c) => ({ kind: "cmp", at: toIso(c.created_at), order: 1, id: Number(c.id ?? 0), c })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id));

  const rows = [];
  const counted = Object.fromEntries(names.map((n) => [n, 0]));
  let week = null;
  const snapshot = (wk) => {
    for (const name of names) {
      for (const r of board(name)) rows.push({ view: name, week: wk, url: r.url, rank: r.rank, mu: r.mu, sigma: r.sigma });
    }
  };
  const listedSet = new Set(listed);
  const board = (name) => buildBoard([...states.get(name)].filter(([url]) => listedSet.has(url)));

  for (const e of events) {
    if (history) {
      const wk = weekOf(e.at);
      if (week && wk !== week) snapshot(week);
      week = wk;
    }
    if (e.kind === "reset") {
      for (const name of names) {
        const s = stateOf(name, e.r.url);
        s.sigma = Math.max(s.sigma, SIGMA_UNSURE);
      }
      continue;
    }
    const ranking = parseRanking(e.c.ranking);
    if (!ranking) continue;
    const pair = ranking.length === 2 && ranking[0].length === 1 && ranking[1].length === 1;
    for (const name of names) {
      const w = defs[name].weight(e.c);
      if (!(w > 0)) continue;
      const out = rateRanking((u) => stateOf(name, u), ranking, w);
      if (!out) continue;
      counted[name]++;
      for (const [url, r] of out) {
        const s = stateOf(name, url);
        s.mu = r.mu;
        s.sigma = r.sigma;
        s.comparisons++;
      }
      if (pair) {
        stateOf(name, ranking[0][0]).wins++;
        stateOf(name, ranking[1][0]).losses++;
      }
    }
  }
  if (history && week) snapshot(week);

  const boards = Object.fromEntries(names.map((n) => [n, board(n)]));
  return { boards, history: rows, counted };
}
