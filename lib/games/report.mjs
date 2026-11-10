// Report download (owner decision 2026-11-10): a portfolio's AI report as
// a print-optimised HTML page (app/report/print), which the browser saves
// as a PDF. Only for signed-in visitors, or through a one-time link sent by
// email: the link's token is stored only as its SHA-256, works once, and
// expires after LINK_TTL_MS.
//
// Why HTML and not a PDF made on the Worker: a PDF library on the Worker
// either ships its standard fonts only (no accents beyond Latin-1, no
// non-Latin names) or a megabyte-scale font, and can't lay out the
// screenshot and notes as well as the browser's own "Save as PDF" does.
import { createHash } from "node:crypto";

export const LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const iso = (d) => new Date(d).toISOString();

/** Stores a one-time link for `url` under the hash of `token`. */
export async function createReportLink(db, { url, token, now = new Date() }) {
  await db.execute({
    sql: "INSERT INTO report_links (token_hash, url, created_at, expires_at) VALUES (?, ?, ?, ?)",
    args: [hashToken(token), url, iso(now), iso(new Date(now).getTime() + LINK_TTL_MS)],
  });
}

/**
 * Uses a link: marks it used in the same statement that checks it is unused
 * and unexpired, so it opens once even when two requests race. Returns the
 * portfolio URL, or null.
 */
export async function consumeReportLink(db, { token, now = new Date() }) {
  if (!TOKEN.test(String(token ?? ""))) return null;
  const res = await db.execute({
    sql: "UPDATE report_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING url",
    args: [iso(now), hashToken(token), iso(now)],
  });
  return res.rows[0] ? String(res.rows[0].url) : null;
}

/** Drops a link (its email could not be sent). */
export async function dropReportLink(db, token) {
  await db.execute({ sql: "DELETE FROM report_links WHERE token_hash = ?", args: [hashToken(token)] });
}

/** Housekeeping: links expired more than a week ago. */
export async function pruneReportLinks(db, { now = new Date() } = {}) {
  const res = await db.execute({ sql: "DELETE FROM report_links WHERE expires_at < ?", args: [iso(new Date(now).getTime() - 7 * 86400000)] });
  return res.rowsAffected;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const LABELS = {
  visual_design: "Visual design",
  five_second_test: "Five-second test",
  storytelling: "Project presentation",
  writing: "Writing",
  memorability: "Memorability",
};
const CHECK_LABELS = {
  resume: "Resume link",
  github: "GitHub link",
  contact: "Contact path",
  project_links: "Project links load",
  own_domain: "Own domain",
  fresh_footer: "Footer year is current",
  original: "Not a template clone",
};

/** The grade as the report shows it, from portfolios.ai_rubric; null without a usable grade. */
export function reportGrade(raw) {
  let g;
  try {
    g = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!g || !["S", "A", "B", "C", "D"].includes(g.tier)) return null;
  return {
    tier: g.tier,
    // Only the top tiers get a public letter (as on the portfolio page).
    showTier: ["S", "A", "B"].includes(g.tier),
    quality: typeof g.quality_score === "number" ? g.quality_score : null,
    checksScore: typeof g.checks_score === "number" ? g.checks_score : null,
    axes: Object.entries(LABELS)
      .map(([k, label]) => {
        const a = g[k];
        const score = typeof a === "number" ? a : a?.score;
        return typeof score === "number" ? { key: k, label, score, note: typeof a?.note === "string" ? a.note : null } : null;
      })
      .filter(Boolean),
    checks: g.checks && typeof g.checks === "object"
      ? Object.entries(CHECK_LABELS)
          .filter(([k]) => typeof g.checks[k] === "boolean")
          .map(([k, label]) => ({ key: k, label, pass: g.checks[k] }))
      : [],
    model: typeof g.model === "string" ? g.model : null,
    judgedAt: typeof g.judged_at === "string" ? g.judged_at : null,
  };
}

/** The print page: self-contained HTML with print styles and a Save as PDF button. */
export function renderReportHtml({ name, url, tagline, grade, percentiles, hero, siteUrl, now = new Date() }) {
  const domain = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  })();
  const pct = (label, v) => (v == null ? "" : `<div class="pct"><span>${esc(label)}</span><strong>Top ${esc(v)}%</strong></div>`);
  const date = (d) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(name)} - PortfolioRank report</title>
