// One pass over a page's HTML (the browser-rendered DOM for single-page apps,
// or a plain fetch's HTML in the Worker's quick grade) that reads what the
// facts (./facts.mjs) and the portfolio signals (./signals.mjs) need: every
// link, every control a visitor clicks that is not a plain link, the visible
// text, the title and h1 text, and the attribute values they look in.
//
// Controls are buttons, links without an href, elements with role="button"
// (or link, menuitem, tab), elements with an onclick attribute, and input
// buttons. A "View Resume" button that opens a PDF from script, a GitHub icon
// button, a "Contact" button that scrolls to the form: a person counts them,
// so the facts and signals count them too (facts audit, 2026-11-21:
// scripts/experiments/facts-audit/).
//
// The scanner reads tags the way a browser does (a quote starts a value only
// right after "=", so a stray quote in a name or an unquoted value is kept,
// and a ">" inside a quoted class such as "[&>svg]:size-4" does not end the
// tag), never backtracks, and gives up on a tag at the next "<" or at a quote
// that is never closed. Every character is read a bounded number of times,
// so time is linear in the input: the quick grade runs this on up to 1.5 MB
// from any address a visitor submits.

/** Longest control text read for words: buttons and menu items, not cards of prose. */
export const LABEL_MAX = 60;
/** Characters of text kept per link or control. */
const TEXT_CAP = 300;
/** How far up the open elements a closing tag looks for its match. */
const CLOSE_SEARCH = 64;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = { script: /<\/script/gi, style: /<\/style/gi };
const CONTROL_ROLES = new Set(["button", "link", "menuitem", "tab"]);
// Attributes whose value is a URL a control may open: for the GitHub fact only.
const URL_ATTRS = new Set(["data-href", "data-url", "data-link", "formaction"]);
const isSpace = (c) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
const isLetter = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

export const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");

