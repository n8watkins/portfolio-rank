// The free code checks of the discovery pipeline (docs/DISCOVERY.md), ported
// from the pilot's check.mjs and enrich.mjs: each candidate's page is
// fetched once (plus its robots.txt, and the README of a GitHub repo), and
// everything later steps need is kept from that one fetch: the html lang,
// title, description, headings, about 1,200 characters of text and link
// counts (the AI screen's evidence).
//
// checkPage answers { status: "dropped", reason, detail } or
// { status: "screen", evidence }. Reasons are the seen-set's coarse codes
// (lib/discovery/sites.mjs): dead, blocked, parked and empty are looked at
// again later; template, not_portfolio and duplicate are final. `detail`
// (http_404, robots_disallow, ...) is for the run summary only.
import { PLATFORM_HOST } from "./normalize.mjs";
import { siteKeyOf } from "../../lib/grader/url.mjs";
import { USER_AGENT } from "./http.mjs";

const TIMEOUT = 10000;
const MAX_BYTES = 1_500_000;

/** Reads at most `max` bytes of a response body as text. */
async function readCapped(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, max);
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** robots.txt says no to us (a group naming us, else "*", disallows "/"). */
export function robotsBlocksRoot(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = raw.replace(/#.*/, "").trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!lastWasAgent || !cur) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === "disallow" || k === "allow")) cur.rules.push([k, v]);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes("portfoliorankbot")));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return use.some((g) => g.rules.some(([k, v]) => k === "disallow" && v === "/") && !g.rules.some(([k, v]) => k === "allow" && v === "/"));
}

const NAMED = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", middot: "·", mdash: "-", ndash: "-" };
const ent = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? " ";
    try {
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    } catch {
      return "";
    }
  });
