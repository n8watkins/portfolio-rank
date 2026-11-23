// "Code checks facts": everything about a portfolio that code can check for
// free, measured from the page's HTML and stored in portfolios.facts so the
// AI grade (pipeline/rubric.mjs) gets it as context instead of guessing it
// from a screenshot. capture.mjs measures the rendered page; judge.mjs
// measures over plain HTTP for rows captured before facts existed.
//
// measureFacts is pure; checkLinks makes HTTP requests (HEAD, then GET when
// HEAD is refused), capped in number and time, never to private addresses.
import { GH_RESERVED, RESUME_PATH, RESUME_WORDS, controlFacts, isGithubProfile, scanPage, stripTags } from "./page-controls.mjs";
import { portfolioSignals } from "./signals.mjs";
import { parkingPhrase, visibleText } from "./gate.mjs";

// 2 (2026-11-21): resume, GitHub, contact, project links and in-page
// sections also come from buttons and other non-link controls
// (./page-controls.mjs). Facts stored with v 1 were measured from links
// only.
// 3 (2026-11-22): project links are picked from the projects first (links in
// an element or section that says projects, and GitHub repositories), and
// pass when at least MIN_PROJECT_LINKS load; the footer year is also read
// after the year ("2026 ©"); the capture measures the phone view too and
// merges it in (mergeViews). A row gets the new version at its next capture,
// or from the whole-list re-measure (remeasure-all.yml, see AUTOMATION.md).
export const FACTS_VERSION = 3;
export const LINK_CHECK_MAX = 8;
export const LINK_TIMEOUT_MS = 8000;
/** The fewest project links that load for "project links load" to pass (and for full project points, lib/check-points.mjs). */
export const MIN_PROJECT_LINKS = 3;

/** The candidates' lowest tier (projectCandidates): outbound links outside any projects section. */
export const LOW_TIER = 3;
/**
 * The owner's choice for links of the lowest tier (checkLinks):
 *   "beside"  they count toward the three only when at least one higher-tier project link loads (variant A);
 *   "never"   they never count and are not requested: only links in a section the page labels as projects,
 *             the projects page's main content, the site's own project pages and repositories count (variant B).
 * Either way, when they are left out the result names how many (`not_counted`). ("all", every link counts as
 * before tiers, is only for the re-pick of facts of version 1 and 2.) "never" was chosen from the live tests of
 * 75 sites (2026-11-23): both give the same pass on 72; on gauravgrv.vercel.app (a "What I work with" list of
 * library sites) and ashlok.dev (a placeholder link, a DMCA badge, the site's own source) "beside" passed a site
 * with one real project link, and its counts take in universities, partners and blog posts.
 */
export const LOW_LINKS = "never";
/**
 * Own project pages on a host that answers 200 for an address that cannot exist (a catch-all host, an app
 * shell) are verified by their text instead of their status (checkProjectLinks): at least this many words of
 * their own, and no more than this share of their words shared with the nonsense page or the home page.
 */
export const OWN_PAGE_MIN_WORDS = 50;
export const OWN_PAGE_MAX_OVERLAP = 0.8;
/** The facts version whose project-link rule is the one below; older facts keep the rule they were measured under. */
export const PROJECT_RULE_VERSION = 3;
const isLinks = (l) => Boolean(l && typeof l === "object" && typeof l.checked === "number");
const n = (x) => Number(x) || 0;
/** Whether facts of `version` (their `v`; none is version 0) are read with the version 3 project-link rule. */
export const newProjectRule = (version) => n(version) >= PROJECT_RULE_VERSION;

/**
 * How much of "project links load" a check earns, 0 to 1, or null when it
 * cannot be told. One rule per facts version, so what a visitor sees never
 * changes for a site until it is measured again:
 *
 *   version 3 and newer: a third for each project link that loads, full at
 *   MIN_PROJECT_LINKS. The site's own pages count fully, because they load
 *   only when they are real pages (checkProjectLinks: on a host that answers
 *   every address, by their own text).
 *   A link behind a bot check is neither loading nor broken: it is left out,
 *   and when the ones behind a bot check could have made the difference
 *   (2 load and 1 is behind one) the result is unknown, not a fail. None
 *   found is 0;
 *   versions 1 and 2 (the rule they were measured under): the loading share
 *   of the links checked, times checked / MIN_PROJECT_LINKS up to 1; none
 *   found is 0.
 *
 * The rubric's pass (projectLinksPass) is a share of 1 under the same rule,
 * and the automated checks score (lib/check-points.mjs) is this share of its
 * points.
 */
export function projectLinksShare(links, version) {
  if (!isLinks(links)) return null;
  if (!newProjectRule(version)) return links.checked > 0 ? (n(links.ok) / links.checked) * Math.min(1, links.checked / MIN_PROJECT_LINKS) : 0;
  const blocked = n(links.blocked);
  if (links.checked > 0 && blocked >= links.checked) return null;
  const counted = n(links.ok);
  if (counted >= MIN_PROJECT_LINKS) return 1;
  if (counted + blocked >= MIN_PROJECT_LINKS) return null;
  return counted / MIN_PROJECT_LINKS;
}

/**
 * Pass (true), fail (false) or unknown (null) for "project links load", by
 * the rule of the facts' version (projectLinksShare): version 3 passes at a
 * share of 1; versions 1 and 2 passed when at least one was checked and none
 * was broken.
 */
export function projectLinksPass(links, version) {
  if (!isLinks(links)) return null;
  if (!newProjectRule(version)) return links.checked > 0 ? n(links.broken) === 0 : null;
  const share = projectLinksShare(links, version);
  return share == null ? null : share >= 1;
}

/**
 * The project-link check in words, wherever it is shown, or null when it was
 * never checked. Version 3: "5 of 8 project links load" (links behind a bot
 * check left out of both numbers and named after), "Project links: none
 * found". Versions 1 and 2 keep the words they were shown with: "4 of 5
 * load, 1 broken", "No project links to check".
 */
export function projectLinksText(links, version) {
  if (!isLinks(links)) return null;
  if (!newProjectRule(version)) return links.checked ? `${n(links.ok)} of ${links.checked} load${n(links.broken) ? `, ${n(links.broken)} broken` : ""}` : "No project links to check";
  // Other links on the page, left out because no project link in the projects loads (checkLinks).
  const others = n(links.not_counted) ? `${n(links.not_counted)} other ${n(links.not_counted) === 1 ? "link" : "links"} on the page ${n(links.not_counted) === 1 ? "was" : "were"} not counted` : "";
  if (links.checked <= 0) return others ? `No project links found in a projects section; ${others}` : "Project links: none found";
  const blocked = n(links.blocked);
  const tested = links.checked - blocked;
  const wall = blocked ? `${blocked} behind a bot check` : "";
  if (tested <= 0) return `Project links: ${[wall, others].filter(Boolean).join("; ")}`;
  // Own pages that answered but could not be told from a page that does not exist (a catch-all host) do not load.
  const shell = n(links.own_unverified) ? `${n(links.own_unverified)} of the site's own project pages could not be told apart from an empty page, so they were not counted` : "";
  return `${n(links.ok)} of ${tested} project links load${[wall, shell, others].filter(Boolean).map((s) => `; ${s}`).join("")}`;
}