<style>
  :root { color-scheme: light; --ink: #16181d; --mute: #5b6170; --edge: #dde0e6; --accent: #4f46e5; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; border-bottom: 1px solid var(--edge); padding-bottom: 16px; }
  h1 { font-size: 26px; margin: 0; line-height: 1.2; }
  .sub { color: var(--mute); margin: 4px 0 0; }
  .brand { font-weight: 700; white-space: nowrap; }
  .brand b { color: var(--accent); }
  .hero { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; border: 1px solid var(--edge); border-radius: 10px; margin: 20px 0 0; background: #f3f4f6; }
  .summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0 0; }
  .tier { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 12px; background: var(--accent); color: #fff; font-size: 30px; font-weight: 700; }
  .tier.neutral { background: #eceef2; color: var(--ink); font-size: 18px; }
  .pct, .score { border: 1px solid var(--edge); border-radius: 10px; padding: 8px 12px; min-width: 120px; }
  .pct span, .score span { display: block; font-size: 12px; color: var(--mute); }
  .pct strong, .score strong { font-size: 18px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  .axes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .axis { border: 1px solid var(--edge); border-radius: 10px; padding: 10px 12px; break-inside: avoid; }
  .axis div { display: flex; justify-content: space-between; font-weight: 600; }
  .bar { height: 6px; border-radius: 3px; background: #eceef2; margin-top: 6px; }
  .bar i { display: block; height: 6px; border-radius: 3px; background: var(--accent); }
  .axis p { margin: 6px 0 0; color: var(--mute); font-size: 13px; }
  ul.checks { list-style: none; padding: 0; margin: 0; columns: 2; }
  ul.checks li { padding: 2px 0; break-inside: avoid; }
  footer { margin-top: 32px; border-top: 1px solid var(--edge); padding-top: 12px; color: var(--mute); font-size: 12px; }
  .print { margin-top: 20px; padding: 10px 16px; border: 0; border-radius: 8px; background: var(--ink); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  @media (max-width: 520px) { header { flex-direction: column; } ul.checks { columns: 1; } }
  @media print {
    @page { size: A4; margin: 14mm; }
    main { padding: 0; max-width: none; }
    .print { display: none; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${esc(name)}</h1>
      <p class="sub">${esc(tagline ?? "Developer portfolio")} · <a href="${esc(url)}">${esc(domain)}</a></p>
    </div>
    <div class="brand">Portfolio<b>Rank</b></div>
  </header>
  ${hero ? `<img class="hero" src="${esc(hero)}" alt="Screenshot of ${esc(domain)}">` : ""}
  <section class="summary" aria-label="Summary">
    <div class="tier${grade.showTier ? "" : " neutral"}" aria-label="${grade.showTier ? `Tier ${esc(grade.tier)}` : "AI review"}">${grade.showTier ? esc(grade.tier) : "AI"}</div>
    ${grade.quality == null ? "" : `<div class="score"><span>Quality</span><strong>${esc(grade.quality.toFixed(1))} / 5</strong></div>`}
    ${grade.checksScore == null ? "" : `<div class="score"><span>Checks passed</span><strong>${esc(grade.checksScore)} / 100</strong></div>`}
    ${percentiles ? pct("Merged", percentiles.merged) + pct("AI", percentiles.ai) + pct("People", percentiles.people) : ""}
  </section>
  <h2>AI design review</h2>
  <div class="axes">
    ${grade.axes
      .map(
        (a) => `<div class="axis"><div><span>${esc(a.label)}</span><span>${esc(a.score)} / 5</span></div><div class="bar"><i style="width:${(a.score / 5) * 100}%"></i></div>${a.note ? `<p>${esc(a.note)}</p>` : ""}</div>`
      )
      .join("\n    ")}
  </div>
  ${grade.checks.length ? `<h2>Checks by code</h2>\n  <ul class="checks">${grade.checks.map((c) => `<li>${c.pass ? "✓" : "✗"} ${esc(c.label)}</li>`).join("")}</ul>` : ""}
  <button class="print" type="button" onclick="window.print()">Save as PDF</button>
  <footer>
    Graded by Gemini${grade.model ? ` (${esc(grade.model)})` : ""}${grade.judgedAt ? ` on ${esc(date(grade.judgedAt))}` : ""}: an opinion, not a verdict.
    Downloaded ${esc(date(now))} from <a href="${esc(siteUrl)}/p/${esc(encodeURIComponent(url))}">${esc(siteUrl.replace(/^https?:\/\//, ""))}</a>.
  </footer>
</main>
</body>
</html>`;
}
