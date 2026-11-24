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
// Measured on the portfolio-or-not benchmark and fresh samples of listed sites
// (the ops handoff's run-benchmark.mjs prints the scorecard); see
// docs/HOW-IT-RUNS.md. Not wired to anything yet.
//
// One more check lives beside the flags and is never one of them:
// unreadablePage ("the code could not read this page"). It says the code is
// struggling, not that the site is not a portfolio, so it is exported apart
// (READING_PROBLEMS) and portfolioFlags never returns it.
//
// Every quote in a reason or a snippet goes through redactContacts: email
// addresses and phone numbers never leave the page.
import { PROJECT_HEADING, decodeEntities, scanPage, stripTags } from "./page-controls.mjs";
import { pageLinks, projectCandidates } from "./facts.mjs";
import { visibleText } from "./gate.mjs";
import { PHONE_TOKEN, redactContacts } from "./redact.mjs";

/** The most HTML read, as the signals read it. */
const HTML_MAX = 400000;
/** The most page text read. */
const TEXT_MAX = 200000;
/** Longest snippet quoted in a reason. */
const QUOTE_MAX = 60;

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** Text for a reason or a snippet: contact details redacted, whitespace squashed, cut to `max`. */
const quote = (s, max = QUOTE_MAX) => {
  const t = squash(redactContacts(String(s ?? "").replace(/\b(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?\d[\d\s-]{5,}\d/gi, `wa.me/${PHONE_TOKEN}`)));
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
/** The fields readSite reads: a cached reading is reused only while every one of them is the same. */
const READ_FIELDS = ["url", "finalUrl", "name", "html", "text", "plainHtml"];

/**
 * Every h1 to h4 with its words, in one linear pass: the opening and closing tags are found once each and
 * paired in order, so a page of unclosed headings costs no more than a page of closed ones.
 */
function headingsOf(html) {
  const out = [];
  const open = [];
  for (const m of html.matchAll(/<(\/?)h([1-4])\b[^>]*>/gi)) {
    if (!m[1]) {
      open.push({ level: Number(m[2]), start: m.index + m[0].length });
      continue;
    }
    const level = Number(m[2]);
    const i = open.findLastIndex((o) => o.level === level);
    if (i < 0) continue;
    const o = open[i];
    open.length = i;
    if (m.index - o.start > 2000) continue;
    const words = squash(decodeEntities(stripTags(html.slice(o.start, m.index))));
    if (words) out.push({ level, words });
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * What the flags read, from a site's record: { url, finalUrl, name, html,
 * text, plainHtml, signals }. `html` and `text` are the rendered page's (the
 * browser's DOM and innerText); without them the plain HTML is read.
 */
export function readSite(site) {
  const cached = site && typeof site === "object" ? memo.get(site) : null;
  if (cached && READ_FIELDS.every((f) => cached.from[f] === site[f])) return cached.out;
  const s = site ?? {};
  const html = String(s.html || s.plainHtml || "").slice(0, HTML_MAX);
  const finalUrl = String(s.finalUrl || s.url || "");
  const scan = scanPage(html, finalUrl || undefined);
  const textRaw = String(s.text ?? "").trim() ? String(s.text) : visibleText(html);
  const text = squash(decodeEntities(textRaw.slice(0, TEXT_MAX)));
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
  const headings = headingsOf(html);
  // A heading the project pass takes for projects but that names writing ("Featured essays, ideas and more") is
  // a blog's section; when every projects heading is one, the projects section it opened is writing too.
  const headingHits = headings.filter((h) => h.level >= 2 && PROJECT_HEADING.test(h.words)).map((h) => h.words);
  // A bare "Featured" names nothing; a projects heading names the work ("Featured projects", "Open source").
  const projectHeadings = headingHits.filter((w) => !WRITING_HEADING.test(w) && WORK_NOUN.test(w));
  const writingOnly = headingHits.length > 0 && projectHeadings.length === 0;
  // A projects menu entry is a link or a button ("Projects" opening a dropdown), or a link to the site's own
  // projects pages ("/projects/robot-arm"), whatever its label.
  const projectNav = [
    ...links.filter((l) => PROJECTS_LABEL.test(squash(l.text))).map((l) => squash(l.text)),
    ...scan.controls.filter((c) => PROJECTS_LABEL.test(squash(c.label))).map((c) => squash(c.label)),
  ];
  const ownProjectPages = [
    ...new Set(
      links
        .filter((l) => hostOf(l.href) === self && OWN_PROJECT_PATH.test(pathOf(l.href)) && pathOf(l.href) !== pathOf(finalUrl))
        .map((l) => pathOf(l.href))
    ),
  ];
  const inProjects = !writingOnly && [...links, ...scan.controls].some((x) => x.inProjects);
  const shownProjects = writingOnly ? candidates.filter((c) => c.tier <= 2 && c.kind === "outbound").length : candidates.filter((c) => c.tier <= 2).length;
  // A code repository linked anywhere but the page's frame, even inside a post or under a "Blog" heading (which
  // the project-link pass sets aside): for the flags, any repository is project evidence.
  const repos = new Set(links.filter((l) => !l.inChrome && REPO_URL.test(l.href)).map((l) => l.href.toLowerCase())).size;
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
      ownPages: ownProjectPages,
      repos,
      section: inProjects,
      any: shownProjects > 0 || repos > 0 || projectHeadings.length > 0 || projectNav.length > 0 || ownProjectPages.length > 0 || inProjects,
    },
  };
  if (site && typeof site === "object") memo.set(site, { from: Object.fromEntries(READ_FIELDS.map((f) => [f, site[f]])), out });
  return out;
}
const pathOf = (u) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
};
const WORK_NOUN = /proje|projet|proyect|progett|portf|folio|works?\b|case stud|built|made|creat|apps?\b|products?\b|open[- ]?source|\blab\b|experiment|builds?\b|showcase|r[eé]alisation|trabaj|trabalh|作品|项目|プロジェクト|프로젝트/i;
const WRITING_HEADING = /\b(?:essays?|articles?|posts?|writing|writings|notes|blog|talks|thoughts|newsletter|stories|ideas)\b/i;
/** A repository on a code host: "github.com/ana/tidy", not a profile or a host page. */
const REPO_URL = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/(?!(?:orgs|topics|features|about|pricing|login|sponsors|marketplace|explore|settings|collections|trending|site|apps|users)\/)[\w.-]+\/[\w.-]+/i;
/** The site's own projects pages: "/projects", "/projects/robot-arm", "/work/x", "/portfolio", "/case-studies/y". */
const OWN_PROJECT_PATH = /(?:^|\/)(?:projects?|works?|portfolio|case-stud(?:y|ies)|showcase|projets|proyectos|projetos|projekte)(?:\/|$|\.html?$)/i;

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
  // Any project evidence is a site with its parts: a "permanently under construction" tagline
  // (robert.hase-zheng.net), a "Blog: coming soon" beside two projects.
  if (p.text.length > PLACEHOLDER_MAX_TEXT || p.projects.any) return null;
  const m = p.text.match(PLACEHOLDER);
  if (!m) return null;
  return raised("placeholder-page", `The page is ${p.text.length} characters long, shows no projects and says "${quote(m[0])}": a placeholder, not a finished site.`, [m[0]]);
}