const clean = (s) => ent(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** What the checks and the screen read from one page's HTML. */
export function parsePage(html, base) {
  const head = html.slice(0, 200000);
  const lang = (head.match(/<html[^>]*\blang=["']?([a-z]{2,3})/i)?.[1] ?? "").toLowerCase() || null;
  const title = clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const meta = (name) => {
    const tag = head.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"))?.[0];
    return tag ? clean(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "") : "";
  };
  const description = meta("description") || meta("og:description");
  const ogTitle = meta("og:title");
  const body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template|head)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const h1 = clean(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const headings = [...new Set([...body.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => clean(m[2])).filter((h) => h && h.length < 120))].slice(0, 15);
  const text = clean(body);
  const hrefs = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    /* no base */
  }
  const ext = hrefs
    .map((h) => {
      try {
        return new URL(h, base);
      } catch {
        return null;
      }
    })
    .filter((u) => u && /^https?:$/.test(u.protocol) && u.hostname !== host);
  const repoLinks = new Set(ext.filter((u) => u.hostname === "github.com" && u.pathname.split("/").filter(Boolean).length >= 2).map((u) => u.pathname.toLowerCase())).size;
  const liveLinks = new Set(ext.filter((u) => /(vercel\.app|netlify\.app|github\.io|herokuapp\.com|onrender\.com|pages\.dev|fly\.dev|railway\.app)$/.test(u.hostname) || /apps\.apple\.com|play\.google\.com/.test(u.hostname)).map((u) => u.href)).size;
  const socials = [...new Set(ext.map((u) => u.hostname.replace(/^www\./, "").match(/^(linkedin|github|twitter|x|dribbble|behance|medium|youtube|kaggle|leetcode|stackoverflow)\.com$/)?.[1]).filter(Boolean))];
  const resume = hrefs.some((h) => /resume|\bcv\b|curriculum/i.test(h)) || /\b(resume|résumé|cv|curriculum vitae)\b/i.test(text);
  return {
    lang,
    title,
    description,
    ogTitle,
    h1,
    headings,
    text,
    linksGithub: hrefs.some((h) => /github\.com\/[^/\s"']+/i.test(h)),
    linksLinkedin: hrefs.some((h) => /linkedin\.com\/in\//i.test(h)),
    repoLinks,
    liveLinks,
    socials,
    resume,
  };
}

const DEFAULT_TITLE =
  /^(react app|vite \+ react( \+ ts)?|vite app|vite \+ vue( \+ ts)?|vite \+ svelte( \+ ts)?|vite \+ ts|vite|create next app|next\.js|nextjs|astro|astro basics|document|untitled( document)?|home|index|my portfolio|portfolio|my website|website|welcome|title|page title|loading\.*|app|angular|myapp|my app|vue app|svelte app|hello world|test|new project|lovable app|lovable generated project|v0 app|bolt|template|your name.*|site title)$/i;
const PARKED =
  /(domain (is |may be )?for sale|buy this domain|this domain (has been|is) (registered|parked)|parked (free|domain)|sedoparking|hugedomains|dan\.com|afternic|domain parking|godaddy\.com\/domains|this site can't be reached|account (has been )?suspended|site (is )?(not found|unavailable)|there isn't a github pages site here|deployment_not_found|404: not_found|the deployment could not be found|page not found|site not found|looks like you've followed a broken link|no such app|application error|welcome to nginx|it works!|apache2 (ubuntu|debian) default page|index of \/|coming soon|under construction|this page is under maintenance|web server's default page|cpanel|future home of something quite cool|project not found|this site has been paused|website expired|default web site page)/i;
const LOREM = /lorem ipsum|dolor sit amet|consectetur adipiscing/i;
const PLACEHOLDER = /\b(john doe|jane doe|firstname lastname|first name last name|insert name|your name here)\b/i;
const PLACEHOLDER_HEAD = /\b(your name|your full name|john doe|jane doe)\b/i;
// Template credits and the demo text of popular portfolio templates (owner rule: no templates).
const TEMPLATE_MARKERS = [
  ["html codex", /html ?codex/i],
  ["colorlib", /colorlib/i],
  ["bootstrapmade", /bootstrapmade/i],
  ["themewagon", /themewagon/i],
  ["templatemo", /templatemo/i],
  ["html5 up", /html5 ?up(\.net)?/i],
  ["start bootstrap", /start ?bootstrap/i],
  ["tooplate", /tooplate/i],
  ["w3layouts", /w3layouts/i],
  ["uideck", /uideck/i],
  ["graygrids", /graygrids/i],
  ["themeforest", /themeforest|envato/i],
  ["free template", /free (html5? |website |bootstrap )?template|template by|theme by|designed by .{0,40}(templates?|themes?)\b|distributed by/i],
  ["al-folio", /al-folio/i],
  ["academicpages", /academicpages|academic pages/i],
  ["minimal mistakes", /minimal mistakes/i],
  ["chirpy", /chirpy theme|jekyll-theme-chirpy/i],
  ["beautiful jekyll", /beautiful[- ]jekyll/i],
  ["wowchemy/hugo blox", /wowchemy|hugo ?blox/i],
  ["hugo theme", /hugo[- ](profile|theme)|papermod|hugo-coder/i],
  ["hydejack", /hydejack/i],
  ["jekyll theme", /jekyll[- ]theme|powered by jekyll .{0,40}theme/i],
  ["brittany chiang v4", /brittany chiang/i],
  ["developerFolio", /developerfolio|saad pasta/i],
  ["masterPortfolio", /masterportfolio|ashutosh hathidara/i],
  ["simplefolio", /simplefolio|jacobo mart[ií]nez|cobiwave/i],
  ["vcard", /vcard - personal portfolio|richard hanrick|codewithsadee/i],
  ["3d portfolio jsm", /adrian hajdin|jsmastery|js mastery/i],
  ["devportfolio", /ryan fitzgerald|devportfolio/i],
  ["dopefolio", /dopefolio|ram maheshwari|rammcodes/i],
  ["soumyajit", /soumyajit/i],
  ["gatsby starter", /gatsby[- ]starter/i],
  ["astro theme", /astro[- ]theme|astrofolio|astro-portfolio-template/i],
  ["next template", /nextjs[- ]portfolio[- ]template|portfolio[- ]template/i],
];
// Markers that only count in the footer (a credit), not anywhere on the page.
const FOOTER_ONLY = new Set(["html codex", "colorlib", "bootstrapmade", "themewagon", "templatemo", "html5 up", "start bootstrap", "tooplate", "w3layouts", "uideck", "graygrids", "themeforest", "free template", "al-folio", "academicpages", "minimal mistakes", "chirpy", "beautiful jekyll", "wowchemy/hugo blox", "hugo theme", "hydejack", "jekyll theme", "gatsby starter", "astro theme"]);
const PERSON_STOP = new Set(
  "software engineer developer web full stack front end frontend backend portfolio welcome home about my personal website projects project the and designer design data scientist student official page site blog digital creative studio react next app hello world contact resume senior junior product ui ux machine learning ai mobile ios android cloud devops game games to of for in a an dev tech solutions services agency company inc ltd llc free online best new modern simple minimal dark light theme template fullstack computer science security cyber analyst architect consultant freelance freelancer photography photographer artist writer musician music art work works labs lab hub space world's i'm hi im landing dashboard store shop news docs documentation api tool tools generator manager platform open source".split(" ")
);
/** A person's name ("Jane Doe") in the first text that has one, or null. */
export function personName(...texts) {
  const re = /(?<![\p{L}])([\p{Lu}][\p{Ll}'’-]{1,20})(?:\s+(?:[\p{Lu}]\.\s*)?([\p{Lu}][\p{Ll}'’-]{1,24})){1,2}(?![\p{L}])/gu;
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(re)) {
      const words = m[0].split(/\s+/).filter((w) => !/^[\p{Lu}]\.$/u.test(w));
      if (words.length >= 2 && words.every((w) => !PERSON_STOP.has(w.toLowerCase()))) return m[0];
    }
  }
  return null;
}
const PORTFOLIO_WORDS =
  /(\b(portfolio|my (work|projects)|projects|about me|resume|résumé|curriculum vitae|cv|hire me|i'?m an?|hi,? i'?m|hello,? i'?m|software engineer|developer|engineer|designer|personal (web)?site|experience|skills|portafolio|portfólio|portifólio|desarrollador|desenvolvedor|développeur|entwickler|ingeniero|engenheiro|ingénieur|sviluppatore|programador|proyectos|projetos|projets|projekte|sobre m[ií]|à propos|über mich)\b|разработчик|портфолио|проекты|开发|工程师|作品|个人主页|エンジニア|ポートフォリオ|개발자|포트폴리오|مطور|مهندس|geliştirici|yazılım|lập trình|pengembang|deweloper|programista|vývojář)/i;
// The README says the site was forked from, or built on, someone else's template or theme.
const README_TEMPLATE = new RegExp(
  [
    String.raw`forked from`,
    String.raw`\b(based on|built (on|with|using|from|upon)|using|uses|made (with|using|from)|created (with|from|using)|started (from|with)|derived from|adapted from|modified from|customi[sz]ed (from|version of)|powered by|credits?( goes)? to|thanks to|template by|theme by|design by)\s+(the |a |an |this |[\w@./-]+'s )?[^\n.]{0,60}?\b(portfolio |website |personal |jekyll |hugo |astro |next\.?js |gatsby |react |bootstrap |html5? |free )?(template|theme)\b`,
    String.raw`github\.com/(saadpasta/developerfolio|cobiwave/simplefolio|codewithsadee/vcard|adrianhajdin/project_3d_developer_portfolio|ashutosh1919/masterportfolio|ryanfitzgerald/devportfolio|rammcodes/dopefolio|bchiang7/v4|soumyajit4419/portfolio|academicpages|alshedivat/al-folio|mmistakes/minimal-mistakes|cotes2020/jekyll-theme-chirpy|wowchemy|hugoblox|daattali/beautiful-jekyll|gurusabarish/hugo-profile)`,
  ].join("|"),
  "gi"
);

/** The README's template or fork credit, or null (a dark/light theme or an issue template does not count). */
export function readmeTemplate(md) {
  if (!md) return null;
  const hit = [...String(md).matchAll(README_TEMPLATE)].map((m) => m[0]).find((s) => !/(dark|light|colou?r|site's|own|custom|my|toggle|switch|system|default|email|issue|pull request|pr) (template|theme)\b/i.test(s));
  return hit ? hit.toLowerCase().slice(0, 120) : null;
}

/** The template credits found on a page (the template author's own site is not a copy of it). */
export function templateMarkers(p, hosts) {
  const tmText = `${p.title} ${p.description} ${p.text.slice(-6000)} ${p.text.slice(0, 3000)}`;
  const footer = p.text.slice(-1500);
  const hostFlat = hosts.join(" ").replace(/[^a-z0-9 ]/g, "");
  return TEMPLATE_MARKERS.filter(([n, re]) => {
    const m = (FOOTER_ONLY.has(n) ? footer : tmText).match(re);
    if (!m) return false;
    const flat = m[0].toLowerCase().replace(/[^a-z0-9]/g, "");
    return !(flat.length > 5 && hostFlat.includes(flat));
  }).map(([n]) => n);
}

const deadFor = (status) => (status === 401 || status === 403 || status === 429 ? "blocked" : "dead");

/**
 * The code checks on one page that answered: what is wrong with it, or
 * null when it may be a portfolio. Pure, for the tests.
 * @param {{ status: number, type: string, html: string, url: string, finalUrl: string, context?: any, readme?: string | null }} page
 */
export function judgePage({ status, type, html, url, finalUrl, context = null, readme = null }) {
  if (status === 403 && /just a moment|attention required|cf-chl|captcha/i.test(html.slice(0, 5000))) return { reason: "blocked", detail: "bot_challenge" };
  if (status < 200 || status >= 300) return { reason: deadFor(status), detail: `http_${status >= 500 ? "5xx" : status}` };
  const finalHost = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (PLATFORM_HOST.test(finalHost)) return { reason: "not_portfolio", detail: "redirects_to_platform" };
  if (!/html/i.test(type) && !/<html|<!doctype html/i.test(html.slice(0, 2000))) return { reason: "not_portfolio", detail: "not_html" };
  const p = parsePage(html, finalUrl);
  const all = `${p.title} ${p.description} ${p.text.slice(0, 20000)}`;
  if (PARKED.test(p.title) || (p.text.length < 400 && PARKED.test(p.text))) return { reason: "parked", detail: "parked_or_error_page" };
  const defaultTitle = !p.title || DEFAULT_TITLE.test(p.title.trim());
  const jsShell = p.text.length < 200 && /<script\b/i.test(html);
  if (p.text.length < 200 && !jsShell) return { reason: "empty", detail: "empty_page" };
  if (jsShell && defaultTitle) return { reason: "empty", detail: "default_title_js_shell" };
  if (defaultTitle && p.text.length < 800) return { reason: "empty", detail: "default_title_little_text" };
  if (LOREM.test(all)) return { reason: "template", detail: "lorem_ipsum" };
  if (PLACEHOLDER.test(p.text.slice(0, 3000)) || PLACEHOLDER_HEAD.test(`${p.title} ${p.h1}`)) return { reason: "template", detail: "placeholder_name" };
  const markers = templateMarkers(p, [new URL(url).hostname, finalHost]);
  if (markers.length) return { reason: "template", detail: `template_page:${markers[0]}` };
  const fromReadme = readmeTemplate(readme);
  if (fromReadme) return { reason: "template", detail: "template_readme" };
  if (/\btemplate\b/i.test(`${context?.description ?? ""} ${(context?.topics ?? []).join(" ")}`)) return { reason: "template", detail: "template_repo_meta" };
  const portfolioWords = PORTFOLIO_WORDS.test(`${p.title} ${p.description} ${p.text.slice(0, 5000)}`);
  const titlePerson = personName(p.title, p.ogTitle, p.h1);
  if (!portfolioWords && !(titlePerson && (p.linksGithub || p.linksLinkedin))) return { reason: "not_portfolio", detail: "no_portfolio_words" };
  const person = personName(p.title, p.ogTitle, p.h1, p.text.slice(0, 600));
  if (!person && !p.linksGithub && !p.linksLinkedin) return { reason: "not_portfolio", detail: "no_person_signal" };
  return { reason: null, page: p, jsShell };
}

/** The screen's evidence from a page that passed: small, and never more than the AI needs. */
export function evidenceOf(p, { url, finalUrl, context = null, jsShell = false }) {
  return {
    url,
    finalUrl,
    lang: p.lang,
    title: p.title.slice(0, 200),
    description: p.description.slice(0, 300),
    headings: p.headings,
    text: p.text.slice(0, 1200),
    repoLinks: p.repoLinks,
    liveLinks: p.liveLinks,
    socials: p.socials,
    resume: p.resume,
    linksGithub: p.linksGithub,
    jsShell,
    ...(context?.description ? { repoDescription: context.description } : {}),
  };
}

/**
 * Fetches one candidate (robots.txt first) and runs the code checks.
 * @param {{ url: string, context?: any }} row
 * @param {{ fetchPage: typeof fetch, fetchText?: (url: string) => Promise<string | null> }} io fetchPage refuses private addresses (pipeline/net-guard-node.mjs guardedFetch)
 */
export async function checkPage(row, { fetchPage, fetchText = async () => null }) {
  const headers = { "user-agent": USER_AGENT, "accept-language": "en;q=0.9,*;q=0.5" };
  const origin = new URL(row.url).origin;
  try {
    const r = await fetchPage(`${origin}/robots.txt`, { headers: { ...headers, accept: "text/plain,*/*" }, signal: AbortSignal.timeout(TIMEOUT) });
    const text = await readCapped(r, 200_000);
    if (r.status < 400 && !/<html/i.test(text.slice(0, 500)) && robotsBlocksRoot(text)) return { status: "dropped", reason: "blocked", detail: "robots_disallow" };
  } catch {
    /* no robots.txt: allowed */
  }
  let res;
  let html;
  try {
    res = await fetchPage(row.url, { headers: { ...headers, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(TIMEOUT) });
    html = await readCapped(res, MAX_BYTES);
  } catch (e) {
    const msg = String(e?.cause?.code ?? e?.name ?? e?.message ?? e);
    const detail = /timeout/i.test(msg) ? "timeout" : /ENOTFOUND|EAI_AGAIN/.test(msg) ? "dns_not_found" : /blocked/.test(String(e?.message)) ? "private_address" : "fetch_error";
    return { status: "dropped", reason: detail === "private_address" ? "not_portfolio" : "dead", detail };
  }
  const finalUrl = res.url || row.url;
  const readme = row.context?.repo ? await fetchText(`https://raw.githubusercontent.com/${row.context.repo}/HEAD/README.md`).catch(() => null) : null;
  const j = judgePage({ status: res.status, type: res.headers.get("content-type") ?? "", html, url: row.url, finalUrl, context: row.context, readme });
  if (j.reason) return { status: "dropped", reason: j.reason, detail: j.detail };
  return { status: "screen", finalKey: siteKeyOf(finalUrl), evidence: evidenceOf(j.page, { url: row.url, finalUrl, context: row.context, jsShell: j.jsShell }) };
}
