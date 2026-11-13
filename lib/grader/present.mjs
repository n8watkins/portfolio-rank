// How the grade report page (app/grade/[id]) words a finished grade: the
// one-line verdict, the measured facts grouped as a hiring manager reads
// them, and the expected effect of each fix. Pure code over the stored grade
// and the cached pool of graded portfolios (lib/grader/report.mjs
// gradedPool): no Gemini request, no table scan.
import { AI_CRITERIA, checksScore, qualityScore } from "../../pipeline/rubric.mjs";
import { seedFromGrade } from "../ranking/engine.mjs";
import { familyOf } from "../tiers.mjs";
import { gradeKey } from "../grade-score.mjs";

/** One line under the result, by the grade's own letter (Gemini's S to D, the report card): what the grade says in plain words. */
export const VERDICT = {
  SSS: "Among the very best in the library: polished, clear and memorable.",
  "S+": "Outstanding: polished, clear and memorable.",
  S: "One of the best: polished and clear, with little to fix.",
  A: "Strong and clear, with a few rough edges.",
  B: "Solid basics; the projects need more story.",
  C: "Works, but looks like a template and says little.",
  D: "Hard to tell who this is or what they built.",
};
export const verdictOf = (tier) => VERDICT[tier] ?? VERDICT[familyOf(tier)] ?? VERDICT.C;

/** What each measured fact means to a hiring manager, and the fix (keys are pipeline/rubric.mjs CODE_CRITERIA ids). */
export const FACT_COPY = {
  contact: { short: "Contact", missing: "Someone who likes your work has no way to reach you.", fix: "Add an email link or a contact form." },
  resume: { short: "Resume", missing: "Recruiters look for a resume first; many move on without one.", fix: "Link a PDF from the top of the page." },
  github: { short: "GitHub", missing: "They can't check your code.", fix: "Link your GitHub profile beside your contact links." },
  project_links: { short: "Working project links", missing: "A dead demo reads as abandoned work.", fix: "Fix or remove the broken links." },
  own_domain: { short: "Own domain", missing: "A shared host looks temporary.", fix: "A domain costs about $12 a year and reads as yours." },
  fresh_footer: { short: "Up to date", missing: "An old year suggests the site was left behind.", fix: "Update the footer year, or drop it." },
  original: { short: "Your own design", missing: "It looks like many other portfolios.", fix: "Change the layout, type or colours so it feels like yours." },
};

/** The three questions a hiring manager asks, each answered by measured facts. */
export const FACT_GROUPS = [
  { key: "reach", title: "Can they reach you?", facts: ["contact", "resume"] },
  { key: "work", title: "Can they see your work?", facts: ["github", "project_links"] },
  { key: "current", title: "Does it look current and yours?", facts: ["own_domain", "fresh_footer", "original"] },
];

/**
 * The report's fact lines ({ id, label, pass, detail }) in the three groups:
 * passing facts (chips), missing facts (cards with the meaning and the fix)
 * and facts the checks couldn't measure. A group with nothing measured is
 * left out.
 */
export function hiringGroups(facts) {
  const by = new Map((facts ?? []).map((f) => [f.id, f]));
  const line = (f) => ({ id: f.id, short: FACT_COPY[f.id]?.short ?? f.label, detail: f.detail ?? "" });
  return FACT_GROUPS.map((g) => {
    const items = g.facts.map((id) => by.get(id)).filter(Boolean);
    return {
      key: g.key,
      title: g.title,
      ok: items.filter((f) => f.pass === true).map(line),
      missing: items.filter((f) => f.pass === false).map((f) => ({ ...line(f), missing: FACT_COPY[f.id]?.missing ?? "", fix: FACT_COPY[f.id]?.fix ?? "" })),
      unknown: items.filter((f) => f.pass !== true && f.pass !== false).map(line),
    };
  }).filter((g) => g.ok.length + g.missing.length + g.unknown.length > 0);
}

const scoreOf = (v) => (typeof v === "number" ? v : typeof v?.score === "number" ? v.score : null);
const label = (id) => AI_CRITERIA.find((c) => c.id === id)?.name ?? id;

/** How many of `pool` sit above a grade key (lib/grade-score.mjs). */
const above = (pool, key) => pool.reduce((n, p) => n + (typeof p.key === "number" && p.key > key ? 1 : 0), 0);

/**
 * Each fix with what making it should change, in words:
 * - an AI axis: the grade with that score one point higher, scored the way
 *   the report card scores it (lib/grade-score.mjs), gives the places the
 *   grade gains among the graded pool;
 * - a measured fact: the checks score with that check passing.
 * `isSelf(url)` leaves the graded site itself out of the pool.
 *
 * @param {any} grade
 * @param {{ criterion: string, title: string, why: string, by: "ai" | "code" }[]} fixes
 * @param {{ url: string, key?: number | null }[]} pool
 * @param {{ isSelf?: (url: string) => boolean }} [options]
 * @returns {{ criterion: string, title: string, why: string, by: "ai" | "code", effect: string | null }[]}
 */
