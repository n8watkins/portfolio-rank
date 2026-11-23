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

/**
 * How much of "project links load" a check earns, 0 to 1: a third for each
 * link that loads, full at MIN_PROJECT_LINKS (a dead link among them costs
 * nothing once three load); 0 when none were found. Null when it was never
 * checked, or when every link found was behind a bot check (it could not be
 * told). The rubric's pass (pipeline/rubric.mjs codeChecks) is a share of 1,
 * and the automated checks score (lib/check-points.mjs) is this share of its
 * points, so the two always agree.
 */
export function projectLinksShare(links) {
  if (!links || typeof links !== "object" || typeof links.checked !== "number") return null;
  const ok = Number(links.ok) || 0;
  if (links.checked > 0 && ok === 0 && (Number(links.blocked) || 0) >= links.checked) return null;
  return Math.min(1, ok / MIN_PROJECT_LINKS);
}

/**
 * The project-link check in words, wherever it is shown: "5 of 8 project
 * links load", "Project links: none found" when there were none to check, or
 * null when they were never checked.
 */
export function projectLinksText(links) {
  if (!links || typeof links !== "object" || typeof links.checked !== "number") return null;
  if (links.checked <= 0) return "Project links: none found";
  return `${Number(links.ok) || 0} of ${links.checked} project links load`;
}

// Free hosting subdomains: a site served from one is not on its own domain.
export const FREE_HOSTS =
  /\.(vercel\.app|netlify\.app|github\.io|gitlab\.io|framer\.website|framer\.app|framer\.ai|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|surge\.sh|onrender\.com|herokuapp\.com|glitch\.me|replit\.app|repl\.co|wixsite\.com|squarespace\.com|webflow\.io|carrd\.co|notion\.site|super\.site|wordpress\.com|blogspot\.com|neocities\.org|fly\.dev|railway\.app|azurewebsites\.net|amplifyapp\.com|translate\.goog)$/i;

// Profiles on sites for freelancing, link lists, competitive coding, data
// science, art, film, books and anime (the grading preview's retest,
// 2026-11-22: stimmie.dev's "find me" list, hellosagar's Upwork and Fiverr):
// a profile is never a project, so it never fills a project-link slot.
const PROFILE_HOSTS =
  /(^|\.)(upwork\.com|fiverr\.com|freelancer\.com|toptal\.com|linktr\.ee|bio\.link|beacons\.ai|kaggle\.com|codeforces\.com|codechef\.com|hackerearth\.com|geeksforgeeks\.org|kattis\.com|topcoder\.com|imdb\.com|goodreads\.com|letterboxd\.com|myanimelist\.net|anilist\.co|deviantart\.com|artstation\.com|youpic\.com|500px\.com|flickr\.com|unsplash\.com|pinterest\.com|reddit\.com|twitch\.tv|spotify\.com|soundcloud\.com|substack\.com|producthunt\.com|wellfound\.com|angel\.co|glassdoor\.com|indeed\.com)$/i;
/** A CodePen profile (codepen.io/name), not one of its pens (codepen.io/name/pen/id). */
const isCodepenProfile = (u) => /(^|\.)codepen\.io$/i.test(u.hostname) && u.pathname.split("/").filter(Boolean).length <= 1;