// Free hosting subdomains: a site served from one is not on its own domain.
export const FREE_HOSTS =
  /\.(vercel\.app|netlify\.app|github\.io|gitlab\.io|framer\.website|framer\.app|framer\.ai|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|surge\.sh|onrender\.com|herokuapp\.com|glitch\.me|replit\.app|repl\.co|wixsite\.com|squarespace\.com|webflow\.io|carrd\.co|notion\.site|super\.site|wordpress\.com|blogspot\.com|neocities\.org|fly\.dev|railway\.app|azurewebsites\.net|amplifyapp\.com|translate\.goog)$/i;

// Profiles on sites for freelancing, link lists, competitive coding, data
// science, art, film, books and anime (the grading preview's retest,
// 2026-11-22: stimmie.dev's "find me" list, hellosagar's Upwork and Fiverr):
// a profile is never a project, so it never fills a project-link slot.
const PROFILE_HOSTS =
  /(^|\.)(upwork\.com|fiverr\.com|freelancer\.com|toptal\.com|linktr\.ee|bio\.link|beacons\.ai|kaggle\.com|codeforces\.com|codechef\.com|hackerearth\.com|geeksforgeeks\.org|kattis\.com|topcoder\.com|imdb\.com|goodreads\.com|letterboxd\.com|myanimelist\.net|anilist\.co|deviantart\.com|artstation\.com|youpic\.com|500px\.com|flickr\.com|unsplash\.com|pinterest\.com|reddit\.com|twitch\.tv|spotify\.com|soundcloud\.com|substack\.com|producthunt\.com|wellfound\.com|angel\.co|glassdoor\.com|indeed\.com|vsco\.co|about\.me|peerlist\.io|read\.cv|polywork\.com|bento\.me|contra\.com|layers\.to)$/i;
/** An address on a code host itself (github.com/ana, gitlab.com/ana/x, bitbucket.org/ana): not a portfolio site. */
export function isCodeHostAddress(url) {
  try {
    return /^(?:github\.com|gitlab\.com|bitbucket\.org)$/i.test(new URL(url).hostname.replace(/^www\./i, ""));
  } catch {
    return false;
  }
}
// Profiles on sites whose other pages are projects: a Devpost, GitLab, Bitbucket, Hugging Face or Replit user
// page (one segment: devpost.com/ana, replit.com/@ana), and an itch.io creator's home page. Their project
// pages (devpost.com/software/x, gitlab.com/ana/x, huggingface.co/spaces/ana/x, ana.itch.io/game) count.
const PROFILE_PATH_HOSTS = /^(?:devpost\.com|gitlab\.com|bitbucket\.org|huggingface\.co|replit\.com)$/i;
const isPathProfile = (h, path) => {
  const segs = path.split("/").filter(Boolean);
  if (PROFILE_PATH_HOSTS.test(h)) return segs.length === 1 && !/^(?:software|hackathons)$/i.test(segs[0]);
  return /\.itch\.io$/i.test(h) && segs.length === 0;
};
// Certificates and course records: proof of learning, not projects (aradhyapuneeth.github.io's Microsoft Learn
// and Neo4j certificates). Whole hosts, or the certificate paths of a learning site. (Coursera, Udemy,
// freeCodeCamp, LinkedIn and HackerRank are left out whole, NOT_PROJECT.)
const CERTIFICATE_HOSTS = /(^|\.)(credly\.com|youracclaim\.com|accredible\.com|credential\.net|certmetrics\.com|graphacademy\.neo4j\.com)$/i;
const CERTIFICATE_PATH = {
  "learn.microsoft.com": /\/(?:api\/)?credentials\b|\/users\/[^/]+\/(?:credentials|transcript|achievements)\b/i,
  "datacamp.com": /^\/(?:completed\/)?statement-of-accomplishment\//i,
};
const isCertificate = (h, path) => CERTIFICATE_HOSTS.test(h) || Boolean(CERTIFICATE_PATH[h]?.test(path));
/** A CodePen profile (codepen.io/name), not one of its pens (codepen.io/name/pen/id). */
const isCodepenProfile = (u) => /(^|\.)codepen\.io$/i.test(u.hostname) && u.pathname.split("/").filter(Boolean).length <= 1;

// Hosts that are profiles or services, not project demos.
const NOT_PROJECT =
  /(^|\.)(linkedin\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|threads\.com|bsky\.app|mastodon\.social|dribbble\.com|behance\.net|medium\.com|dev\.to|hashnode\.com|stackoverflow\.com|leetcode\.com|hackerrank\.com|discord\.gg|discord\.com|t\.me|wa\.me|calendly\.com|cal\.com|buymeacoffee\.com|ko-fi\.com|patreon\.com|google\.com|googleapis\.com|gstatic\.com|fonts\.googleapis\.com|w3\.org|schema\.org|creativecommons\.org|vercel\.com|netlify\.com|nextjs\.org|reactjs\.org|react\.dev|gatsbyjs\.com|astro\.build|tailwindcss\.com|fontawesome\.com|unsplash\.com|icons8\.com|flaticon\.com|coursera\.org|udemy\.com|smashingmagazine\.com|css-tricks\.com|freecodecamp\.org|hashnode\.dev|w3schools\.com|developer\.mozilla\.org|cookiebot\.com|onetrust\.com)$/i;
// App store and extension store listings are projects, though their parent hosts are on the list above.
const STORE_HOST = /^(?:play\.google\.com|chromewebstore\.google\.com)$/i;
// The sites of the tools a developer uses, as named in a "Tools I use" list: languages, frameworks and
// libraries, databases, cloud and hosting providers, design tools. The exact site only (with or without www),
// never a subdomain, so a project shipped on one of them (an app on a provider's subdomain, hub.docker.com/r/x,
// flask.palletsprojects.com is not on the list) still counts; the hosting platforms' own app domains
// (vercel.app, netlify.app, github.io, web.app, onrender.com, up.railway.app) are not on it at all.
const TOOL_SITE =
  /^(?:www\.)?(?:nodejs\.org|typescriptlang\.org|javascript\.com|python\.org|go\.dev|golang\.org|rust-lang\.org|kotlinlang\.org|swift\.org|php\.net|ruby-lang\.org|java\.com|dart\.dev|flutter\.dev|angular\.dev|angular\.io|vuejs\.org|svelte\.dev|nuxt\.com|remix\.run|expressjs\.com|nestjs\.com|djangoproject\.com|laravel\.com|spring\.io|getbootstrap\.com|sass-lang\.com|mui\.com|redux\.js\.org|graphql\.org|prisma\.io|vitejs\.dev|vite\.dev|webpack\.js\.org|jestjs\.io|threejs\.org|d3js\.org|jquery\.com|tensorflow\.org|pytorch\.org|numpy\.org|jupyter\.org|mongodb\.com|postgresql\.org|mysql\.com|redis\.io|sqlite\.org|supabase\.com|firebase\.com|docker\.com|kubernetes\.io|git-scm\.com|aws\.amazon\.com|azure\.microsoft\.com|heroku\.com|render\.com|railway\.app|digitalocean\.com|cloudflare\.com|figma\.com|adobe\.com|canva\.com|sketch\.com|postman\.com|code\.visualstudio\.com|jetbrains\.com|openai\.com)$/i;
