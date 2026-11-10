import { AI_CRITERIA, CODE_CRITERIA } from "@/pipeline/rubric.mjs";

// Plain-language lists of what the AI grade looks at, read from the rubric
// (pipeline/rubric.mjs) so the copy follows it when the criteria change.

/** "a, b, c and d" */
function list(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Sentence case inside a sentence, but names like GitHub keep their capitals.
const lower = (s: string) => s.replace(/^[A-Z][a-z]*\b/, (w) => (/[A-Z]/.test(w.slice(1)) ? w : w.toLowerCase()));

/** What Gemini scores, e.g. "visual design, five-second test, ...". */
export const AI_JUDGES = list(AI_CRITERIA.map((c) => lower(c.name)));

/** The code checks that count towards the checks score. */
export const CODE_CHECKS = list(CODE_CRITERIA.filter((c) => c.weight > 0).map((c) => lower(c.name)));

/** Measured for context only, never scored. */
export const CODE_CONTEXT = list(CODE_CRITERIA.filter((c) => c.weight === 0).map((c) => lower(c.name)));
