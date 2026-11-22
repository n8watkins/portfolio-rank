// The audit's broad DOM probe: runs in the page (page.evaluate) after the
// page has had every chance to render and has been scrolled through. It is
// deliberately wider than the code under test (pipeline/facts.mjs,
// pipeline/signals.mjs) and shares nothing with it: every link, button,
// role=button, onclick, tabindex and pointer-cursor element with its label
// (text, aria-label, title, alt, value), any URL it carries (href, onclick,
// data-*), whether it is visible, and where it is; headings; ids; embedded
// PDFs; forms. The audit decides the truth from this and the screenshots.
export function domProbe() {
  const MAX = 4000;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const labelOf = (el) =>
    clean(
      [
        (el.innerText ?? el.textContent ?? "").slice(0, 200),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("alt"),
        el.querySelector?.("img[alt]")?.getAttribute("alt"),
        el.querySelector?.("svg title")?.textContent,
        el.getAttribute("value"),
        el.getAttribute("download"),
      ]
        .filter(Boolean)
        .join(" | ")
    ).slice(0, 160);
  const urlsOf = (el) => {
    const out = [];
    if (el.href && typeof el.href === "string") out.push(el.href);
    for (const a of el.attributes) {
      if (a.name === "href") continue;
      const m = String(a.value).match(/https?:\/\/[^\s'"`)]+|mailto:[^\s'"`)]+|tel:[^\s'"`)]+|[\w./-]+\.pdf\b/gi);
      if (m) out.push(...m.map((u) => `${a.name}=${u}`));
    }
    return out.slice(0, 6);
  };
  const where = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const seen = new Set();
  const clickables = [];
  const add = (el, via) => {
    if (seen.has(el) || clickables.length >= MAX) return;
    seen.add(el);
    clickables.push({ tag: el.tagName.toLowerCase(), via, label: labelOf(el), urls: urlsOf(el), onclick: Boolean(el.getAttribute("onclick")), visible: isVisible(el), box: where(el) });
  };
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [onclick], input[type="button"], input[type="submit"], summary')) add(el, "semantic");
  for (const el of document.querySelectorAll("[tabindex]")) if (el.getAttribute("tabindex") !== "-1") add(el, "tabindex");
  // Pointer-cursor elements with a short label that are not inside one already listed.
  let scanned = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (++scanned > 20000) break;
    if (seen.has(el) || el.closest("a, button, [role=button], [role=link]")) continue;
    if (getComputedStyle(el).cursor !== "pointer") continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === "pointer" && !seen.has(parent)) continue; // the outermost pointer element stands for it
    const label = labelOf(el);
    if (label.length > 0 && label.length <= 80) add(el, "pointer");
  }
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
    .slice(0, 300)
    .map((h) => ({ tag: h.tagName.toLowerCase(), text: clean(h.innerText ?? h.textContent).slice(0, 120), visible: isVisible(h), y: where(h).y }));
  const ids = [...document.querySelectorAll("[id]")]
    .map((e) => e.id)
    .filter((id) => /project|work|portfolio|about|contact|resume|\bcv\b|experience|skill/i.test(id))
    .slice(0, 60);
  const embeds = [...document.querySelectorAll("iframe, embed, object")].map((e) => e.getAttribute("src") || e.getAttribute("data") || "").filter(Boolean).slice(0, 20);
  const forms = document.querySelectorAll("form").length;
  const emailInputs = document.querySelectorAll('input[type="email"], textarea').length;
  return {
    title: document.title,
    text: document.body?.innerText ?? "",
    htmlChars: document.documentElement.outerHTML.length,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    clickables,
    headings,
    ids,
    embeds,
    forms,
    emailInputs,
  };
}