// The paths on a tool's site where a person's own work lives: a Figma file, prototype or community file, a
// Canva design, a Sketch share, a Postman workspace or collection. Everything else on a tool's site (its home,
// docs such as nodejs.org/api/fs.html, pricing, blog) is the tool's. An exemption list rather than "the root or
// one short segment": docs paths are unbounded, and work paths on these few design and API tools are not.
const TOOL_WORK_PATH = {
  "figma.com": /^\/(?:file|proto|design|board|slides|community\/(?:file|plugin|widget))\//i,
  "canva.com": /^\/design\//i,
  "sketch.com": /^\/s\//i,
  "postman.com": /^\/[^/]+\/(?:workspace|collection|api|flows?)(?:\/|$)/i,
};
const isToolSite = (h, path) => TOOL_SITE.test(h) && !TOOL_WORK_PATH[h.replace(/^www\./, "")]?.test(path);
// A package registry's home page names the registry, not a project; its package pages are projects.
const REGISTRY_HOME = /^(?:www\.)?(?:npmjs\.com|pypi\.org|crates\.io|rubygems\.org|pub\.dev|packagist\.org|nuget\.org)$/i;


// Known templates, by a marker they leave in the HTML. The value is the name
// stored in facts.template.
export const TEMPLATE_MARKERS = [
  [/html5up|html5 up\b/i, "HTML5 UP"],
  [/startbootstrap|start bootstrap/i, "Start Bootstrap"],
  [/bootstrapmade/i, "BootstrapMade"],
  [/colorlib/i, "Colorlib"],
  [/templatemo/i, "TemplateMo"],
  [/w3layouts/i, "W3layouts"],
  [/themeforest|envato/i, "ThemeForest"],
  [/freehtml5\.co|gettemplates\.co/i, "FreeHTML5"],
  [/uicookies/i, "uiCookies"],
  [/themewagon/i, "ThemeWagon"],
  [/gatsby-starter-[a-z0-9-]+/i, "Gatsby starter"],
  [/astro-theme-[a-z0-9-]+|astrofy/i, "Astro theme"],
  [/developerFolio|saadpasta/i, "developerFolio"],
];
const BUILDERS = [
  [/static\.wixstatic\.com|wix\.com\s+website\s+builder|_wixCssImports/i, "Wix"],
  [/squarespace\.com|static1\.squarespace/i, "Squarespace"],
  [/data-wf-page|webflow\.com\/|assets\.website-files\.com/i, "Webflow"],
  [/framerusercontent\.com|framer\.com\/m\/|data-framer-/i, "Framer"],
  [/carrd\.co/i, "Carrd"],
  [/super\.so|notion-static\.com/i, "Notion"],
  [/\/wp-content\//i, "WordPress"],
  [/readymag/i, "Readymag"],
];

/**
 * Subdomains of a person's own domain that are services, not work: mail, a blog, static files, sign-in, a CV,
 * and short links to their profiles ("git.phyominthein.com", "linkedin.", "ig.").
 */
const OWN_SERVICE_SUBDOMAIN =
  /^(?:mail|webmail|smtp|blog|news|cdn|static|assets|media|img|images|files|status|api|auth|login|admin|analytics|stats|links?|go|cal|calendar|book|resume|cv|shop|store|git|github|gh|gitlab|linkedin|li|in|ig|insta|instagram|x|twitter|tw|fb|facebook|yt|youtube|tiktok|discord|telegram|tg|wa|whatsapp|mastodon|bsky|threads|dribbble|behance|medium|dev|contact|email|me|about)$/i;

const host = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
/**
 * Every <a href> on the page, absolute, with its text and aria-label. Read by
 * the tag scanner (./page-controls.mjs scanPage), so a Tailwind class such as
 * "[&>svg]:size-4" does not end the tag before its href, and a stray quote
 * (href=/o'neil, title=5") is read as a browser reads it.
 */
export function extractLinks(html, baseUrl) {
  return scanPage(html, baseUrl).links;
}


/** Is this a private, loopback or link-local address that must never be fetched? */
export function isPrivateHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(h)) return true;
  return false;
}

// A copyright year next to its mark, either way round: "© 2026", "Copyright 2024-2026", "2026 © Name",
// "2020 - 2026 ©". The second year of a range counts. A bare year without a mark never does.
const COPYRIGHT_MARK = String.raw`(?:©|&copy;|&#169;|\(c\)|copyright)`;
const YEAR = String.raw`((?:19|20)\d{2})`;
// A hyphen, an en dash or an em dash between the two years of a range (U+2013, U+2014).
const RANGE_DASH = `\\s*[-${String.fromCharCode(0x2013, 0x2014)}]\\s*`;
const MARK_THEN_YEAR = new RegExp(String.raw`${COPYRIGHT_MARK}\s*(?:\d{4}${RANGE_DASH})?${YEAR}(?!\d)`, "gi");
// The year first only where it opens a footer line: at the start of a line or after a separator
// ("|", "•", "·", "/", a bracket, or a spaced dash), with nothing but spaces before its mark on the same
// line. So "since 2019 © All rights reserved", "Graduated 2018" above "© Jane Doe" and a phone number
// ending in a year are never footer years.
const SAME_LINE_DASH = `[ \\t]*[-${String.fromCharCode(0x2013, 0x2014)}][ \\t]*`;
const YEAR_THEN_MARK = new RegExp(
  String.raw`(?:^[ \t]*|[|•·/(\[][ \t]*|[ \t][-${String.fromCharCode(0x2013, 0x2014)}][ \t]+)${YEAR}(?:${SAME_LINE_DASH}${YEAR})?[ \t]*${COPYRIGHT_MARK}`,
  "gim"
);

/** The highest plausible copyright year on the page, or null. */
export function footerYear(text, now = new Date()) {
  const max = now.getUTCFullYear() + 1;
  const s = String(text ?? "");
  let best = null;
  const take = (y) => {
    if (y <= max && (best == null || y > best)) best = y;
  };
  for (const m of s.matchAll(MARK_THEN_YEAR)) take(Number(m[1]));
  for (const m of s.matchAll(YEAR_THEN_MARK)) take(Number(m[2] ?? m[1]));
  return best;
}

// The label of a nav control that scrolls to a section of the page.
const NAV_SECTION = /^\s*(home|about(?: me)?|projects?|work|portfolio|skills|experience|contact(?: me)?|blog|services|education|testimonials)\s*$/;

