// The quality scorecard of a draft (docs/CONTENT-ENGINE.md, "Quality tools"):
// plain code, no AI and no metered call, shown on /admin/blog/[id] and in the
// side-by-side compare. It counts what a reader would notice: length,
// reading level, real portfolio examples, sources, claims cut, images with
// alt text and repeated phrases, and it applies the owner's two editorial
// rules (2026-11-11):
//
//   no dev meta  posts are about portfolios, never about building
//                PortfolioRank: no bug postmortems, build-in-public, running
//                costs, our stack, our pipeline, and no claims about our
//                infrastructure (one draft said "Amazon SES"; we don't use it);
//   payoff       one clear takeaway a reader can use on their own
//                portfolio, stated early (in the first 150 words).
//
// The same two rules run as code checks on every draft (editorialChecks),
// so a draft that breaks them is revised, then dropped, before it reaches
// the review queue. Plain JavaScript: the app, the engine and the tests
// share it.

/** The length the owner asked for (2026-11-11): about 500 to 800 words unless the data earns more. */
export const TARGET_WORDS = { min: 500, max: 800 };
/** A takeaway must be stated within this many words of the start. */
export const PAYOFF_WITHIN = 150;
/** The reading grade above which a post is flagged as hard going. */
export const MAX_GRADE = 11;

// Dev meta and infrastructure: what PortfolioRank is built with and how it
// runs. Each entry is [pattern, what it is]; a hit flags the draft.
/** @type {[RegExp, string][]} */
export const DEV_META = [
  [/\b(?:our|the site's|portfoliorank's)\s+(?:pipeline|stack|database|servers?|infrastructure|back ?end|cron(?: jobs?)?|workers?|codebase|hosting|bill|costs?|budget|quota|api keys?)\b/i, "how PortfolioRank is built or run"],
  [/\b(?:post-?mortem|build(?:ing)? in public|behind the scenes of (?:portfoliorank|our)|what it costs to run|running costs?)\b/i, "build-in-public or a postmortem"],
  [/\b(?:my|our|the) (?:api )?key (?:wasn't|was not|stopped|didn't)\b/i, "a story about our own bug"],
  [/\bwe (?:built|shipped|deployed|migrated|refactored|rewrote|fixed (?:a|the|our) bug)\b/i, "what we built"],
  [/\b(?:Amazon SES|AWS|Cloudflare|Turso|libSQL|Workers AI|Vercel|Netlify|Next\.js|OpenNext|wrangler|Tavily|Pexels|AI Gateway|R2 bucket)\b/, "our infrastructure or vendors"],
  [/\b(?:Gemini\s+\d|Flash-Lite|requests? per (?:day|minute)|rate limits?|daily quota|free tier)\b/i, "our model setup or quotas"],
];

// A reader's action: second person, a verb a reader can do today.
const ACTION = /\b(?:add|put|show|lead|cut|link|use|make|keep|write|move|start|test|check|replace|swap|ship|open|name|pick|trim|drop|lighten|compress|place|give|lose|delete|remove|try|choose|turn|set|load|feature|label|explain|state|tell|list)\b/i;
const READER = /\b(?:you|your|yours)\b/i;

