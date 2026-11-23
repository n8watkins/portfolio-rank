// Suspicion flags: named, explainable reasons to think a live site may not be
// a portfolio. The health check answers "is this site alive"; these answer
// "is there something on this alive page that a person should look at".
//
// Each flag is a pure function over what the product already has for a site
// (the rendered HTML and text, the plain HTML, the listed and final address,
// the listed name, the portfolio signals). No network, no AI. A flag is never
// a verdict: nothing here removes, hides or ranks a site. A flag that is raised
// returns { flag, reason, snippets }: its name, one plain sentence quoting what
// was found on the page, and the bits of the page it matched. A flag that is
// not raised returns null.
//
// The owner's rulings they are designed by (2026-11-23): "a portfolio page is
// fundamentally defined by showcasing technical projects you've created", and
// the projects may be design work; a page selling coaching is not a portfolio
// even if a developer's; a freelancer's portfolio that says hire me is one; a
// solo developer under a studio name who shows projects they built is one; a
// digital resume with no projects may stay listed; an intro or gate screen in
// front of a real portfolio is still a portfolio (the code just cannot read it).
//
// Measured on the portfolio-or-not benchmark and a fresh sample of listed sites
// (the ops handoff's run-benchmark.mjs prints the scorecard); see
// docs/HOW-IT-RUNS.md. Not wired to anything yet.
import { PROJECT_HEADING, decodeEntities, scanPage, stripTags } from "./page-controls.mjs";
import { pageLinks, projectCandidates } from "./facts.mjs";
import { visibleText } from "./gate.mjs";

/** The most HTML read, as the signals read it. */
const HTML_MAX = 400000;
/** Longest snippet quoted in a reason. */
const QUOTE_MAX = 60;

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const quote = (s, max = QUOTE_MAX) => {
  const t = squash(s);
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const raised = (flag, reason, snippets = []) => ({ flag, reason, snippets: [...new Set(snippets.map((s) => quote(s, 120)))].slice(0, 8) });
/** Every match of `re` (global) in `text`, up to `max`. */
const allMatches = (text, re, max = 50) => {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m && out.length < max; m = g.exec(text)) {
    out.push(m[0]);
    if (m[0] === "") g.lastIndex++;
  }
  return out;
};

// ---------- what every flag reads, worked out once per site ----------

// A link to a profile elsewhere, or an email or phone link: what a link card is made of.
const SOCIAL_HOST =
  /(^|\.)(github\.com|gitlab\.com|linkedin\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|bsky\.app|mastodon\.[a-z]+|dribbble\.com|behance\.net|medium\.com|dev\.to|hashnode\.(?:com|dev)|substack\.com|t\.me|telegram\.me|wa\.me|discord\.(?:gg|com)|reddit\.com|stackoverflow\.com|kaggle\.com|leetcode\.com|codepen\.io|twitch\.tv|spotify\.com|soundcloud\.com|chess\.com|lichess\.org|linktr\.ee|calendly\.com|cal\.com|keybase\.io|polywork\.com|read\.cv|peerlist\.io|unsplash\.com|pinterest\.com|patreon\.com|ko-fi\.com|buymeacoffee\.com)$/i;
const CONTACT_SCHEME = /^(mailto|tel|sms):/i;

const memo = new WeakMap();

/**
 * What the flags read, from a site's record: { url, finalUrl, name, html,
 * text, plainHtml, signals }. `html` and `text` are the rendered page's (the
 * browser's DOM and innerText); without them the plain HTML is read.
 */
export function readSite(site) {
  if (site && typeof site === "object" && memo.has(site)) return memo.get(site);
  const s = site ?? {};
  const html = String(s.html || s.plainHtml || "").slice(0, HTML_MAX);
  const finalUrl = String(s.finalUrl || s.url || "");
  const scan = scanPage(html, finalUrl || undefined);
  const textRaw = String(s.text ?? "").trim() ? String(s.text) : visibleText(html);
  const text = squash(decodeEntities(textRaw));
  const self = hostOf(finalUrl);
  const links = pageLinks(html, finalUrl, scan);
  const outbound = [];
  const social = [];
  const contact = [];
  for (const l of links) {
    if (CONTACT_SCHEME.test(l.raw ?? "")) {
      contact.push(l);
      continue;
    }
    const h = hostOf(l.href);
    if (!h || h === self || h.endsWith(`.${self}`) || self.endsWith(`.${h}`)) continue;
    if (SOCIAL_HOST.test(h)) social.push(l);
    else outbound.push(l);
  }
  const candidates = finalUrl ? projectCandidates(links, finalUrl, Infinity) : [];
  const headings = [];
  for (const m of html.matchAll(/<h([1-4])\b[^>]*>([\s\S]{0,2000}?)<\/h\1\s*>/gi)) {
    const words = squash(decodeEntities(stripTags(m[2])));
    if (words) headings.push({ level: Number(m[1]), words });
  }
  const projectHeadings = headings.filter((h) => h.level >= 2 && PROJECT_HEADING.test(h.words)).map((h) => h.words);
  const projectNav = links.filter((l) => PROJECTS_LABEL.test(squash(l.text))).map((l) => squash(l.text));
  const inProjects = [...links, ...scan.controls].some((x) => x.inProjects);
  const shownProjects = candidates.filter((c) => c.tier <= 2).length;
  const title = squash(decodeEntities(scan.head));
  const out = {
    url: String(s.url ?? ""),
    finalUrl,
    name: String(s.name ?? ""),
    html,
    text,
    title,
    headings,
    links,
    outbound,
    social,
    contact,
    signals: s.signals ?? null,
    projects: {
      shown: shownProjects,
      headings: projectHeadings,
      nav: projectNav,
      section: inProjects,
      any: shownProjects > 0 || projectHeadings.length > 0 || projectNav.length > 0 || inProjects,
    },
  };
  if (site && typeof site === "object") memo.set(site, out);
  return out;
}

