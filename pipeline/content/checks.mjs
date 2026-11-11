// The code checks on a draft (docs/CONTENT-ENGINE.md, gates 1 and 4 and
// pipeline stage 5): placeholders and stray numbers, the naming rule,
// links, and the template. Each check returns { name, ok, problems }; a
// draft passes only when every one is ok. They run on the draft before its
// placeholders are filled (numbers) and after (names and links), so a
// figure in a post can only have come from the fact sheet.
import { PLACEHOLDER, SLOTS, assembleBody, draftTexts, fill, oneSentencePerLine } from "./writer.mjs";
import { checkActions, checkCallout, checkHook, checkParagraphs, checkSuperlatives } from "./quality.mjs";
import { SITE_URL, domainOf } from "./facts.mjs";

/** The template's word range (POST_TEMPLATE.md; owner decision 2026-11-10: 250 to 400 words), with 10% slack either side. */
export const WORDS = { min: 250, max: 400, slack: 0.1 };

// Digits a post may hold outside placeholders: years, the numbers of a
// numbered list, the Gemini model names and the rubric's 1 to 5 scale.
const ALLOWED_NUMBERS = [
  /\b(?:19|20)\d{2}\b/g,
  /^\s*\d{1,2}\.\s/gm,
  /\b(?:Gemini\s+)?\d\.\d\s+Flash(?:-Lite)?\b/gi,
  /\bgemini-\d\.\d-flash(?:-lite)?\b/gi,
  /\b1\s?(?:to|-)\s?5\b/g,
  /\[\[image:[a-z0-9-]+\]\]/g,
];

const URL_RE = /\bhttps?:\/\/[^\s)<>\]"']+/gi;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|dev|io|me|app|net|org|co|ai|xyz|tech|site|page|pro|vercel\.app|netlify\.app|github\.io|pages\.dev|onrender\.com|in|uk|ca|de|fr)\b/gi;

const result = (name, problems) => ({ name, ok: problems.length === 0, problems });

/**
 * Placeholders and stray numbers, on the unfilled draft. `allowedSentences`
 * are outside claims a search supported (gate 2): numbers inside them stay.
 */
export function checkNumbers(draft, facts, { allowedSentences = [], names = [] } = {}) {
  const ids = new Set(facts.map((f) => f.id));
  const problems = [];
  for (const [field, raw] of draftTexts(draft)) {
    let text = raw;
    // Supported claims, the names a post may use, and addresses (the names
    // and links checks judge those) don't count as numbers.
    for (const s of [...allowedSentences, ...names].filter(Boolean)) text = text.split(s).join(" ");
    text = text.replace(URL_RE, " ").replace(DOMAIN_RE, " ");
    for (const m of text.matchAll(PLACEHOLDER)) if (!ids.has(m[1])) problems.push(`${field}: unknown placeholder ${m[0]}`);
    let bare = text.replace(PLACEHOLDER, " ");
    for (const re of ALLOWED_NUMBERS) bare = bare.replace(re, " ");
    for (const m of bare.matchAll(/\d[\d,.]*%?/g)) {
      const at = Math.max(0, m.index - 30);
      problems.push(`${field}: a number not from the fact sheet: "${bare.slice(at, m.index + m[0].length + 20).replace(/\s+/g, " ").trim()}"`);
    }
  }
  return result("numbers", problems);
}

