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
// only; nothing re-measures them for the version (see AUTOMATION.md).
export const FACTS_VERSION = 2;
export const LINK_CHECK_MAX = 8;
export const LINK_TIMEOUT_MS = 8000;

// Free hosting subdomains: a site served from one is not on its own domain.
export const FREE_HOSTS =
  /\.(vercel\.app|netlify\.app|github\.io|gitlab\.io|framer\.website|framer\.app|framer\.ai|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|surge\.sh|onrender\.com|herokuapp\.com|glitch\.me|replit\.app|repl\.co|wixsite\.com|squarespace\.com|webflow\.io|carrd\.co|notion\.site|super\.site|wordpress\.com|blogspot\.com|neocities\.org|fly\.dev|railway\.app|azurewebsites\.net|amplifyapp\.com|translate\.goog)$/i;

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

/** The highest plausible copyright year on the page, or null. */
export function footerYear(text, now = new Date()) {
  const max = now.getUTCFullYear() + 1;
  let best = null;
  for (const m of String(text ?? "").matchAll(/(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-\u2013\u2014]\s*)?((?:19|20)\d{2})/gi)) {
    const y = Number(m[1]);
    if (y <= max && (best == null || y > best)) best = y;
  }
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
  const fromControls = page.controls.flatMap((c) => c.navUrls.map((href) => ({ raw: href, href, text: c.label })));
  return [...page.links, ...fromControls];
}

/**
 * Outbound links that look like projects or demos: other sites and GitHub
 * repositories, without social profiles, services and the site itself.
 */
export function projectLinkCandidates(links, siteUrl, max = LINK_CHECK_MAX) {
  const self = host(siteUrl);
  const seen = new Set();
  const out = [];
  for (const l of links) {
    let u;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!h || h === self || isPrivateHost(h)) continue;
    if (h === "github.com") {
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length < 2 || GH_RESERVED.test(segs[0])) continue; // a profile, not a repository
    } else if (NOT_PROJECT.test(h) || /\.(pdf|png|jpe?g|gif|svg|webp|zip)$/i.test(u.pathname)) {
      continue;
    }
    u.hash = "";
    const key = u.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
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

/** measureFacts plus the project-link check. */
export async function measurePage(input, { fetchImpl = globalThis.fetch, userAgent, timeoutMs } = {}) {
  const scan = scanPage(input.html, input.finalUrl || input.url);
  const facts = measureFacts({ ...input, scan });
  const urls = projectLinkCandidates(pageLinks(input.html, facts.final_url, scan), facts.final_url);
  facts.project_links = await checkLinks(urls, { fetchImpl, userAgent, timeoutMs });
  return facts;
}
