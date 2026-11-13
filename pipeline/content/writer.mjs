// The writer's shared pieces: the length profiles, the {{id}} placeholders
// and filling them, the draft's shape and the Markdown code assembles (the
// TL;DR block, the hero marker, the call to action). The writer itself is
// pipeline/content/compose.mjs (docs/audits/blog-engine.md).
import { SITE_URL } from "./facts.mjs";

export const CTA = `**Grade your portfolio on PortfolioRank** -> ${SITE_URL}`;
export const SLOTS = ["hero", "inline-1", "inline-2", "inline-3", "inline-4", "inline-5"];

/**
 * A post's length profile (owner, 2026-11-12: lengths vary by topic, tight
 * posts that make the point and deeper analysis posts). `standard` is the
 * default; a draft asks for another through sheet.length. Longer posts get
 * more sections and more images to break the page up.
 */
export const LENGTHS = {
  standard: { name: "standard", min: 700, max: 1000, sections: 3, inline: [2, 3] },
  short: { name: "short", min: 500, max: 750, sections: 2, inline: [1, 2] },
  medium: { name: "medium", min: 1200, max: 1600, sections: 4, inline: [3, 4] },
  long: { name: "long", min: 1800, max: 2200, sections: 5, inline: [4, 5] },
};

/** The length profile of a sheet: its `length` if set, else standard. */
export const lengthOf = (sheet) => LENGTHS[sheet?.length] ?? LENGTHS.standard;
/** What the writer sees of a fact sheet: no queries, no raw values. */
export function sheetForWriter(sheet) {
  return {
    story: sheet.headline,
    angle: sheet.angle,
    ...(sheet.focus ? { focus: sheet.focus } : {}),
    ...(sheet.guidelines?.length ? { editor_guidelines: sheet.guidelines } : {}),
    ...(sheet.ownerNotes ? { owner_notes: sheet.ownerNotes } : {}),
    data_as_of: sheet.dataAsOf.slice(0, 10),
    length: { words: `${lengthOf(sheet).min} to ${lengthOf(sheet).max}`, sections: lengthOf(sheet).sections, inline_images: `${lengthOf(sheet).inline[0]} to ${lengthOf(sheet).inline[1]}` },
    ...(sheet.relatedPosts?.length ? { related_posts: sheet.relatedPosts } : {}),
    facts: sheet.facts.map((f) => ({ placeholder: `{{${f.id}}}`, label: f.label, display: f.display, ...(f.scope ? { scope: f.label } : {}), ...(f.tone === "positive" && f.about ? { site_url: f.about } : {}) })),
    notable_facts: (sheet.notable ?? []).map((n) => n.why),
    ties: (sheet.superlatives ?? []).filter((x) => x.tied).map((x) => ({ claim: x.term, facts: x.factIds.map((i) => `{{${i}}}`), tie_placeholder: `{{${x.tieFactId}}}` })),
    example_sites: (sheet.examples ?? []).map((e) => ({ axis: e.axis, name: e.name, site_url: e.url, fact: `{{${e.factId}}}` })),
    charts: sheet.charts.map((c) => ({ chart_id: c.id, title: c.title })),
    names: sheet.names.map((n) => ({ name: n.name, site: n.domain, site_url: n.url, reason: n.reason })),
    screenshots: sheet.screenshots.map((s) => ({ site_url: s.url, name: s.name })),
  };
}

export const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/** Fills {{id}} placeholders with the facts' displays. Unknown ids stay, for the checks to catch. */
export function fill(text, facts) {
  const byId = new Map(facts.map((f) => [f.id, f.display]));
  return String(text ?? "").replace(PLACEHOLDER, (m, id) => (byId.has(id) ? byId.get(id) : m));
}

/** Puts each sentence of a prose line on its own line (POST_TEMPLATE.md). */
export function oneSentencePerLine(markdown) {
  return String(markdown)
    .split("\n")
    .map((line) => {
      if (/^\s*(#|>|\d+\.|[-*]|\[\[)/.test(line)) return line;
      return line.replace(/([.?!])\s+(?=[A-Z{"])/g, "$1\n");
    })
    .join("\n");
}

/**
 * Layout repairs code can make safely, applied to every draft Gemini
 * returns: a subhead run into the line before it goes on its own line, and
 * the "Try this" heading is exactly that (models echo the instruction into
 * it). Wording and numbers are never touched.
 */
export function normalizeDraft(draft) {
  const body = String(draft?.body ?? "")
    .replace(/([^\n])[ \t]+(###\s)/g, "$1\n\n$2")
    .replace(/^[ \t]+(###\s)/gm, "$1")
    .replace(/^###\s+Try this\b.*$/gim, "### Try this")
    // The hero goes above the body (assembleBody); a writer that also places it in the body loses nothing.
    .replace(/^[ \t]*\[\[image:hero\]\][ \t]*\n?/gm, "");
  return { ...draft, body };
}

/**
 * The post's Markdown from a draft (placeholders still in): the TL;DR block,
 * the hero marker, the body, the call to action. Filling comes after.
 */
export function assembleBody(draft) {
  const tldr = ["> **TL;DR**", ...(draft.tldr ?? []).map((b) => `> - ${String(b).trim()}`)].join("\n");
  const body = oneSentencePerLine(String(draft.body ?? "").trim());
  return [tldr, "[[image:hero]]", body, CTA].join("\n\n");
}

/** Every text field of a draft, as [field, text], for the checks. */
export function draftTexts(draft) {
  return [
    ["title", draft.title],
    ["alt_title_a", draft.alt_title_a],
    ["alt_title_b", draft.alt_title_b],
    ["subtitle", draft.subtitle],
    ["share_line", draft.share_line],
    ["newsletter_blurb", draft.newsletter_blurb],
    ...(draft.tags ?? []).map((t, i) => [`tags[${i}]`, t]),
    ["body", assembleBody(draft)],
    ...(draft.images ?? []).map((im) => [`images.${im.slot}.alt`, im.alt]),
  ].map(([k, v]) => [k, String(v ?? "")]);
}
