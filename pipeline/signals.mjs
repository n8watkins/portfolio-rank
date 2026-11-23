// Portfolio-likeness first pass (free, deterministic, no Gemini): count the
// things a personal portfolio usually has, from the page's HTML. A page with
// none or almost none is flagged needs_review: never removed or hidden for
// it, only moved to the front of the grading queue so Gemini's is_portfolio
// can confirm or clear it. The signals are stored per site
// (portfolios.signals) for the transparent rubric later.

import { CONTACT_WORDS, LABEL_MAX, decodeEntities, firstTitle, isGithubProfile, isResumeLabel, scanPage } from "./page-controls.mjs";

// At or below this many signals a page needs review.
export const NEEDS_REVIEW_MAX = 1;

// The most HTML the signals read: a bound against a pathological page, not a
// size real pages reach with their text. It used to be 400,000, and
// singhshailendra.in's plain HTML (591,613 characters, 2026-11-23) carries
// its menu and all its text after 533,000 characters of class names, so all
// of it was cut. The reading is linear (./page-controls.mjs scanPage):
// 2,000,000 characters take well under a second.
export const SIGNALS_MAX_HTML = 2000000;

// What a person calls themselves in the page's own head ("Abhishek Singh |
// Software Developer | MERN Stack & 3D Expert"): a role ends in one of these.
// One person, so singular: "Our engineers" is not a role.
const ROLE_NOUN = String.raw`(?:developer|engineer|designer|programmer|architect|scientist|analyst|consultant|freelancer|researcher|technologist|devops|sre|student|coder|lead|founder|cto)`;
const WORD = String.raw`[\p{L}\d+#.&/-]+`;
// In a title's part: everything up to its last role word ("Frontend Team Lead and Senior Javascript/Typescript Engineer").
const ROLE_IN_PART = new RegExp(String.raw`^(.*\b${ROLE_NOUN})(?![\p{L}\d])`, "iu");
// In the description: "I'm a web developer", "Jane Doe, a web developer", "is a Sydney-based data and AI engineer",
// "as a full-stack developer", or a description that starts with the role ("Design engineer in Warsaw.").
const ROLE_IN_DESCRIPTION = new RegExp(
  String.raw`(?:\b(?:i am|i['’]m)\s+(?:an?\s+)?|(?:\b(?:is|as)|,)\s+an?\s+|^)((?:${WORD}\s+){0,4}?${ROLE_NOUN})(?![\p{L}\d])`,
  "iu"
);
// Praise a person gives themselves, not part of the role ("a driven software developer").
const PUFFERY = /^(?:(?:passionate|driven|curious|dedicated|motivated|enthusiastic|creative|results-driven|detail-oriented|highly|very|self-taught|friendly|hardworking|hard-working|skilled|talented)\s+)+/i;
const TITLE_SPLIT = /\s+[|·•–—-]\s+|\s*[|·•]\s*|\s+[–—]\s*|:\s+/;
const ROLE_MAX_WORDS = 8;

const tidy = (s) => decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim();
/** The role a piece of text ends in, or null: at most ROLE_MAX_WORDS words, without self-praise. */
const roleFrom = (s, re) => {
  const m = tidy(s).match(re);
  if (!m) return null;
  const role = m[1].replace(PUFFERY, "").replace(/^(?:an?|the)\s+/i, "").replace(/^[\s,;&+-]+/, "").trim();
  return role && role.split(" ").length <= ROLE_MAX_WORDS ? role : null;
};

/**
 * The role the page states in its own head, or null when it states none:
 * from the <title> first (the first part of "Name | Role | Tagline" that ends
 * in a role word), then from the meta description's "I'm a ... developer".
 * Words only as the page writes them, never guessed. Stored with the site's
 * signals (portfolios.signals.role); nothing reads it yet.
 * @param {string} title @param {string} [description]
 */
export function statedRole(title, description = "") {
  for (const part of tidy(title).split(TITLE_SPLIT)) {
    const role = roleFrom(part, ROLE_IN_PART);
    if (role) return role;
  }
  return roleFrom(description, ROLE_IN_DESCRIPTION);
}

/** The content of the page's <meta name="description">, or "". */
export function metaDescription(html) {
  for (const tag of String(html ?? "").slice(0, 200000).match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?description\b/i.test(tag)) continue;
    return tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1] ?? "";
  }
  return "";
}

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
 * { projects, about, contact, resume, github, name, score, needsReview },
 * and `role` (statedRole) when the page's head states one: it counts for no
 * signal. `scan` is the page's scanPage result when the caller has one.
 */
export function portfolioSignals(html, name, scan = null) {
  const raw = String(html ?? "").slice(0, SIGNALS_MAX_HTML);
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
  const role = statedRole(firstTitle(raw), metaDescription(raw));
  return { ...s, score, needsReview: score <= NEEDS_REVIEW_MAX, ...(role ? { role } : {}) };
}