// Hosts that are profiles or services, not project demos.
const NOT_PROJECT =
  /(^|\.)(linkedin\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|threads\.com|bsky\.app|mastodon\.social|dribbble\.com|behance\.net|medium\.com|dev\.to|hashnode\.com|stackoverflow\.com|leetcode\.com|hackerrank\.com|discord\.gg|discord\.com|t\.me|wa\.me|calendly\.com|cal\.com|buymeacoffee\.com|ko-fi\.com|patreon\.com|google\.com|googleapis\.com|gstatic\.com|fonts\.googleapis\.com|w3\.org|schema\.org|creativecommons\.org|vercel\.com|netlify\.com|nextjs\.org|reactjs\.org|react\.dev|gatsbyjs\.com|astro\.build|tailwindcss\.com|fontawesome\.com|unsplash\.com|icons8\.com|flaticon\.com|credly\.com|coursera\.org|udemy\.com)$/i;


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
const YEAR_THEN_MARK = new RegExp(String.raw`(?<!\d)${YEAR}(?:${RANGE_DASH}${YEAR})?\s*${COPYRIGHT_MARK}`, "gi");

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
  const fromControls = page.controls.flatMap((c) => c.navUrls.map((href) => ({ raw: href, href, text: c.label, inProjects: c.inProjects, inChrome: c.inChrome, inSocial: c.inSocial })));
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
    repo = true;
  } else if (NOT_PROJECT.test(h) || PROFILE_HOSTS.test(h) || isCodepenProfile(u) || /\.(pdf|png|jpe?g|gif|svg|webp|zip)$/i.test(u.pathname)) {
    return null;
  }
  u.hash = "";
  return { key: u.href, repo };
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

// A same-site page that lists the projects ("/projects", "Work", "Portfolio", "Case studies", "/solutions/"),
// read from a link's words or its path. Not work experience or a work history.
const PROJECTS_PAGE = /\b(?:projects?|works?(?!\s*(?:experience|history|place|timeline))|my work|portfolios?|case\s*stud(?:y|ies)|solutions?|showcase)\b/i;
/** "/case-studies/my_app" as words, so PROJECTS_PAGE can read a path. */
const pathWords = (p) => decodeURIComponent(String(p ?? "")).replace(/[-_/.]+/g, " ");
const sameHost = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

/**
 * A link to a page of the site itself, as the URL that is checked: http(s),
 * not the home page, not a file, without its fragment. Null otherwise.
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
  if (!p || /\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|txt|ico|css|js)$/i.test(p)) return null;
  u.hash = "";
  return { key: u.href, path: p.toLowerCase() };
}

/**
 * The project-link candidates with where each came from, at most `max`, in
 * this order:
 *   1. outbound demo and repository links in the projects: links inside a
 *      projects element or section (`inProjects`), GitHub repositories outside
 *      the nav, header and footer, the destinations a project button opens
 *      (`from: "button"`), and every outbound link in the main content of the
 *      site's projects page (`from: "projects_page"`);
 *   2. the site's own pages for single projects: a same-site link in a home
 *      page projects section, or on the projects page a same-site link outside
 *      its nav, header and footer whose path says project, work, portfolio,
 *      case study or solution, or sits under the projects page's own path
 *      ("/projects/foo" from "/projects");
 *   3. every other outbound link, in page order.
 * A profile, a link in a "find me" list, the site's home page and the
 * projects page itself are never candidates. `links` carry `from` ("home",
 * "phone", "projects_page" or "button"; "home" when missing) and, for the
 * projects page, its address in `page`. Returns [{ url, from, kind }], kind
 * "outbound" or "own page".
 */
export function projectCandidates(links, siteUrl, max = LINK_CHECK_MAX) {
  const self = host(siteUrl);
  const seen = new Set();
  const tiers = [[], [], []];
  for (const l of links) {
    const from = l.from ?? "home";
    const onProjectsPage = from === "projects_page";
    const p = projectUrl(l, self);
    if (p) {
      // A list of where else to find the person ("Find me", "Let's connect") holds profiles, not projects.
      if (seen.has(p.key) || (l.inSocial && !p.repo)) continue;
      seen.add(p.key);
      const inProjects = l.inProjects || from === "button" || (p.repo && !l.inChrome) || (onProjectsPage && !l.inChrome);
      tiers[inProjects ? 0 : 2].push({ url: p.key, from, kind: "outbound" });
      continue;
    }
    const own = ownPageUrl(l, self);
    if (!own || seen.has(own.key) || l.inChrome || l.inSocial) continue;
    let ok = false;
    if (onProjectsPage) {
      const base = (() => {
        try {
          return new URL(l.page).pathname.replace(/\/+$/, "").toLowerCase();
        } catch {
          return "";
        }
      })();
      ok = own.path !== base && (PROJECTS_PAGE.test(pathWords(own.path)) || (base !== "" && own.path.startsWith(`${base}/`)));
    } else {
      // In a home page projects section; not its "All projects" link to the listing page itself.
      ok = Boolean(l.inProjects) && !LISTING_PATH.test(own.path);
    }
    if (!ok) continue;
    seen.add(own.key);
    tiers[1].push({ url: own.key, from, kind: "own page" });
  }
  return [...tiers[0].map((c) => ({ ...c, tier: 1 })), ...tiers[1].map((c) => ({ ...c, tier: 2 })), ...tiers[2].map((c) => ({ ...c, tier: 3 }))].slice(0, max);
}