export { isGithubProfile };

/**
 * Every link on the page as extractLinks returns it, plus the URLs a
 * non-link control navigates to from its onclick (a button's
 * window.open('https://github.com/me/app') or location.href = '...'), so a
 * project opened from a button is a project link too. URLs merely written in
 * data- attributes (tracking, form endpoints) are not. `scan` is a scanPage
 * result to reuse.
 * @param {string} html
 * @param {string} baseUrl
 * @param {ReturnType<typeof scanPage> | null} [scan]
 */
export function pageLinks(html, baseUrl, scan = null) {
  const page = scan ?? scanPage(html, baseUrl);
  const fromControls = page.controls.flatMap((c) => c.navUrls.map((href) => ({ raw: href, href, text: c.label, inProjects: c.inProjects, inChrome: c.inChrome, inSocial: c.inSocial, inAside: c.inAside, inOther: c.inOther })));
  return [...page.links, ...fromControls];
}

/**
 * An outbound link that may be a project or a demo, as the URL that is
 * checked: another site or a GitHub repository, not a social profile, a
 * service, a file or the site itself. Null otherwise. `repo` says it is a
 * GitHub repository.
 */
function projectUrl(l, self) {
  let u;
  try {
    u = new URL(l.href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!h || h === self || isPrivateHost(h)) return null;
  let repo = false;
  if (h === "github.com") {
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length < 2 || GH_RESERVED.test(segs[0])) return null; // a profile, not a repository
    // A pull request, an issue, a commit or a comparison is a contribution to someone's code, not a repository.
    if (/^(?:pull|pulls|issues?|commit|commits|compare|discussions)$/i.test(segs[2] ?? "")) return null;
    repo = true;
  } else if ((NOT_PROJECT.test(h) && !STORE_HOST.test(h)) || isToolSite(h, u.pathname) || (REGISTRY_HOME.test(h) && u.pathname.replace(/\/+$/, "") === "") || PROFILE_HOSTS.test(h) || isPathProfile(h, u.pathname) || isCertificate(h, u.pathname) || isCodepenProfile(u) || /\.(pdf|png|jpe?g|gif|svg|webp|zip)$/i.test(u.pathname)) {
    return null;
  }
  u.hash = "";
  // A subdomain of the site's own domain is the person's own work ("gradesim.stimmie.dev" on stimmie.dev,
  // "photography.siemvanbree.nl"), except the usual service subdomains. Never on a shared host: on
  // "ana.github.io" another "*.github.io" is someone else's, and it is not a subdomain of "ana.github.io" anyway.
  const ownSub = Boolean(self) && h.endsWith(`.${self}`) && !OWN_SERVICE_SUBDOMAIN.test(h.slice(0, -self.length - 1));
  return { key: u.href, repo, ownSub };
}

/**
 * The links checked for "project links load", at most `max`: first the
 * outbound links inside the projects (an element whose id, class,
 * aria-label or heading says projects, work, portfolio, case study: a link
 * `inProjects`, ./page-controls.mjs) and links to GitHub repositories outside
 * the page's nav, header and footer, in page order; only then every other
 * outbound link, in page order. So a school, an employer or a client named in
 * the about or experience sections never takes the place of a project.
 * Social profiles, services and the site itself are never candidates.
 */
export function projectLinkCandidates(links, siteUrl, max = LINK_CHECK_MAX) {
  return projectCandidates(links, siteUrl, max).map((c) => c.url);
}

// A path segment that names a list of projects: "/projects", "/work", "/portfolio", "/case-studies",
// "/solutions". Whole segments only, so "/how-it-works", "/networks" and "/workshop" are not.
// Other languages too: "/proyectos", "/projets". A page name's extension is read off first: "projects.html"
// (josephmansilla.github.io) is "projects".
const LISTING_WORDS = String.raw`projects?|works?|my-work|selected-work|portfolios?|case-stud(?:y|ies)|solutions?|showcase|projets|proyectos|projekte|projetos|progetti|projecten|projekty|проекты|проекти|项目|作品|obras|trabalhos|trabajos|travaux|r[eé]alisations`;
const pageName = (s) => String(s).replace(/\.(?:html?|php)$/i, "");
const LISTING_NAME = new RegExp(String.raw`^(?:${LISTING_WORDS})$`, "iu");
const LISTING_SEGMENT = { test: (s) => LISTING_NAME.test(pageName(s)) };
// Names that are a projects page only as the site's first path segment and under a label that says the same:
// "/made" labelled "Made" (milan.milanovic.org), "/lab" labelled "Lab". Not "/research/lab", not "/ci/builds"
// labelled "CI", and never a listing above a project's own page ("/builds/1234").
const MAKER_PAGE = /^(?:made|builds|lab|creations)$/i;
const makerPage = (segs, label) =>
  segs.length === 1 && MAKER_PAGE.test(pageName(segs[0])) && new RegExp(String.raw`(?<!\p{L})${pageName(segs[0])}(?!\p{L})`, "iu").test(String(label ?? ""));
// A segment that a GET could act on: sign-in and sign-out, subscription and account actions ("/unsubscribe",
// "/logout", "/delete", "/pay"). Never requested, wherever it sits, even as a project's own name.
const ACTION_SEGMENT =
  /^(?:log-?in|log-?out|sign-?in|sign-?out|sign-?up|register|subscribe|unsubscribe|opt-?out|confirm|confirmation|verify|activate|delete|remove|cancel|edit|pay|wp-login\.php)$/i;
// A segment that is not a project page above a project's name ("/projects/tag/react", "/blog/projects/x"),
// and never the projects page: pages about the person or the site, and sections of an app.
const SECTION_SEGMENT =
  /^(?:about(?:-me|-us)?|contact(?:-me|-us)?|blog|posts?|articles?|news|newsletter|press|resume|cv|tags?|category|categories|page|search|feed|rss|privacy|terms|cookies|legal|account|profile|settings|admin|dashboard|auth|oauth|session|cart|basket|checkout|payment|payments|download|downloads|export|shop|store|faq|pricing|services|clients|team|careers|jobs|how-it-works|api|wp-admin)$/i;
const NOT_PROJECT_SEGMENT = { test: (s) => ACTION_SEGMENT.test(s) || SECTION_SEGMENT.test(s) };
const segmentsOf = (p) => String(p ?? "").split("/").filter(Boolean).map((s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
});
const sameHost = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

/**
 * A link to a page of the site itself, as the URL that is checked: http(s),
 * not the home page, not a file, no query, without its fragment. Null otherwise.
 */