/** Every URL in a text, trailing punctuation trimmed. */
export function urlsIn(text) {
  return [...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

/**
 * The naming rule as code, on the filled draft: a portfolio's name, domain
 * or URL may appear only if it is on the sheet's names list. `roster` is
 * every portfolio [{ name, url }]. Single-word names are matched only when
 * they are 6 letters or longer, so common first names don't trip it.
 */
export function checkNames(filledTexts, sheet, roster, { extraDomains = [] } = {}) {
  const allowedUrls = new Set(sheet.names.map((n) => n.url));
  const allowedDomains = new Set([domainOf(SITE_URL), ...sheet.names.map((n) => n.domain), ...extraDomains].filter(Boolean));
  const allowedNames = new Set(sheet.names.map((n) => String(n.name).toLowerCase()));
  const problems = new Set();
  const matchers = [];
  for (const r of roster) {
    const name = String(r.name ?? "").trim();
    if (name && (name.includes(" ") || name.length >= 6) && !allowedNames.has(name.toLowerCase()) && !allowedUrls.has(r.url)) {
      matchers.push({ re: new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}])`, "iu"), label: name });
    }
  }
  for (const [field, text] of filledTexts) {
    for (const m of matchers) if (m.re.test(text)) problems.add(`${field}: names ${m.label}, who is not on this post's list of positive names`);
    for (const d of String(text).match(DOMAIN_RE) ?? []) {
      const dom = d.toLowerCase().replace(/^www\./, "");
      if (!allowedDomains.has(dom) && ![...allowedDomains].some((a) => dom.endsWith(`.${a}`))) problems.add(`${field}: mentions ${dom}, which this post may not name or link`);
    }
  }
  return result("names", [...problems]);
}

/** Links: http(s) only, on the allowed list. Loading them is checkLinksLoad. */
export function checkLinks(filledTexts, allowed) {
  const ok = new Set(allowed.map((u) => String(u).replace(/\/$/, "")));
  const problems = [];
  for (const [field, text] of filledTexts) {
    for (const m of String(text).matchAll(/\]\(([^)]*)\)/g)) {
      const u = m[1].trim();
      if (!/^https?:\/\//i.test(u) && !u.startsWith("/")) problems.push(`${field}: link "${u}" is not a web address`);
    }
    for (const u of urlsIn(text)) {
      if (!ok.has(u.replace(/\/$/, "")) && domainOf(u) !== domainOf(SITE_URL)) problems.push(`${field}: link ${u} is not one this post may use`);
    }
  }
  return result("links", problems);
}

/** Whether each external URL loads (2xx or 3xx), with a short timeout. Returns a check. */
export async function checkLinksLoad(urls, fetchImpl, { timeoutMs = 10000 } = {}) {
  const problems = [];
  for (const u of [...new Set(urls)]) {
    if (domainOf(u) === domainOf(SITE_URL)) continue;
    try {
      const res = await fetchImpl(u, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "PortfolioRank link check" } });
      if (!res.ok) problems.push(`link ${u} answered ${res.status}`);
      await res.body?.cancel?.();
    } catch (e) {
      problems.push(`link ${u} did not load (${String(e?.message ?? e).slice(0, 80)})`);
    }
  }
  return result("links-load", problems);
}

/** Words of body text: Markdown marks, image markers and the call to action don't count. */
export function wordCount(markdown) {
  const text = String(markdown)
    .replace(/\[\[image:[^\]]+\]\]/g, " ")
    .replace(/^\*\*Grade your portfolio.*$/m, " ")
    .replace(/[#>*_`[\]()-]/g, " ");
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}{]/u.test(w)).length;
}

