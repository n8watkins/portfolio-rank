// "Code checks facts": everything about a portfolio that code can check for
// free, measured from the page's HTML and stored in portfolios.facts so the
// AI grade (pipeline/rubric.mjs) gets it as context instead of guessing it
// from a screenshot. capture.mjs measures the rendered page; judge.mjs
// measures over plain HTTP for rows captured before facts existed.
//
// measureFacts is pure; checkLinks makes HTTP requests (HEAD, then GET when
// HEAD is refused), capped in number and time, never to private addresses.
import { portfolioSignals } from "./signals.mjs";

export const FACTS_VERSION = 1;
export const LINK_CHECK_MAX = 8;
export const LINK_TIMEOUT_MS = 8000;

// Free hosting subdomains: a site served from one is not on its own domain.
export const FREE_HOSTS =
  /\.(vercel\.app|netlify\.app|github\.io|gitlab\.io|framer\.website|framer\.app|framer\.ai|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|surge\.sh|onrender\.com|herokuapp\.com|glitch\.me|replit\.app|repl\.co|wixsite\.com|squarespace\.com|webflow\.io|carrd\.co|notion\.site|super\.site|wordpress\.com|blogspot\.com|neocities\.org|fly\.dev|railway\.app|azurewebsites\.net|amplifyapp\.com|translate\.goog)$/i;

// Hosts that are profiles or services, not project demos.
const NOT_PROJECT =
  /(^|\.)(linkedin\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|bsky\.app|mastodon\.social|dribbble\.com|behance\.net|medium\.com|dev\.to|hashnode\.com|stackoverflow\.com|leetcode\.com|hackerrank\.com|discord\.gg|discord\.com|t\.me|wa\.me|calendly\.com|cal\.com|buymeacoffee\.com|ko-fi\.com|patreon\.com|google\.com|googleapis\.com|gstatic\.com|fonts\.googleapis\.com|w3\.org|schema\.org|creativecommons\.org|vercel\.com|netlify\.com|nextjs\.org|reactjs\.org|react\.dev|gatsbyjs\.com|astro\.build|tailwindcss\.com|fontawesome\.com|unsplash\.com|icons8\.com|flaticon\.com|credly\.com|coursera\.org|udemy\.com)$/i;

const GH_RESERVED =
  /^(sponsors|topics|features|about|pricing|marketplace|orgs|organizations|settings|notifications|explore|login|join|new|search|apps|collections|readme|site|customer-stories|enterprise|team|security|contact|trending|events|github-copilot)$/i;

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
const decode = (s) =>
  String(s ?? "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");

