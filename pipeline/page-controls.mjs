// The controls on a page a visitor clicks that are not plain links: buttons,
// links without an href, elements with role="button" (or link, menuitem,
// tab), elements with an onclick attribute, and input buttons. A "View Resume" button that opens a
// PDF from script, a GitHub icon button, a "Contact" button that scrolls to
// the form: a person counts them, so the facts (./facts.mjs) and the
// portfolio signals (./signals.mjs) count them too (facts audit, 2026-11-21:
// scripts/experiments/facts-audit/).
//
// Pure, from the page's HTML (the browser-rendered DOM for single-page apps).
// A control's label is its own text, aria-label, title and the alt text of
// an image inside it; the label is only read for words when the text is
// short (LABEL_MAX), so a big clickable card that mentions "resume" in a
// sentence is not taken for a resume button. URLs in its attributes (onclick,
// data-href and the like) are kept as written.

/** Longest control text read for words: buttons and menu items, not cards of prose. */
export const LABEL_MAX = 60;

const ATTR = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const attr = (attrs, name) => {
  const m = String(attrs ?? "").match(ATTR(name));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
};
const decode = (s) =>
  String(s ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'");
const plain = (inner) =>
  String(inner ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

// A tag's attributes, quoted values whole: class="[&>svg]:size-4" holds a ">".
export const TAG_ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const A = TAG_ATTRS;
/** An attribute value, quoted or not, that starts with one of `words` ("button|tab"). */
const valueOf = (words) => String.raw`(?:"(?:${words})\b[^"]*"|'(?:${words})\b[^']*'|(?:${words})\b)`;
const PATTERNS = [
  new RegExp(String.raw`<(button)\b(${A})>([\s\S]*?)<\/button>`, "gi"),
  // Kept only without an href: a script-driven menu item (<a class="menu">Contact</a>).
  new RegExp(String.raw`<(a)\b(${A})>([\s\S]*?)<\/a>`, "gi"),
  new RegExp(String.raw`<([a-z][\w-]*)\b(${A}\brole\s*=\s*${valueOf("button|link|menuitem|tab")}${A})>([\s\S]*?)<\/\1>`, "gi"),
  new RegExp(String.raw`<([a-z][\w-]*)\b(${A}\bonclick\s*=${A})>([\s\S]*?)<\/\1>`, "gi"),
];
const INPUT = new RegExp(String.raw`<input\b(${A}\btype\s*=\s*${valueOf("button|submit")}${A})>`, "gi");
const hasHref = (attrs) => /\bhref\s*=/i.test(String(attrs).replace(/"[^"]*"|'[^']*'/g, '""'));
// URLs written in a control's attributes other than href: window.open('...'), data-href="...".
const URL_IN_ATTR = /\b(?:onclick|data-[\w-]+|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const URL_TOKEN = /(?:https?:\/\/|mailto:|tel:)[^\s'"`<>)]+|[\w./~-]+\.pdf\b/gi;

/**
 * Every non-link control in `html`: { tag, label, text, urls }. `label` joins
 * the text (when at most LABEL_MAX characters), aria-label, title and image
 * alt; `urls` are absolute where `baseUrl` resolves them.
 */
export function extractControls(html, baseUrl) {
  const raw = String(html ?? "");
  const out = [];
  const push = (tag, attrs, inner) => {
    const text = plain(inner);
    const alt = String(inner ?? "").match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    const svgTitle = String(inner ?? "").match(/<title[^>]*>([^<]{1,60})<\/title>/i)?.[1] ?? "";
    const label = [text.length <= LABEL_MAX ? text : "", attr(attrs, "aria-label"), attr(attrs, "title"), attr(attrs, "value"), alt, svgTitle]
      .map((s) => decode(s).trim())
      .filter(Boolean)
      .join(" ");
    const urls = [];
    for (const m of String(attrs).matchAll(URL_IN_ATTR)) {
      for (const u of decode(m[1] ?? m[2] ?? "").match(URL_TOKEN) ?? []) {
        try {
          urls.push(new URL(u, baseUrl).href);
        } catch {
          /* not a URL after all */
        }
      }
    }
    out.push({ tag: tag.toLowerCase(), label, text: text.slice(0, 200), urls });
  };
  for (const re of PATTERNS) {
    for (const m of raw.matchAll(re)) if (m[1].toLowerCase() !== "a" || !hasHref(m[2])) push(m[1], m[2], m[3]);
  }
  for (const m of raw.matchAll(INPUT)) push("input", m[1], "");
  return out;
}

// Letter-aware edges: \b treats the final é of "résumé" as a word edge it never finds.
export const RESUME_WORDS = /(?<![\p{L}\p{N}])(resume|résumé|cv|curriculum vitae)(?![\p{L}\p{N}])/iu;
export const RESUME_PATH = /resume|\/cv\b|[-_]cv\.pdf/i;
export const CONTACT_WORDS = /\bcontact\b|get in touch|hire me|say hello|let'?s talk|email me|reach out/i;
export const GITHUB_WORD = /\bgithub\b/i;

const pathOf = (u) => {
  try {
    return new URL(u).pathname;
  } catch {
    return "";
  }
};

/** What the non-link controls show: { resume, github, contact } (github only from a GitHub profile URL or a "GitHub" label). */
export function controlFacts(controls, isGithubProfile) {
  let resume = false;
  let github = false;
  let contact = false;
  for (const c of controls) {
    if (RESUME_WORDS.test(c.label) || c.urls.some((u) => RESUME_PATH.test(pathOf(u)))) resume = true;
    if (c.urls.some(isGithubProfile) || GITHUB_WORD.test(c.label)) github = true;
    if (CONTACT_WORDS.test(c.label) || c.urls.some((u) => /^mailto:/i.test(u))) contact = true;
  }
  return { resume, github, contact };
}
