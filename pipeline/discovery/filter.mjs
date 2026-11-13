// The language and topic filter of the discovery pipeline (docs/DISCOVERY.md),
// ported from the pilot's filter.py (about 95% right on its random sample of
// 100): keep English, computer-field personal portfolios. Free and instant,
// so the AI screen only sees what passes.
//
// Language: the page's own words decide when they are clear; the
// <html lang> attribute (the pilot's suggested first signal) decides when
// they are not, and confirms a foreign page whose words lean foreign.
// Templates often leave lang="en" on a translated page, so a clear foreign
// text wins over lang="en".

const W = (s) => new Set(s.split(/\s+/));
const EN = W("the and to of my i a in is with for on that this you are am have i'm i've about projects work contact experience skills built building love passionate based currently");
const FOREIGN = {
  es: W("el los las una para con por que del sobre mis proyectos soy desarrollador experiencia contacto ayuda empresas necesidades portafolio mí desarrolladora"),
  pt: W("os uma para com por que do da sobre meus projetos sou desenvolvedor experiência contato em é um focado laboratório portfólio desenvolvedora"),
  fr: W("les des une pour avec par que sur mes projets suis développeur expérience et je"),
  de: W("und der die das ein eine mit für von über meine projekte ich bin entwickler erfahrung kontakt"),
  id: W("dan yang saya untuk dengan dari proyek pengalaman"),
};
const NONLATIN = /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/g;

const DEV =
  /\b(software|developer|develop(ing|ment)|engineer(ing)?|programmer|coder|coding|full[- ]?stack|front[- ]?end|back[- ]?end|web ?dev|devops|sre|machine learning|ml engineer|data engineer|ai engineer|mobile dev|ios|android|react|next\.?js|vue|angular|svelte|node\.?js|typescript|javascript|python|java|golang|rust|c\+\+|c#|\.net|kotlin|swift|django|flask|rails|laravel|php|kubernetes|docker|aws|api|open[- ]source|computer science|cs student|github|designer|ux|ui|product design|figma|interaction design|web design|motion design|data scien\w*|data analy\w*|cyber ?security|security engineer|game dev\w*|unity|unreal|it support|sysadmin|cloud|embedded|firmware|hardware|fpga|robotics)\b/gi;
const TITLE_PRODUCT = /\b(free|tool|checker|analy[sz]er|templates?|design assets|marketplace|agency|coaching|studio os|lab|fleet management|create the best|builder|platform|sale)\b/i;
const PLACEHOLDER = /(street address|your name|lorem ipsum|city, state, zip|your custom text)/i;
const NOT_PORTFOLIO = [
  ["product", /\b(pricing|free trial|sign up free|get started free|book a demo|our (team|clients|services|platform|product)|we (help|build|are a)|agency|startup|saas|customers|request a demo)\b/i],
  ["docs", /\b(documentation|docs|api reference|reference manual|getting started guide|changelog)\b/i],
  ["investing", /\b(stocks?|trading|investor|investment|crypto ?portfolio|asset allocation|dividends?)\b/i],
  ["creative_only", /\b(photographer|photography|wedding|tattoo|makeup|painter|fashion|model portfolio|architecture firm|interior design|real estate|lawyer|attorney|dentist)\b/i],
];
const HARDWARE = /\b(embedded|firmware|hardware|fpga|pcb|robotics|electronics)\b/i;
const SOFTWARE = /\b(software|web|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;

/** The language of a text by its words: "en", a FOREIGN key, "non-latin" or "unknown"; with the English and best foreign word counts. */
export function textLanguage(t) {
  if (!String(t).trim()) return { lang: "unknown", en: 0, foreign: 0 };
  const letters = String(t).match(/\p{L}/gu) ?? [];
  if (letters.length && (String(t).match(NONLATIN) ?? []).length / letters.length > 0.2) return { lang: "non-latin", en: 0, foreign: letters.length };
  const words = String(t).toLowerCase().match(/[a-zà-ÿ']+/g) ?? [];
  const en = words.filter((w) => EN.has(w)).length;
  let best = "en";
  let score = 0;
  for (const [k, set] of Object.entries(FOREIGN)) {
    const n = words.filter((w) => set.has(w)).length;
    if (n > score) [best, score] = [k, n];
  }
  if ((score >= 3 && score > en) || (score >= 2 && en <= 1)) return { lang: best, en, foreign: score };
  return { lang: en > 0 ? "en" : "unknown", en, foreign: score };
}

/** The page's language: its words when they are clear, else its <html lang>. */
export function pageLanguage({ lang = null, title = "", description = "", text = "" }) {
  const t = textLanguage(`${title} ${description} ${String(text).slice(0, 1200)}`);
  if (t.lang !== "en" && t.lang !== "unknown") return t.lang;
  const attr = lang ? String(lang).toLowerCase().slice(0, 2) : null;
  // A non-English lang attribute wins unless the words are clearly English.
  if (attr && attr !== "en" && !(t.lang === "en" && t.en >= 5 && t.foreign === 0)) return attr;
  return t.lang === "unknown" && attr ? attr : t.lang === "unknown" ? "unknown" : "en";
}

/**
 * The filter's verdict on a page's evidence (pipeline/discovery/check.mjs
 * evidenceOf): { keep: true, priority } or { keep: false, reason, detail }.
 * Reasons are the seen-set's final codes: not_english, not_portfolio,
 * template.
 * @param {{ lang?: string | null, title?: string, description?: string, text?: string, linksGithub?: boolean, repoDescription?: string }} e
 */
export function filterPage(e) {
  const lang = pageLanguage(e);
  if (lang !== "en" && lang !== "unknown") return { keep: false, reason: "not_english", detail: lang };
  const t = `${e.title ?? ""} ${e.description ?? ""} ${String(e.text ?? "").slice(0, 300)}`;
  const full = `${t} ${e.repoDescription ?? ""}`;
  const devHits = (full.match(DEV) ?? []).length;
  const title = String(e.title ?? "");
  if (PLACEHOLDER.test(t)) return { keep: false, reason: "template", detail: "placeholder_text" };
  if (TITLE_PRODUCT.test(title) && !/\b(portfolio|developer|engineer|designer)\b/i.test(title)) return { keep: false, reason: "not_portfolio", detail: "product" };
  for (const [name, rx] of NOT_PORTFOLIO) if (rx.test(t) && devHits < 3) return { keep: false, reason: "not_portfolio", detail: name };
  if (devHits === 0 && !e.linksGithub) return { keep: false, reason: "not_portfolio", detail: "no_tech_signal" };
  return { keep: true, priority: HARDWARE.test(t) && !SOFTWARE.test(t) ? "low" : "normal" };
}
