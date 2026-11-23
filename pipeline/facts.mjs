// "Code checks facts": everything about a portfolio that code can check for
// free, measured from the page's HTML and stored in portfolios.facts so the
// AI grade (pipeline/rubric.mjs) gets it as context instead of guessing it
// from a screenshot. capture.mjs measures the rendered page; judge.mjs
// measures over plain HTTP for rows captured before facts existed.
//
// measureFacts is pure; checkLinks makes HTTP requests (HEAD, then GET when
// HEAD is refused), capped in number and time, never to private addresses.
import { GH_RESERVED, RESUME_PATH, RESUME_WORDS, controlFacts, isGithubProfile, removeElements, scanPage, stripTags } from "./page-controls.mjs";
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
// 4 (2026-11-23): the misses of the production trial of version 3 on 25 sites. An own page on a host that
// answers every address is judged by its text of its own (OWN_PAGE_MIN_WORDS); on the projects page a link to
// the site's own page counts at any path that is not a section of the site (isProjectsPageLink); one outside
// host takes at most PER_HOST_MAX of the places before the others; a hash route ("#/projects") can be the
// projects page; the capture waits for the projects page's content to settle (./capture-projects.mjs). The
// project-link rule, its words and its points are version 3's (PROJECT_RULE_VERSION): version 3 and 4 facts are
// read alike, and the re-measure of the whole list measures the version 3 rows again.
export const FACTS_VERSION = 4;
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
 * shell) are verified by their text instead of their status (checkLinks): the lines of text a page does not
 * share with the nonsense page or the home page (its menu, header, footer and sidebar are on those too) must
 * hold at least this many distinct words. Judged by the text of its own, not by a share of the whole page, so
 * a short write-up under a menu of several hundred words counts (bhavaniravi.com's project pages: 30 to 49 of
 * their own), while a catch-all host's identical pages (none of their own) and a thin page (a title, a line)
 * do not.
 */
export const OWN_PAGE_MIN_WORDS = 20;
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
// A certificate's verification or badge page on any host, by its path: Oracle's
// catalog-education.oracle.com/ords/certview/sharebadge (houssambouzid.dev's certificates, in a panel the
// projects heading runs into), "/verify-certificate", "/certificate-verification".
const CERTIFICATE_ANY_PATH = /(?:^|\/)(?:certview|sharebadge|verify-?certificates?|certificates?-verification)(?:\/|$)/i;
const isCertificate = (h, path) => CERTIFICATE_HOSTS.test(h) || Boolean(CERTIFICATE_PATH[h]?.test(path)) || CERTIFICATE_ANY_PATH.test(path);
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
// labelled "CI", and never a listing above a project's own page ("/builds/1234"). "/toys" labelled "Toys"
// (expensive.toys: its UI toys, each a page of its own under /toys).
const MAKER_PAGE = /^(?:made|builds|lab|creations|toys)$/i;
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

