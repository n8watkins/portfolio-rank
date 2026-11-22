// Portfolio-likeness first pass (free, deterministic, no Gemini): count the
// things a personal portfolio usually has, from the page's HTML. A page with
// none or almost none is flagged needs_review: never removed or hidden for
// it, only moved to the front of the grading queue so Gemini's is_portfolio
// can confirm or clear it. The signals are stored per site
// (portfolios.signals) for the transparent rubric later.

import { CONTACT_WORDS, LABEL_MAX, isGithubProfile, isResumeLabel, scanPage } from "./page-controls.mjs";

// At or below this many signals a page needs review.
export const NEEDS_REVIEW_MAX = 1;

const SOCIAL = /href\s*=\s*["']?https?:\/\/(?:www\.)?(?:linkedin\.com\/in|twitter\.com|x\.com|instagram\.com|dribbble\.com|behance\.net|mastodon\.[a-z]+|bsky\.app|threads\.net)\//i;
const GITHUB = /href\s*=\s*["']?https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+/i;
// A nav-like control that opens the projects (krishnananda.netlify.app's "Works" tab). Not a bare "Work": a Work / Education toggle is a timeline.
const PROJECTS_CONTROL = /^\s*(?:works|my work|projects?|portfolio)\s*$/i;

const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
const clean = (s) => String(s ?? "").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");

/**
 * Signals from a page's HTML (server HTML, or the browser-rendered DOM for
 * single-page apps) and the listed name. Returns
 * { projects, about, contact, resume, github, name, score, needsReview }.
 * `scan` is the page's scanPage result when the caller has one.
 */
export function portfolioSignals(html, name, scan = null) {
  const raw = String(html ?? "").slice(0, 400000);
  // One linear pass (./page-controls.mjs): the text without scripts and styles, the title and h1, link targets and ids, and the controls.
  const page = scan ?? scanPage(raw);
  const text = fold(clean(page.text));
  // Link targets and ids count too: "#projects", "/about", "resume.pdf".
  const attrs = fold(page.attrValues.join(" "));
  const both = `${text} ${attrs}`;
  const head = fold(clean(page.head));
  // Controls: an icon-only button labelled "View Resume" or "Contact" counts;
  // a "Works" tab counts for projects. GitHub needs a github.com URL on the
  // control, not the word ("Sign in with GitHub"). Nothing for about.
  const controls = page.controls;
  const tokens = fold(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const s = {
    projects:
      /\b(projects?|portfolio|my work|selected work|case stud(?:y|ies)|things i(?:'ve)? built)\b/.test(both) ||
      controls.some((c) => c.inLink == null && PROJECTS_CONTROL.test(c.text)),
    about: /\babout(?:[ -]?me)?\b|\bwho i am\b/.test(both),
    contact:
      /mailto:/i.test(raw) ||
      /<form\b/i.test(raw) ||
      SOCIAL.test(raw) ||
      /\bcontact\b|\bget in touch\b|\bhire me\b/.test(both) ||
      controls.some((c) => c.parts.some((p) => p.length <= LABEL_MAX && CONTACT_WORDS.test(p))),
    resume: /\b(resume|cv|curriculum vitae)\b/.test(both) || controls.some((c) => c.parts.some(isResumeLabel)),
    github: GITHUB.test(raw) || controls.some((c) => [...c.navUrls, ...c.attrUrls].some(isGithubProfile)),
    name: tokens.length > 0 && tokens.some((t) => head.includes(t)),
  };
  const score = Object.values(s).filter(Boolean).length;
  return { ...s, score, needsReview: score <= NEEDS_REVIEW_MAX };
}