/** A link whose whole label names the projects page: "Projects", "My work", "Explore Work →", "Case studies". Not "How I work". */
const PROJECTS_LINK_TEXT = /^\s*(?:(?:my|all|our|selected|featured|recent|view all|see all|explore|view)\s+)?(?:projects?|works?|portfolio|case stud(?:y|ies)|solutions|showcase)\s*[→›»↗]?\s*$/i;

/** A page that lists projects rather than shows one: "/projects", "/work", "/portfolio", "/case-studies". */
const LISTING_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:projects?|works?|my-work|portfolios?|case-stud(?:y|ies)|solutions?|showcase)$/i;

/**
 * The site's own projects page to read when the home page shows fewer than
 * MIN_PROJECT_LINKS projects (pure): the first same-site link, nav links
 * included, whose path or text says projects, work, portfolio, case studies,
 * solutions or showcase, on the same host, not the home page and not a link
 * to a section of the page itself. `links` are the home page's (desktop and
 * phone, `from` set); `homeUrl` the page's final address. Returns the address
 * or null.
 */
export function projectsPageFor(links, homeUrl) {
  const self = host(homeUrl);
  const home = (() => {
    try {
      return new URL(homeUrl).pathname.replace(/\/+$/, "").toLowerCase();
    } catch {
      return "";
    }
  })();
  // The projects the home page shows itself: its candidates of the first two kinds.
  const shown = projectCandidates(links, homeUrl, Infinity).filter((c) => c.tier <= 2).length;
  if (shown >= MIN_PROJECT_LINKS) return null;
  // A listing path ("/projects") first, then any path that says projects ("/topic/portfolios/"), then a link's words.
  let byPath = null;
  let byText = null;
  for (const l of links) {
    const own = ownPageUrl(l, self);
    if (!own || own.path === home) continue;
    if (LISTING_PATH.test(own.path)) return own.key;
    if (!byPath && PROJECTS_PAGE.test(pathWords(own.path))) byPath = own.key;
    if (!byText && PROJECTS_LINK_TEXT.test(String(l.text ?? ""))) byText = own.key;
  }
  return byPath ?? byText;
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
    footer_year: footerYear(text) ?? footerYear(stripTags(raw)),
    internal_pages: internal.size,
    sections: sections.size,
    template,
    builder,
    motion: typeof motion === "boolean" ? motion : null,
    signals: { score: signals.score, ...Object.fromEntries(["projects", "about", "contact", "resume", "github", "name"].map((k) => [k, signals[k]])) },
    words,
    project_links: null,
    measured_at: now.toISOString(),
  };
}

/**
 * Check links: HEAD, then GET when HEAD is refused. A link "loads" on 2xx/3xx;
 * 401/403/429/999 is a bot wall (blocked, not broken); 404, 410, 5xx, DNS
 * failures and timeouts are broken. Returns { checked, ok, broken, blocked }.
 */