// A URL a control navigates to from script: window.open('...'), location.href = '...', location.assign('...').
const NAV_IN_SCRIPT = /(?:window\.open|location\.(?:assign|replace))\s*\(\s*(['"`])([^'"`]{1,2000})\1|location(?:\.href)?\s*=\s*(['"`])([^'"`]{1,2000})\3/g;

function resolve(u, baseUrl) {
  try {
    return new URL(u, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Reads `html` once. Returns { links, controls, text, head, attrValues, generator }:
 *   links      every <a> with a non-empty href, in page order: { raw, href, text } as extractLinks gave them
 *   controls   { tag, label, parts, text, navUrls, attrUrls, inLink }: `parts` the label's pieces (text when
 *              at most LABEL_MAX characters, aria-label, title, image alt, an input's value), `navUrls` URLs
 *              it opens from onclick, `attrUrls` URLs in data-href and the like, `inLink` the href of the
 *              link around it, if any
 *   text       the visible text (no script or style), tags as spaces
 *   head       the text of the title and h1 elements
 *   attrValues values of attributes whose name ends in "href" or "id"
 *   generator  the meta generator's content
 */
export function scanPage(html, baseUrl) {
  const s = String(html ?? "");
  const n = s.length;
  const links = [];
  const controls = [];
  const text = [];
  const head = [];
  const attrValues = [];
  let generator = "";
  /** @type {{ name: string, link?: any, control?: any, head?: boolean }[]} */
  const stack = [];
  const openLinks = [];
  const openControls = [];
  let headOpen = 0;
  const noQuote = { '"': false, "'": false };

  const addText = (t) => {
    if (!t || !/\S/.test(t)) return;
    text.push(t);
    if (headOpen) head.push(t);
    const l = openLinks.at(-1);
    if (l && l.len < TEXT_CAP) {
      l.parts.push(t);
      l.len += t.length;
    }
    const c = openControls.at(-1);
    if (c && c.len < TEXT_CAP) {
      c.textParts.push(t);
      c.len += t.length;
    }
  };
  const close = (rec) => {
    if (rec.link) openLinks.splice(openLinks.lastIndexOf(rec.link), 1);
    if (rec.control) openControls.splice(openControls.lastIndexOf(rec.control), 1);
    if (rec.head) headOpen--;
  };

  /**
   * Parses the tag at `i` ("<" then a letter). Returns { end, name, attrs,
   * selfClosing }, or { abort } where it gave up (the next "<", the end, or a
   * quote never closed): what it read is then text, and reading goes on from
   * there, so nothing is read twice.
   */
  const parseTag = (i) => {
    let p = i + 1;
    while (p < n && !isSpace(s[p]) && s[p] !== ">" && s[p] !== "/" && s[p] !== "<") p++;
    const name = s.slice(i + 1, p).toLowerCase();
    const attrs = new Map();
    let selfClosing = false;
    for (;;) {
      while (p < n && (isSpace(s[p]) || s[p] === "/")) {
        selfClosing = s[p] === "/";
        p++;
      }
      if (p >= n || s[p] === "<") return { abort: p };
      if (s[p] === ">") return { end: p + 1, name, attrs, selfClosing };
      selfClosing = false;
      const a0 = p;
      while (p < n && !isSpace(s[p]) && s[p] !== "=" && s[p] !== ">" && s[p] !== "<" && !(s[p] === "/" && s[p + 1] === ">")) p++;
      const attr = s.slice(a0, p).toLowerCase();
      while (p < n && isSpace(s[p])) p++;
      let value = "";
      if (s[p] === "=") {
        p++;
        while (p < n && isSpace(s[p])) p++;
        const q = s[p];
        if (q === '"' || q === "'") {
          if (noQuote[q]) return { abort: p + 1 };
          const j = s.indexOf(q, p + 1);
          if (j < 0) {
            noQuote[q] = true;
            return { abort: p + 1 };
          }
          value = s.slice(p + 1, j);
          p = j + 1;
        } else {
          const v0 = p;
          while (p < n && !isSpace(s[p]) && s[p] !== ">") p++;
          value = s.slice(v0, p);
        }
      }
      if (attr && !attrs.has(attr)) attrs.set(attr, value);
    }
  };

  let i = 0;
  let t0 = 0;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const next = s[lt + 1];
    if (next === "!" || next === "?") {
      addText(s.slice(t0, lt));
      const isComment = s.startsWith("!--", lt + 1);
      const j = isComment ? s.indexOf("-->", lt + 4) : s.indexOf(">", lt + 2);
      if (j < 0) {
        t0 = n;
        break;
      }
      i = t0 = j + (isComment ? 3 : 1);
      continue;
    }
    if (next === "/") {
      addText(s.slice(t0, lt));
      let p = lt + 2;
      while (p < n && !isSpace(s[p]) && s[p] !== ">" && s[p] !== "<") p++;
      const name = s.slice(lt + 2, p).toLowerCase();
      const j = s.indexOf(">", p);
      if (j < 0) {
        t0 = n;
        break;
      }
      for (let k = stack.length - 1; k >= 0 && k >= stack.length - CLOSE_SEARCH; k--) {
        if (stack[k].name !== name) continue;
        while (stack.length > k) close(stack.pop());
        break;
      }
      i = t0 = j + 1;
      continue;
    }
    if (!isLetter(next ?? "")) {
      i = lt + 1;
      continue;
    }
    const tag = parseTag(lt);
    if (tag.abort != null) {
      // Not a tag after all: what was read is text, and reading goes on where it stopped.
      i = Math.max(lt + 1, tag.abort);
      continue;
    }
    addText(s.slice(t0, lt));
    i = t0 = tag.end;
    const { name, attrs } = tag;
    for (const [k, v] of attrs) if (k.endsWith("href") || k.endsWith("id")) attrValues.push(v);
    if (name === "meta" && String(attrs.get("name") ?? "").toLowerCase() === "generator") generator ||= attrs.get("content") ?? "";
    if (RAW[name]) {
      const re = RAW[name];
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) {
        t0 = n;
        break;
      }
      const j = s.indexOf(">", m.index);
      if (j < 0) {
        t0 = n;
        break;
      }
      i = t0 = j + 1;
      continue;
    }
    if (name === "img") {
      const c = openControls.at(-1);
      if (c && attrs.get("alt")) c.alts.push(attrs.get("alt"));
    }
    const rec = { name };
    const href = attrs.get("href");
    const raw = href == null ? "" : decodeEntities(href).trim();
    if (name === "a" && raw) {
      rec.link = { raw, aria: attrs.get("aria-label") ?? "", parts: [], len: 0 };
      links.push(rec.link);
    }
    const role = String(attrs.get("role") ?? "").trim().toLowerCase().split(/\s+/)[0];
    const type = String(attrs.get("type") ?? "").trim().toLowerCase();
    const isControl =
      name === "button" ||
      (name === "a" && href == null) ||
      CONTROL_ROLES.has(role) ||
      attrs.has("onclick") ||
      (name === "input" && (type === "button" || type === "submit"));
    if (isControl && !rec.link) {
      const navUrls = [];
      for (const m of String(attrs.get("onclick") ?? "").matchAll(NAV_IN_SCRIPT)) {
        const u = resolve(decodeEntities(m[2] ?? m[4]), baseUrl);
        if (u) navUrls.push(u);
      }
      const attrUrls = [];
      for (const [k, v] of attrs) {
        if (!URL_ATTRS.has(k)) continue;
        const u = resolve(decodeEntities(v).trim(), baseUrl);
        if (u) attrUrls.push(u);
      }
      rec.control = {
        tag: name,
        aria: attrs.get("aria-label") ?? "",
        title: attrs.get("title") ?? "",
        value: name === "input" ? (attrs.get("value") ?? "") : "",
        alts: [],
        textParts: [],
        len: 0,
        navUrls,
        attrUrls,
        inLink: openLinks.at(-1)?.raw ?? null,
      };
      controls.push(rec.control);
    }
    if (name === "title" || name === "h1") rec.head = true;
    if (VOID.has(name) || tag.selfClosing) continue;
    stack.push(rec);
    if (rec.link) openLinks.push(rec.link);
    if (rec.control) openControls.push(rec.control);
    if (rec.head) headOpen++;
  }
  addText(s.slice(t0, n));

  return {
    links: links
      .map((l) => {
        const href = resolve(l.raw, baseUrl);
        if (!href) return null;
        const t = l.parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
        return { raw: l.raw, href, text: `${t} ${l.aria}`.trim() };
      })
      .filter(Boolean),
    controls: controls.map((c) => {
      const own = decodeEntities(c.textParts.join(" ")).replace(/\s+/g, " ").trim();
      const parts = [own.length <= LABEL_MAX ? own : "", c.aria, c.title, ...c.alts, c.value].map((x) => decodeEntities(x).replace(/\s+/g, " ").trim()).filter(Boolean);
      return { tag: c.tag, label: parts.join(" "), parts, text: own.slice(0, 200), navUrls: c.navUrls, attrUrls: c.attrUrls, inLink: c.inLink };
    }),
    text: text.join(" "),
    head: head.join(" "),
    attrValues,
    generator,
  };
}

/** The HTML with every "<...>" replaced by a space, as /<[^>]+>/g did, in one pass. */
export function stripTags(html) {
  const s = String(html ?? "");
  let out = "";
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break; // no ">" left: the rest stays as it is
    if (gt === lt + 1) {
      out += s.slice(i, gt + 1); // "<>" is not a tag
      i = gt + 1;
      continue;
    }
    out += `${s.slice(i, lt)} `;
    i = gt + 1;
  }
  return out + s.slice(i);
}

/**
 * The HTML without its <name>...</name> elements (a space in their place), as
 * /<name[\s\S]*?<\/name>/gi did, in one pass: once no closing tag is left,
 * none of the later openings has one either.
 */
export function removeElements(html, name) {
  const s = String(html ?? "");
  const open = new RegExp(`<${name}`, "gi");
  const end = new RegExp(`</${name}>`, "gi");
  let out = "";
  let i = 0;
  for (;;) {
    open.lastIndex = i;
    const o = open.exec(s);
    if (!o) break;
    end.lastIndex = o.index;
    const e = end.exec(s);
    if (!e) break;
    out += `${s.slice(i, o.index)} `;
    i = e.index + e[0].length;
  }
  return out + s.slice(i);
}

/** The text of the first <title> element, as /<title[^>]*>([\s\S]*?)<\/title>/i read it, in one pass. */
export function firstTitle(html) {
  const s = String(html ?? "");
  const open = /<title/gi;
  for (let o = open.exec(s); o; o = open.exec(s)) {
    const gt = s.indexOf(">", o.index + 6);
    if (gt < 0) return "";
    const close = /<\/title>/gi;
    close.lastIndex = gt + 1;
    const c = close.exec(s);
    if (!c) return "";
    return s.slice(gt + 1, c.index);
  }
  return "";
}

/** The non-link controls of `html` (scanPage). */
export function extractControls(html, baseUrl) {
  return scanPage(html, baseUrl).controls;
}

// Main's word test for links, kept as it was so a link that counted still counts.
const RESUME_WORD_ASCII = /\b(resume|résumé|cv|curriculum vitae)\b/i;
// The same with letter-aware edges, so "Résumé" and "Resumé" end where a person sees them end.
const RESUME_WORD_LATIN = /(?<![A-Za-z0-9À-ɏ])(resume|résumé|resumé|cv|curriculum vitae)(?![A-Za-z0-9À-ɏ])/i;
/** A resume word in a link's text or address (main's test, plus accented endings). */
export const RESUME_WORDS = { test: (s) => RESUME_WORD_ASCII.test(s) || RESUME_WORD_LATIN.test(s) };
export const RESUME_PATH = /resume|\/cv\b|[-_]cv\.pdf/i;
/**
 * A control label that is a resume and nothing else: "Resume", "View Resume",
 * "Download CV", "Resume.pdf", "下载CV". "Resume slideshow" (a carousel's
 * pause and resume) is not.
 */
const RESUME_LABEL =
  /^[\s\p{P}\p{S}]*(?:(?:view|download|open|see|get|read|check out)\s+)?(?:(?:my|the)\s+)?(?:resume|résumé|resumé|cv|curriculum vitae)(?:\s*\.?\s*pdf)?[\s\p{P}\p{S}]*$/iu;
const CJK_RESUME = /^[\s\p{P}\p{S}]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]*(?:resume|résumé|cv)[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]*[\s\p{P}\p{S}]*$/iu;
export const isResumeLabel = (part) => {
  if (part.length > 120) return false;
  // A word shown twice for a hover effect ("Resume Resume") is read once.
  const p = part.replace(/(\S+)(?:\s+\1)+/giu, "$1");
  return RESUME_LABEL.test(p) || CJK_RESUME.test(p);
};
export const CONTACT_WORDS = /\bcontact\b|get in touch|hire me|say hello|let'?s talk|email me|reach out/i;

