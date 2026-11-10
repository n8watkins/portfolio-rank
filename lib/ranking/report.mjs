// A readable summary of a recompute: per view, the top of the board with
// confidence and ties, how many sites have enough evidence, and the
// stability analytics. Used by scripts/recompute-ratings.mjs and the
// offline simulation.
import { CONFIDENT_SIGMA } from "./config.mjs";
import { stabilityReport } from "./analytics.mjs";

export function summarize({ boards, history, comparisons, counted, top = 20 }) {
  const views = Object.keys(boards);
  const perView = {};
  for (const view of views) {
    const rows = boards[view];
    const conf = { settled: 0, confident: 0, provisional: 0, unsure: 0 };
    for (const r of rows) conf[r.confidence]++;
    const compared = rows.filter((r) => r.comparisons > 0).length;
    perView[view] = {
      sites: rows.length,
      comparisonsCounted: counted[view] ?? 0,
      sitesCompared: compared,
      enoughEvidence: conf.settled + conf.confident,
      enoughEvidenceRule: `sigma <= ${CONFIDENT_SIGMA}`,
      confidence: conf,
      tiesInTop: rows.slice(0, top).filter((r) => r.tiedWithNext).length,
      top: rows.slice(0, top).map((r) => ({
        rank: r.rank,
        url: r.url,
        mu: Math.round(r.mu * 100) / 100,
        sigma: Math.round(r.sigma * 100) / 100,
        range: [r.low, r.high],
        confidence: r.confidence,
        tiedWithNext: r.tiedWithNext,
        comparisons: r.comparisons,
        wins: r.wins,
        losses: r.losses,
        tier: r.tier ?? null,
      })),
    };
  }
  return { views: perView, stability: stabilityReport({ comparisons, history, views }) };
}

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The summary as Markdown (job summary, terminal). */
export function summaryMarkdown(summary, { top = 20 } = {}) {
  const out = [];
  for (const [view, v] of Object.entries(summary.views)) {
    out.push(
      `## ${view}`,
      "",
      `${v.sites} listed site(s), ${v.comparisonsCounted} comparison(s) counted, ${v.sitesCompared} site(s) compared at least once, ${v.enoughEvidence} with enough evidence (${v.enoughEvidenceRule}).`,
      `Confidence: ${Object.entries(v.confidence).map(([k, n]) => `${k} ${n}`).join(", ")}. Ties in the top ${top}: ${v.tiesInTop}.`,
      "",
      "| # | Site | Tier | mu | sigma | 95% range | Confidence | W-L | Tied with next |",
      "| ---: | --- | :-: | ---: | ---: | --- | --- | --- | :-: |",
      ...v.top.slice(0, top).map(
        (r) =>
          `| ${r.rank} | ${host(r.url)} | ${r.tier ?? "-"} | ${r.mu.toFixed(2)} | ${r.sigma.toFixed(2)} | ${r.range[0]} to ${r.range[1]} | ${r.confidence} | ${r.wins}-${r.losses} | ${r.tiedWithNext ? "yes" : ""} |`
      ),
      ""
    );
  }
  const s = summary.stability;
  out.push("## Stability", "");
  for (const p of s.positionBias) out.push(`- Position bias (${p.judge}): first shown won ${p.firstWins} of ${p.n} (${p.share}, 95% ${p.low} to ${p.high})${p.biased ? ", biased" : ""}.`);
  for (const r of s.repeatDisagreement) if (r.repeats) out.push(`- Repeat disagreement (${r.judge}): ${r.disagreements} of ${r.repeats} repeats (${r.rate}).`);
  for (const c of s.contradictions) if (c.triangles) out.push(`- Contradictions (${c.judge}): ${c.cyclic} of ${c.triangles} triangles are cycles (${c.rate}).`);
  for (const [view, m] of Object.entries(s.movement)) {
    const last = m.weeks.at(-1);
    if (last) out.push(`- Rank movement (${view}, week of ${last.week}): mean ${last.mean}, median ${last.median}, 90th percentile ${last.p90} places; ${last.moved} of ${last.sites} moved.`);
  }
  return `${out.join("\n")}\n`;
}