function ownPageUrl(l, self) {
  let u;
  try {
    u = new URL(l.href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" || !sameHost(u.hostname.toLowerCase(), self)) return null;
  const p = u.pathname.replace(/\/+$/, "");
  if (!p || u.search || /\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|txt|ico|css|js|json)$/i.test(p)) return null;
  u.hash = "";
  return { key: u.href, path: p.toLowerCase() };
}

/**
 * Whether a same-site path is a page for one project: it sits under a
 * listing ("/projects/foo", "/portfolio/bar", "/solutions/x"), or under
 * `base` (the projects page's own path), and no segment above the project's
 * name is an about, contact, blog, tag, category or action page
 * ("/projects/tag/react", "/blog/projects/x"). The name right under the
 * listing is the project's own and may be any word but an action:
 * "/projects/dashboard", "/projects/api", "/case-studies/checkout",
 * "/work/store" are projects; "/projects/logout" or "/projects/delete" is
 * never requested. The listing itself is not one.
 */
function isOwnProjectPath(path, base = "") {
  const segs = segmentsOf(path);
  if (!segs.length) return false;
  const parents = segs.slice(0, -1);
  const underListing = parents.some((s) => LISTING_SEGMENT.test(s));
  const underBase = base !== "" && path.startsWith(`${base}/`);
  if (!underListing && !underBase) return false;
  const nameUnderListing = (parents.length > 0 && LISTING_SEGMENT.test(parents.at(-1))) || (base !== "" && `/${parents.join("/")}`.toLowerCase() === base);
  if (segs.some((s) => ACTION_SEGMENT.test(s))) return false;
  return !(nameUnderListing ? parents : segs).some((s) => SECTION_SEGMENT.test(s));
}

/**
 * A page whose own name says it is one project: "project-sync.html", "/project_solar", "/work-dashboard",
 * "/case-study-x": "project", "work" or "case study", then "-" or "_" and a name. Not "/works-cited" (a
 * bibliography), nor "/portfolio-2019" (an archive of a year). Its other segments must not be a section or action.
 */
function isNamedProjectPage(path) {
  const segs = segmentsOf(path);
  if (!segs.length || segs.some((s) => ACTION_SEGMENT.test(s) || SECTION_SEGMENT.test(s))) return false;
  const name = segs.at(-1).replace(/\.html?$/i, "");
  return /^(?:projects?|work|case-stud(?:y|ies))[-_].{2,}$/i.test(name);
}

/**
 * The project-link candidates with where each came from, at most `max`, in
 * this order:
 *   1. outbound demo and repository links in the projects: links inside a
 *      projects element or section (`inProjects`) and GitHub repositories
 *      outside the nav, header and footer, on the home page (both views) or
 *      on the site's projects page (`from: "projects_page"`);
 *   2. the site's own pages for single projects (isOwnProjectPath): in a home
 *      page projects section, or on the projects page outside its nav,
 *      header and footer;
 *   3. every other outbound link (LOW_TIER), in page order: outside any
 *      projects section, or in what looks like a tool list, a banner or a
 *      section that is not projects. These count only as LOW_LINKS says.
 * A profile, a link in a "find me" list, the site's home page and the
 * projects page itself are never candidates. `links` carry `from` ("home",
 * "phone" or "projects_page"; "home" when missing) and, for the projects
 * page, its address in `page`. Returns [{ url, from, kind, tier }], kind
 * "outbound" or "own page".
 */
export function projectCandidates(links, siteUrl, max = LINK_CHECK_MAX) {
  const self = host(siteUrl);
  const homePath = (() => {
    try {
      return new URL(siteUrl).pathname.replace(/\/+$/, "").toLowerCase();
    } catch {
      return "";
    }
  })();
  const seen = new Set();
  const tiers = [[], [], []];
  for (const l of links) {
    const from = l.from ?? "home";
    const onProjectsPage = from === "projects_page";
    // A credit ("Powered by Hugo & Narrow", "Theme by ..."), repository included: never a project. The one place a
    // repository is dropped. Not inside the projects, nor in the main content of the projects page, where "Built
    // with Next.js & <a>source</a>" describes the project itself.
    if (l.credit && !l.inProjects && (l.inChrome || !onProjectsPage)) continue;
    const p = projectUrl(l, self);
    if (p) {
      // A list of where else to find the person ("Find me", "Let's connect") holds profiles, not projects.
      if (seen.has(p.key) || (l.inSocial && !p.repo)) continue;
      // On the site's own projects page (a listing page by its path or label, projectsPageFor) the whole
      // main content is the projects, whatever its headings and classes: its title is almost always an h1
      // "Projects", which opens no section, and utility-class cards say nothing. Nav, header and footer stay out.
      // On the home page only a projects element or section, or a repository, counts as in the projects.
      // A guess from a class, id or heading only lowers a link, never removes it: a link in what looks like a
      // tool list, a cookie banner or a comment widget (inAside) is an other outbound link (tier 3), checked
      // only when slots remain, on either page; a repository is never lowered. What keeps a tool list or a
      // banner from passing is the host lists (TOOL_SITE, NOT_PROJECT), which remove the tools' own sites.
      if (onProjectsPage && l.inChrome) continue;
      // A repository, or a subdomain of the site's own domain (its own work), counts as in the projects anywhere
      // but the page's frame and a section whose heading says it is not projects ("Work Experience" with an
      // employer's repositories, "Repos I like").
      const inProjects = Boolean(l.inProjects) || ((p.repo || p.ownSub) && !l.inChrome && !l.inOther) || (onProjectsPage && !l.inAside);
      seen.add(p.key);
      tiers[inProjects ? 0 : 2].push({ url: p.key, from, kind: "outbound" });
      continue;
    }
    const own = ownPageUrl(l, self);
    // Never the home page itself (a site served under a path, as samrinjaji.github.io/my-portfolio/ is).
    if (!own || own.path.replace(/\/index\.html?$/, "") === homePath || seen.has(own.key) || l.inChrome || l.inSocial) continue;
    const rel = homePath && own.path.startsWith(`${homePath}/`) ? own.path.slice(homePath.length) : own.path;
    let ok = false;
    if (onProjectsPage) {
      const base = pathOfUrl(l.page);
      ok = own.path !== base && isOwnProjectPath(rel, homePath && base.startsWith(homePath) ? base.slice(homePath.length) : base);
    } else {
      // In a home page projects section, with a project page's path, or a page of its own whose name says
      // project ("project-sync.html", sebascherny.github.io's case studies at the site's root).
      ok = Boolean(l.inProjects) && (isOwnProjectPath(rel) || isNamedProjectPage(rel));
    }
    if (!ok) continue;
    seen.add(own.key);
    tiers[1].push({ url: own.key, from, kind: "own page" });
  }
  // Every own project page goes ahead of the lowest tier, which only fills the slots left over (sujanbhatta.tech:
  // 6 case studies, then partner logos). stimmie.dev's own apps on its subdomains are in the first tier now, so
  // its own pages no longer push them out.
  const own = tiers[1].map((c) => ({ ...c, tier: 2 }));
  return [...tiers[0].map((c) => ({ ...c, tier: 1 })), ...own, ...tiers[2].map((c) => ({ ...c, tier: LOW_TIER }))].slice(0, max);
}

/**
 * A link whose whole label names the projects page: "Projects", "My work", "Explore Work →", "Case studies",
 * "Proyectos", "Mis proyectos", "Réalisations". Not "How I work". ("Made", "Lab": only with their own path, makerPage.)
 */
const PROJECTS_LINK_TEXT = new RegExp(
  String.raw`^\s*(?:(?:my|all|our|selected|featured|recent|view all|see all|explore|view|mis|meus|mes|meine|i miei|mijn|мои)\s+)?(?:projects?|works?|portfolio|portafolio|portf[oó]lio|case stud(?:y|ies)|solutions|showcase|projets|proyectos|projekte|projetos|progetti|projecten|projekty|проекты|проекти|项目|作品|obras|trabalhos|trabajos|travaux|r[eé]alisations)\s*[→›»↗]?\s*$`,
  "iu"
);

const pathOfUrl = (u) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
};