export function fixEffects(grade, fixes, pool, { isSelf = () => false } = {}) {
  const others = (pool ?? []).filter((p) => !isSelf(p.url));
  const key = gradeKey(grade);
  return (fixes ?? []).map((f) => {
    if (f.by === "ai") {
      const s = scoreOf(grade?.[f.criterion]);
      if (typeof s !== "number" || s >= 5) return { ...f, effect: null };
      const lifted = { ...grade, [f.criterion]: { ...(typeof grade[f.criterion] === "object" ? grade[f.criterion] : {}), score: s + 1 } };
      lifted.quality_score = qualityScore(lifted);
      const next = gradeKey(lifted);
      const gain = key != null && next != null && others.length ? above(others, key) - above(others, next) : 0;
      if (gain > 0) return { ...f, effect: `the grade climbs about ${gain} ${gain === 1 ? "place" : "places"} if ${label(f.criterion).toLowerCase()} goes up one point` };
      const q = seedFromGrade(grade).quality;
      return { ...f, effect: typeof q === "number" ? `the quality score goes from ${q.toFixed(1)} to ${lifted.quality_score.toFixed(1)} of 5` : null };
    }
    const before = checksScore(grade?.checks);
    const after = checksScore({ ...(grade?.checks ?? {}), [f.criterion]: true });
    return { ...f, effect: before != null && after != null && after > before ? `checks passed go from ${before} to ${after} of 100` : null };
  });
}

/**
 * A pool site's place by ELO among the portfolios with enough face-offs, as
 * the hourly refresh placed it (lib/tiers-store.mjs), and its "top N%"; null
 * while it has too few face-offs (it shows the starting tier, no place).
 */
export function placeIn(pool, url) {
  const me = pool?.find((p) => p.url === url);
  if (!me || typeof me.place !== "number" || typeof me.top !== "number") return null;
  return { rank: me.place, total: me.of ?? null, topPct: me.top };
}

/**
 * How a finished grade is celebrated on its report (components/grade/
 * Celebration), escalating with the result: level 1 for the top half, up to
 * 5 for an SSS. The badge, when there is one, is the games badge the owner
 * earns for reaching that level (lib/games/badges.mjs, counter gradeLevel).
 */
export const CELEBRATIONS = [
  null,
  { level: 1, key: "top50", title: "Top half", line: "Ahead of most graded portfolios." },
  { level: 2, key: "top25", title: "Top 25%", line: "Ahead of three in four graded portfolios.", badge: "top25" },
  { level: 3, key: "top10", title: "Top 10%", line: "Ahead of nine in ten graded portfolios.", badge: "top10" },
  { level: 4, key: "top5", title: "Top 5%", line: "Ahead of 95 in 100 graded portfolios.", badge: "top5" },
  { level: 5, key: "s", title: "SSS tier", line: "The highest grade there is: one of the top 3.", badge: "stier" },
];

/**
 * The celebration level of a report (0 for none): an SSS grade (the top 3
 * by rank, lib/tiers.mjs) is level 5; otherwise its "top X%" among graded
 * portfolios.
 * @param {{ tier?: string | null, percentile?: { topPct: number } | null } | null | undefined} report
 */
export function celebrationLevel(report) {
  if (!report) return 0;
  if (String(report.tier ?? "").toUpperCase() === "SSS") return 5;
  const p = report.percentile?.topPct;
  if (typeof p !== "number" || !(p > 0)) return 0;
  return p <= 5 ? 4 : p <= 10 ? 3 : p <= 25 ? 2 : p <= 50 ? 1 : 0;
}

// Page titles that name the page, not a person or a site.
const GENERIC_TITLE = /^(home|homepage|portfolio|my portfolio|welcome|index|about|about me|redirecting\.*|loading\.*|untitled|document)$/i;

/**
 * The name a report (and its share card) leads with: the list's name for a
 * listed portfolio (the person), else the page title's first part ("Nathan
 * Watkins | Full-Stack Developer" gives "Nathan Watkins") when it reads like
 * a name, else the site's own address.
 *
 * @param {{ listedName?: string | null, title?: string | null, domain: string }} input
 */
export function displayName({ listedName, title, domain }) {
  if (listedName && listedName.trim()) return listedName.trim();
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  const head = t.split(/\s+[|\-–—·•:]\s+/)[0]?.trim() ?? "";
  if (head.length >= 2 && head.length <= 60 && !GENERIC_TITLE.test(head)) return head;
  return domain;
}
