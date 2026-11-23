// The code-measured facts a stored grade is read with. A site is graded once
// (owner, 2026-11-21), and its grade (portfolios.ai_rubric) keeps a copy of
// the facts it was made with and the code checks made from them. The page is
// measured again at every capture, and after the measuring code changes
// (remeasure-all.yml), into portfolios.facts. So every reader of a grade's
// code items (resume, GitHub, contact, own domain, project links, footer
// year) reads them from the newest measured facts when those are at least as
// new a measuring version as the grade's copy, and from the grade's copy
// otherwise: the automated checks score (lib/check-points.mjs through
// lib/tiers-store.mjs), the report card's "checks passed", the fact chips and
// the printable report all agree.
//
// Gemini's answer (its letter, its five scores and notes, its portfolio
// verdict) is never changed, and nothing here writes: the stored grade stays
// as it was made. Pure.
import { checksScore, codeChecks, geminiAnswered } from "../pipeline/rubric.mjs";

/** The facts a grade's code checks are made from (pipeline/rubric.mjs codeChecks). */
export const CODE_FACT_KEYS = ["resume", "github", "contact", "own_domain", "project_links", "footer_year"];

const parse = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

/** The measuring version of a facts object (pipeline/facts.mjs FACTS_VERSION, its `v`), 0 when it has none. */
export function factsVersionOf(facts) {
  const v = Number(parse(facts)?.v);
  return Number.isFinite(v) ? v : 0;
}

/**
 * The row's measured facts when they should replace the grade's copy: they
 * exist and their measuring version is at least the grade's. Null otherwise.
 */
export function freshFactsFor(grade, rowFacts) {
  const fresh = parse(rowFacts);
  if (!fresh || Array.isArray(fresh)) return null;
  return factsVersionOf(fresh) >= factsVersionOf(grade?.facts) ? fresh : null;
}

/**
 * The grade as its readers should see it: with the row's newest measured
 * facts (`rowFacts`, portfolios.facts, a JSON string or an object) in place
 * of the copy frozen into the grade for the code items, and its code checks
 * and checks score made again from them (`facts_from: "measured"` marks such
 * a copy). A project-link check the newest facts do not have yet keeps the
 * grade's. Returns the grade itself when there is nothing fresher, or no
 * usable grade.
 */
export function withFreshFacts(grade, rowFacts, { now = new Date() } = {}) {
  if (!grade || typeof grade !== "object" || grade.error || typeof grade.tier !== "string") return grade;
  const fresh = freshFactsFor(grade, rowFacts);
  if (!fresh) return grade;
  const old = grade.facts && typeof grade.facts === "object" ? grade.facts : {};
  const facts = { ...old, v: fresh.v ?? old.v, measured_at: fresh.measured_at ?? old.measured_at };
  for (const k of CODE_FACT_KEYS) {
    if (k === "project_links" && fresh[k] == null) continue;
    if (k in fresh) facts[k] = fresh[k];
  }
  // The grade's own project links, kept, are judged by the rule of the version they were measured under.
  if (fresh.project_links == null && old.project_links != null) facts.v = old.v;
  // The other facts (the template fingerprint, signals) stay the grade's, so every check is made again from one set.
  const checks = codeChecks(facts, now);
  return { ...grade, facts, checks, checks_score: checksScore(checks), facts_from: "measured" };
}

/**
 * What the Code checks score reads for a site (owner, 2026-11-22: the
 * Starting rank comes only from code measurements): a Gemini grade read with
 * the newest measured facts (withFreshFacts), or, for a site Gemini has not
 * graded, its own measured facts (`rowFacts`) with the code checks made from
 * them. The same items either way, so one site has one number whether or not
 * the model has looked at it. Null when there is neither.
 */
export function checksReading(grade, rowFacts, { now = new Date() } = {}) {
  const g = parse(grade);
  if (geminiAnswered(g)) return withFreshFacts(g, rowFacts, { now });
  const facts = parse(rowFacts);
  if (!facts || Array.isArray(facts)) return null;
  const checks = codeChecks(facts, now);
  return { facts, checks, checks_score: checksScore(checks), facts_from: "measured" };
}

/** withFreshFacts for a stored grade as text (portfolios.ai_rubric), or null when it is not a grade. */
export function freshGrade(rawRubric, rowFacts, opts) {
  const g = parse(rawRubric);
  return g && !Array.isArray(g) ? withFreshFacts(g, rowFacts, opts) : null;
}