/**
 * The projects a home page shows itself, as the pass counts them: its
 * outbound demo and repository links and its own project pages.
 */
function shownProjects(links, homeUrl) {
  return projectCandidates(links, homeUrl, Infinity).filter((x) => x.tier <= 2).length;
}

/**
 * The site's own projects page to read when the home page shows fewer than
 * MIN_PROJECT_LINKS projects (pure): the first same-site link, nav links
 * included, whose last path segment is a listing ("/projects", "/work",
 * "/portfolio", "/case-studies", "/solutions", "/es/projects", "/topic/
 * portfolios"), else the first whose whole label names one ("Projects",
 * "Explore Work →"); never a path with an about, blog, contact, client,
 * how-it-works or similar segment, a query, the home page or a section of
 * it. `links` are the home page's (desktop and phone, `from` set); `homeUrl`
 * its final address. Returns the address or null.
 */
export function projectsPageFor(links, homeUrl) {
  const self = host(homeUrl);
  const home = pathOfUrl(homeUrl);
  if (shownProjects(links, homeUrl) >= MIN_PROJECT_LINKS) return null;
  let byText = null;
  for (const l of links) {
    const own = ownPageUrl(l, self);
    if (!own) continue;
    // Read below the home page's own path, so a site served under /my-portfolio/ is not its own projects page.
    const rel = (home && own.path.startsWith(home) ? own.path.slice(home.length) : own.path).replace(/\/index\.html?$/, "");
    const segs = segmentsOf(rel);
    if (!segs.length || segs.some((s) => NOT_PROJECT_SEGMENT.test(s))) continue;
    if (LISTING_SEGMENT.test(segs.at(-1)) || makerPage(segs, l.text)) return own.key;
    if (!byText && PROJECTS_LINK_TEXT.test(String(l.text ?? ""))) byText = own.key;
  }
  return byText;
}

/**
 * Facts from a page's HTML and visible text (pure). `motion` comes from the
 * capture's frame difference; `project_links` is filled by checkLinks.
 */
export function measureFacts({ html = "", text = "", url, finalUrl, name = "", motion = null, source = "rendered", now = new Date(), scan = null }) {
  const base = finalUrl || url;
  // One pass over the HTML (./page-controls.mjs); measurePage passes its own in.
  const page = scan ?? scanPage(html, base);
  const links = page.links;
  const self = host(base);
  const internal = new Set();
  const sections = new Set();
  let github = false;
  let resume = false;
  let contactLink = false;
  for (const l of links) {
    let u;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    const label = `${l.raw} ${l.text}`;
    if (/^mailto:/i.test(l.raw)) contactLink = true;
    if (/linkedin\.com\/in\/|(^|\.)(twitter|x)\.com\/[A-Za-z0-9_]+/i.test(l.href)) contactLink = true;
    if (/\bcontact\b|get in touch|hire me|say hello/i.test(label)) contactLink = true;
    if (RESUME_WORDS.test(label) || RESUME_PATH.test(u.pathname)) resume = true;
    if (isGithubProfile(u.href)) github = true;
    if (h === self && (u.protocol === "http:" || u.protocol === "https:")) {
      if (l.raw.startsWith("#") && l.raw.length > 1) sections.add(l.raw.slice(1).toLowerCase());
      else if (u.hash && u.hash.length > 1 && (u.pathname === "/" || u.pathname === new URL(base).pathname)) sections.add(u.hash.slice(1).toLowerCase());
      else {
        const p = u.pathname.replace(/\/+$/, "").toLowerCase();
        if (p && !/\.(pdf|png|jpe?g|gif|svg|webp|xml|txt|ico|css|js)$/.test(p)) internal.add(p);
      }
    }
  }
  // Buttons and other non-link controls: a "View Resume" button, a GitHub icon button, a "Contact" button.
  const controls = page.controls;
  const byControl = controlFacts(controls, isGithubProfile);
  resume ||= byControl.resume;
  github ||= byControl.github;
  contactLink ||= byControl.contact;
  // A nav button that scrolls to a section ("Projects", "About") is an in-page
  // section, as a "#projects" link is: not when it sits in a link (the link
  // decides), and not twice when a "#about" link already names its section.
  const sectionKey = (w) => w.toLowerCase().replace(/[^a-z]+/g, " ").trim().replace(/\s+me$/, "").replace(/s$/, "");
  const hashKeys = new Set([...sections].map(sectionKey));
  for (const c of controls) {
    if (c.inLink != null) continue;
    const word = c.text.toLowerCase().match(NAV_SECTION)?.[1];
    if (!word) continue;
    const key = sectionKey(word);
    if (hashKeys.has(key)) continue;
    hashKeys.add(key);
    sections.add(`nav:${key}`);
  }
  const signals = portfolioSignals(html, name, page);
  const raw = String(html ?? "");
  const template = TEMPLATE_MARKERS.find(([re]) => re.test(raw))?.[1] ??
    (/brittany\s*chiang/i.test(raw) && !/brittany/i.test(name) ? "Brittany Chiang v4 clone" : null);
  const generator = page.generator;
  const builder =
    BUILDERS.find(([re, label]) => re.test(raw) || generator.toLowerCase().includes(label.toLowerCase()))?.[1] ?? null;
  const words = String(text ?? "").split(/\s+/).filter(Boolean).length;
  return {
    v: FACTS_VERSION,
    source,
    final_url: base,
    own_domain: Boolean(self) && !FREE_HOSTS.test(`.${self}`),
    resume,
    github,
    contact: contactLink || /<form\b/i.test(raw),
    footer_year: footerYear(text) ?? footerYear(stripTags(raw, { lines: true })),
    internal_pages: internal.size,
    sections: sections.size,
    template,
    builder,
    motion: typeof motion === "boolean" ? motion : null,
    signals: { score: signals.score, ...Object.fromEntries(["projects", "about", "contact", "resume", "github", "name"].map((k) => [k, signals[k]])) },
    words,
    project_links: null,
    measured_at: now.toISOString(),
    // A host's error or placeholder page served 200: mergeViews adds nothing from it.
    ...(isErrorPage({ html: raw, text }) ? { error_page: true } : {}),
  };
}

