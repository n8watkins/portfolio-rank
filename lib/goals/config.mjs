// The owner's goals (owner decision 2026-11-13): milestones that, once
// reached, call for a decision. The weekly check (pipeline/goals.mjs, Monday
// morning Pacific) measures each one, records its progress, and the first
// time a goal is reached emails the owner with a calendar invite for a
// decision slot. A goal fires once, ever.
//
// A goal is reached when ANY of its conditions holds. Each condition reads
// one metric (pipeline/goals.mjs METRICS) and needs `atLeast`; `weeks: 2`
// would mean two finished weeks in a row.
//
// To add a goal, add an entry here with a new, stable id (the id is what
// records that it fired; never reuse one).

/**
 * @typedef {{ metric: "newsletter_confirmed" | "graded_portfolios", atLeast: number, weeks?: number, label: string }} GoalCondition
 * @typedef {{ id: string, title: string, why: string, conditions: GoalCondition[], meeting: { title: string, minutes: number, agenda: string } }} Goal
 */

/** @type {Goal[]} */
export const GOALS = [
  {
    id: "newsletter-move-to-kit",
    title: "Newsletter: move to Kit",
    why: "The newsletter has outgrown sending through PortfolioRank's own email gate (the shared daily caps): move the list to Kit before the next issues.",
    conditions: [{ metric: "newsletter_confirmed", atLeast: 40, label: "40+ confirmed newsletter subscribers" }],
    meeting: {
      title: "Decide: move the newsletter to Kit",
      minutes: 30,
      agenda: "1. Pick the Kit plan (the free tier first).\n2. Export the confirmed subscribers and import them with their consent date.\n3. Point new sign-ups and issues at Kit, and stop sending issues through the email gate.",
    },
  },
  {
    id: "library-5000-graded",
    title: "Library: 5,000 graded portfolios",
    why: "The library has 5,000 graded portfolios: time to review the free-tier limits at this size and decide what grading and discovery do next.",
    conditions: [{ metric: "graded_portfolios", atLeast: 5000, label: "5,000+ graded portfolios in the library" }],
    meeting: {
      title: "Decide: the library at 5,000 graded portfolios",
      minutes: 30,
      agenda: "1. Check /admin/limits (Turso, R2, Workers CPU) against the 5,000-site projections.\n2. Decide the grading and discovery pace for the next stretch.\n3. Note what to celebrate or announce.",
    },
  },
];