/** Fewer visible characters than this: the code has nothing to read. */
export const UNREADABLE_MAX_TEXT = 60;

/**
 * Not a suspicion: the code could not read this page. Almost no text: a logo,
 * a name, an intro or "who's watching" screen, a lock screen, a page drawn on
 * a canvas, a bot check. Most are real portfolios behind a screen the code
 * does not press (the owner: "an intro or gate screen in front of a real
 * portfolio is still a portfolio"). Exported apart from the flags
 * (READING_PROBLEMS) so it can never be sent to the review queue as a
 * suspicion; it is the reading lane's to fix.
 */
export function unreadablePage(site) {
  const p = readSite(site);
  if (p.text.length >= UNREADABLE_MAX_TEXT) return null;
  return raised(
    "unreadable-page",
    p.text ? `The code could not read this page: it shows only ${plural(p.text.length, "character")} of text ("${quote(p.text)}").` : "The code could not read this page: it shows no text at all.",
    [p.text]
  );
}

// "This page has moved", "my new site is at ...": a notice about the site itself.
const MOVED = new RegExp(
  [
    String.raw`\b(?:this |my )?(?:page|site|website|blog|portfolio|home ?page)\s+(?:has\s+)?(?:moved|relocated|migrated)\b`,
    String.raw`\bmoved to (?:a )?(?:new|my new) (?:site|website|domain|address|home|portfolio)\b`,
    String.raw`\b(?:has|have) a new (?:home|address|domain)\b`,
    String.raw`\b(?:my )?new (?:site|website|portfolio|home|address) (?:is|lives) (?:at|here|now)\b`,
    String.raw`\b(?:find|visit) me (?:now )?(?:at|on) (?:my new|the new)\b`,
  ].join("|"),
  "i"
);
// "We moved to rafalazar", "find me at akhshy.dev": a notice only when the place named is another site of the
// person's that the page links to, or a domain that is not a profile host ("find me at github.com" is not).
const MOVED_TO = /\b(?:(?:we|i)(?:'ve|’ve| have)?\s+moved\s+(?:over\s+)?to|find me (?:now )?at)\s+([\p{L}0-9][\p{L}0-9.-]*[\p{L}0-9])/giu;
/** Longer than this, "moved" is in an article or a project's text, not a notice. */
export const MOVED_MAX_TEXT = 1500;

/** A short page with no projects that says the site has moved to another site. */
export function movedNotice(site) {
  const p = readSite(site);
  // Any project evidence is the site itself, whatever it says ("I moved to Lisbon").
  if (p.text.length > MOVED_MAX_TEXT || p.projects.any) return null;
  const elsewhere = [...new Set(p.outbound.map((l) => hostOf(l.href)).filter(Boolean))];
  let said = p.text.match(MOVED)?.[0] ?? null;
  if (!said) {
    for (const m of p.text.matchAll(MOVED_TO)) {
      const place = m[1].toLowerCase().replace(/\.$/, "");
      const isDomain = /\.[a-z]{2,}$/.test(place);
      const linked = elsewhere.some((h) => h.includes(place) || place.includes(h));
      if (linked || (isDomain && !SOCIAL_HOST.test(place))) {
        said = m[0];
        break;
      }
    }
  }
  if (!said) return null;
  return raised("moved-notice", `The page is ${p.text.length} characters long, shows no projects and says "${quote(said)}"${elsewhere.length ? `, with a link to ${elsewhere[0]}` : ""}: a forwarding notice, not a portfolio.`, [said, ...elsewhere.slice(0, 2)]);
}

// Month names and their short forms in the languages the list has (English, Spanish, Portuguese, French,
// German, Dutch, Italian, Turkish), so a date needs a real month: "Note 3, 2024" and "Semester 1 2023" are not.
const MONTH = String.raw`(?:jan(?:uary|uar|vier|eiro|uari)?|feb(?:ruary|ruar|braio|rero)?|fev(?:ereiro)?|f[eé]v(?:rier)?|mar(?:ch|s|zo|ço|co|t)?|m[äa]rz|maart|apr(?:il|ile)?|abr(?:il)?|avr(?:il)?|may|mai|mayo|maio|maggio|mei|jun(?:e|i|io|ho)?|juin|giugno|jul(?:y|i|io|ho)?|juil(?:let)?|luglio|aug(?:ust|ustus)?|ago(?:sto)?|ao[uû]t|sep(?:t|tember|tiembre|tembre)?|set(?:embro|tembre)?|oct(?:ober|ubre|obre)?|okt(?:ober)?|out(?:ubro)?|ott(?:obre)?|nov(?:ember|iembre|embre|embro)?|dec(?:ember)?|dez(?:ember|embro)?|d[eé]c(?:embre)?|dic(?:iembre|embre)?|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)`;
// Dates the way posts carry them: "November 3, 2026", "Oct 21, 2026", "3 Nov 2026", "4 Mayıs 2026",
// "05/10/2026", "2026-10-05".
const DATE_RE = new RegExp(
  [
    String.raw`\b${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d\d\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\.?\s+(?:de\s+)?${MONTH}\.?,?\s+(?:de\s+)?(?:19|20)\d\d\b`,
    String.raw`\b\d{1,2}[/.]\d{1,2}[/.](?:19|20)\d\d\b`,
    String.raw`\b(?:19|20)\d\d-\d{2}-\d{2}\b`,
  ].join("|"),
  "giu"
);
// "· 3 min read", "⏱️ 10 min read", "5 minutes de lecture": a reading time says "read", a talk's "30 min" does not.
const READ_TIME = /\b\d{1,3}\s*(?:min(?:ute)?s?|dk|мин)\.?\s*(?:read|de lecture|de leitura|de lectura|lesezeit|okuma)\b/giu;
/** At least this many dated posts, in a post structure, make a list of posts. */
export const BLOG_MIN_POSTS = 5;

/**
 * The dates without a calendar's: a contribution graph or a date picker lists every day in a row
 * ("2025-11-23", "No contributions on October 3, 2025", ...), posts do not. When ten or more dates read as days
 * and most of them have a neighbouring day, those dates go.
 */
function notACalendar(dates) {
  const day = (d) => {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : Date.parse(`${d.replace(/(\d)(?:st|nd|rd|th)/, "$1")} 00:00:00 UTC`);
    return Number.isFinite(t) ? Math.round(t / 864e5) : null;
  };
  const read = dates.map((d) => [d, day(d)]).filter(([, n]) => n != null);
  if (read.length < 10) return dates;
  const days = new Set(read.map(([, n]) => n));
  const runs = [...days].filter((n) => days.has(n - 1) || days.has(n + 1)).length;
  if (runs / days.size < 0.5) return dates;
  const calendar = new Set(read.filter(([, n]) => days.has(n - 1) || days.has(n + 1)).map(([d]) => d));
  return dates.filter((d) => !calendar.has(d));
}

// Links to the site's own posts: "/blog/x", "/posts/x", "/2026/03/x", "/p/x".
const POST_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:blog|posts?|articles?|notes|writing|writings|journal|essays|til|garden|log|news|p|yazilar|yazi|artigos|articulos)\/[^/]+|^\/(?:19|20)\d\d\/\d{1,2}\//i;
// A post at the site's root, the way Ghost and WordPress address them: one segment of five or more words
// ("/how-to-build-your-own-social-audio-chat-application").
const POST_SLUG = /^\/[a-z0-9]+(?:-[a-z0-9]+){4,}$/;
// A resume or a work history on the page: the owner keeps a digital resume with no projects listed.
// Read only in a section title of up to four words (isResumeHeading): "Experience", "Work history", "Education
// & skills"; a post titled "... an exceptional user experience in retail" is not one.
const RESUME_HEADING = /\b(?:experience|work history|employment|career|resume|résumé|curriculum|cv|education|skills|deneyim|experiencia|experiência|expérience|berufserfahrung|werkervaring)\b/i;
// A site that calls itself a blog, in the languages the list has; and the words that make it more than one.
const BLOG_WORD = String.raw`(?:blog|weblog|dev ?blog|tech ?blog|digital garden|bit[aá]cora|ki[şs]isel blog)`;
// The blog word as the site's NAME, in one part of a name split at "|", "-", ":", "," and the like: "Patrick's
// Blog", "Ana's blog about Rust", "A blog about Rust", "Kevinbkdev Blog", "Kişisel Blog", "a blog by Bouwe",
// "blog of Ana", "Ana Ruiz-Blog", "Blog" alone. Never "Code & Blog", "Portfolio and blog" or "I build things and
// blog about them".
const BLOG_NAME_OWNED = new RegExp(String.raw`^(?:.+['’]s\s+|my\s+|the\s+|a\s+)?${BLOG_WORD}(?:\s+(?:about|on|for)\s+\S.*)?$`, "iu");
const BLOG_NAME_BY = new RegExp(String.raw`^(?:a\s+|the\s+)?${BLOG_WORD}\s+(?:by|of|de|von|van|di)\s+\S`, "iu");
const BLOG_NAME_END = new RegExp(String.raw`(?:^|\s)(\S+)\s+${BLOG_WORD}$`, "iu");
const NOT_A_NAME_BEFORE = /^(?:&|and|und|et|e|y|en|\+|or)$/i;
/**
 * The part of a name the site gives itself (title, og:site_name, first h1) that names it as a blog, or null.
 * A dash glued to the blog word ("Ana Ruiz-Blog") splits the name there too.
 */
function blogNamePart(name) {
  const parts = String(name)
    .replace(new RegExp(String.raw`(\S)\p{Pd}(${BLOG_WORD})\b`, "giu"), "$1 | $2")
    .split(/\s*[|·:,/\p{Pd}]\s+|\s+[|·:/\p{Pd}]\s*/u);
  for (const part of parts) {
    const s = part.trim().replace(/[.!]+$/, "");
    if (BLOG_NAME_OWNED.test(s) || BLOG_NAME_BY.test(s)) return s;
    const end = s.match(BLOG_NAME_END);
    if (end && !NOT_A_NAME_BEFORE.test(end[1])) return s;
  }
  return null;
}

// ---------- project links outside posts ----------

const VOID_TAG = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Containers a card can be: the smallest one around a link that holds more than the link itself.
const CARD_TAG = new Set(["li", "div", "article", "section", "aside", "tr", "td", "dd", "figure", "p", "main"]);
const CHROME_TAG = new Set(["nav", "header", "footer"]);
/** The most of a card read for a date or a post link; a bigger block is not one card. */
const CARD_MAX = 4000;
/** Links read by the post test. */
const POST_TEST_LINKS = 3000;

/**
 * The project links a page shows (code repositories, live demos on project hosting or labelled "live" or "demo",
 * the site's own project pages), each with whether it sits inside a post: inside an <article>, or in the same
 * card as a date or a link to a post ("/blog/x"). Links in the page's nav, header and footer are left out. One
 * linear pass over the tags: [{ href, inPost }].
 */
export function projectLinkPlaces(site) {
  const p = readSite(site);
  const html = p.html;
  const self = hostOf(p.finalUrl);
  const stack = [];
  const anchors = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]{0,2000})>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.findLastIndex((e) => e.tag === tag);
      if (i >= 0) {
        for (const e of stack.slice(i)) e.end = m.index;
        stack.length = i;
      }
      if (tag === "a" && anchors.length && anchors.at(-1).textEnd == null) anchors.at(-1).textEnd = m.index;
      continue;
    }
    if (tag === "a" && anchors.length < POST_TEST_LINKS) {
      const href = m[3].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const raw = href ? (href[1] ?? href[2] ?? href[3]) : "";
      let abs = "";
      try {
        abs = raw ? new URL(decodeEntities(raw), p.finalUrl || undefined).href : "";
      } catch {}
      anchors.push({ href: abs, start: m.index, textStart: m.index + m[0].length, ancestors: stack.slice() });
    }
    if (!VOID_TAG.has(tag) && !m[3].trimEnd().endsWith("/") && tag !== "script" && tag !== "style") {
      const cls = m[3].match(/\b(?:class|id)\s*=\s*["']([^"']{0,300})["']/gi)?.join(" ") ?? "";
      stack.push({ tag, start: m.index, end: null, post: POST_CONTAINER.test(cls) });
    }
  }
  const out = [];
  for (const a of anchors) {
    if (!a.href || a.ancestors.some((e) => CHROME_TAG.has(e.tag))) continue;
    const h = hostOf(a.href);
    const label = squash(stripTags(html.slice(a.textStart, a.textEnd ?? a.textStart + 200)));
    const own = h === self && OWN_PROJECT_PATH.test(pathOf(a.href)) && pathOf(a.href) !== pathOf(p.finalUrl);
    const demo = h && h !== self && !SOCIAL_HOST.test(h) && (PROJECT_HOSTING.test(h) || /\b(?:live|demo|visit site|launch)\b/i.test(label));
    if (!REPO_URL.test(a.href) && !own && !demo) continue;
    out.push({ href: a.href, inPost: inPost(html, a, label, self) });
  }
  return out;
}