const words = (s) => String(s).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** Plain text of a post body: no Markdown marks, image markers or the call to action. */
export function plainBody(markdown) {
  return String(markdown ?? "")
    .replace(/\[\[image:[^\]]+\]\]/g, " ")
    .replace(/^\*\*Grade your portfolio.*$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`]/g, " ");
}

/** Sentences of plain text (one per line in our posts, else split at . ? !). */
export function sentences(text) {
  return String(text)
    .split(/\n+|(?<=[.?!])\s+(?=[A-Z0-9"])/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
}

/** Syllables of an English word, by the usual vowel-group estimate. */
export function syllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** The Flesch-Kincaid grade of plain text, one decimal; null for too little text. */
export function readingGrade(text) {
  const ss = sentences(text);
  const ws = words(text);
  if (ss.length < 2 || ws.length < 30) return null;
  const syl = ws.reduce((a, w) => a + syllables(w), 0);
  return Math.round((0.39 * (ws.length / ss.length) + 11.8 * (syl / ws.length) - 15.59) * 10) / 10;
}

const FILLER = new Set(["the", "a", "an", "of", "to", "and", "in", "on", "is", "are", "it", "that", "this", "for", "with", "as", "at", "by", "or", "be"]);

/** Phrases of four words that appear more than once (ignoring all-filler ones), most repeated first: [{ phrase, n }]. */
export function repeatedPhrases(text, { size = 4, limit = 8 } = {}) {
  const ws = words(String(text).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " "));
  const m = new Map();
  for (let i = 0; i + size <= ws.length; i++) {
    const g = ws.slice(i, i + size);
    if (g.filter((w) => !FILLER.has(w)).length < 2) continue;
    const k = g.join(" ");
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m]
    .filter(([, n]) => n > 1)
    .map(([phrase, n]) => ({ phrase, n }))
    .sort((a, b) => b.n - a.n || a.phrase.localeCompare(b.phrase))
    .slice(0, limit);
}

/** Every dev-meta or infrastructure hit in `text`: [{ match, why }]. */
export function devMetaHits(text) {
  const out = [];
  for (const [re, why] of DEV_META) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of String(text).matchAll(g)) out.push({ match: m[0], why });
  }
  return out;
}

/**
 * The takeaway: the first sentence within the first PAYOFF_WITHIN words
 * that speaks to the reader and asks them to do something. { ok, sentence }.
 */
export function findPayoff(text) {
  let seen = 0;
  for (const s of sentences(text)) {
    if (seen >= PAYOFF_WITHIN) break;
    if (READER.test(s) && ACTION.test(s)) return { ok: true, sentence: s };
    seen += words(s).length;
  }
  return { ok: false, sentence: null };
}

/**
 * The scorecard of a stored post (lib/content/blog.mjs getPost's shape: body,
 * title, subtitle, facts, checks, claims, images). Returns { words,
 * readingGrade, examples, sources, claimsCut, images: { total, withAlt },
 * repeated, devMeta, payoff, flags }, where flags lists what the owner
 * should look at, in plain words.
 */
export function scorecard(post) {
  const body = plainBody(post.body);
  const n = words(body).length;
  const grade = readingGrade(body);
  const names = (post.facts?.names ?? []).filter((x) => x?.name);
  const examples = names.filter((x) => body.includes(x.name) || String(post.body ?? "").includes(x.url)).map((x) => x.name);
  const sources = [...new Set((post.claims ?? []).map((c) => c.url).filter(Boolean))];
  const claimsCut = (post.checks?.history ?? []).reduce((a, h) => a + (h?.claims?.cut?.length ?? 0), 0);
  const imgs = post.images ?? [];
  const withAlt = imgs.filter((i) => String(i.alt ?? "").trim().length >= 8).length;
  const repeated = repeatedPhrases(body);
  const devMeta = devMetaHits([post.title, post.subtitle, body].filter(Boolean).join("\n"));
  const payoff = findPayoff([post.subtitle, body].filter(Boolean).join("\n"));
  const flags = [];
  if (n < TARGET_WORDS.min) flags.push(`Short: ${n} words, about ${TARGET_WORDS.min} to ${TARGET_WORDS.max} wanted`);
  if (n > TARGET_WORDS.max) flags.push(`Long: ${n} words, about ${TARGET_WORDS.min} to ${TARGET_WORDS.max} wanted unless the data earns more`);
  if (!payoff.ok) flags.push(`No takeaway for the reader in the first ${PAYOFF_WITHIN} words`);
  if (devMeta.length) flags.push(`Dev meta: ${[...new Set(devMeta.map((d) => d.match))].slice(0, 4).join(", ")}`);
  if (grade != null && grade > MAX_GRADE) flags.push(`Hard to read: grade ${grade}`);
  if (!examples.length) flags.push("No real portfolio named as an example");
  if (withAlt < imgs.length) flags.push(`${imgs.length - withAlt} image(s) without alt text`);
  if (repeated.length >= 3) flags.push(`${repeated.length} repeated phrases`);
  return { words: n, readingGrade: grade, examples, sources, claimsCut, images: { total: imgs.length, withAlt }, repeated, devMeta, payoff, flags };
}

/**
 * The two editorial rules as code checks on a draft before it is stored
 * (pipeline/content/checks.mjs codeChecks): dev meta and the payoff. `text`
 * is the filled title, subtitle and body. Returns { name, ok, problems }.
 */
export function editorialChecks(text) {
  const p = [];
  const hits = devMetaHits(text);
  for (const h of hits.slice(0, 5)) p.push(`no dev meta: "${h.match}" is about ${h.why}; posts are about portfolios, never about building PortfolioRank or its infrastructure: remove it`);
  if (!findPayoff(text).ok) p.push(`payoff: state one clear takeaway the reader can use on their own portfolio within the first ${PAYOFF_WITHIN} words (a sentence to "you" that asks them to do something)`);
  return { name: "editorial", ok: p.length === 0, problems: p };
}