/** github.com's own pages: a first path segment that is not a user or an organization. */
export const GH_RESERVED =
  /^(sponsors|topics|features|about|pricing|marketplace|orgs|organizations|settings|notifications|explore|login|join|new|search|apps|collections|readme|site|customer-stories|enterprise|team|security|contact|trending|events|github-copilot)$/i;

/** A GitHub profile or repository URL (not github.com's own pages). */
export function isGithubProfile(href) {
  try {
    const u = new URL(href);
    if (u.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") return false;
    const first = u.pathname.split("/").filter(Boolean)[0];
    return Boolean(first) && !GH_RESERVED.test(first);
  } catch {
    return false;
  }
}

const pathOf = (u) => {
  try {
    return new URL(u).pathname;
  } catch {
    return "";
  }
};

/**
 * What the non-link controls show: { resume, github, contact }. Resume needs a
 * resume-like label or a resume file it opens; GitHub needs a github.com
 * profile or repository URL on the control (the word alone, as in "Sign in
 * with GitHub", is not a link); contact a contact label or a mailto it opens.
 */
export function controlFacts(controls, isGithubProfile) {
  let resume = false;
  let github = false;
  let contact = false;
  for (const c of controls) {
    const urls = [...c.navUrls, ...c.attrUrls];
    if (c.parts.some(isResumeLabel) || urls.some((u) => RESUME_PATH.test(pathOf(u)))) resume = true;
    if (urls.some(isGithubProfile)) github = true;
    if (c.parts.some((p) => p.length <= LABEL_MAX && CONTACT_WORDS.test(p)) || urls.some((u) => /^mailto:/i.test(u))) contact = true;
  }
  return { resume, github, contact };
}
