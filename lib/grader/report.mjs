// The report built from a finished grade: the facts and the AI's judgments
// shown apart (DECISIONS.md, "Facts and AI judgment are shown apart"), the
// strengths, the fixes to make first, where the site would land among the
// graded portfolios, similar portfolios, and portfolios doing the visitor's
// weakest things better. Everything here is code over the stored grade and
// existing grades: no extra Gemini request.
//
// The comparisons use the same number the leaderboard is seeded with
// (lib/ranking/engine.mjs seedFromGrade: the tier sets the level, the
// quality score nudges it within the tier), so "you'd rank about #340"
// means the same thing as the board. They are computed once, when the grade
// is written, from a pool of the listed graded portfolios that is cached for
// an hour, so a report view never scans the portfolios table.
//
// The same facts and judgments make the printable report of a listed
// portfolio's grade (printView, renderReportHtml; app/report/print).
import { AI_CRITERIA, CODE_CRITERIA, CRITERIA, NOT_A_FAULT } from "../../pipeline/rubric.mjs";
import { gradeQuality, seedFromGrade } from "../ranking/engine.mjs";
import { ACTIVE, NOT_PORTFOLIO } from "../../pipeline/roster.mjs";

export const POOL_TTL_MS = 60 * 60 * 1000;
const POOL_KEY = "grader:pool";

const byId = Object.fromEntries(CRITERIA.map((c) => [c.id, c]));

/** What a failed code check means for the visitor, as a fix. */
const FIX_COPY = {
  resume: { title: "Link your resume", why: "Recruiters look for a resume or CV link; none was found on the page." },
  github: { title: "Link your GitHub profile", why: "A GitHub link lets people see your code; none was found." },
  contact: { title: "Make it easy to reach you", why: "No email link, contact form, contact page or LinkedIn profile was found." },
  project_links: { title: "Fix broken project links", why: "Some project or demo links on the page don't load." },
  own_domain: { title: "Use your own domain", why: "The site is on a free hosting subdomain; your own name reads as more professional." },
  fresh_footer: { title: "Update the footer year", why: "An old copyright year makes the site look unmaintained." },
};
const AXIS_FIX = {
  visual_design: "Tighten the visual design",
  five_second_test: "Say who you are and what you do at the top",
  storytelling: "Show the problem, your role and the outcome for each project",
  writing: "Tighten the writing",
  memorability: "Give people something to remember",
};

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
};
const parse = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

/** Facts as pass/fail lines with a short detail (the code criteria with a weight). */
export function factLines(grade) {
  const checks = grade?.checks ?? {};
  const facts = grade?.facts ?? {};
  const detail = {
    resume: (v) => (v ? "Resume or CV link found" : "No resume link"),
    github: (v) => (v ? "GitHub profile linked" : "No GitHub link"),
    contact: (v) => (v ? "Contact path found" : "No contact path"),
    project_links: () => {
      const l = facts.project_links;
      return l && l.checked ? `${l.ok} of ${l.checked} load${l.broken ? `, ${l.broken} broken` : ""}` : "No project links to check";
    },
    own_domain: (v) => (v ? "Own domain" : "Free hosting subdomain"),
    fresh_footer: () => (typeof facts.footer_year === "number" ? `Footer says ${facts.footer_year}` : "No footer year"),
  };
  return CODE_CRITERIA.filter((c) => c.weight > 0 && !NOT_A_FAULT.has(c.id)).map((c) => ({
    id: c.id,
    label: c.name,
    pass: checks[c.id] ?? null,
    detail: detail[c.id]?.(checks[c.id]) ?? "",
  }));
}

/** The AI's five judgments, 1 to 5 with its note (older grades stored a bare score). */
export function judgmentLines(grade) {
  return AI_CRITERIA.map((c) => {
    const a = grade?.[c.id];
    return { id: c.id, label: c.name, score: typeof a === "number" ? a : (a?.score ?? null), note: typeof a?.note === "string" ? a.note : "" };
  });
}

/**
 * Up to three strengths (AI axes scored 4 or 5, best first, then passed
 * heavy code checks) and up to three fixes (failed code checks and AI axes
 * scored 3 or less, by weight times the gap).
 */
