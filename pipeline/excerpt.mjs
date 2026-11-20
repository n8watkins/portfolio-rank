// The projects-aware page-text excerpt of rubric v3, built by code.
//
// Rubric v2 sends the first 4,000 characters of the flattened page text, so
// on about half of all sites a long nav, hero or about section pushes the
// projects out of the text that judges projects (docs/audits/
// gemini-prompting.md, F2). v3 keeps the same budget but fills it in parts:
// the top of the page (who and what), then the projects section found in
// the rendered page, then whatever else fits. The capture reads the page's
// outline in the browser (readPageOutline) and code builds the excerpt
// (buildExcerpt), so the model never decides what it gets to see.
import { PAGE_TEXT_MAX, normalizePageText } from "./rubric.mjs";

/** Characters of the top of the page in an excerpt. */
export const INTRO_MAX = 1200;
/** Characters of the projects section in an excerpt (more when the rest is short). */
export const PROJECTS_MAX = 2000;

// A heading or anchor that names the projects. "Work" alone counts, but not
// work experience, how I work or work with me.
// "Portfolio" counts only as the whole heading ("My portfolio"), since
// "Developer portfolio" is usually the site's own title.
export const PROJECTS_RX = /\b(projects?|works?|case stud(?:y|ies)|things i(?:'|’)?ve (?:built|made)|what i(?:'|’)?ve built|showcase|creations|builds)\b|^\W*(?:my )?portfolio\W*$/i;
export const NOT_PROJECTS_RX = /experience|how i work|work with me|let'?s work|working|work history|hire|contact|open to|manager|officer|intern\b|lead\b|owner/i;
/** A heading short enough to be a section title, not a sentence. */
export const HEADING_MAX_WORDS = 6;

/**
 * Runs in the page (page.evaluate). The rendered text plus the projects
 * section: its heading, its own text and its top on the page (for a
 * screenshot), found by a heading or an element id that names the projects.
 * Self-contained: the patterns are passed in as sources.
 */
export function readPageOutline({ projects, notProjects, maxWords }) {
  const RX = new RegExp(projects, "i");
  const NOT = new RegExp(notProjects, "i");
  const text = document.body?.innerText ?? "";
  const bodyLen = Math.max(1, text.length);
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const textOf = (el) => (el.innerText ?? "").trim();
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,[role=heading]")]
    .filter(shown)
    .map((el) => ({ el, level: Number(el.tagName[1]) || 2, text: textOf(el).replace(/\s+/g, " ").slice(0, 120) }))
    .filter((h) => h.text);
  // The section a heading opens: its parents up to the last one that is
  // still a section of the page (not most of the page).
  const containerOf = (el) => {
    let c = el;
    while (c.parentElement && c.parentElement !== document.body) {
      const p = c.parentElement;
      if (textOf(p).length > 0.7 * bodyLen) break;
      c = p;
      if (/^(SECTION|ARTICLE|MAIN)$/.test(c.tagName) && textOf(c).length > 200) break;
    }
    return c;
  };
  let heading = null;
  let box = null;
  const title = (t) => {
    const words = t.trim().split(/\s+/).length;
    return t.length <= 48 && words <= maxWords && (!/[.!?]$/.test(t.trim()) || words <= 3);
  };
  const fits = (x) => x.level > 1 && title(x.text) && RX.test(x.text) && !NOT.test(x.text);
  // A heading that ends in "projects" or "work" ("Featured projects",
  // "Selected work.") wins over one that only mentions them, such as a
  // project's own title or a job title.
  const ends = /^\W*(?:[\w&'’]+\s+){0,2}(?:projects?|works?)\W*$/i;
  const h = headings.find((x) => fits(x) && ends.test(x.text)) ?? headings.find(fits);
  if (h) {
    heading = h.text;
    box = containerOf(h.el);
  } else {
    box = [...document.querySelectorAll("[id]")].find((e) => RX.test(e.id) && !NOT.test(e.id) && shown(e) && textOf(e).length > 80) ?? null;
    if (box) heading = `#${box.id}`;
  }
  const projectsText = box ? textOf(box) : "";
  const top = box ? Math.max(0, Math.round(box.getBoundingClientRect().top + window.scrollY - 24)) : null;
  return {
    text,
    headings: headings.map(({ level, text: t }) => ({ level, text: t })).slice(0, 60),
    projects: box ? { heading, text: projectsText, top } : null,
    height: document.documentElement.scrollHeight,
  };
}

/** The patterns for readPageOutline, as sources (page.evaluate cannot take a RegExp). */
export const OUTLINE_ARGS = { projects: PROJECTS_RX.source, notProjects: NOT_PROJECTS_RX.source, maxWords: HEADING_MAX_WORDS };

const cut = (t, max) => normalizePageText(t, max);

/**
 * Finds the projects section in plain page text when the outline found none:
 * the first short line after the top of the page that names the projects.
 * Returns the text from that line on, or "".
 */
export function projectsFromText(text) {
  const lines = String(text ?? "").split("\n");
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (at > 300 && l.length > 0 && l.length <= 40 && l.split(/\s+/).length <= HEADING_MAX_WORDS && PROJECTS_RX.test(l) && !NOT_PROJECTS_RX.test(l)) {
      return lines.slice(i).join("\n");
    }
    at += lines[i].length + 1;
  }
  return "";
}

/**
 * The excerpt sent with a v3 grade, at most `max` characters of page text:
 * the whole page when it fits; otherwise the top of the page, the projects
 * section and the rest, each labelled, so the model knows parts were left
 * out. Returns { text, parts, full_length, projects_found }.
 */
export function buildExcerpt({ text, projects = null }, max = PAGE_TEXT_MAX) {
  const all = normalizePageText(text, Number.MAX_SAFE_INTEGER);
  if (all.length <= max) return { text: all, parts: ["whole page"], full_length: all.length, projects_found: Boolean(projects?.text) || projectsFromText(all) !== "" };
  const fromDom = projects?.text ? normalizePageText(projects.text, Number.MAX_SAFE_INTEGER) : "";
  const proj = fromDom || normalizePageText(projectsFromText(all), Number.MAX_SAFE_INTEGER);
  // Where the projects start in the page, so the top and the rest do not repeat them.
  const start = proj ? all.indexOf(proj.slice(0, 80)) : -1;
  const introEnd = start >= 0 ? Math.min(INTRO_MAX, start) : INTRO_MAX;
  const intro = cut(all.slice(0, introEnd), INTRO_MAX);
  const parts = [`[top of the page]\n${intro}`];
  const names = ["top of the page"];
  let left = max - intro.length;
  if (proj) {
    const label = projects?.heading ? `[projects section: ${String(projects.heading).slice(0, 60)}]` : "[projects section]";
    const p = cut(proj, Math.max(PROJECTS_MAX, left - 600));
    parts.push(`${label}\n${p}`);
    names.push("projects section");
    left -= p.length + label.length;
  }
  // The rest of the page in reading order, without the parts already sent.
  let rest = all.slice(introEnd);
  if (proj && start >= 0) rest = `${all.slice(introEnd, start)}\n${all.slice(start + proj.length)}`;
  rest = rest.trim();
  if (rest && left > 200) {
    parts.push(`[more of the page]\n${cut(rest, left - 20)}`);
    names.push("more of the page");
  }
  return { text: parts.join("\n"), parts: names, full_length: all.length, projects_found: Boolean(proj) };
}