export async function checkLinks(urls, { fetchImpl = globalThis.fetch, timeoutMs = LINK_TIMEOUT_MS, concurrency = 4, userAgent } = {}) {
  const res = { checked: 0, ok: 0, broken: 0, blocked: 0 };
  const headers = { Accept: "text/html,*/*;q=0.8", ...(userAgent ? { "User-Agent": userAgent } : {}) };
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
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const verdict = await one(queue.shift());
        if (!verdict) continue;
        res.checked++;
        res[verdict]++;
      }
    })
  );
  return res;
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
  if (!phone) return desktop;
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

/**
 * The home page's links as the project-link candidates read them (pure): the
 * desktop reading's, the phone reading's (`input.phone`) and the destinations
 * the page's project buttons open (`input.buttonUrls`, read by the capture),
 * each with `from`. For projectsPageFor and measurePage.
 */
export function homeProjectLinks(input) {
  const base = input.finalUrl || input.url;
  const links = pageLinks(input.html, base).map((l) => ({ ...l, from: "home" }));
  if (readable(input.phone)) links.push(...pageLinks(input.phone.html, input.phone.finalUrl || base).map((l) => ({ ...l, from: "phone" })));
  for (const href of input.buttonUrls ?? []) links.push({ raw: href, href, text: "", inProjects: true, from: "button" });
  return links;
}

/** How many of the candidates checked came from each place, and the projects page read, if any. */
function sourcesOf(candidates, projectsPage) {
  const count = (from) => candidates.filter((c) => c.from === from).length;
  return {
    home: count("home"),
    phone: count("phone"),
    buttons: count("button"),
    projects_page: projectsPage ? { url: projectsPage, count: count("projects_page") } : null,
    own_pages: candidates.filter((c) => c.kind === "own page").length,
  };
}

/**
 * measureFacts plus the project-link check. `input.phone` ({ html, text,
 * finalUrl }), when given, is the same page read at 390 wide: it is measured
 * too and merged in (mergeViews). The candidates (projectCandidates) come from
 * both views, the destinations of the page's project buttons
 * (`input.buttonUrls`) and, when the capture read it, the site's own projects
 * page (`input.projectsPage`: { html, finalUrl }), so one check covers them
 * all. `views` records what was read, `project_links_from` where the
 * candidates checked came from.
 */
export async function measurePage(input, { fetchImpl = globalThis.fetch, userAgent, timeoutMs } = {}) {
  const { phone = null, projectsPage = null, buttonUrls = [], ...desktopInput } = input;
  const scan = scanPage(desktopInput.html, desktopInput.finalUrl || desktopInput.url);
  let facts = measureFacts({ ...desktopInput, scan });
  const views = ["desktop"];
  if (readable(phone)) {
    const phoneBase = phone.finalUrl || facts.final_url;
    const phoneFacts = measureFacts({ ...desktopInput, html: phone.html, text: phone.text ?? "", finalUrl: phoneBase });
    facts = mergeViews(facts, phoneFacts);
    views.push("phone");
  }
  const links = homeProjectLinks({ ...desktopInput, finalUrl: facts.final_url, phone, buttonUrls });
  let projectsPageUrl = null;
  if (readable(projectsPage) && projectsPage.finalUrl) {
    projectsPageUrl = projectsPage.finalUrl;
    links.push(...pageLinks(projectsPage.html, projectsPageUrl).map((l) => ({ ...l, from: "projects_page", page: projectsPageUrl })));
    views.push("projects page");
  }
  const candidates = projectCandidates(links, facts.final_url);
  facts.project_links = await checkLinks(
    candidates.map((c) => c.url),
    { fetchImpl, userAgent, timeoutMs }
  );
  // The links checked, with where each came from: the nightly re-check (pipeline/evidence.mjs) tests these again.
  facts.project_candidates = candidates.map(({ url, from, kind }) => ({ url, from, kind }));
  facts.project_links_from = sourcesOf(candidates, projectsPageUrl);
  facts.views = views;
  return facts;
}
