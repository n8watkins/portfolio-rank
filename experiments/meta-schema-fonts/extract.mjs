// Functions that run inside the page (page.evaluate). They must stay
// self-contained: no closures over module scope.

/** Head tags, JSON-LD bodies, microdata and RDFa types from the current DOM. */
export function readHead() {
  const meta = (attr, key) => {
    for (const m of document.querySelectorAll(`meta[${attr}]`)) {
      if ((m.getAttribute(attr) || "").trim().toLowerCase() === key) return (m.getAttribute("content") || "").trim();
    }
    return null;
  };
  const any = (key) => meta("property", key) ?? meta("name", key);
  const rels = (rel) =>
    [...document.querySelectorAll("link[rel]")]
      .filter((l) => l.getAttribute("rel").toLowerCase().split(/\s+/).includes(rel))
      .map((l) => l.getAttribute("href"));
  const microdata = [...document.querySelectorAll("[itemscope]")].map((el) => {
    const props = {};
    for (const p of el.querySelectorAll("[itemprop]")) {
      if (p.closest("[itemscope]") !== el && p !== el) continue;
      const k = p.getAttribute("itemprop");
      if (props[k]) continue;
      props[k] = (p.getAttribute("content") || p.getAttribute("href") || p.getAttribute("src") || p.textContent || "").trim().slice(0, 200);
    }
    return { type: el.getAttribute("itemtype"), nested: !!el.parentElement?.closest("[itemscope]"), props };
  });
  const titleEl = document.querySelector("head title") || document.querySelector("title");
  return {
    title: titleEl ? titleEl.textContent.trim() : null,
    titleCount: document.querySelectorAll("title").length,
    description: meta("name", "description"),
    canonical: rels("canonical"),
    og: {
      title: any("og:title"),
      description: any("og:description"),
      image: any("og:image") ?? any("og:image:url") ?? any("og:image:secure_url"),
      url: any("og:url"),
      type: any("og:type"),
    },
    twitter: { card: any("twitter:card"), title: any("twitter:title"), image: any("twitter:image") ?? any("twitter:image:src") },
    jsonld: [...document.querySelectorAll('script[type="application/ld+json" i]')].map((s) => s.textContent),
    microdata,
    rdfa: [...document.querySelectorAll("[typeof]")].map((el) => el.getAttribute("typeof")).slice(0, 20),
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
    lang: document.documentElement.getAttribute("lang"),
    viewport: meta("name", "viewport"),
    icons: [...rels("icon"), ...rels("apple-touch-icon")].filter(Boolean),
    scripts: [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).slice(0, 200),
    // Inline scripts, trimmed: only the first 2 KB of each, enough for analytics snippets.
    inline: [...document.querySelectorAll("script:not([src])")]
      .map((s) => s.textContent)
      .filter((t) => /gtag|googletagmanager|GTM-|plausible|fathom|umami|posthog|hotjar|clarity|cloudflareinsights|_vercel|analytics|matomo|_paq|mixpanel|segment|sentry|goatcounter/i.test(t))
      .map((t) => t.slice(0, 2000)),
    // Subresources requested over plain http (mixed content on an https page).
    insecure: [...document.querySelectorAll("script[src], img[src], iframe[src], link[rel~=stylesheet][href], video[src], audio[src], source[src]")]
      .map((el) => el.getAttribute("src") || el.getAttribute("href"))
      .filter((u) => /^http:\/\//i.test(u || ""))
      .slice(0, 20),
  };
}

/**
 * Visible text grouped by computed font-family stack. Tags up to 3 sample
 * elements per stack with data-msf-id so the caller can ask the browser
 * (CDP CSS.getPlatformFontsForNode) which font actually drew them.
 */
export function readFonts() {
  const groups = new Map();
  let next = 0;
  const seen = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"].includes(el.tagName)) continue;
    // Not opacity: text that fades in on scroll or after a delay is still the page's text.
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size < 4) continue;
    const stack = cs.fontFamily;
    const body = size <= 22 && (text.length >= 60 || !!el.closest("p, li, dd, blockquote, td, article p"));
    let g = groups.get(stack);
    if (!g) groups.set(stack, (g = { stack, chars: 0, bodyChars: 0, elements: 0, sampleIds: [], sampleText: [], pua: 0 }));
    g.chars += text.length;
    if (body) g.bodyChars += text.length;
    // Private-use characters are icon-font glyphs.
    g.pua += (text.match(/[-]/g) || []).length;
    if (!seen.has(el)) {
      seen.add(el);
      g.elements++;
      if (g.sampleIds.length < 3) {
        const id = String(next++);
        el.setAttribute("data-msf-id", id);
        g.sampleIds.push(id);
        g.sampleText.push(text.slice(0, 40));
      }
    }
  }
  const webfonts = [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ""), status: f.status }));
  return { groups: [...groups.values()], webfonts, textChars: [...groups.values()].reduce((a, g) => a + g.chars, 0) };
}