export function strengthsAndFixes(grade) {
  const strengths = [];
  for (const c of [...AI_CRITERIA].sort((a, b) => (grade?.[b.id]?.score ?? 0) - (grade?.[a.id]?.score ?? 0) || b.weight - a.weight)) {
    const s = grade?.[c.id]?.score;
    if (typeof s === "number" && s >= 4) strengths.push({ criterion: c.id, title: c.name, why: grade[c.id].note || c.what, by: "ai" });
  }
  for (const c of [...CODE_CRITERIA].filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight)) {
    if (strengths.length >= 3) break;
    if (grade?.checks?.[c.id] === true && c.weight >= 0.15) strengths.push({ criterion: c.id, title: c.name, why: c.what, by: "code" });
  }
  const fixes = [];
  for (const c of CODE_CRITERIA) {
    if (!c.weight || NOT_A_FAULT.has(c.id) || grade?.checks?.[c.id] !== false) continue;
    fixes.push({ criterion: c.id, title: FIX_COPY[c.id]?.title ?? c.name, why: FIX_COPY[c.id]?.why ?? c.what, by: "code", weight: c.weight * 2.5 });
  }
  for (const c of AI_CRITERIA) {
    const s = grade?.[c.id]?.score;
    if (typeof s !== "number" || s > 3) continue;
    fixes.push({ criterion: c.id, title: AXIS_FIX[c.id] ?? c.name, why: grade[c.id].note || c.what, by: "ai", weight: c.weight * (4 - s) * 1.2 });
  }
  fixes.sort((a, b) => b.weight - a.weight);
  return {
    strengths: strengths.slice(0, 3),
    fixes: fixes.slice(0, 3).map(({ weight, ...f }) => (void weight, f)),
  };
}

/**
 * The comparison pool: listed, graded portfolios (not flagged "not a
 * portfolio"), each with its seed level, tier, quality, axis scores and
 * roles. Cached in the cache table for an hour.
 */
export async function gradedPool(db, { now = Date.now(), ttlMs = POOL_TTL_MS } = {}) {
  const hit = (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [POOL_KEY] })).rows[0];
  if (hit && now - Number(hit.at) < ttlMs) {
    const v = parse(hit.v);
    if (Array.isArray(v)) return v;
  }
  const rows = (
    await db.execute(
      `SELECT url, name, ai_rubric FROM portfolios
       WHERE ai_rubric IS NOT NULL AND json_valid(ai_rubric) AND json_extract(ai_rubric, '$.tier') IS NOT NULL
         AND ${ACTIVE()} AND NOT ${NOT_PORTFOLIO()}`
    )
  ).rows;
  const pool = [];
  for (const r of rows) {
    const g = parse(r.ai_rubric);
    const seed = seedFromGrade(g);
    if (seed.basis !== "grade") continue;
    pool.push({
      url: String(r.url),
      name: String(r.name ?? "") || domainOf(r.url),
      mu: seed.mu,
      tier: seed.tier,
      quality: gradeQuality(g),
      axes: Object.fromEntries(AI_CRITERIA.map((c) => [c.id, typeof g[c.id] === "number" ? g[c.id] : (g[c.id]?.score ?? null)])),
      roles: Array.isArray(g.roles) ? g.roles.slice(0, 3) : [],
    });
  }
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [POOL_KEY, JSON.stringify(pool), now] });
  return pool;
}

const site = (p) => ({ url: p.url, name: p.name, domain: domainOf(p.url), tier: p.tier, path: `/p/${encodeURIComponent(p.url)}` });

/**
 * Where the grade lands among the pool, similar portfolios and "doing it
 * better" lists. `selfKey(url)` identifies the graded site itself, which is
 * left out (grading a listed site reuses nothing, and it is not its own
 * neighbour).
 */
export function compareWithPool(grade, pool, { isSelf = () => false } = {}) {
  const seed = seedFromGrade(grade);
  const others = pool.filter((p) => !isSelf(p.url));
  if (seed.basis !== "grade" || others.length === 0) return { percentile: null, similar: [], better: [] };
  const above = others.filter((p) => p.mu > seed.mu).length;
  const total = others.length + 1;
  const rank = above + 1;
  const percentile = {
    rank,
    total,
    // "About top N%", never 0.
    topPct: Math.max(1, Math.round((100 * rank) / total)),
    // The share of graded portfolios this one is ahead of.
    ahead: Math.round((100 * (total - rank)) / total),
    level: seed.mu,
  };
  const roles = new Set((grade.roles ?? []).map((r) => String(r).toLowerCase()));
  const similar = others
    .filter((p) => p.tier === seed.tier)
    .map((p) => ({ p, d: Math.abs(p.mu - seed.mu) - (p.roles.some((r) => roles.has(String(r).toLowerCase())) ? 0.75 : 0) }))
    .sort((a, b) => a.d - b.d || a.p.url.localeCompare(b.p.url))
    .slice(0, 4)
    .map(({ p }) => site(p));
  // The two weakest AI axes, then portfolios scoring 5 there, best first.
  const weakest = AI_CRITERIA.filter((c) => typeof grade?.[c.id]?.score === "number" && grade[c.id].score <= 4)
    .sort((a, b) => grade[a.id].score - grade[b.id].score || b.weight - a.weight)
    .slice(0, 2);
  const better = weakest
    .map((c) => ({
      criterion: c.id,
      label: byId[c.id].name,
      yours: grade[c.id].score,
      sites: others
        .filter((p) => p.axes[c.id] === 5 && p.mu > seed.mu)
        .sort((a, b) => b.mu - a.mu || a.url.localeCompare(b.url))
        .slice(0, 3)
        .map(site),
    }))
    .filter((b) => b.sites.length);
  return { percentile, similar, better };
}