/**
 * Check links: HEAD, then GET when HEAD is refused. A link "loads" on 2xx/3xx;
 * 401/403/429/999 is a bot wall (blocked, not broken); 404, 410, 5xx, DNS
 * failures and timeouts are broken. `urls` are addresses or candidates
 * ({ url, kind }, projectCandidates).
 *
 * The site's own project pages (kind "own page") must be real pages. When
 * there are any, one address on the same host that cannot exist (a random
 * segment under the first own page's parent path) is asked for once, with a
 * plain GET: when it answers 404 or another error, own pages count by their
 * status like any link; when it answers 2xx (a host or an app shell that
 * answers every address), each own page is fetched (GET, its body capped at
 * OWN_PAGE_MAX_BYTES) and loads only when its visible text has at least
 * OWN_PAGE_MIN_WORDS distinct words, and at most OWN_PAGE_MAX_OVERLAP of them
 * are also on the nonsense page and on the home page (`homeText`); two own
 * pages with the same text count once. An own page that answered but failed
 * that is counted as checked, not loading, in `own_unverified`.
 *
 * Returns { checked, ok, broken, blocked, own_ok, own_unverified, own_check }:
 * `own_ok` how many of the loading ones are own pages, `own_check` "status",
 * "text" or null (no own pages).
 */
export async function checkLinks(urls, { fetchImpl = globalThis.fetch, timeoutMs = LINK_TIMEOUT_MS, concurrency = 4, userAgent, homeText = "", lowLinks = LOW_LINKS } = {}) {
  const res = { checked: 0, ok: 0, broken: 0, blocked: 0, own_ok: 0, own_unverified: 0, own_check: null };
  const headers = { Accept: "text/html,*/*;q=0.8", ...(userAgent ? { "User-Agent": userAgent } : {}) };
  /** A plain GET with its visible text (the body capped), or null when it failed. */
  async function getPage(url) {
    try {
      const r = await fetchImpl(url, { method: "GET", redirect: "follow", headers, signal: AbortSignal.timeout(timeoutMs) });
      const html = await readCapped(r, OWN_PAGE_MAX_BYTES);
      return { status: r.status, words: wordSet(visibleText(html)) };
    } catch {
      return null;
    }
  }
  async function one(url) {
    let h;
    try {
      h = new URL(url).hostname;
    } catch {
      return null;
    }
    if (isPrivateHost(h)) return null;
    const req = async (method) => {
      const r = await fetchImpl(url, { method, redirect: "follow", headers, signal: AbortSignal.timeout(timeoutMs) });
      try {
        await r.body?.cancel?.();
      } catch {
        /* body already consumed or not cancellable */
      }
      return r.status;
    };
    let status;
    try {
      status = await req("HEAD");
      if ([400, 403, 404, 405, 429, 501].includes(status)) status = await req("GET");
    } catch {
      return "broken";
    }
    if (status >= 200 && status < 400) return "ok";
    if ([401, 403, 429, 999].includes(status)) return "blocked";
    return "broken";
  }
  const all = urls.map((u) => (typeof u === "string" ? { url: u, kind: "outbound" } : u));
  // LOW_LINKS "never": the lowest tier is not requested at all, only named.
  const isLow = (c) => c.tier >= LOW_TIER;
  const skipped = lowLinks === "never" ? all.filter(isLow).length : 0;
  const queue = skipped ? all.filter((c) => !isLow(c)) : all;
  // Once per check: does the host answer an address that cannot exist?
  const firstOwn = queue.find((c) => c.kind === "own page");
  let byText = null;
  if (firstOwn) {
    const probe = await getPage(nonsenseUrl(firstOwn.url));
    byText = probe && probe.status >= 200 && probe.status < 300 ? { probe: probe.words, home: wordSet(homeText) } : null;
    res.own_check = byText ? "text" : "status";
  }
  const seenTexts = new Set();
  /** An own page on a host that answers every address: loads only with text of its own. */
  async function ownByText(url) {
    const got = await getPage(url);
    if (!got) return "broken";
    if (got.status >= 400) return [401, 403, 429, 999].includes(got.status) ? "blocked" : "broken";
    const key = [...got.words].sort().join(" ");
    const real = got.words.size >= OWN_PAGE_MIN_WORDS && overlap(got.words, byText.probe) <= OWN_PAGE_MAX_OVERLAP && overlap(got.words, byText.home) <= OWN_PAGE_MAX_OVERLAP && !seenTexts.has(key);
    seenTexts.add(key);
    return real ? "ok" : "own_unverified";
  }
  const done = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const c = queue.shift();
        let verdict;
        try {
          if (c.kind === "own page" && byText && !isPrivateHost(new URL(c.url).hostname)) verdict = await ownByText(c.url);
          else verdict = await one(c.url);
        } catch {
          verdict = null;
        }
        if (verdict) done.push({ c, verdict });
      }
    })
  );
  // The lowest tier (LOW_TIER: links outside any projects section, the projects page's asides) cannot make the
  // pass on its own: with LOW_LINKS "beside" it counts only when at least one link of a higher tier (in the
  // projects, on the projects page, a repository, an own project page) loads; with "never" it was not requested.
  // Either way what was left out is named (`not_counted`), so certificates, a tool list or documentation links
  // never pass a site with no projects.
  const low = done.filter(({ c }) => isLow(c));
  const highLoads = done.some(({ c, verdict }) => !isLow(c) && verdict === "ok");
  // "all": every link counts, as before tiers (the plain-fetch re-pick of facts of version 1 and 2).
  const counted = lowLinks !== "all" && low.length && !highLoads ? done.filter(({ c }) => !isLow(c)) : done;
  const notCounted = skipped + (counted !== done ? low.length : 0);
  if (notCounted) res.not_counted = notCounted;
  for (const { c, verdict } of counted) {
    res.checked++;
    res[verdict]++;
    if (verdict === "ok" && c.kind === "own page") res.own_ok++;
  }
  return res;
}

/** The most of an own page's body read to verify it by its text. */
export const OWN_PAGE_MAX_BYTES = 300_000;

/** An address on the same host as `url` that cannot exist: a random segment under the same parent path. */
export function nonsenseUrl(url) {
  const u = new URL(url);
  const parent = u.pathname.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
  const rand = globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? Math.random().toString(36).slice(2).padEnd(24, "x");
  u.pathname = `${parent}/no-such-page-${rand}`;
  u.search = "";
  u.hash = "";
  return u.href;
}