// Pages of a personal site that are not one project, beside SECTION_SEGMENT's: what the person uses, is doing now,
// writes, says, reads, earned and is reached by, in English and other languages, and the site's own legal and
// taxonomy pages. Only for links on the projects page that are not under a listing (isProjectsPageLink): "/uses",
// "/now", "/talks", "/til", "/slash" (an index of such pages, amanhimself.dev's), "/topics/react", "/kontakt".
const SITE_SECTION_SEGMENT = new RegExp(
  String.raw`^(?:` +
    [
      // What the person uses, writes, says and reads.
      String.raw`uses|now|slash(?:es)?|writing|writings|essays|notes|til|snippets|thoughts|journal|talks|speaking|podcasts?|videos|newsletters?|links|bookmarks|books|reading|library|photos|photography|gallery|archives?|changelog|colophon|guestbook|stack|tech-?stack|tools|toolbox|gear|setup|resources`,
      // Their story, what they earned, who they are.
      String.raw`experience|education|skills|testimonials|recommendations|achievements?|accomplishments|certifications?|certificates?|credentials|awards?|honou?rs|publications?|papers|research|journey|timeline|story|my-story|history|authors?|team|people|bio|me|who-?am-?i|hire(?:-me)?|work-with-me|availability|sponsors?|donate|support|community|events|home|index|welcome|start`,
      // Reaching them, in English and other languages.
      String.raw`get-?in-?touch|lets-?talk|let-?s-?talk|say-?hi|say-?hello|hello|reach-?out|connect|book(?:-a)?-call|schedule|appointments?|contacto|contato|contatti|kontakt|kontakty|contactez-?moi|contacte|sobre(?:-mi|-mim)?|acerca(?:-de(?:-mi)?)?|a-?propos|qui-suis-je|uber-?mich|ueber-?mich|über-?mich|chi-sono|over-?mij|o-?mnie|inicio|accueil|startseite`,
      // The site's legal pages, its feeds and its ways of sorting posts.
      String.raw`privacy(?:-policy)?|cookie-?policy|terms(?:-of-(?:service|use))?|imprint|impressum|datenschutz|mentions-legales|aviso-legal|legal-notice|disclaimer|accessibility|credits|acknowledg(?:e)?ments|topics?|series|labels?|collections?|feeds?|atom|sitemap`,
    ].join("|") +
    String.raw`)$`,
  "i"
);
// A link's whole label that names a section of the site, a way to reach the person or a step through a list:
// "Home", "Achievements", "Get in touch", "Let's talk →", "Sobre mí", "Next project", "Older posts". Such a link on
// the projects page is never a project, whatever its address ("/start" labelled "Home").
const SECTION_LABEL = new RegExp(
  String.raw`^(?:` +
    [
      String.raw`home|homepage|start|main page|about(?: me| us)?|contact(?: me| us)?|get in touch|let'?s talk|let’s talk|say hi|say hello|hire me|work with me|book a call|schedule a call|reach out|blog|posts|articles|writing|notes|newsletter|resume|cv|my cv|my resume|uses|now|talks|speaking|achievements|accomplishments|certifications|certificates|awards|honou?rs|publications|papers|research|experience|education|skills|stack|tech stack|tools|resources|journey|timeline|my story|testimonials|recommendations|team|authors?`,
      String.raw`privacy(?: policy)?|cookie policy|cookies|terms(?: of (?:service|use))?|imprint|impressum|datenschutz|legal|legal notice|mentions légales|aviso legal|accessibility|credits|sitemap|rss|feed|topics|series|tags|categories`,
      String.raw`inicio|accueil|startseite|sobre(?: mí| mi| mim)?|acerca de(?: mí)?|à propos|a propos|qui suis-je|über mich|uber mich|chi sono|over mij|o mnie|contacto|contato|contatti|kontakt|contactez-moi|me contacter|escríbeme|escribeme`,
      String.raw`(?:next|previous|prev|older|newer|more)(?: (?:project|projects|post|posts|page|work|case study))?|(?:see|view|show) (?:all|more)(?: projects| work)?|all projects|back(?: to (?:top|home|projects|work))?|load more|page \d+|\d+`,
    ].join("|") +
    String.raw`)$`,
  "iu"
);
/** A link's label as SECTION_LABEL reads it: arrows, bullets and dashes are spaces. */
const labelOf = (l) => String(l.text ?? "").replace(/[→←↗↘›»«‹·•|#–—:-]+/gu, " ").replace(/\s+/g, " ").trim();
// ISO 639-1 language codes, for a language switch at the start of the path ("/en", "/pt-BR", "/zh-Hans").
const LANGUAGE_CODES = new Set(
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(" ")
);
/**
 * A language switch: an ISO 639-1 code, alone or with a 2-letter region or a script ("pt-br", "zh-hant", "sr-latn").
 * The scripts are the ISO 15924 codes sites use, so "/ar-demo" (an AR demo) is no language.
 */
const isLanguage = (s) => {
  const m = /^([a-z]{2})(?:[-_](?:[a-z]{2}|hans|hant|latn|cyrl|arab|deva|beng|grek|hebr|jpan|kore|taml|thai|telu|guru|gujr|knda|mlym|orya|sinh|ethi|geor|armn|mong|tibt))?$/i.exec(s);
  return Boolean(m && LANGUAGE_CODES.has(m[1].toLowerCase()));
};
/** A year, as a dated archive of posts uses one ("/2024/05/launch"). */
const YEAR_SEGMENT = /^(?:19|20)\d{2}$/;

/**
 * Whether a same-site link on the site's own projects page, in its main content, is a page for one project
 * whatever its path ("/rht", "/apps/lasttimei"): it is not another listing ("/work"), its first segment is not a
 * language ("/en", "/pt-br": "/ai-chat" and "/go-cli" are projects), and no segment is a section of the site
 * (about, contact, blog, resume, tags, NOT_PROJECT_SEGMENT, SITE_SECTION_SEGMENT), an action, a year or a page
 * number. The home page, the projects page itself, its menus (menuLinks) and links labelled as a section
 * (SECTION_LABEL) are left out by the caller. On the projects page only: on the home page a same-site link is a
 * section of the site far more often than a project.
 */
function isProjectsPageLink(path) {
  const segs = segmentsOf(path).map(pageName);
  if (!segs.length || LISTING_SEGMENT.test(segs.at(-1)) || MAKER_PAGE.test(segs.at(-1)) || isLanguage(segs[0]) || /^\d+$/.test(segs.at(-1))) return false;
  return !segs.some((s) => NOT_PROJECT_SEGMENT.test(s) || SITE_SECTION_SEGMENT.test(s) || YEAR_SEGMENT.test(s));
}

/** How deep a menu may sit below the container its links share: "<div><a>", "<ul><li><a>", "<ul><li><span><a>". */
const MENU_DEPTH = 3;
/**
 * The projects page's links that sit in a menu, whatever it is built from (a "<div class="navbar">" is no <nav>):
 * a link to the home page or to the projects page itself (not an in-page anchor) marks the smallest element around
 * it that holds at least 3 links, and the links at the same depth in that element are a menu when most of their
 * labels are 1 to 3 words (MENU_LABEL_WORDS). A grid of project cards links neither the home page nor the
 * projects page, so it is never one (amanhimself.dev's apps); a lone "Back home" link above the cards sits at
 * another depth than they do, and a breadcrumb's "Home" beside cards whose links carry a title and a description
 * (bhavaniravi.com's) does not make the cards a menu. `links` are the projects page's,
 * with `anc` (./page-controls.mjs scanPage). Returns a Set of them.
 */
function menuLinks(links, homeUrl, pageUrl) {
  const strip = (p) => p.replace(/\/index\.html?$/i, "").replace(/\/+$/, "").toLowerCase();
  const self = host(homeUrl);
  const targets = new Set([strip(pathOfUrl(homeUrl)), strip(pathOfUrl(pageUrl))]);
  const isFrameTarget = (l) => {
    // Not an in-page anchor, nor a project card's link to the site itself labelled with its address
    // ("younes-megaache.com" as one card among the projects on younes-megaache.com/projects).
    if (String(l.raw ?? "").startsWith("#") || isAddressLabel(l)) return false;
    try {
      const u = new URL(l.href);
      return sameHost(u.hostname.toLowerCase(), self) && targets.has(strip(u.pathname));
    } catch {
      return false;
    }
  };
  const count = new Map();
  for (const l of links) for (const id of l.anc ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  const menus = [];
  for (const l of links) {
    if (!isFrameTarget(l) || !l.anc?.length) continue;
    for (let k = l.anc.length - 1; k >= 0; k--) {
      if ((count.get(l.anc[k]) ?? 0) < 3) continue;
      const depth = l.anc.length - 1 - k;
      if (depth <= MENU_DEPTH) menus.push({ id: l.anc[k], depth });
      break;
    }
  }
  const out = new Set();
  for (const m of menus) {
    const group = links.filter((l) => {
      const k = l.anc?.indexOf(m.id) ?? -1;
      return k >= 0 && l.anc.length - 1 - k === m.depth;
    });
    // A menu's labels are a word or three ("Home", "Achievements", "Get in touch"); a breadcrumb's "Home" beside
    // project cards whose links hold a title and a description (bhavaniravi.com's) makes no menu of the cards.
    // A label that is an address ("github.com", "nan-mo-hoam.com") is a project card's, never a menu's.
    const short = group.filter((l) => !isAddressLabel(l) && labelOf(l).split(" ").filter(Boolean).length <= MENU_LABEL_WORDS).length;
    if (short >= group.length * 0.7) for (const l of group) out.add(l);
  }
  return out;
}
/** The most words in a menu link's label (menuLinks). */
const MENU_LABEL_WORDS = 3;
/** A label that is a web address: "github.com", "younes-megaache.com", "app.example.dev/demo". */
const ADDRESS_LABEL = /^(?:https?:\/\/)?(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\/\S*)?$/iu;
const isAddressLabel = (l) => ADDRESS_LABEL.test(String(l.text ?? "").replace(/\s+/g, " ").trim());

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
  // The projects page's menus, whatever they are built from (menuLinks): their links are its frame.
  const pageLinksOnly = links.filter((l) => l.from === "projects_page");
  const menu = pageLinksOnly.length ? menuLinks(pageLinksOnly, siteUrl, pageLinksOnly[0].page) : new Set();
  for (const l of links) {
    const from = l.from ?? "home";
    const onProjectsPage = from === "projects_page";
    if (onProjectsPage && menu.has(l)) continue;
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
      const relBase = homePath && base.startsWith(homePath) ? base.slice(homePath.length) : base;
      // Under a listing or the projects page's own path; or, in its main content (not an aside), a page of the site
      // at any path that is not one of its section pages (amanhimself.dev's apps at "/rht", "/lasttimei").
      // Not in an aside, a section that is not projects or a list of profiles, and not labelled as a section of the site.
      ok = own.path !== base && (isOwnProjectPath(rel, relBase) || (!l.inAside && !l.inOther && !SECTION_LABEL.test(labelOf(l)) && isProjectsPageLink(rel)));
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
  // At most PER_HOST_MAX links of one outside host first, so one site does not take every place (bekahhw.com's
  // "My Work" page: 8 articles on one shut-down company site before its live projects); the places left are filled
  // in order. The higher tiers are picked first, so a link outside the projects never takes a project's place.
  // One repository is one project: only its first link counts (garebear99.github.io linked three releases of one
  // plugin's repository, which alone made a pass), the highest tier first. The same outside page twice, its
  // fragment aside, is one link already (projectUrl drops the fragment).
  const repos = new Set();
  const oneEach = (c) => {
    const k = c.kind === "outbound" ? hostKey(c.url) : "";
    if (!k.includes("/")) return true;
    if (repos.has(k)) return false;
    repos.add(k);
    return true;
  };
  const high = [...tiers[0].map((c) => ({ ...c, tier: 1 })), ...tiers[1].map((c) => ({ ...c, tier: 2 }))].filter(oneEach);
  const low = tiers[2].map((c) => ({ ...c, tier: LOW_TIER })).filter(oneEach);
  const picked = spreadByHost(high, max);
  return [...picked, ...spreadByHost(low, max - picked.length)];
}

/** The most links of one outside host taken before other hosts get a place (a repository counts once, oneEach). */
export const PER_HOST_MAX = 3;
const CODE_HOST = /^(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i;
/**
 * What PER_HOST_MAX counts per: the host without "www.", or on a code host the repository's owner and name
 * ("github.com/ana/app"), since each repository is a project of its own.
 */
export function hostKey(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!CODE_HOST.test(h)) return h;
    const [owner = "", repo = ""] = u.pathname.split("/").filter(Boolean);
    return `${h}/${owner.toLowerCase()}/${repo.toLowerCase().replace(/\.git$/, "")}`;
  } catch {
    return "";
  }
}
/**
 * At most `max` of `list`, in its order: first every candidate whose outside host (hostKey) has had fewer than
 * PER_HOST_MAX places (the site's own pages are not counted per host), then the ones skipped, in order, for the
 * places left.
 */
function spreadByHost(list, max) {
  if (!(max > 0)) return [];
  const perHost = new Map();
  const take = new Set();
  for (const c of list) {
    if (take.size >= max) break;
    if (c.kind === "own page") {
      take.add(c);
      continue;
    }
    const k = hostKey(c.url);
    const had = perHost.get(k) ?? 0;
    if (had >= PER_HOST_MAX) continue;
    perHost.set(k, had + 1);
    take.add(c);
  }
  for (const c of list) {
    if (take.size >= max) break;
    take.add(c);
  }
  return list.filter((c) => take.has(c));
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
 * A same-site link whose address is the home page's but for a hash route ("#/projects", "#!/work/"), as
 * { key: the address with its route, segs: the route's segments }, or null. An in-page anchor ("#projects") is not
 * a route, nor is a route with a query ("#/projects?tab=x"). Loading it is a plain GET of the home page itself (the
 * part after "#" is never sent); the app's own router then shows the route.
 */
export function hashRoute(l, homeUrl) {
  let u;
  let h;
  try {
    u = new URL(l.href);
    h = new URL(homeUrl);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !sameHost(u.hostname.toLowerCase(), h.hostname.toLowerCase())) return null;
  const strip = (p) => p.replace(/\/index\.html?$/i, "").replace(/\/+$/, "").toLowerCase();
  if (strip(u.pathname) !== strip(h.pathname) || u.search) return null;
  const m = /^#!?\/([^?]*)$/.exec(u.hash);
  if (!m) return null;
  const segs = segmentsOf(m[1]).map(pageName);
  if (!segs.length || segs.some((s) => ACTION_SEGMENT.test(s))) return null;
  return { key: u.href, segs };
}

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
    // A route of an app on the home page's own address: "#/projects", "#!/work" (chiragsamal.github.io).
    const route = hashRoute(l, homeUrl);
    if (route) {
      if (route.segs.some((s) => NOT_PROJECT_SEGMENT.test(s))) continue;
      if (LISTING_SEGMENT.test(route.segs.at(-1)) || makerPage(route.segs, l.text)) return route.key;
      if (!byText && PROJECTS_LINK_TEXT.test(String(l.text ?? ""))) byText = route.key;
      continue;
    }
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
 * OWN_PAGE_MAX_BYTES) and loads only when the lines of its visible text that
 * are on neither the nonsense page nor the home page (`homeText`) hold at
 * least OWN_PAGE_MIN_WORDS distinct words (ownText); two own pages with the
 * same text of their own count once. An own page that answered but failed
 * that is counted as checked, not loading, in `own_unverified`. When the
 * nonsense page answers 2xx but says it is not found (its title or first h1,
 * saysNotFound: a "soft 404", as an app that draws its pages in the browser
 * serves), the host tells its pages apart itself: an own page loads when it
 * answers 2xx and does not say so, and is broken when it does.
 *
 * Returns { checked, ok, broken, blocked, own_ok, own_unverified, own_check }:
 * `own_ok` how many of the loading ones are own pages, `own_check` "status",
 * "text", "not_found_page" or null (no own pages).
 */
export async function checkLinks(urls, { fetchImpl = globalThis.fetch, timeoutMs = LINK_TIMEOUT_MS, concurrency = 4, userAgent, homeText = "", lowLinks = LOW_LINKS, homeUrl = null } = {}) {
  const res = { checked: 0, ok: 0, broken: 0, blocked: 0, own_ok: 0, own_unverified: 0, own_check: null };
  const headers = { Accept: "text/html,*/*;q=0.8", ...(userAgent ? { "User-Agent": userAgent } : {}) };
  /** A plain GET with the lines of its visible text (the body capped), or null when it failed. */
  async function getPage(url) {
    try {
      const r = await fetchImpl(url, { method: "GET", redirect: "follow", headers, signal: AbortSignal.timeout(timeoutMs) });
      const html = await readCapped(r, OWN_PAGE_MAX_BYTES);
      return { status: r.status, lines: textLines(html), notFound: saysNotFound(html) };
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
  let notFoundPage = false;
  if (firstOwn) {
    const probe = await getPage(nonsenseUrl(firstOwn.url));
    // A host that answers 200 but says the made-up address is not found (nevo.is-a.dev: "NEVO | Project Not Found",
    // its pages drawn in the browser) tells its pages apart itself: own pages count when they answer and do not say so.
    // Only when the home page does not say so too: a site titled "404 Studio - Ana" says it on every page.
    if (probe && probe.status >= 200 && probe.status < 300 && probe.notFound) {
      const home = await getPage(homeUrl ?? new URL("/", firstOwn.url).href);
      notFoundPage = Boolean(home && home.status < 400 && !home.notFound);
    }
    // The lines every page of the site shares (its menu, header, footer): the nonsense page's and the home page's.
    if (!notFoundPage) byText = probe && probe.status >= 200 && probe.status < 300 ? { frame: new Set([...probe.lines, ...textLines(homeText, { html: false })]) } : null;
    res.own_check = notFoundPage ? "not_found_page" : byText ? "text" : "status";
  }
  const seenTexts = new Set();
  /** An own page on a host that answers every address: loads only with text of its own. */
  async function ownByText(url) {
    const got = await getPage(url);
    if (!got) return "broken";
    if (got.status >= 400) return [401, 403, 429, 999].includes(got.status) ? "blocked" : "broken";
    const mine = ownText(got.lines, byText.frame);
    const real = mine.words >= OWN_PAGE_MIN_WORDS && !seenTexts.has(mine.key);
    seenTexts.add(mine.key);
    return real ? "ok" : "own_unverified";
  }
  /** An own page on a host whose made-up address says "not found": loads when it answers and does not say so. */
  async function ownByNotFound(url) {
    const got = await getPage(url);
    if (!got) return "broken";
    if (got.status >= 400) return [401, 403, 429, 999].includes(got.status) ? "blocked" : "broken";
    return got.notFound ? "broken" : "ok";
  }
  const done = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const c = queue.shift();
        let verdict;
        try {
          if (c.kind === "own page" && notFoundPage && !isPrivateHost(new URL(c.url).hostname)) verdict = await ownByNotFound(c.url);
          else if (c.kind === "own page" && byText && !isPrivateHost(new URL(c.url).hostname)) verdict = await ownByText(c.url);
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

/**
 * The lines of a page's visible text, lower case, spaces collapsed, empty ones left out: of its HTML (block
 * elements and <br> end a line; scripts, styles and noscript removed), or with `html: false` of a text that
 * already has its lines (the stored page text).
 */
export function textLines(src, { html = true } = {}) {
  const text = html ? stripTags(removeElements(removeElements(removeElements(src, "script"), "style"), "noscript"), { lines: true }) : String(src ?? "");
  return text
    .replace(/&[a-z#0-9]+;/gi, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}
// A short line (its title, a heading) that says the page was not found: "NEVO | Project Not Found", "404",
// "This page does not exist", "Page introuvable".
const NOT_FOUND_LINE =
  /(?<![\p{L}\p{N}])(?:404|not found|no such page|does(?:n['’]t| not) exist|(?:could(?:n['’]t| not)|can['’]?t|cannot) (?:be )?find|introuvable|no encontrad[ao]|nicht gefunden|non trovat[ao]|não encontrad[ao])(?![\p{L}\p{N}])/iu;
/**
 * Whether a page's HTML says it was not found: its title or its first h1, at most 10 words, says so. Only those,
 * so a menu or a post titled "Fixing 404 errors" further down never makes a page "not found".
 */
export function saysNotFound(html) {
  const s = String(html ?? "");
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? "";
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(s)?.[1] ?? "";
  return [title, h1].some((t) => {
    const line = stripTags(t).replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    return line !== "" && line.split(" ").length <= 10 && NOT_FOUND_LINE.test(line);
  });
}

/**
 * An own page's text of its own: its lines that are not in `frame` (the lines of the nonsense page and the
 * home page), as `words` (how many distinct words of 3 letters or more they hold) and `key` (the same text
 * for two pages that are copies of each other). Scripts written without spaces between words (Chinese,
 * Japanese, Thai, Lao, Khmer, Myanmar, Tibetan) have no words to split: there every NO_SPACE_LETTERS_PER_WORD
 * of their letters count as one word, so a write-up of 60 such letters has 20 and a page title alone does not.
 */
export function ownText(lines, frame) {
  const mine = [...new Set(lines.filter((l) => !frame.has(l)))];
  const all = mine.join(" ");
  const noSpace = all.match(NO_SPACE_LETTER) ?? [];
  const words = new Set(all.replace(NO_SPACE_LETTER, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  return { words: words.size + Math.floor(noSpace.length / NO_SPACE_LETTERS_PER_WORD), key: [...mine].sort().join("\n") };
}
const NO_SPACE_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/gu;
export const NO_SPACE_LETTERS_PER_WORD = 3;
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
  facts.project_links = await checkLinks(candidates, { fetchImpl, userAgent, timeoutMs, homeText, lowLinks, homeUrl: facts.final_url });
  // The links checked, with where each came from and their tier: the nightly re-check (pipeline/evidence.mjs)
  // tests these again, by the same rule for the lowest tier.
  facts.project_candidates = candidates.map(({ url, from, kind, tier }) => ({ url, from, kind, tier }));
  facts.project_links_from = sourcesOf(candidates, projectsPageUrl);
  facts.views = views;
  return facts;
}