/** The whole report for a finished grade, as stored in grade_jobs.report. */
export function buildReport(grade, pool, { isSelf } = {}) {
  return {
    facts: factLines(grade),
    judgments: judgmentLines(grade),
    ...strengthsAndFixes(grade),
    ...compareWithPool(grade, pool, { isSelf }),
    poolSize: pool.length,
  };
}

// ---------------------------------------------------------------------------
// The printable report (GAMES_V2, app/report/print): a listed portfolio's
// grade as a print-optimised HTML page, which the browser saves as a PDF.
//
// Why HTML and not a PDF made on the Worker: a PDF library on the Worker
// either ships its standard fonts only (no accents beyond Latin-1, no
// non-Latin names) or a megabyte-scale font, and can't lay out the
// screenshot and notes as well as the browser's own "Save as PDF" does.
// ---------------------------------------------------------------------------

const TIERS = ["S", "A", "B", "C", "D"];
// Only the top tiers get a public letter (as on the portfolio page).
const PUBLIC_TIERS = ["S", "A", "B"];

/**
 * A stored grade (portfolios.ai_rubric) as the printable report shows it:
 * the same facts and judgments as a grade report, only the lines the grade
 * has. Null without a usable grade.
 */
export function printView(raw) {
  const g = parse(raw);
  if (!g || !TIERS.includes(g.tier)) return null;
  return {
    tier: g.tier,
    showTier: PUBLIC_TIERS.includes(g.tier),
    quality: typeof g.quality_score === "number" ? g.quality_score : null,
    checksScore: typeof g.checks_score === "number" ? g.checks_score : null,
    judgments: judgmentLines(g).filter((j) => typeof j.score === "number"),
    facts: factLines(g).filter((f) => typeof f.pass === "boolean"),
    model: typeof g.model === "string" ? g.model : null,
    judgedAt: typeof g.judged_at === "string" ? g.judged_at : null,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The print page: self-contained HTML with print styles and a Save as PDF
 * button. `view` is printView(); `percentiles` the portfolio's "top X%" per
 * board (lib/games/pool.mjs percentilesOf), or null.
 */
export function renderReportHtml({ name, url, tagline, view, percentiles, hero, siteUrl, now = new Date() }) {
  const domain = domainOf(url);
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
  h1 { font-size: 26px; margin: 0; line-height: 1.2; overflow-wrap: anywhere; }
  .sub { color: var(--mute); margin: 4px 0 0; overflow-wrap: anywhere; }
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
    <div class="tier${view.showTier ? "" : " neutral"}" aria-label="${view.showTier ? `Tier ${esc(view.tier)}` : "AI review"}">${view.showTier ? esc(view.tier) : "AI"}</div>
    ${view.quality == null ? "" : `<div class="score"><span>Quality</span><strong>${esc(view.quality.toFixed(1))} / 5</strong></div>`}
    ${view.checksScore == null ? "" : `<div class="score"><span>Checks passed</span><strong>${esc(view.checksScore)} / 100</strong></div>`}
    ${percentiles ? pct("Merged", percentiles.merged) + pct("AI", percentiles.ai) + pct("People", percentiles.people) : ""}
  </section>
  <h2>AI design review</h2>
  <div class="axes">
    ${view.judgments
      .map(
        (a) => `<div class="axis"><div><span>${esc(a.label)}</span><span>${esc(a.score)} / 5</span></div><div class="bar"><i style="width:${(Math.max(0, Math.min(5, a.score)) / 5) * 100}%"></i></div>${a.note ? `<p>${esc(a.note)}</p>` : ""}</div>`
      )
      .join("\n    ")}
  </div>
  ${view.facts.length ? `<h2>Checks by code</h2>\n  <ul class="checks">${view.facts.map((f) => `<li>${f.pass ? "✓" : "✗"} ${esc(f.label)}</li>`).join("")}</ul>` : ""}
  <button class="print" type="button">Save as PDF</button>
  <footer>
    Graded by Gemini${view.model ? ` (${esc(view.model)})` : ""}${view.judgedAt ? ` on ${esc(date(view.judgedAt))}` : ""}: an opinion, not a verdict.
    Downloaded ${esc(date(now))} from <a href="${esc(siteUrl)}/p/${esc(encodeURIComponent(url))}">${esc(siteUrl.replace(/^https?:\/\//, ""))}</a>.
  </footer>
</main>
<script src="/report-print.js" defer></script>
</body>
</html>`;
}