/** The template (docs/content/POST_TEMPLATE.md) and the house rules. */
export function checkTemplate(draft, sheet) {
  const p = [];
  const body = String(draft.body ?? "");
  const all = draftTexts(draft);
  if (!String(draft.title ?? "").trim()) p.push("title is empty");
  if (String(draft.title ?? "").length > 100) p.push("title is longer than 100 characters");
  if (!String(draft.alt_title_a ?? "").trim() || !String(draft.alt_title_b ?? "").trim()) p.push("two alternative titles are needed");
  if (!String(draft.subtitle ?? "").trim()) p.push("subtitle is empty");
  const tags = draft.tags ?? [];
  if (tags.length < 2 || tags.length > 4) p.push(`tags: ${tags.length}, 2 to 4 needed`);
  if (!String(draft.share_line ?? "").trim() || fill(draft.share_line, sheet.facts).length >= 260) p.push("share line must be under 260 characters");
  if (!String(draft.newsletter_blurb ?? "").trim()) p.push("newsletter blurb is empty");
  const tldr = draft.tldr ?? [];
  if (tldr.length !== 3) p.push(`TL;DR has ${tldr.length} bullets, exactly 3 needed`);
  tldr.forEach((b, i) => {
    if (!new RegExp(PLACEHOLDER.source).test(String(b))) p.push(`TL;DR bullet ${i + 1} has no fact placeholder`);
  });
  const heads = [...body.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim());
  if (heads.filter((h) => !/^try this$/i.test(h)).length < 2) p.push("at least two ### subheads are needed besides Try this");
  if (/^#{1,2}\s|^#{4,}\s/m.test(body)) p.push("only ### subheads are allowed");
  const tryAt = body.search(/^###\s+Try this\s*$/im);
  if (tryAt < 0) p.push('a "### Try this" section is needed');
  else {
    const rest = body.slice(tryAt).split("\n").slice(1);
    const next = rest.findIndex((l) => /^###\s/.test(l));
    const steps = (next < 0 ? rest : rest.slice(0, next)).filter((l) => /^\s*\d+\.\s+\S/.test(l));
    if (steps.length < 3) p.push(`"Try this" has ${steps.length} numbered steps, 3 needed`);
  }
  if (!/^>\s*\*\*[^*]+\*\*/m.test(body)) p.push("one key-number callout (a quote starting with a bold line) is needed");
  if (/<\/?[a-z][^>]*>/i.test(body) || /\{[^{}]*\}\s*\/>|import\s+\w+\s+from/.test(body)) p.push("no HTML or MDX is allowed in the body");
  if (/!\[[^\]]*\]\(/.test(body)) p.push("images go in as [[image:...]] markers, not Markdown images");
  for (const [field, text] of all) {
    if (text.includes("—")) p.push(`${field}: em dash`);
  }
  // Images: a hero and 2 or 3 inline slots, each placed once.
  const images = draft.images ?? [];
  const slots = images.map((i) => i.slot);
  if (!slots.includes("hero")) p.push("a hero image slot is needed");
  const inline = slots.filter((s) => s !== "hero");
  if (inline.length < 2 || inline.length > 3) p.push(`${inline.length} inline image slots, 2 or 3 needed`);
  if (new Set(slots).size !== slots.length) p.push("an image slot is listed twice");
  for (const s of inline) if (!body.includes(`[[image:${s}]]`)) p.push(`image ${s} is not placed in the body`);
  for (const m of body.matchAll(/\[\[image:([a-z0-9-]+)\]\]/g)) if (!SLOTS.includes(m[1]) || !slots.includes(m[1]) || m[1] === "hero") p.push(`body places unknown image ${m[1]}`);
  for (const im of images) {
    if (!String(im.alt ?? "").trim()) p.push(`image ${im.slot}: alt text is empty`);
    if (im.kind === "chart" && !sheet.charts.some((c) => c.id === im.chart_id)) p.push(`image ${im.slot}: chart ${im.chart_id ?? "(none)"} is not in the fact sheet`);
    if (im.kind === "screenshot" && !sheet.screenshots.some((s) => s.url === im.site_url)) p.push(`image ${im.slot}: screenshot of ${im.site_url ?? "(none)"} is not allowed`);
  }
  const words = wordCount(fill(assembleBody(draft), sheet.facts));
  const lo = Math.floor(WORDS.min * (1 - WORDS.slack));
  const hi = Math.ceil(WORDS.max * (1 + WORDS.slack));
  if (words < lo) p.push(`body has ${words} words; ${WORDS.min} to ${WORDS.max} wanted: add about ${325 - words} words, for example a longer paragraph`);
  if (words > hi) p.push(`body has ${words} words; ${WORDS.min} to ${WORDS.max} wanted: cut about ${words - 325} words`);
  return result("template", p);
}

/** Every code check on a draft. Returns { ok, checks, failures }. */
export function codeChecks(draft, sheet, { roster, allowedSentences = [], claimUrls = [] }) {
  const filled = draftTexts(draft).map(([k, v]) => [k, fill(v, sheet.facts)]);
  const checks = [
    checkNumbers(draft, sheet.facts, { allowedSentences, names: sheet.names.map((n) => n.name) }),
    checkNames(filled, sheet, roster, { extraDomains: claimUrls.map(domainOf) }),
    checkLinks(filled, [SITE_URL, ...sheet.names.map((n) => n.url), ...claimUrls]),
    checkTemplate(draft, sheet),
    checkParagraphs({ ...draft, body: oneSentencePerLine(String(draft.body ?? "")) }),
    checkSuperlatives(draft, sheet),
    checkCallout(draft, sheet),
    checkHook(draft, sheet),
    checkActions(draft, sheet),
  ];
  return { ok: checks.every((c) => c.ok), checks, failures: checks.flatMap((c) => c.problems.map((x) => `${c.name}: ${x}`)) };
}