/** Every <a href> on the page, absolute, with its text. */
export function extractLinks(html, baseUrl) {
  const out = [];
  const src = String(html ?? "");
  // Headings in order, so each link knows the section it sits in ("where on the page").
  const heads = [...src.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((h) => ({ at: h.index, text: shorten(decode(h[2].replace(/<[^>]+>/g, " ")), 60) })).filter((h) => h.text);
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const raw = decode(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (!raw) continue;
    const text = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80);
    const aria = m[1].match(/\baria-label\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    const section = heads.filter((h) => h.at < m.index).at(-1)?.text ?? null;
    out.push({ raw, href: abs, text: `${text} ${aria}`.trim(), section });
  }
  return out;
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
export function measureFacts({ html = "", text = "", url, finalUrl, name = "", motion = null, source = "rendered", now = new Date() }) {
  const base = finalUrl || url;
  const links = extractLinks(html, base);
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
    if (/\b(resume|résumé|cv|curriculum vitae)\b/i.test(label) || /resume|\/cv\b|[-_]cv\.pdf/i.test(u.pathname)) resume = true;
    if (h === "github.com") {
      const first = u.pathname.split("/").filter(Boolean)[0];
      if (first && !GH_RESERVED.test(first)) github = true;
    }
    if (h === self && (u.protocol === "http:" || u.protocol === "https:")) {
      if (l.raw.startsWith("#") && l.raw.length > 1) sections.add(l.raw.slice(1).toLowerCase());
      else if (u.hash && u.hash.length > 1 && (u.pathname === "/" || u.pathname === new URL(base).pathname)) sections.add(u.hash.slice(1).toLowerCase());
      else {
        const p = u.pathname.replace(/\/+$/, "").toLowerCase();
        if (p && !/\.(pdf|png|jpe?g|gif|svg|webp|xml|txt|ico|css|js)$/.test(p)) internal.add(p);
      }
    }
  }
  const signals = portfolioSignals(html, name);
  const raw = String(html ?? "");
  const template = TEMPLATE_MARKERS.find(([re]) => re.test(raw))?.[1] ??
    (/brittany\s*chiang/i.test(raw) && !/brittany/i.test(name) ? "Brittany Chiang v4 clone" : null);
  const generator = raw.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";
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
    footer_year: footerYear(text) ?? footerYear(raw.replace(/<[^>]+>/g, " ")),
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

/** Whitespace collapsed, cut at a word boundary to at most `max` characters, with an ellipsis when cut. */
function shorten(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max / 2))).trim()}…`;
}

/** At most this many failed links are kept with their details. */
export const LINK_FAILURES_MAX = 10;

/** Where each candidate link sits on the page: href -> { text, section }, from extractLinks. */
export function linkContext(links) {
  const out = {};
  for (const l of links) {
    let key;
    try {
      const u = new URL(l.href);
      u.hash = "";
      key = u.href;
    } catch {
      continue;
    }
    if (!out[key]) out[key] = { text: shorten(decode(String(l.text ?? "")), 60) || null, section: l.section ?? null };
  }
  return out;
}

/** A failed check in words: "404 Not Found", "timed out after 8 s", "didn't connect". */
function failureReason(status, error, timeoutMs) {
  if (error) return /timeout|abort/i.test(String(error?.name ?? error?.message ?? error)) ? `timed out after ${Math.round(timeoutMs / 1000)} s` : "didn't connect (no such site, or it refused the connection)";
  const names = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 410: "Gone", 429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 999: "refused by the site" };
  return `${status}${names[status] ? ` ${names[status]}` : ""}`;
}

/**
 * Check links: HEAD, then GET when HEAD is refused. A link "loads" on 2xx/3xx;
 * 401/403/429/999 is a bot wall (blocked, not broken); 404, 410, 5xx, DNS
 * failures and timeouts are broken. Returns { checked, ok, broken, blocked,
 * failures }, where failures lists up to LINK_FAILURES_MAX broken and blocked
 * links: { url, kind, status, reason, text, section } (text and section from
 * `context`, linkContext's map).
 */
export async function checkLinks(urls, { fetchImpl = globalThis.fetch, timeoutMs = LINK_TIMEOUT_MS, concurrency = 4, userAgent, context = {} } = {}) {
  const res = { checked: 0, ok: 0, broken: 0, blocked: 0, failures: [] };
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
    } catch (e) {
      return { verdict: "broken", url, status: null, reason: failureReason(null, e ?? "error", timeoutMs) };
    }
    if (status >= 200 && status < 400) return { verdict: "ok" };
    if ([401, 403, 429, 999].includes(status)) return { verdict: "blocked", url, status, reason: failureReason(status, null, timeoutMs) };
    return { verdict: "broken", url, status, reason: failureReason(status, null, timeoutMs) };
  }
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const r = await one(queue.shift());
        if (!r) continue;
        res.checked++;
        res[r.verdict]++;
        if (r.verdict !== "ok") res.failures.push({ url: r.url, kind: r.verdict, status: r.status, reason: r.reason, text: context[r.url]?.text ?? null, section: context[r.url]?.section ?? null });
      }
    })
  );
  // Broken first, then blocked, each in page order as far as the checks finished.
  res.failures = [...res.failures.filter((f) => f.kind === "broken"), ...res.failures.filter((f) => f.kind === "blocked")].slice(0, LINK_FAILURES_MAX);
  return res;
}

/** measureFacts plus the project-link check. */
export async function measurePage(input, { fetchImpl = globalThis.fetch, userAgent, timeoutMs } = {}) {
  const facts = measureFacts(input);
  const links = extractLinks(input.html, facts.final_url);
  const urls = projectLinkCandidates(links, facts.final_url);
  facts.project_links = await checkLinks(urls, { fetchImpl, userAgent, timeoutMs, context: linkContext(links) });
  return facts;
}
