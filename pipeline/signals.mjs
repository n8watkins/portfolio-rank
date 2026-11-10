// Portfolio-likeness first pass (free, deterministic, no Gemini): count the
// things a personal portfolio usually has, from the page's HTML. A page with
// none or almost none is flagged needs_review: never removed or hidden for
// it, only moved to the front of the grading queue so Gemini's is_portfolio
// can confirm or clear it. The signals are stored per site
// (portfolios.signals) for the transparent rubric later.

// At or below this many signals a page needs review.
export const NEEDS_REVIEW_MAX = 1;

const SOCIAL = /href\s*=\s*["']?https?:\/\/(?:www\.)?(?:linkedin\.com\/in|twitter\.com|x\.com|instagram\.com|dribbble\.com|behance\.net|mastodon\.[a-z]+|bsky\.app|threads\.net)\//i;
const GITHUB = /href\s*=\s*["']?https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+/i;

const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

const textOf = (html) =>
  String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");

/**
 * Signals from a page's HTML (server HTML, or the browser-rendered DOM for
 * single-page apps) and the listed name. Returns
 * { projects, about, contact, resume, github, name, score, needsReview }.
 */
export function portfolioSignals(html, name) {
  const raw = String(html ?? "").slice(0, 400000);
  const text = fold(textOf(raw));
  // Link targets and ids count too: "#projects", "/about", "resume.pdf".
  const attrs = fold((raw.match(/(?:href|id)\s*=\s*["'][^"']*["']/gi) ?? []).join(" "));
  const both = `${text} ${attrs}`;
  const head = fold(
    textOf(
      [...raw.matchAll(/<(title|h1)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]).join(" ")
    )
  );
  const tokens = fold(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const s = {
    projects: /\b(projects?|portfolio|my work|selected work|case stud(?:y|ies)|things i(?:'ve)? built)\b/.test(both),
    about: /\babout(?:[ -]?me)?\b|\bwho i am\b/.test(both),
    contact: /mailto:/i.test(raw) || /<form\b/i.test(raw) || SOCIAL.test(raw) || /\bcontact\b|\bget in touch\b|\bhire me\b/.test(both),
    resume: /\b(resume|cv|curriculum vitae)\b/.test(both),
    github: GITHUB.test(raw),
    name: tokens.length > 0 && tokens.some((t) => head.includes(t)),
  };
  const score = Object.values(s).filter(Boolean).length;
  return { ...s, score, needsReview: score <= NEEDS_REVIEW_MAX };
}