// A container a blog engine marks as a post by its class or id: "post", "post-excerpt", "entry", "hentry".
const POST_CONTAINER = /(?:class|id)\s*=\s*["'](?:[^"']*[\s_-])?(?:post|posts|entry|entries|excerpt|hentry|blog-post|post-content|post-body|article-body)(?:[\s_-][^"']*)?["']/i;

/**
 * Whether a link sits inside a post: an <article> or a container marked as a post around it, or the card around
 * it carries a date or a post link.
 */
function inPost(html, a, label, self) {
  if (a.ancestors.some((e) => e.tag === "article" || e.post)) return true;
  for (let i = a.ancestors.length - 1; i >= 0; i--) {
    const e = a.ancestors[i];
    if (!CARD_TAG.has(e.tag) || e.end == null) continue;
    const inner = html.slice(e.start, e.end);
    const text = squash(stripTags(inner));
    // The smallest container that holds more than the link itself is its card.
    if (text.length < label.length + 20 && (inner.match(/<a\b/gi) ?? []).length < 2) continue;
    // A block too big to be one card says nothing: the link is not taken to be in a post.
    if (inner.length > CARD_MAX) return false;
    if (allMatches(text, DATE_RE, 1).length) return true;
    for (const m of inner.matchAll(/\bhref\s*=\s*["']?([^"'\s>]+)/gi)) {
      try {
        const u = new URL(decodeEntities(m[1]), `https://${self}/`);
        if (hostOf(u.href) === self && (POST_PATH.test(pathOf(u.href)) || /\/blog\//i.test(u.pathname))) return true;
      } catch {}
    }
    return false;
  }
  return false;
}

const SELF_PORTFOLIO = /\b(?:portf[oó]lio|portafolio|projects?|works?|case stud(?:y|ies)|resume|résumé|cv)\b/i;
// A heading that names projects as a section: the plural, or the projects family's section words.
const PROJECTS_SECTION = /\b(?:projects|portfolio|works|(?:my|selected|recent|featured|side|client|our|personal|open[- ]source) work|case studies|things i(?:'ve| have)? built|projets|proyectos|projekte|projetos|progetti|projecten|projeler|projelerim|r[eé]alisations|trabajos|trabalhos)\b/i;
// A bare section heading ("Work", "Open source") no longer protects a page that calls itself a blog on its own: a
// blog's post category is titled the same. Project links shown outside the posts under it do.
/** What the site calls itself: its <title>, og:site_name and first h1. */
function selfNames(p) {
  const title = p.html.match(/<title\b[^>]*>([\s\S]{0,500}?)<\/title>/i)?.[1] ?? "";
  const og = p.html.match(/<meta\b[^>]*(?:property|name)\s*=\s*["']og:site_name["'][^>]*>/i)?.[0]?.match(/\bcontent\s*=\s*["']([^"']{0,200})["']/i)?.[1] ?? "";
  const h1 = p.headings.find((h) => h.level === 1)?.words ?? "";
  return [title, og, h1].map((s) => squash(decodeEntities(s))).filter(Boolean);
}
const isResumeHeading = (h) => RESUME_HEADING.test(h.words) && h.words.split(/\s+/).length <= 4;
// Work shown as dated posts: case studies are projects whatever their dates.
const CASE_STUDY = /\bcase stud(?:y|ies)\b|\bestudios? de caso\b|\bestudos? de caso\b/i;

// A menu or page link to the site's writing: "Blog", "Writing", "Articles", "Posts", "Notes".
const BLOG_LINK = /^(?:(?:my|the|read (?:my|the))\s+)?(?:blog|weblog|writing|writings|articles|posts|notes|journal|log|newsletter|essays|thoughts|tech blog|dev blog)\s*[→›»↗]?$/i;

/**
 * The blog facts of a page, for the blog-only flag and for showing why a page
 * with a blog was not flagged: { posts, what, snippets, blogLink, hasBlog,
 * verdict, why }. verdict is "blog-only" or null, and `why` says what keeps
 * the page quiet.
 *
 * Posts are counted only in a real post structure: <time> elements (how a
 * blog engine dates a post), or links to the site's own post pages ("/blog/x",
 * "/2026/03/x"), and the page must carry as many dates (with a real month) or
 * reading times ("5 min read") as that. Calendar days, a talk's "30 min", a job
 * timeline and "read more" links never count.
 */
export function blogFacts(site) {
  const p = readSite(site);
  const dates = notACalendar(allMatches(p.text, DATE_RE, 400));
  const times = allMatches(p.text, READ_TIME, 300);
  // <time> elements are how a blog engine marks a post's date; a resume's timeline rarely uses them.
  const datedArticles = (p.html.match(/<time\b/gi) ?? []).length;
  const self = hostOf(p.finalUrl);
  const postLinks = new Set(p.links.filter((l) => hostOf(l.href) === self && (POST_PATH.test(pathOf(l.href)) || POST_SLUG.test(pathOf(l.href)))).map((l) => pathOf(l.href))).size;
  const structure = Math.max(datedArticles, postLinks);
  const dated = Math.max(dates.length, times.length);
  const posts = Math.min(structure, dated);
  const what = dates.length >= times.length ? plural(dates.length, "dated post") : plural(times.length, "post", "posts with a reading time");
  const blogLink = p.links.map((l) => squash(l.text)).find((t) => BLOG_LINK.test(t)) ?? null;
  const base = { posts, what, snippets: [...dates.slice(0, 3), ...times.slice(0, 2)], blogLink, hasBlog: posts >= BLOG_MIN_POSTS || Boolean(blogLink) };
  // The site's name says blog (its title, og:site_name or first h1), the portfolio words are not in that same part
  // of the name, and it has none of a portfolio's own parts: no projects menu entry, no project link shown outside
  // its posts (a repository, a live demo, its own project page), no plural projects heading, no resume heading.
  // Whatever the headings say, project links inside posts (in an <article>, or in a card with a date or a post
  // link) never protect it. When the structure is unclear a link counts as outside the posts: missing a blog is
  // the cheaper mistake.
  const calls = selfNames(p)
    .map(blogNamePart)
    .find((part) => part && !SELF_PORTFOLIO.test(part));
  if (calls && dated >= 1 && !p.projects.nav.length && !p.headings.some((h) => PROJECTS_SECTION.test(h.words)) && !p.headings.some(isResumeHeading)) {
    if (!projectLinkPlaces(site).some((l) => !l.inPost)) return { ...base, hasBlog: true, verdict: "blog-only", calls };
  }
  if (posts < BLOG_MIN_POSTS) {
    const why = !base.hasBlog ? "no blog" : `a "${blogLink}" link, but fewer than ${BLOG_MIN_POSTS} dated posts on this page: the posts live elsewhere`;
    return { ...base, verdict: null, why };
  }
  const p2 = p.projects;
  const protectedBy = p2.nav.length
    ? `a projects entry in its menu ("${quote(p2.nav[0], 30)}")`
    : p2.ownPages.length
      ? `links to its own project pages ("${quote(p2.ownPages[0], 30)}")`
      : p2.headings.length
        ? `a projects heading ("${quote(p2.headings[0], 40)}")`
        : p2.shown || p2.repos
          ? plural(Math.max(p2.shown, p2.repos), "project link")
          : p2.section
            ? "a projects section"
            : CASE_STUDY.test(p.text)
              ? "case studies"
              : p.headings.some(isResumeHeading)
                ? `a resume or work history ("${quote(p.headings.find(isResumeHeading).words, 30)}"): a digital resume`
                : null;
  if (protectedBy) return { ...base, verdict: null, why: `${what}, but also ${protectedBy}: not only a blog` };
  return { ...base, verdict: "blog-only" };
}

/**
 * A list of dated posts and nothing else the code can see: only a blog. The
 * owner: "having a blog shouldn't be a negative. It just can't just be a blog
 * page." Any project evidence keeps it quiet (a projects section, heading,
 * project link, a projects menu link or button, links to the site's own
 * project pages, case studies), and so does a resume or work history (a
 * digital resume, which the owner keeps). A portfolio with a blog is never
 * flagged.
 */
export function blogOnly(site) {
  const b = blogFacts(site);
  if (b.verdict !== "blog-only") return null;
  if (b.calls) {
    return raised("blog-only", `The site calls itself a blog ("${quote(b.calls, 50)}") and has no projects menu, no project pages, no projects section and no work history: only a blog.`, [b.calls, ...b.snippets]);
  }
  return raised("blog-only", `The page has ${b.what} and no projects, project links, projects menu, case studies or work history: only a blog.`, b.snippets);
}

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
  if (p.text.length > LINK_CARD_MAX_TEXT || p.text.length < UNREADABLE_MAX_TEXT || p.projects.any || WORK_WORD.test(p.text)) return null;
  const profiles = [...new Set([...p.social.map((l) => hostOf(l.href)), ...p.contact.map((l) => String(l.raw).split(":")[0].toLowerCase())])];
  if (profiles.length < 2) return null;
  const others = new Set(p.outbound.map((l) => hostOf(l.href)));
  if (others.size > 2) return null;
  // A page of its own beyond the card (an about page, a CV, a writing list) is more than a card.
  const own = new Set(p.links.filter((l) => hostOf(l.href) === hostOf(p.finalUrl) && !/^#/.test(l.raw ?? "") && pathOf(l.href) !== pathOf(p.finalUrl)).map((l) => pathOf(l.href)));
  if (own.size > 1) return null;
  // The owner has not ruled on a contact card yet (palmeida.netlify.app and ericc.vercel.app, which he kept):
  // a flag for him to look at, never more.
  return raised("link-card", `The page is ${p.text.length} characters of text with ${plural(profiles.length, "profile or contact link")} (${profiles.slice(0, 5).join(", ")}) and no projects: a contact card.`, profiles);
}

// Dropped: "thin-page" (a short page with no projects and too few profile links to be a link card). On the
// benchmark it flagged 3 non-portfolios and 8 real portfolios, most of them intro or gate screens
// ("Press the button to begin"), so it could never be safe to show the owner.

// The page speaking as a company: "we" and "our" against "I" and "my", in the languages the list has.
const WE = /\b(?:we|we're|we’re|we've|we’ve|we'll|our|ours|ourselves|wij|ons|onze|wir|unser(?:e|en|er)?|nous|notre|nos|nosotros|nuestr[oa]s?|n[oó]s|noss[oa]s?|biz|bizim)\b/giu;
// Not "je" (Dutch "you", French "I"), "ben" (Dutch "am", Turkish "I") nor "eu" (Portuguese "I", and the EU):
// either way round they miscount.
const I = /\b(?:i|i'm|i’m|i've|i’ve|i'll|i’d|my|me|mine|myself|ik|mijn|ich|mein(?:e|en|er)?|j'ai|mon|moi|yo|mi|mis|meu|minha|meus|benim)\b/giu;
// "us" alone is the United States as often as a pronoun, so it counts only in "contact us", "about us", "join us".
const US = /\b(?:contact|about|join|with|hire|email|call|ask|tell|reach)\s+us\b/giu;
// More than one person: a team, staff, jobs, founders in the plural.
const TEAM = /\b(?:our team|the team behind|team members|meet the team|our people|our staff|our employees|our founders|co-?founders|founded by [\p{L}.-]+ and [\p{L}.-]+|we(?:'re| are) hiring|join (?:our|the) team|careers|vacatures|vacancies|job openings|open positions|internships?|stellenangebote|offres d'emploi|empleos|vagas)\b/giu;
// Selling services or a product: what a company's home page asks for.
const SELLING = /\b(?:our services|services we offer|what we do|we offer|we provide|we help|we build|we design|we develop|we create|we deliver|we specialise|we specialize|get a (?:free )?quote|request a quote|free consultation|book a (?:call|demo|consultation)|start a project|pricing|plans? & pricing|our clients|our work|ons werk|onze diensten|diensten|unsere leistungen|nos services|nuestros servicios|nossos servi[cç]os|case studies|testimonials|trusted by)\b/giu;
// A freelancer or a one-person studio says so; their "we" is still one person showing their work.
// "Freelance" alone is as often a page's topic (a freelance-rate calculator); it counts as a person's word.
const SOLO = /\b(?:freelanc(?:e|er|ing)\s+(?:(?:web|software|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ui|ux|ui\/ux|product|graphic)\s+)?(?:developer|designer|engineer|programmer|consultant|dev)|(?:i'?m|i am|as|work as) an? (?:[\p{L}-]+ )?freelanc(?:e|er)|independent (?:[\p{L}-]+ ){0,2}(?:developer|designer|engineer|consultant)|(?:founded|run|owned)(?: and run)? by (?:a|an|one) (?:[\p{L}-]+ ){0,3}(?:developer|designer|engineer|person)|solo (?:developer|founder|studio)|one-person|one person (?:studio|agency|business)|i'?m (?:a|an) [\p{L} -]{0,40}(?:developer|engineer|designer|programmer|consultant)|hire me|my (?:projects|work|portfolio)|zzp|autónomo|autônomo|indépendant)\b/giu;
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
  // "We are Anna and Ben": a couple or a two-person studio, which the owner may still count as a portfolio.
  const pair = p.text.match(PAIR);
  const two = pair ? ` It names two people ("${quote(`${pair[1]} and ${pair[2]}`, 40)}"): possibly a two-person studio rather than a company.` : "";
  return raised(
    "company-voice",
    `The page speaks as "we" ${plural(we, "time")} against "I" ${plural(i, "time")} and says ${evidence.slice(0, 3).map((e) => `"${e}"`).join(", ")}: a company or agency, not one person's portfolio.${two}`,
    evidence
  );
}
const PAIR = /\b(?:[Ww]e are|[Ww]e're|[Ww]e’re|[Ff]ounded by|[Rr]un by|[Mm]ade by|by)\s+(\p{Lu}\p{Ll}{1,20})\s+(?:and|&|und|et|y|e|en)\s+(\p{Lu}\p{Ll}{1,20})\b/u;

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

/** First-person words that say a person is behind the page. */
export const PRODUCT_MAX_I = 3;

/**
 * The page is one product's or tool's home page (a calculator suite, a
 * portfolio builder): at least four product parts (pricing, sign up,
 * documentation, terms, FAQ) and no person on it. A person is on it when the
 * page names the listed person, speaks as "I" a few times, or says it is one
 * person's ("founded and run by an independent software engineer"); a page
 * with several projects stays quiet too. A one-word listed name is never taken
 * for a brand: "Darshan" on darshan.is-a.dev is a person.
 */
export function productPage(site) {
  const p = readSite(site);
  if (p.projects.shown >= 2) return null;
  const parts = PRODUCT_PARTS.filter(([, re]) => re.test(p.text)).map(([n]) => n);
  if (parts.length < PRODUCT_MIN_PARTS) return null;
  if (allMatches(p.text, I, 50).length >= PRODUCT_MAX_I || allMatches(p.text, SOLO, 1).length) return null;
  const tokens = fold(p.name).split(/[^\p{L}0-9]+/u).filter((t) => t.length >= 3);
  const text = fold(p.text);
  // The listed name on the page is a person, except a one-word name that is the whole of a two-label domain
  // ("Calzye" on calzye.com) on a page that says nothing in the first person and never names that word as a
  // person ("by Kunal", "I'm Kunal" on kunal.dev): then it is the product's own name. Never a name on a shared
  // or personal host ("Darshan" on darshan.is-a.dev).
  const labels = hostOf(p.finalUrl).split(".");
  const productName =
    tokens.length === 1 &&
    labels.length === 2 &&
    labels[0] === tokens[0] &&
    !allMatches(p.text, I, 1).length &&
    !new RegExp(String.raw`\b(?:by|i'?m|i’m|i am|hi,? i'?m|my name is|meet|about|founder|built by|made by|created by|designed by)\s+${tokens[0]}\b`, "i").test(text);
  if (!productName && tokens.some((t) => text.includes(t))) return null;
  return raised("product-page", `The page has the parts of a product's site (${parts.join(", ")}), and no person behind it: one product or tool, not a portfolio.`, parts);
}

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

// Dropped: "single-document" (one essay in paragraphs). Its only catch was the one site it was built from
// (trixum.net, by a link count), and a prose resume with no years looked the same; a page with a resume
// cannot be told from an essay with a resume link. trixum.net is caught by hidden-spam-links instead.

// ---------- hidden spam links: the site appears to have been compromised ----------

// A container that can never be opened, by its own inline style: zero width or height, zero font size, a large
// negative offset. Not display none or visibility hidden (tabs, menus and dialogs open from those), not opacity
// 0 (an animation's start) and not the hidden attribute.
const HIDDEN_STYLE = /(?:^|;)\s*(?:(?:width|height|max-width|max-height)\s*:\s*0(?:px|em|rem|%)?\s*(?:!important)?\s*(?:;|$)|font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:!important)?\s*(?:;|$)|(?:left|top|right|text-indent|margin-left|margin-top)\s*:\s*-\d{3,}(?:\.\d+)?(?:px|em|rem))/i;
// Where a developer's own projects live: a "casino-royale-clone.vercel.app" is a project, never injected spam.
const PROJECT_HOSTING = /(?:^|\.)(?:vercel\.app|netlify\.app|github\.io|gitlab\.io|onrender\.com|pages\.dev|herokuapp\.com|web\.app|firebaseapp\.com|surge\.sh|glitch\.me|railway\.app|fly\.dev|replit\.app|repl\.co|codesandbox\.io|stackblitz\.io|github\.com|gitlab\.com|itch\.io)$/i;
/** Different spam domains needed: injected links point at several sites. */
export const SPAM_MIN_DOMAINS = 2;
// Words of the usual injected spam: gambling, adult content, pharmacy.
const SPAM_WORD =
  /(?:casino|slots?\b|slot ?gacor|gacor|togel|judi|toto ?4d|poker|baccarat|sbobet|betting|bahis|bet\d{2,}|\bbet\b|grandpashabet|jackpot|lottery|porn|xxx|\bsex\b|escort|hentai|nude|viagra|cialis|kamagra|pharmacy|levitra|tramadol)/i;
/** Spam links needed inside hidden containers. */
export const SPAM_MIN_LINKS = 3;
/** The most of a hidden container read for its links. */
const HIDDEN_SPAN = 50000;

/**
 * Links hidden in an invisible block (a zero-width <marquee>, a box pushed far
 * off screen) that point to other domains and name gambling, adult content or
 * pharmacy: the usual mark of a site that has been compromised (trixum.net, in
 * the server's own HTML). Reads the plain HTML and the rendered page. The
 * reason never repeats the link text.
 */
export function hiddenSpamLinks(site) {
  const p = readSite(site);
  const self = hostOf(p.finalUrl);
  const seen = new Set();
  const domains = new Set();
  let hits = 0;
  const kinds = new Set();
  for (const html of [String(site?.plainHtml ?? "").slice(0, HTML_MAX), p.html]) {
    let containers = 0;
    for (const m of html.matchAll(/<(marquee|div|span|p|section|ul|ol|li|font|aside|footer|center)\b([^>]{0,2000})>/gi)) {
      const attrs = m[2];
      if (!/\bstyle\s*=|^\s*marquee/i.test(attrs) && m[1].toLowerCase() !== "marquee") continue;
      const style = attrs.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const styleText = style ? (style[1] ?? style[2]) : "";
      const zeroMarquee = m[1].toLowerCase() === "marquee" && (/\b(?:width|height)\s*=\s*["']?0["'\s>]/i.test(`${attrs}>`) || /(?:^|;)\s*(?:width|height)\s*:\s*0/i.test(styleText));
      if (!zeroMarquee && !HIDDEN_STYLE.test(styleText)) continue;
      // Bounded: a page of hundreds of hidden menus is read for its first 200.
      if (++containers > 200) break;
      const block = html.slice(m.index, m.index + HIDDEN_SPAN);
      const end = block.search(new RegExp(`</${m[1]}\\s*>`, "i"));
      const inside = end > 0 ? block.slice(0, end) : block;
      for (const a of inside.matchAll(/<a\b([^>]{0,2000})>([\s\S]{0,500}?)<\/a\s*>/gi)) {
        const href = a[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const url = href ? (href[1] ?? href[2] ?? href[3]) : "";
        const h = hostOf(url);
        if (!h || h === self || h.endsWith(`.${self}`) || self.endsWith(`.${h}`) || PROJECT_HOSTING.test(h)) continue;
        const title = a[1].match(/\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const words = `${h} ${title ? (title[1] ?? title[2]) : ""} ${stripTags(a[2])}`;
        const w = words.match(SPAM_WORD);
        const key = `${m.index}:${a.index}:${url}`;
        if (!w || seen.has(key)) continue;
        seen.add(key);
        domains.add(h);
        hits++;
        kinds.add(/porn|xxx|sex|escort|hentai|nude/i.test(w[0]) ? "adult content" : /viagra|cialis|kamagra|pharmacy|levitra|tramadol/i.test(w[0]) ? "pharmacy" : "gambling");
      }
    }
    if (hits >= SPAM_MIN_LINKS && domains.size >= SPAM_MIN_DOMAINS) break;
    seen.clear();
    domains.clear();
    hits = 0;
    kinds.clear();
  }
  if (hits < SPAM_MIN_LINKS || domains.size < SPAM_MIN_DOMAINS) return null;
  const what = [...kinds].sort().join(" and ");
  return raised("hidden-spam-links", `The page hides ${plural(hits, "link")} to ${domains.size} other sites about ${what} in a block that can never be opened: the site appears to have been compromised.`, [`${hits} hidden links`, ...kinds]);
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
  // A forward that keeps the listed address's handle is the person's own other site: oyi77.github.io to
  // oyi77.is-a.dev, anaruiz.netlify.app to anaruiz.dev. (The health check's hijack verdict has the same blind spot.)
  const finalHost = fold(hostOf(p.finalUrl) || to);
  if (handlesOf(p.url).some((h) => finalHost.includes(h))) return null;
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
/**
 * The person's handle in a listed address: the labels of the host that are not a hosting service or a
 * top-level domain ("oyi77" in oyi77.github.io, "anaruiz" in anaruiz.dev), and on a shared host the first path
 * segment too. At least 4 characters, so "me" or "dev" never match.
 */
function handlesOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const labels = u.hostname.toLowerCase().replace(/^www\./, "").split(".");
  const out = labels.slice(0, -1).filter((l) => !SERVICE_LABEL.test(l));
  const seg = u.pathname.split("/").filter(Boolean)[0];
  if (seg && PATH_IS_SITE.test(u.hostname)) out.push(seg.toLowerCase());
  return [...new Set(out.map(fold).map((h) => h.replace(/[^a-z0-9]/g, "")).filter((h) => h.length >= 4))];
}
const SERVICE_LABEL = /^(?:github|gitlab|netlify|vercel|pages|web|firebaseapp|herokuapp|onrender|surge|glitch|is-a|js|co|com|org|net|app|dev|io|site|online|tech|me|blog|portfolio|www)$/i;
const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// ---------- the listed address is a sub-page ----------

// Hosts where a path is the site itself: a GitHub or GitLab Pages project site, a page on a site builder or a
// short link. Their "home" is someone's account root or the service, not the person's site.
const PATH_IS_SITE = /(?:^|\.)(?:github\.io|gitlab\.io|codeberg\.page|pages\.dev|sites\.google\.com|notion\.site|dub\.sh|bit\.ly|carrd\.co|my\.site\.com|txtnode\.com)$/i;
// A path segment that names a portfolio, the person's page or a language: the page meant to be listed.
const PORTFOLIO_PATH = /^(?:[a-z]{2}(?:-[a-z]{2})?|portfolio|portafolio|portfolios|folio|projects?|work|works|me|about|cv|resume|home|index|site|web|dev|[\w-]*(?:portfolio|folio|projects?|resume)[\w-]*)$/i;
// A person's own pages on a shared host: "/~jd/", "/people/jane-doe", "/users/jd", "/staff/jd".
const PERSONAL_PATH = /^\/(?:~[^/]+|(?:people|person|users?|staff|faculty|members?|team|profiles?|u)\/[^/]+)/i;
// Hosts whose home page is never the person's: code hosts, universities and schools, blog and site builders.
// A sub-page there is judged on its own; its home page is never read as the person's.
const SHARED_HOST = /(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|medium\.com|substack\.com|dev\.to|hashnode\.dev|notion\.so|wixsite\.com|wordpress\.com|blogspot\.com|tumblr\.com|weebly\.com|squarespace\.com|webflow\.io|framer\.website|about\.me|linktr\.ee|behance\.net|dribbble\.com|read\.cv|edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/i;

/**
 * Whether the listed address is a sub-page, not the site's home: a path other
 * than "/" or an index file. Returns null for a home page, else { home, path,
 * pathIsSite, portfolioPath, sharedHost }: the home page's address, the path,
 * whether the path is the site itself (a github.io project site, a page on a
 * builder, a university's "/~jd/" or "/people/jane-doe"), whether a segment of
 * the path names a portfolio or a language ("/portfolio", "/portfolio.html",
 * "/en"), and whether the host is shared (its home page is not the person's).
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
  const segments = path.split("/").filter(Boolean).map((s) => s.replace(/\.(?:html?|php|aspx?)$/i, ""));
  return {
    home: `${u.protocol}//${u.host}/`,
    path,
    pathIsSite: PATH_IS_SITE.test(u.hostname) || PERSONAL_PATH.test(path),
    portfolioPath: segments.some((s) => PORTFOLIO_PATH.test(s)),
    sharedHost: SHARED_HOST.test(u.hostname),
  };
}

/** Whether a path names the person: a segment whose words include a part of the name, or the whole name run together. */
function pathNamesPerson(path, name) {
  const tokens = fold(name).split(/[^\p{L}0-9]+/u).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  return fold(path)
    .split("/")
    .filter(Boolean)
    .some((seg) => {
      const s = seg.replace(/\.(?:html?|php)$/, "");
      const words = s.split(/[^\p{L}0-9]+/u);
      // "samlee01": the whole name run together, a number after it allowed; "lalithdabilpuram01" for "Lalith": a
      // segment that starts with a name part of five letters or more.
      const joined = tokens.join("");
      const flat = s.replace(/[^\p{L}0-9]/gu, "");
      return tokens.some((t) => words.includes(t) || (t.length >= 5 && flat.startsWith(t))) || (joined.length >= 6 && flat.replace(/\d+$/, "") === joined);
    });
}

/** The page flags, in plain words for a reason ("only a blog"). */
const PLAIN = {
  "filler-text": "template filler text",
  "placeholder-page": "a placeholder page",
  "moved-notice": "a notice that the site has moved",
  "blog-only": "only a blog",
  "link-card": "a contact card",
  "company-voice": "a company's site",
  "sells-teaching": "a page selling coaching or courses",
  "product-page": "a product's site",
  "readme-page": "a code README",
  "hidden-spam-links": "a page with hidden spam links",
};

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
 *   "home-not-read"          no readable copy of the home page;
 *   "shared-host"            a code host, a university or a builder: its home
 *                            page is not the person's and is never judged.
 */
export function subPageOutcome(site) {
  const sub = subPageAddress(site?.url);
  if (!sub) return null;
  // On a github.io project site, a builder, a short link or a university's "/~jd/" the path is the site; its
  // "home" is an account root, a department or the service. The page's own flags speak for it, never this one.
  if (sub.pathIsSite || looksLikePortfolio(site)) return { outcome: "sub-page-is-portfolio", ...sub };
  // A "/portfolio", "/portfolio.html" or "/en" path, or a path naming the person (a page on a portfolio builder,
  // dinq.me/keith), that raises no flag is the portfolio, read poorly.
  if (sub.sharedHost) return { outcome: "shared-host", ...sub };
  const namedPath = pathNamesPerson(sub.path, site.name);
  if ((sub.portfolioPath || namedPath) && !PAGE_FLAGS.some((fn) => fn(site))) return { outcome: "sub-page-is-portfolio", ...sub, namedPath };
  const h = site.home;
  if (!h || !String(h.html || h.plainHtml || h.text || "").trim()) return { outcome: "home-not-read", ...sub };
  const home = { url: sub.home, finalUrl: h.finalUrl || sub.home, name: site.name, html: h.html ?? "", text: h.text ?? "", plainHtml: h.plainHtml ?? "" };
  // A home page with almost no text (a bot wall's "Just a moment...", an app that draws itself) was not read.
  if (unreadablePage(home)) return { outcome: "home-not-read", ...sub, homeFlags: [] };
  const homeFlags = PAGE_FLAGS.map((fn) => fn(home)).filter(Boolean).map((f) => f.flag);
  return { outcome: looksLikePortfolio(home) ? "home-is-portfolio" : "home-not-portfolio", ...sub, homeFlags };
}

/**
 * The listed address is a sub-page that is not itself a portfolio (a blog
 * category page, a single post, an about page): the reason says, in plain
 * words, what the site's home page is. A sub-page that is the portfolio (a
 * github.io project site, a "/portfolio" path, any sub-page showing
 * projects) and a page on a shared host (a code host, a university, a
 * builder) are never flagged.
 */
export function subPage(site) {
  const o = subPageOutcome(site);
  if (!o || o.outcome === "sub-page-is-portfolio" || o.outcome === "shared-host") return null;
  const where = `The listed address is a sub-page (${quote(o.path, 50)}) that shows no projects`;
  if (o.outcome === "home-is-portfolio") return raised("sub-page", `${where}; the site's home page ${o.home} shows projects: the listing should point at the home page.`, [o.path, o.home]);
  if (o.outcome === "home-not-portfolio") {
    const what = o.homeFlags.length ? o.homeFlags.map((f) => PLAIN[f] ?? f).join(" and ") : "a page with no projects";
    return raised("sub-page", `${where}, and the site's home page ${o.home} is not a portfolio either: it is ${what}.`, [o.path, o.home]);
  }
  return raised("sub-page", `${where}; the site's home page ${o.home} could not be read.`, [o.path, o.home]);
}

/** The flags that read the page itself (not the address or the forward). */
const PAGE_FLAGS = [fillerText, placeholderPage, movedNotice, blogOnly, linkCard, companyVoice, sellsTeaching, productPage, readmePage, hiddenSpamLinks];

/**
 * Every flag, by name, in the order they are reported: suspicions that a live
 * site may not be a portfolio, each for a person to look at.
 */
export const FLAGS = {
  "filler-text": fillerText,
  "placeholder-page": placeholderPage,
  "moved-notice": movedNotice,
  "blog-only": blogOnly,
  "link-card": linkCard,
  "company-voice": companyVoice,
  "sells-teaching": sellsTeaching,
  "product-page": productPage,
  "readme-page": readmePage,
  "hidden-spam-links": hiddenSpamLinks,
  "forwards-elsewhere": forwardsElsewhere,
  "sub-page": subPage,
};

/**
 * What the code struggles to read, apart from the flags: never a suspicion that
 * the site is not a portfolio, never for the review queue as one.
 */
export const READING_PROBLEMS = {
  "unreadable-page": unreadablePage,
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

/** The reading problems for a site (READING_PROBLEMS): [{ flag, reason, snippets }]. Empty when none. */
export function readingProblems(site) {
  return Object.values(READING_PROBLEMS)
    .map((fn) => fn(site))
    .filter(Boolean);
}
