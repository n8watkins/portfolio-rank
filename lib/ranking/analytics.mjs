// Stability analytics, all computed from the stored comparisons and the
// weekly rank snapshots (no extra AI cost):
//
//   rank movement      how far each site's rank moves per week
//   contradictions     A beat B, B beat C, C beat A: the share of fully
//                      compared triangles that are cycles
//   repeat disagreement  how often the same judge gives a different answer
//                      on a pair it has judged before
//   position bias      how often the site shown first wins
import { parseRanking } from "./views.mjs";
import { pairKey } from "./matchmaking.mjs";

/** The winner and loser of a one-on-one comparison, or null (skip, tie, batched). */
export function duel(c) {
  if (c.outcome === "skip") return null;
  const r = parseRanking(c.ranking);
  if (!r || r.length !== 2 || r[0].length !== 1 || r[1].length !== 1) return null;
  return { winner: r[0][0], loser: r[1][0] };
}

const parseShown = (shown) => {
  if (Array.isArray(shown)) return shown;
  try {
    const s = JSON.parse(String(shown ?? "null"));
    return Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
};

/** Who a judgement belongs to, for consistency checks: the same kind of rater, model and prompt. */
export const judgeOf = (c) =>
  c.rater_type === "ai" ? `ai|${c.model ?? "?"}|${c.prompt_version ?? "?"}` : c.rater_type;

/** Wilson 95% interval for k successes out of n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/** Share of one-on-one wins by the site shown first, per judge. Only comparisons that recorded the order count. */
export function positionBias(comparisons) {
  const by = new Map();
  for (const c of comparisons) {
    if (c.method !== "one_on_one") continue;
    const d = duel(c);
    const shown = parseShown(c.shown);
    if (!d || !shown || shown.length !== 2) continue;
    const key = judgeOf(c);
    const g = by.get(key) ?? { judge: key, n: 0, firstWins: 0 };
    g.n++;
    if (shown[0] === d.winner) g.firstWins++;
    by.set(key, g);
  }
  return [...by.values()].map((g) => {
    const [lo, hi] = wilson(g.firstWins, g.n);
    return { ...g, share: r3(g.firstWins / g.n), low: r3(lo), high: r3(hi), biased: lo > 0.5 || hi < 0.5 };
  });
}

/** How often a judge contradicts its own earlier answer on the same pair. */
export function repeatDisagreement(comparisons) {
  const by = new Map(); // judge -> Map(pair -> [winners in time order])
  const sorted = [...comparisons].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id ?? 0) - Number(b.id ?? 0));
  for (const c of sorted) {
    if (c.method !== "one_on_one") continue;
    const d = duel(c);
    if (!d) continue;
    const judge = judgeOf(c);
    const m = by.get(judge) ?? new Map();
    const k = pairKey(d.winner, d.loser);
    m.set(k, [...(m.get(k) ?? []), d.winner]);
    by.set(judge, m);
  }
  return [...by].map(([judge, m]) => {
    let pairs = 0;
    let repeats = 0;
    let disagreements = 0;
    for (const winners of m.values()) {
      if (winners.length < 2) continue;
      pairs++;
      for (const w of winners.slice(1)) {
        repeats++;
        if (w !== winners[0]) disagreements++;
      }
    }
    return { judge, pairs, repeats, disagreements, rate: repeats ? r3(disagreements / repeats) : null };
  });
}

/**
 * Contradiction (cycle) rate per judge: every pair gets its majority winner
 * (pairs with a split vote are left out); of the triangles whose three pairs
 * all have one, the share that go round in a circle.
 */
export function cycleRate(comparisons) {
  const by = new Map(); // judge -> Map(pair -> net wins for the alphabetically first site)
  for (const c of comparisons) {
    if (c.method !== "one_on_one") continue;
    const d = duel(c);
    if (!d) continue;
    const judge = judgeOf(c);
    const m = by.get(judge) ?? new Map();
    const k = pairKey(d.winner, d.loser);
    const first = d.winner < d.loser ? d.winner : d.loser;
    m.set(k, (m.get(k) ?? 0) + (d.winner === first ? 1 : -1));
    by.set(judge, m);
  }
  return [...by].map(([judge, m]) => {
    const beats = new Map(); // url -> Set(urls it beats)
    const adj = new Map(); // url -> Set(neighbours with a decided edge)
    for (const [k, net] of m) {
      if (net === 0) continue;
      const [a, b] = k.split("\n");
      const [w, l] = net > 0 ? [a, b] : [b, a];
      if (!beats.has(w)) beats.set(w, new Set());
      beats.get(w).add(l);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!adj.has(x)) adj.set(x, new Set());
        adj.get(x).add(y);
      }
    }
    const wins = (x, y) => beats.get(x)?.has(y) ?? false;
    let triangles = 0;
    let cyclic = 0;
    for (const [u, nu] of adj) {
      for (const v of nu) {
        if (v <= u) continue;
        for (const w of adj.get(v)) {
          if (w <= v || !nu.has(w)) continue;
          triangles++;
          const outU = (wins(u, v) ? 1 : 0) + (wins(u, w) ? 1 : 0);
          const outV = (wins(v, u) ? 1 : 0) + (wins(v, w) ? 1 : 0);
          const outW = (wins(w, u) ? 1 : 0) + (wins(w, v) ? 1 : 0);
          if (outU === 1 && outV === 1 && outW === 1) cyclic++;
        }
      }
    }
    return { judge, triangles, cyclic, rate: triangles ? r3(cyclic / triangles) : null };
  });
}

/**
 * Week-on-week rank movement for one view, from the weekly snapshots
 * ([{view, week, url, rank}]): per week, the mean, median and 90th
 * percentile of the absolute rank change of sites present both weeks, and
 * the biggest climbers and fallers of the latest week.
 */
export function rankMovement(history, view, { top = 5 } = {}) {
  const weeks = new Map();
  for (const h of history) {
    if (h.view !== view) continue;
    if (!weeks.has(h.week)) weeks.set(h.week, new Map());
    weeks.get(h.week).set(h.url, h.rank);
  }
  const order = [...weeks.keys()].sort();
  const perWeek = [];
  let latest = [];
  for (let i = 1; i < order.length; i++) {
    const prev = weeks.get(order[i - 1]);
    const cur = weeks.get(order[i]);
    const moves = [];
    for (const [url, rank] of cur) {
      if (prev.has(url)) moves.push({ url, from: prev.get(url), to: rank, change: prev.get(url) - rank });
    }
    const abs = moves.map((m) => Math.abs(m.change)).sort((a, b) => a - b);
    const q = (p) => (abs.length ? abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] : null);
    perWeek.push({
      week: order[i],
      sites: abs.length,
      moved: abs.filter((x) => x > 0).length,
      mean: abs.length ? r3(abs.reduce((s, x) => s + x, 0) / abs.length) : null,
      median: q(0.5),
      p90: q(0.9),
    });
    latest = moves;
  }
  const climbers = [...latest].sort((a, b) => b.change - a.change).filter((m) => m.change > 0).slice(0, top);
  const fallers = [...latest].sort((a, b) => a.change - b.change).filter((m) => m.change < 0).slice(0, top);
  return { view, weeks: perWeek, climbers, fallers };
}

/** Everything above in one object, for the recompute summary and the weekly report. */
export function stabilityReport({ comparisons, history, views }) {
  return {
    positionBias: positionBias(comparisons),
    repeatDisagreement: repeatDisagreement(comparisons),
    contradictions: cycleRate(comparisons),
    movement: Object.fromEntries(views.map((v) => [v, rankMovement(history, v)])),
  };
}