/**
 * A link label that is the projects and nothing else, in the languages the list has, after any numbering or
 * decoration ("/Projects", "03 Work", "// Portfolio").
 */
const PROJECTS_LABEL =
  /^[\s/#~>|.:\d\p{Pd}]*(?:(?:my|all|our|selected|featured|recent|view all|see all|explore|view|see|mis|meus|mes|meine|i miei|mijn|ons|onze|мои)\s+)?(?:projects?|works?|portfolio|portafolio|portf[oó]lio|case stud(?:y|ies)|showcase|projets|proyectos|projekte|projetos|progetti|projecten|projekty|projeler|projelerim|werk|проекты|проекти|项目|作品|obras|trabalhos|trabajos|travaux|r[eé]alisations|creations|builds|experiments|lab)\s*[→›»↗]?$/iu;

// ---------- the flags ----------

// Filler a template ships with: Latin placeholder text and the "your name here" family.
const FILLER = [
  /\blorem ipsum\b/i,
  /\bdolor sit amet\b/i,
  /\bconsectetur adipi(?:s|sc)ing\b/i,
  /\bsed do eiusmod\b/i,
  /\byour name here\b/i,
  /\binsert (?:your|text|project|name)\b[^.]{0,20}\bhere\b/i,
  /\b(?:project|company) (?:title|name) (?:goes )?here\b/i,
];

/** The page contains template filler ("Lorem ipsum") or a fill-in-the-blank line. */
export function fillerText(site) {
  const p = readSite(site);
  const hits = FILLER.flatMap((re) => allMatches(p.text, re, 20));
  if (!hits.length) return null;
  const around = hits.slice(0, 3).map((h) => {
    const i = p.text.indexOf(h);
    return p.text.slice(i, i + 40);
  });
  return raised("filler-text", `The text contains filler: "${quote(around[0], 40)}"${hits.length > 1 ? ` (${plural(hits.length, "filler phrase")} in all)` : ""}.`, around);
}

// A page that says it is not ready yet.
const PLACEHOLDER = new RegExp(
  [
    String.raw`\bcoming soon\b`,
    String.raw`\bunder construction\b`,
    String.raw`\bunder (?:development|maintenance)\b`,
    String.raw`\bcooking (?:up )?something\b`,
    String.raw`\bsomething (?:new|exciting|awesome|big) is (?:coming|on (?:its|the) way|brewing)\b`,
    String.raw`\bwork in progress\b`,
    String.raw`\blaunching soon\b`,
    String.raw`\bstay tuned\b`,
    String.raw`\bcheck back (?:soon|later)\b`,
    String.raw`\b(?:site|page|portfolio|website) is (?:currently )?(?:being (?:re)?built|under)\b`,
    String.raw`\bcurrently (?:re)?(?:building|designing|working on) (?:my|the|this) (?:new )?(?:site|website|portfolio|page)\b`,
    String.raw`\ben construcci[oó]n\b`,
    String.raw`\bem constru[cç][aã]o\b`,
    String.raw`\bpr[oó]ximamente\b`,
    String.raw`\bbient[oô]t disponible\b`,
    String.raw`\bin arbeit\b`,
  ].join("|"),
  "i"
);
/** A page this short that says "coming soon" is the whole page saying it. */
export const PLACEHOLDER_MAX_TEXT = 600;

/** A short page that says it is coming soon, under construction or a work in progress. */
export function placeholderPage(site) {
  const p = readSite(site);
  if (p.text.length > PLACEHOLDER_MAX_TEXT) return null;
  const m = p.text.match(PLACEHOLDER);
  if (!m) return null;
  return raised("placeholder-page", `The page is ${p.text.length} characters long and says "${quote(m[0])}": a placeholder, not a finished site.`, [m[0], p.text.slice(0, 120)]);
}

/** Fewer visible characters than this: the code has nothing to read. */
export const LITTLE_TEXT_MAX = 60;

/**
 * Almost no text: a logo, a name, an intro or "who's watching" screen, a page
 * drawn on a canvas. Often a real portfolio behind a gate the code does not
 * press; the owner rules "an intro or gate screen in front of a real portfolio
 * is still a portfolio", so this asks a person to look and is never acted on.
 */
export function littleText(site) {
  const p = readSite(site);
  if (p.text.length >= LITTLE_TEXT_MAX) return null;
  return raised("little-text", p.text ? `The page shows only ${plural(p.text.length, "character")} of text: "${quote(p.text)}".` : "The page shows no text at all.", [p.text]);
}

// "This page has moved", "We moved to ...", "find me at my new site".
const MOVED = new RegExp(
  [
    String.raw`\b(?:this |my )?(?:page|site|website|blog|portfolio|home)\s+(?:has\s+)?(?:moved|relocated|migrated)\b`,
    String.raw`\b(?:we|i)(?:'ve|’ve| have)?\s+moved\b`,
    String.raw`\bmoved to (?:a )?(?:new|my new)\b`,
    String.raw`\b(?:has|have) a new (?:home|address|domain)\b`,
    String.raw`\bno longer (?:maintained|updated|in use|active)\b`,
    String.raw`\b(?:my )?new (?:site|website|portfolio|home|address) (?:is|lives) (?:at|here|now)\b`,
    String.raw`\b(?:find|visit) me (?:now )?(?:at|on) (?:my new|the new)\b`,
    String.raw`\bfind me at [a-z0-9-]+\.[a-z]{2,}\b`,
  ].join("|"),
  "i"
);
/** Longer than this, "moved" is in an article or a project's text, not a notice. */
export const MOVED_MAX_TEXT = 1500;

/** A short page that says the site has moved somewhere else. */
export function movedNotice(site) {
  const p = readSite(site);
  // A page with projects is the site itself, whatever it says ("I moved to Lisbon").
  if (p.text.length > MOVED_MAX_TEXT || p.projects.any) return null;
  const m = p.text.match(MOVED);
  if (!m) return null;
  const elsewhere = p.outbound.map((l) => hostOf(l.href)).filter(Boolean);
  return raised("moved-notice", `The page is ${p.text.length} characters long and says "${quote(m[0])}"${elsewhere.length ? `, with a link to ${elsewhere[0]}` : ""}: a forwarding notice, not a portfolio.`, [m[0], ...elsewhere.slice(0, 2)]);
}

// Dates the way posts carry them: "November 3, 2026", "Oct 21, 2026", "3 Nov 2026", "4 Mayıs 2026",
// "05/10/2026", "2026-10-05". A word month in any language: a word of 3 to 10 letters beside a day and a year.
const DATE_RE = new RegExp(
  [
    String.raw`\b\p{L}{3,10}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d\d\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\.?\s+(?:de\s+)?\p{L}{3,10}\.?,?\s+(?:de\s+)?(?:19|20)\d\d\b`,
    String.raw`\b\d{1,2}[/.]\d{1,2}[/.](?:19|20)\d\d\b`,
    String.raw`\b(?:19|20)\d\d-\d{2}-\d{2}\b`,
  ].join("|"),
  "giu"
);
// "· 3 min read", "⏱️ 10 min read", "2 min · 347 words", "5 minutes de lecture".
const READ_TIME = /\b\d{1,3}\s*(?:min(?:ute)?s?|dk|мин)\.?\s*(?:read|de lecture|de leitura|de lectura|lesezeit|okuma)?\b/giu;
const POST_WORD = /\b(?:read more|continue reading|read post|read article|leia mais|ler mais|leer m[aá]s|weiterlesen|lire la suite|devam[ıi]n[ıi] oku|yaz[ıi]ya git)\b/giu;
/** At least this many dated entries or "read more" links make a list of posts. */
export const BLOG_MIN_POSTS = 4;

const monthLike = (d) => {
  // "Version 3, 2026" or "Since 12 2020": a date needs a month word, not any word.
  const w = d.match(/\p{L}{3,10}/u)?.[0]?.toLowerCase();
  return !w || !NOT_MONTH.test(w);
};
/**
 * The dates without a calendar's: a contribution graph or a date picker lists every day in a row
 * ("2025-11-23", "2025-11-24", ...), posts do not. ISO dates go when most of them are a day after another.
 */
function notACalendar(dates) {
  const iso = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (iso.length < 10) return dates;
  const days = new Set(iso.map((d) => Date.parse(`${d}T00:00:00Z`) / 864e5));
  const runs = [...days].filter((d) => days.has(d - 1) || days.has(d + 1)).length;
  return runs / days.size >= 0.5 ? dates.filter((d) => !iso.includes(d)) : dates;
}
const NOT_MONTH =/^(?:since|from|version|page|step|chapter|part|level|season|episode|issue|vol|volume|room|year|years|about|over|with|and|the|for|copyright|rights|reserved)$/i;

/**
 * A list of dated posts and no projects anywhere: a blog. Projects anywhere
 * (a projects section, heading or menu link, a project link) keep it quiet:
 * a portfolio with a blog is a portfolio.
 */
// A menu or page link to the site's writing: "Blog", "Writing", "Articles", "Posts", "Notes".
const BLOG_LINK = /^(?:(?:my|the|read (?:my|the))\s+)?(?:blog|weblog|writing|writings|articles|posts|notes|journal|log|newsletter|essays|thoughts|tech blog|dev blog)\s*[→›»↗]?$/i;

/**
 * The blog facts of a page, for the blog-only flag and for showing why a page
 * with a blog was not flagged: { posts, what, snippets, blogLink, hasBlog,
 * projects, verdict } where verdict is "blog-only" (posts and no projects
 * anywhere the code can see), "posts-few-project-links" (ten or more posts,
 * project links only beside them and no projects menu link or section title),
 * or null with `why` saying what protects it.
 */
export function blogFacts(site) {
  const p = readSite(site);
  const dates = notACalendar(allMatches(p.text, DATE_RE, 400).filter(monthLike));
  const times = allMatches(p.text, READ_TIME, 300);
  const more = allMatches(p.text, POST_WORD, 300);
  const articles = (p.html.match(/<article\b/gi) ?? []).length;
  const timeTags = (p.html.match(/<time\b/gi) ?? []).length;
  // "Read more" never counts a post: it is as often a testimonial's or a card's (andrew.codes's recommendations).
  // Only dates, reading times and dated <article> elements do.
  const posts = Math.max(dates.length, times.length, Math.min(articles, timeTags));
  const what = dates.length >= BLOG_MIN_POSTS ? plural(dates.length, "dated post") : times.length >= BLOG_MIN_POSTS ? plural(times.length, "post", "posts with a reading time") : plural(posts, "dated article");
  const blogLink = p.links.map((l) => squash(l.text)).find((t) => BLOG_LINK.test(t)) ?? null;
  const base = { posts, what, snippets: [...dates.slice(0, 3), ...times.slice(0, 2), ...more.slice(0, 2)], blogLink, hasBlog: posts >= BLOG_MIN_POSTS || Boolean(blogLink), projects: p.projects };
  if (posts < BLOG_MIN_POSTS) return { ...base, verdict: null, why: base.hasBlog ? `a "${blogLink}" link but only ${plural(posts, "dated post")} on this page: the posts live elsewhere` : "no blog" };
  if (!p.projects.any) return { ...base, verdict: "blog-only" };
  // A page of whole posts names projects inside them ("New Project", a repository in a post): many posts, few
  // project links and no projects menu link or section title is still only a blog. A section title names the
  // projects in the plural ("Innovative Projects", "Selected work"); a post's subheading in the singular does not.
  const titled = p.projects.headings.some((h) => SECTION_TITLE.test(h));
  if (posts >= BLOG_MANY_POSTS && posts >= 3 * p.projects.shown && !p.projects.nav.length && !titled) return { ...base, verdict: "posts-few-project-links" };
  const why = p.projects.nav.length
    ? `a projects link in its menu ("${p.projects.nav[0]}")`
    : p.projects.headings.length
      ? `a projects heading ("${quote(p.projects.headings[0], 40)}")`
      : p.projects.shown
        ? `${plural(p.projects.shown, "project link")}`
        : "a projects section";
  return { ...base, verdict: null, why: `${what}, but also ${why}: a portfolio with a blog` };
}

/**
 * A list of dated posts and no projects anywhere the code can see: only a
 * blog. The owner: "having a blog shouldn't be a negative. It just can't just
 * be a blog page." Projects anywhere (a projects section, heading or menu
 * link, such as "Projects" or "Work", or a project link) keep it quiet: a
 * portfolio with a blog is a portfolio, and a projects page in the menu is
 * taken as projects without reading it. "Read more" links never count as posts.
 */
export function blogOnly(site) {
  const b = blogFacts(site);
  if (b.verdict === "blog-only") return raised("blog-only", `The page has ${b.what} and no projects section, project heading, projects menu link or project link.`, b.snippets);
  if (b.verdict === "posts-few-project-links") return raised("blog-only", `The page has ${b.what}, ${b.projects.shown ? `only ${plural(b.projects.shown, "project link")}` : "no project link"} and no projects menu link or section title: only a blog.`, b.snippets);
  return null;
}
const SECTION_TITLE = /\b(?:projects|portfolio|works|(?:my|selected|recent|featured|side|client) work|case studies|things i(?:'ve| have)? built|projets|proyectos|projekte|projetos|progetti|projecten|projeler|r[eé]alisations|trabajos|trabalhos)\b/i;
/** With this many posts, a few project links inside them do not make the page a portfolio. */
export const BLOG_MANY_POSTS = 10;

/** Words that say the page holds work (a 3D world's "Skip to portfolio links"). */
const WORK_WORD = /\b(?:portfolio|projects?|my work|case stud(?:y|ies)|showcase)\b/i;
/** A link card's text is at most this long. */
export const LINK_CARD_MAX_TEXT = 400;

/**
 * A name, a line and a handful of profile links, nothing else: a link card.
 * A card with any project link, projects heading or menu link stays quiet.
 */
export function linkCard(site) {
  const p = readSite(site);
  if (p.text.length > LINK_CARD_MAX_TEXT || p.text.length < LITTLE_TEXT_MAX || p.projects.any || WORK_WORD.test(p.text)) return null;
  const profiles = [...new Set([...p.social.map((l) => hostOf(l.href)), ...p.contact.map((l) => String(l.raw).split(":")[0].toLowerCase())])];
  if (profiles.length < 2) return null;
  const others = new Set(p.outbound.map((l) => hostOf(l.href)));
  if (others.size > 2) return null;
  // A page of its own beyond the card (an about page, a CV, a writing list) is more than a card.
  const own = new Set(p.links.filter((l) => hostOf(l.href) === hostOf(p.finalUrl) && !/^#/.test(l.raw ?? "") && new URL(l.href).pathname.replace(/\/+$/, "") !== new URL(p.finalUrl).pathname.replace(/\/+$/, "")).map((l) => new URL(l.href).pathname));
  if (own.size > 1) return null;
  return raised("link-card", `The page is ${p.text.length} characters of text with ${plural(profiles.length, "profile or contact link")} (${profiles.slice(0, 5).join(", ")}) and no projects.`, [p.text.slice(0, 120), ...profiles]);
}

// Dropped: "thin-page" (a short page with no projects and too few profile links to be a link card). On the
// benchmark it flagged 3 non-portfolios and 8 real portfolios, most of them intro or gate screens
// ("Press the button to begin"), so it could never be safe to show the owner.

// The page speaking as a company: "we" and "our" against "I" and "my", in the languages the list has.
const WE = /\b(?:we|we're|we’re|we've|we’ve|we'll|our|ours|ourselves|wij|ons|onze|wir|unser(?:e|en|er)?|nous|notre|nos|nosotros|nuestr[oa]s?|n[oó]s|noss[oa]s?|biz|bizim)\b/giu;
// Not "je" (Dutch "you", French "I") nor "ben" (Dutch "am", Turkish "I"): either way round they miscount.
const I = /\b(?:i|i'm|i’m|i've|i’ve|i'll|i’d|my|me|mine|myself|ik|mijn|ich|mein(?:e|en|er)?|j'ai|mon|moi|yo|mi|mis|eu|meu|minha|meus|benim)\b/giu;
// "us" alone is the United States as often as a pronoun, so it counts only in "contact us", "about us", "join us".
const US = /\b(?:contact|about|join|with|hire|email|call|ask|tell|reach)\s+us\b/giu;
// More than one person: a team, staff, jobs, founders in the plural.
const TEAM = /\b(?:our team|the team behind|team members|meet the team|our people|our staff|our employees|our founders|co-?founders|founded by [\p{L}.-]+ and [\p{L}.-]+|we(?:'re| are) hiring|join (?:our|the) team|careers|vacatures|vacancies|job openings|open positions|internships?|stellenangebote|offres d'emploi|empleos|vagas)\b/giu;
// Selling services or a product: what a company's home page asks for.
const SELLING = /\b(?:our services|services we offer|what we do|we offer|we provide|we help|we build|we design|we develop|we create|we deliver|we specialise|we specialize|get a (?:free )?quote|request a quote|free consultation|book a (?:call|demo|consultation)|start a project|pricing|plans? & pricing|our clients|our work|ons werk|onze diensten|diensten|unsere leistungen|nos services|nuestros servicios|nossos servi[cç]os|case studies|testimonials|trusted by)\b/giu;
// A freelancer or a one-person studio says so; their "we" is still one person showing their work.
const SOLO = /\b(?:freelanc(?:e|er|ing)|independent (?:[\p{L}-]+ ){0,2}(?:developer|designer|engineer|consultant)|(?:founded|run|owned)(?: and run)? by (?:a|an|one) (?:[\p{L}-]+ ){0,3}(?:developer|designer|engineer|person)|solo (?:developer|founder|studio)|one-person|one person (?:studio|agency|business)|i'?m (?:a|an) [\p{L} -]{0,40}(?:developer|engineer|designer|programmer|consultant)|hire me|my (?:projects|work|portfolio)|zzp|autónomo|autônomo|indépendant)\b/giu;
/** "We" words needed, and their least share of the first-person words, for a page to speak as a company. */
export const COMPANY_MIN_WE = 8;
export const COMPANY_MIN_WE_SHARE = 0.75;

/**
 * The page speaks as "we" and sells services, or names a team, jobs or
 * founders: a company or an agency. A freelancer ("freelance", "hire me",
 * "I'm a developer") or a one-person studio that shows projects in its own
 * voice is protected: the flag needs "we" to outnumber "I" three to one and
 * no word that says one person.
 */
export function companyVoice(site) {
  const p = readSite(site);
  const we = allMatches(p.text, WE, 1000).length + allMatches(p.text, US, 200).length;
  const i = allMatches(p.text, I, 1000).length;
  if (we < COMPANY_MIN_WE || we / (we + i) < COMPANY_MIN_WE_SHARE) return null;
  const solo = allMatches(p.text, SOLO, 20);
  if (solo.length) return null;
  const team = [...new Set(allMatches(p.text, TEAM, 50).map((x) => x.toLowerCase()))];
  const selling = [...new Set(allMatches(p.text, SELLING, 50).map((x) => x.toLowerCase()))];
  if (!team.length && selling.length < 2) return null;
  const evidence = [...team, ...selling];
  return raised("company-voice", `The page speaks as "we" ${we} times against "I" ${i} times and says ${evidence.slice(0, 3).map((e) => `"${e}"`).join(", ")}: a company or agency, not one person's portfolio.`, evidence);
}

// Selling teaching: coaching, courses, speaking, a book, mentoring sessions.
const TEACHING = /\b(?:coaching|career coach|executive coach|life coach|leadership coach|book (?:a|your) (?:session|call|coaching)|book (?:me|[\p{Lu}][\p{L}]+) (?:to|for)|buy (?:my|the) book|pre-?order|keynote speaker|professional speaker|speaking engagements?|premium courses?|browse courses|online courses?|enroll(?: now)?|enrol now|workshops? for teams|mentorship program|1[:-]1 mentoring|cohort|masterclass)\b/giu;
/** Different teaching words needed. */
export const TEACHING_MIN = 2;

/**
 * The page sells coaching, courses, speaking or a book and shows no projects:
 * the owner ruled a coaching page is not a portfolio, a developer's or not.
 */
export function sellsTeaching(site) {
  const p = readSite(site);
  // A projects menu link ("Portfolio") is a freelancer who also teaches, not only a teacher.
  if (p.projects.shown > 0 || p.projects.headings.length || p.projects.nav.length) return null;
  const hits = [...new Set(allMatches(p.text, TEACHING, 100).map((x) => x.toLowerCase()))];
  if (hits.length < TEACHING_MIN) return null;
  return raised("sells-teaching", `The page sells teaching (${hits.slice(0, 4).map((h) => `"${h}"`).join(", ")}) and shows no projects.`, hits);
}

// A product's or a tool's own home page: the parts a product site has.
const PRODUCT_PARTS = [
  ["privacy policy", /\bprivacy policy\b/i],
  ["terms", /\bterms (?:of (?:service|use)|(?:&|and) conditions)\b/i],
  ["pricing", /\bpricing\b/i],
  ["sign up", /\b(?:sign up|signup|create (?:an |your )?(?:free )?account|start (?:your )?free trial|no sign-?up)\b/i],
  ["get started", /\bget started\b/i],
  ["documentation", /\b(?:documentation|docs)\b/i],
  ["download", /\bdownload (?:now|for (?:free|mac|windows|ios|android)|the app)\b|\b(?:app store|google play)\b/i],
  ["features", /\bfeatures\b/i],
  ["faq", /\bfaq\b|\bfrequently asked questions\b/i],
  ["free", /\b(?:free forever|100% free|completely free|free online|free to use|it'?s free)\b/i],
  ["users", /\b\d[\d,.]*\+?\s*(?:k\s*)?(?:users|downloads|customers|installs)\b/i],
];
/** Parts of a product site needed. */
export const PRODUCT_MIN_PARTS = 4;

/**
 * The page is one product's or tool's home page (a calculator suite, a
 * portfolio builder): product parts (pricing, sign up, documentation, terms,
 * FAQ) and no person on it. A page that speaks as "I" a few times, names the
 * listed person, or lists several projects stays quiet.
 */
export function productPage(site) {
  const p = readSite(site);
  if (p.projects.shown >= 2) return null;
  const parts = PRODUCT_PARTS.filter(([, re]) => re.test(p.text)).map(([n]) => n);
  const i = allMatches(p.text, I, 50).length;
  if (!parts.length || i >= 5) return null;
  const tokens = String(p.name).toLowerCase().split(/[^\p{L}0-9]+/u).filter((t) => t.length >= 3);
  // The listed name is a brand, not a person, when it is one word that is the site's name too ("Calzye" on
  // calzye.com, "Techfolios" on techfolios.github.io).
  const brand = tokens.length === 1 && hostOf(p.finalUrl).split(".")[0] === tokens[0];
  const person = !brand && tokens.length > 0 && tokens.some((t) => p.text.toLowerCase().includes(t));
  if (person) return null;
  // A brand that talks to "you" about what it lets you do needs fewer parts than a page with no name at all.
  const you = allMatches(p.text, YOU, 200).length;
  const pitch = allMatches(p.text, PITCH, 20);
  if (parts.length >= PRODUCT_MIN_PARTS || (brand && you >= 5 && pitch.length)) {
    const said = [...parts, ...pitch.slice(0, 2).map((x) => `"${x}"`)];
    return raised("product-page", `The page has the parts of a product's site (${said.join(", ")})${brand ? `, under the brand name "${p.name}"` : ""}, and no person behind it: one product or tool, not a portfolio.`, said);
  }
  return null;
}
const YOU = /\b(?:you|your|you're|you’re|yours)\b/giu;
const PITCH = /\b(?:lets you|allows you to|helps you|enables you to|you can (?:easily|quickly)|easily (?:create|build|make)|provides a (?:quick|simple|easy)|no sign-?up)\b/giu;

// The parts of a code repository's README rendered as a page.
const README_PARTS = [
  ["installation", /\b(?:installation|install(?:ing)? (?:the )?dependencies|prerequisites|requirements)\b/i],
  ["getting started", /\b(?:getting started|quick ?start|local development|run(?:ning)? locally)\b/i],
  // Commands as typed: lower case ("CD workflows" is a pipeline, "cd my-app" a command).
  ["commands", /\b(?:npm (?:install|i|run|start|ci)|yarn (?:install|dev|build|start)|pnpm (?:install|dev|i)|bun (?:install|dev)|pip install|git clone)\b|(?:^|\s)cd [\w.-]+\/?(?=\s)/],
  ["repository layout", /\b(?:repository|project|folder|directory|file) (?:structure|layout|tree)\b|├──|└──/i],
  ["license", /\blicen[cs]e[sd]? (?:under|mit)\b|\bmit licen[cs]e\b|^\s*licen[cs]e\s*$/im],
  ["contributing", /\bcontribut(?:ing|ions? (?:are )?welcome)\b|\bpull requests? (?:are )?welcome\b/i],
  ["environment", /\.env(?:\.local|\.example)?\b|\blocalhost:\d{2,5}\b/i],
  ["deploy", /\bdeploy(?:ed|ment)? (?:to|on) (?:vercel|netlify|github pages)\b|\bvercel-ready\b/i],
];
/** README parts needed. */
export const README_MIN_PARTS = 3;

/**
 * The page is a code repository's README rendered as a page (install steps,
 * commands, the folder layout, the license), describing a portfolio instead
 * of being one.
 */
export function readmePage(site) {
  const p = readSite(site);
  const parts = README_PARTS.filter(([, re]) => re.test(p.text));
  // A README tells you how to run the code: commands or the folder layout, beside the rest.
  if (parts.length < README_MIN_PARTS || !parts.some(([n]) => n === "commands" || n === "repository layout")) return null;
  const found = parts.map(([n, re]) => [n, p.text.match(re)?.[0] ?? n]);
  return raised("readme-page", `The page reads as a code repository's README: ${found.map(([n, m]) => `${n} ("${quote(m, 30)}")`).join(", ")}.`, found.map(([, m]) => m));
}

/** An essay is at least this long, in paragraphs, with at most this many links. */
export const ESSAY_MIN_TEXT = 1500;
export const ESSAY_MAX_LINKS = 6;
export const ESSAY_MIN_PARAGRAPH_SHARE = 0.6;
/** Paragraphs this long, and at least this many of them. */
export const ESSAY_PARAGRAPH = 120;
export const ESSAY_MIN_PARAGRAPHS = 6;
/** This many years named make the prose a resume, not an essay. */
export const ESSAY_MAX_YEARS = 3;

/**
 * The page is one document (an essay, a manifesto, a letter): long prose in
 * paragraphs, barely a link, no projects, no profiles. A one-page resume has
 * profile links or a list of roles, and a portfolio has projects.
 */
export function singleDocument(site) {
  const p = readSite(site);
  if (p.text.length < ESSAY_MIN_TEXT || p.projects.any) return null;
  // A resume written as prose names its years ("From 2021 I have been working ..."); the owner keeps a
  // digital resume with no projects listed (lorandkissdev.github.io/github-portfolio).
  if ((p.text.match(/\b(?:19|20)\d\d\b/g) ?? []).length >= ESSAY_MAX_YEARS) return null;
  const linkCount = new Set(p.links.filter((l) => !/^#/.test(l.raw ?? "")).map((l) => l.href)).size;
  if (linkCount > ESSAY_MAX_LINKS || p.social.length + p.contact.length > 1) return null;
  const paragraphs = [...p.html.matchAll(/<p\b[^>]*>([\s\S]{0,20000}?)<\/p\s*>/gi)].map((m) => squash(decodeEntities(stripTags(m[1]))));
  const inParagraphs = paragraphs.reduce((n, t) => n + t.length, 0);
  const share = inParagraphs / p.text.length;
  const long = paragraphs.filter((t) => t.length >= ESSAY_PARAGRAPH).length;
  if (share < ESSAY_MIN_PARAGRAPH_SHARE || long < ESSAY_MIN_PARAGRAPHS) return null;
  const first = paragraphs.find((t) => t.length >= ESSAY_PARAGRAPH) ?? "";
  return raised("single-document", `The page is ${p.text.length} characters of prose in ${plural(long, "long paragraph")}, ${plural(linkCount, "link")} and no projects: one document, such as an essay, not a portfolio. It opens "${quote(first, 50)}".`, [p.title, first.slice(0, 120)]);
}

/**
 * The listed address forwards to another domain whose page does not carry the
 * listed person's name. The health check already judges the forward
 * (pipeline/health.mjs redirectVerdict: { moved, hijack, to }, stored as the
 * check's moved and hijack); this only gives that result a flag's name and
 * sentence, from `site.redirect`. A code host or social profile as the final
 * address is the health check's own failure, not this flag.
 */
export function forwardsElsewhere(site) {
  const r = site?.redirect;
  if (!r?.moved) return null;
  const p = readSite(site);
  // redirectVerdict's `to` is a domain; a caller may pass the final address instead.
  const to = hostOf(r.to) || r.to || hostOf(p.finalUrl);
  const title = p.title ? `; its title is "${quote(p.title, 50)}"` : "";
  if (r.hijack) return raised("forwards-elsewhere", `The listed address forwards to ${to}, and the page there does not carry the name "${quote(p.name, 40)}"${title}.`, [to, p.title]);
  // The health check calls a move safe when any one part of the name is on the page. A move to a domain with
  // none of the name in it, whose page carries only part of the name ("founded by batuhan and demir"), is
  // someone else's site that mentions the person.
  const tokens = fold(p.name).split(/[^\p{L}0-9]+/u).filter((t) => t.length >= 3);
  if (tokens.length < 2) return null;
  const host = fold(hostOf(p.finalUrl) || to);
  const text = fold(`${p.title} ${p.text}`);
  if (tokens.some((t) => host.includes(t)) || tokens.every((t) => text.includes(t))) return null;
  const found = tokens.filter((t) => text.includes(t));
  return raised("forwards-elsewhere", `The listed address forwards to ${to}, a domain without the person's name, and the page there carries only "${found.join(" ")}" of "${quote(p.name, 40)}"${title}.`, [to, ...found, p.title]);
}
const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// ---------- the listed address is a sub-page ----------

// Hosts where a path is the site itself: a GitHub or GitLab Pages project site, a page on a site builder or a
// short link. Their "home" is someone's account root or the service, not the person's site.
const PATH_IS_SITE = /(?:^|\.)(?:github\.io|gitlab\.io|codeberg\.page|pages\.dev|sites\.google\.com|notion\.site|dub\.sh|bit\.ly|carrd\.co|my\.site\.com|txtnode\.com)$/i;
// A path that names a portfolio, the person or a language: the page meant to be listed.
const PORTFOLIO_PATH = /^(?:[a-z]{2}(?:-[a-z]{2})?|portfolio|portafolio|portfolios|folio|projects?|work|works|me|about|cv|resume|home|index|site|web|dev|[\w-]*(?:portfolio|folio|projects?|resume)[\w-]*)$/i;

/**
 * Whether the listed address is a sub-page, not the site's home: a path other
 * than "/" or an index file. Returns null for a home page, else { home, path,
 * pathIsSite, portfolioPath }: the home page's address, the path, whether on
 * this host the path is the site itself (a github.io project site), and
 * whether the path names a portfolio or a language.
 */
export function subPageAddress(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/index\.html?$/i, "");
  if (!path) return null;
  const first = path.split("/").filter(Boolean)[0] ?? "";
  return { home: `${u.protocol}//${u.host}/`, path, pathIsSite: PATH_IS_SITE.test(u.hostname), portfolioPath: PORTFOLIO_PATH.test(first) };
}

/** A page that shows projects and raises none of the page flags. */
function looksLikePortfolio(page) {
  const p = readSite(page);
  return p.projects.any && !PAGE_FLAGS.some((fn) => fn(page));
}

/**
 * For a listed sub-page, what it and the site's home page are. `site.home` is
 * the home page as read ({ html, text, finalUrl, plainHtml }), or missing.
 * Returns null for a home page, else { outcome, home, path } where outcome is
 *   "sub-page-is-portfolio"  the sub-page shows projects and raises no flag, or
 *                            its path is the site itself (a github.io project
 *                            site) or names the portfolio: the common, right case;
 *   "home-is-portfolio"      the home page shows projects and raises no flag:
 *                            the listing should point at the home page;
 *   "home-not-portfolio"     the home page is not a portfolio either;
 *   "home-not-read"          no copy of the home page to judge.
 */
export function subPageOutcome(site) {
  const sub = subPageAddress(site?.url);
  if (!sub) return null;
  // On a github.io project site, a site builder or a short link the path is the site; its "home" is an account
  // root or the service. The page's own flags speak for it, never this one.
  if (sub.pathIsSite || looksLikePortfolio(site)) return { outcome: "sub-page-is-portfolio", ...sub };
  // A "/portfolio" or "/en" path, or a path with the person's name in it (a page on a portfolio builder,
  // dinq.me/keith), that raises no flag is the portfolio, read poorly. Little text alone says the code could not
  // read it (an app that draws itself), not that it is something else.
  const tokens = String(site.name ?? "").toLowerCase().split(/[^\p{L}0-9]+/u).filter((t) => t.length >= 3);
  const namedPath = tokens.some((t) => sub.path.toLowerCase().includes(t));
  if ((sub.portfolioPath || namedPath) && !PAGE_FLAGS.some((fn) => fn !== littleText && fn(site))) return { outcome: "sub-page-is-portfolio", ...sub, namedPath };
  const h = site.home;
  if (!h || !String(h.html || h.plainHtml || h.text || "").trim()) return { outcome: "home-not-read", ...sub };
  const home = { url: sub.home, finalUrl: h.finalUrl || sub.home, name: site.name, html: h.html ?? "", text: h.text ?? "", plainHtml: h.plainHtml ?? "" };
  const homeFlags = PAGE_FLAGS.map((fn) => fn(home)).filter(Boolean).map((f) => f.flag);
  // A home page with almost no text (a bot wall's "Just a moment...", an app that draws itself) was not read.
  if (homeFlags.length === 1 && homeFlags[0] === "little-text") return { outcome: "home-not-read", ...sub, homeFlags };
  return { outcome: looksLikePortfolio(home) ? "home-is-portfolio" : "home-not-portfolio", ...sub, homeFlags };
}

/**
 * The listed address is a sub-page that is not itself a portfolio (a blog
 * category page, a single post, an about page): the reason says what the
 * site's home page is. A sub-page that is the portfolio (a github.io project
 * site, a "/portfolio" path, any sub-page showing projects) is never flagged.
 */
export function subPage(site) {
  const o = subPageOutcome(site);
  if (!o || o.outcome === "sub-page-is-portfolio") return null;
  const where = `The listed address is a sub-page (${quote(o.path, 50)}) that shows no projects`;
  if (o.outcome === "home-is-portfolio") return raised("sub-page", `${where}; the site's home page ${o.home} shows projects: the listing should point at the home page.`, [o.path, o.home]);
  if (o.outcome === "home-not-portfolio") return raised("sub-page", `${where}, and the site's home page ${o.home} is not a portfolio either${o.homeFlags.length ? ` (${o.homeFlags.join(", ")})` : " (no projects)"}.`, [o.path, o.home, ...o.homeFlags]);
  return raised("sub-page", `${where}; the site's home page ${o.home} could not be read.`, [o.path, o.home]);
}

/** The flags that read the page itself (not the address or the forward). */
const PAGE_FLAGS = [fillerText, placeholderPage, littleText, movedNotice, blogOnly, linkCard, companyVoice, sellsTeaching, productPage, readmePage, singleDocument];

/** Every flag, by name, in the order they are reported. */
export const FLAGS = {
  "filler-text": fillerText,
  "placeholder-page": placeholderPage,
  "little-text": littleText,
  "moved-notice": movedNotice,
  "blog-only": blogOnly,
  "link-card": linkCard,
  "company-voice": companyVoice,
  "sells-teaching": sellsTeaching,
  "product-page": productPage,
  "readme-page": readmePage,
  "single-document": singleDocument,
  "forwards-elsewhere": forwardsElsewhere,
  "sub-page": subPage,
};

/** The flags raised for a site, in FLAGS order: [{ flag, reason, snippets }]. Empty when none. */
export function portfolioFlags(site) {
  const out = [];
  for (const fn of Object.values(FLAGS)) {
    const r = fn(site);
    if (r) out.push(r);
  }
  return out;
}