/** The distinct words (3 letters or more, lower case) of a text. */
function wordSet(text) {
  return new Set(String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
}
/** The share of `a`'s words that are also in `b` (0 when `a` is empty). */
function overlap(a, b) {
  if (!a.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / a.size;
}
/** The body of a response as text, at most `max` bytes. */
async function readCapped(r, max) {
  if (!r.body?.getReader) return String((await r.text?.()) ?? "").slice(0, max);
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel?.().catch(() => {});
  }
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

const SIGNAL_KEYS = ["projects", "about", "contact", "resume", "github", "name"];
const higher = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.max(a, b) : typeof a === "number" ? a : typeof b === "number" ? b : (a ?? b ?? null));

/**
 * The desktop view's facts with the phone view's merged in (pure): a yes/no
 * fact is yes when either view has it (a resume button shown only in the
 * phone menu, projects shown inline at 390 wide but in an inactive tab on
 * desktop), the footer year is the higher, the page and section counts the
 * higher, and the portfolio signals are each yes when either view has them.
 * Everything else (the address, own domain, the words, motion, the template)
 * is the desktop view's. No phone facts: the desktop facts as they are.
 */
export function mergeViews(desktop, phone) {
  // A phone reading that is an error or placeholder page (served 200) adds nothing.
  if (!phone || phone.error_page) return desktop;
  const signals = Object.fromEntries(SIGNAL_KEYS.map((k) => [k, Boolean(desktop.signals?.[k] || phone.signals?.[k])]));
  return {
    ...desktop,
    resume: desktop.resume === true || phone.resume === true,
    github: desktop.github === true || phone.github === true,
    contact: desktop.contact === true || phone.contact === true,
    footer_year: higher(desktop.footer_year, phone.footer_year),
    internal_pages: higher(desktop.internal_pages, phone.internal_pages),
    sections: higher(desktop.sections, phone.sections),
    template: desktop.template ?? phone.template ?? null,
    builder: desktop.builder ?? phone.builder ?? null,
    signals: { score: Object.values(signals).filter(Boolean).length, ...signals },
  };
}

const readable = (v) => Boolean(v && typeof v.html === "string" && v.html.trim());

// Error and placeholder pages a host serves with a 200 ("There isn't a GitHub Pages site here", Netlify's
// "Page not found", Vercel's "DEPLOYMENT_NOT_FOUND", Heroku's "no such app"), read as the desktop view's
// parking and blocked rules read a page that is not the site (./gate.mjs parkingPhrase, ./capture-blocked.mjs).
const HOST_ERROR =
  /there isn['’]t a github pages site here|site not found|page not found|404[:\s-]+(?:not found|page)|deployment[_\s]not[_\s]found|this deployment (?:cannot|could not) be found|no such app|this site can['’]t be reached|domain (?:is )?not (?:configured|connected)|project not found/i;

/**
 * Whether a reading ({ html, text }) is a host's error or placeholder page,
 * or a parked domain, though it answered 200: a short page (at most
 * BLOCK_PAGE_WORDS words) that says so, or a parking phrase.
 */
export function isErrorPage({ html = "", text = "" } = {}) {
  const t = String(text || stripTags(html)).replace(/\s+/g, " ").trim();
  if (parkingPhrase({ html, text: t })) return true;
  return t.split(" ").filter(Boolean).length <= BLOCK_PAGE_WORDS && HOST_ERROR.test(t);
}
const BLOCK_PAGE_WORDS = 150;

/**
 * The home page's links as the project-link candidates read them (pure): the
 * desktop reading's and the phone reading's (`input.phone`, unless it is an
 * error page), each with `from`. For projectsPageFor and measurePage.
 */
export function homeProjectLinks(input) {
  const base = input.finalUrl || input.url;
  const links = pageLinks(input.html, base).map((l) => ({ ...l, from: "home" }));
  if (readable(input.phone) && !isErrorPage(input.phone)) links.push(...pageLinks(input.phone.html, input.phone.finalUrl || base).map((l) => ({ ...l, from: "phone" })));
  return links;
}

/** How many of the candidates checked came from each place, and the projects page read, if any. */
function sourcesOf(candidates, projectsPage) {
  const count = (from) => candidates.filter((c) => c.from === from).length;
  return {
    home: count("home"),
    phone: count("phone"),
    projects_page: projectsPage ? { url: projectsPage, count: count("projects_page") } : null,
    own_pages: candidates.filter((c) => c.kind === "own page").length,
  };
}

/**
 * measureFacts plus the project-link check. `input.phone` ({ html, text,
 * finalUrl }), when given, is the same page read at 390 wide: it is measured
 * too and merged in (mergeViews), unless it is an error or placeholder page
 * (isErrorPage). The candidates (projectCandidates) come from both views and,
 * when the capture read it, the site's own projects page
 * (`input.projectsPage`: { html, finalUrl }), so one check covers them all.
 * `views` records what was read, `project_links_from` where the candidates
 * checked came from.
 */
export async function measurePage(input, { fetchImpl = globalThis.fetch, userAgent, timeoutMs, lowLinks = LOW_LINKS } = {}) {
  const { phone = null, projectsPage = null, homeText: storedText = null, ...desktopInput } = input;
  const scan = scanPage(desktopInput.html, desktopInput.finalUrl || desktopInput.url);
  let facts = measureFacts({ ...desktopInput, scan });
  const views = ["desktop"];
  if (readable(phone) && !isErrorPage(phone)) {
    const phoneBase = phone.finalUrl || facts.final_url;
    const phoneFacts = measureFacts({ ...desktopInput, html: phone.html, text: phone.text ?? "", finalUrl: phoneBase });
    facts = mergeViews(facts, phoneFacts);
    views.push("phone");
  }
  const links = homeProjectLinks({ ...desktopInput, finalUrl: facts.final_url, phone });
  let projectsPageUrl = null;
  if (readable(projectsPage) && projectsPage.finalUrl) {
    projectsPageUrl = projectsPage.finalUrl;
    links.push(...pageLinks(projectsPage.html, projectsPageUrl).map((l) => ({ ...l, from: "projects_page", page: projectsPageUrl })));
    views.push("projects page");
  }
  // A listed address on a code host (github.com/ana, gitlab.com/ana) is not a portfolio site: the host's own menu
  // (docs.github.com, github.blog) is no project, and its repositories are on the same host. None found.
  const candidates = isCodeHostAddress(desktopInput.url) || isCodeHostAddress(facts.final_url) ? [] : projectCandidates(links, facts.final_url);
  // With their kind, and the home page's text: the site's own pages must be real pages (checkLinks). The
  // capture passes the page text it stores (`input.homeText`, portfolios.page_text), so the nightly re-check,
  // which reads that stored text, compares own pages against exactly the same words.
  const homeText = storedText ?? (desktopInput.text || visibleText(desktopInput.html));
  facts.project_links = await checkLinks(candidates, { fetchImpl, userAgent, timeoutMs, homeText, lowLinks });
  // The links checked, with where each came from and their tier: the nightly re-check (pipeline/evidence.mjs)
  // tests these again, by the same rule for the lowest tier.
  facts.project_candidates = candidates.map(({ url, from, kind, tier }) => ({ url, from, kind, tier }));
  facts.project_links_from = sourcesOf(candidates, projectsPageUrl);
  facts.views = views;
  return facts;
}
