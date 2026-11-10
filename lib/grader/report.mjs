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
import { AI_CRITERIA, CODE_CRITERIA, CRITERIA } from "../../pipeline/rubric.mjs";
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
  original: { title: "Make the template your own", why: "The page carries the fingerprint of a known template." },
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
    original: () => (facts.template ? `Looks like ${facts.template}` : "No known template found"),
  };
  return CODE_CRITERIA.filter((c) => c.weight > 0).map((c) => ({
    id: c.id,
    label: c.name,
    pass: checks[c.id] ?? null,
    detail: detail[c.id]?.(checks[c.id]) ?? "",
  }));
}

/** The AI's five judgments, 1 to 5 with its note. */
export function judgmentLines(grade) {
  return AI_CRITERIA.map((c) => ({ id: c.id, label: c.name, score: grade?.[c.id]?.score ?? null, note: grade?.[c.id]?.note ?? "" }));
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
    if (!c.weight || grade?.checks?.[c.id] !== false) continue;
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
