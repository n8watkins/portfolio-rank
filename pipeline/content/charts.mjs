// Charts drawn by code from a fact sheet (docs/CONTENT-ENGINE.md, "Images"):
// every bar's value is read from the facts by id, so a chart can't disagree
// with the text. Plain SVG strings (no dependencies, Worker-safe), in the
// house style: flat colours, the PortfolioRank palette, 1200 px wide.

const PALETTE = { bg: "#0a0a0b", card: "#131316", edge: "#26262b", ink: "#ededf0", mute: "#8b8b93", series: ["#fbbf24", "#8b8b93", "#60a5fa"] };

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Every fact id a chart reads. */
export const chartFacts = (chart) => chart.series.flatMap((s) => s.facts);

/**
 * The SVG of one chart spec (facts/charts in pipeline/content/facts.mjs).
 * Throws when a fact it reads is missing or not a number.
 */
export function renderChart(chart, facts, { width = 1200 } = {}) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const series = chart.series.map((s) => ({
    name: s.name,
    values: s.facts.map((id) => {
      const f = byId.get(id);
      if (!f || typeof f.value !== "number" || !Number.isFinite(f.value)) throw new Error(`chart ${chart.id}: fact ${id} is missing or not a number`);
      return { value: f.value, display: f.display };
    }),
  }));
  const cats = chart.categories;
  const max = Math.max(chart.max ?? 0, ...series.flatMap((s) => s.values.map((v) => v.value))) || 1;
  const rowH = 30 * series.length + 26;
  const top = 96;
  const left = 330;
  const right = 110;
  const height = top + cats.length * rowH + 40;
  const barW = width - left - right;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(chart.alt ?? chart.title)}">`,
    `<rect width="${width}" height="${height}" fill="${PALETTE.bg}"/>`,
    `<text x="40" y="52" fill="${PALETTE.ink}" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="600">${esc(chart.title)}</text>`,
  ];
  series.forEach((s, i) => {
    const x = 40 + i * 260;
    out.push(`<rect x="${x}" y="70" width="14" height="14" rx="3" fill="${PALETTE.series[i % PALETTE.series.length]}"/>`);
    out.push(`<text x="${x + 22}" y="82" fill="${PALETTE.mute}" font-family="Inter, system-ui, sans-serif" font-size="16">${esc(s.name)}</text>`);
  });
  cats.forEach((cat, ci) => {
    const y0 = top + ci * rowH;
    out.push(`<text x="40" y="${y0 + 16 + (15 * series.length) / 2}" fill="${PALETTE.ink}" font-family="Inter, system-ui, sans-serif" font-size="18">${esc(cat)}</text>`);
    series.forEach((s, si) => {
      const v = s.values[ci];
      const w = Math.max(2, Math.round((barW * v.value) / max));
      const y = y0 + si * 30;
      out.push(`<rect x="${left}" y="${y}" width="${barW}" height="22" rx="4" fill="${PALETTE.card}"/>`);
      out.push(`<rect x="${left}" y="${y}" width="${w}" height="22" rx="4" fill="${PALETTE.series[si % PALETTE.series.length]}"/>`);
      out.push(`<text x="${left + w + 10}" y="${y + 17}" fill="${PALETTE.ink}" font-family="Inter, system-ui, sans-serif" font-size="16">${esc(v.display)}</text>`);
    });
  });
  out.push(`<text x="${width - 40}" y="${height - 14}" text-anchor="end" fill="${PALETTE.mute}" font-family="Inter, system-ui, sans-serif" font-size="14">PortfolioRank data</text>`);
  out.push("</svg>");
  return out.join("");
}
