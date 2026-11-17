// Whether a sentence is built from the fact sheet, decided by code, so an
// outside claim never depends on the reviewer alone (2026-11-16 review).
//
// The writer fills {{id}} placeholders with the sheet's facts, and each fact
// about one listed site carries that site's URL (`about`, facts.mjs). A
// sentence that names a listed site is therefore "ours" (PortfolioRank's own
// data) only when it holds a placeholder of a fact about that very site, for
// every listed site it names, and says nothing that reads as a statement about
// the world (hiring, studies, what companies do). A sentence that names a site
// without such a fact is free text the model added around a name: it is an
// outside claim whether or not the reviewer flagged it. The one exception is
// advice to the reader (a numbered step, or a sentence that speaks to "you"
// and states no outside fact or number), which claims nothing.
import { SENTENCE_BREAK, FIELDS, plain } from "./claims.mjs";
import { PLACEHOLDER, fill } from "./writer.mjs";

const OUTSIDE_WORDS = /\b(recruit\w*|hir(?:e|es|ed|ing)|employ\w*|compan(?:y|ies)|stud(?:y|ies)|survey\w*|research\w*|reports?|reported|according|analysts?|experts?|say|says|said|found|percent|industry|market|managers?)\b/i;
const SKIP_LINE = /^\s*(#|\[\[)/;
const stripLinks = (s) => String(s).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
const trimUrl = (u) => String(u ?? "").replace(/\/$/, "");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The draft's prose sentences, unfilled and filled: [{ raw, text, key, ids }]. */
export function draftSentences(draft, facts) {
  const out = [];
  const add = (text) => {
    for (const line of String(text ?? "").split("\n")) {
      if (!line.trim() || SKIP_LINE.test(line)) continue;
      for (const raw of line.split(SENTENCE_BREAK)) {
        if (!raw.trim() || /^\s+$/.test(raw)) continue;
        const filled = fill(raw, facts).trim();
        out.push({ raw, text: stripLinks(filled).replace(/^[>\-*\s]+/, "").trim(), key: plain(filled), ids: [...raw.matchAll(new RegExp(PLACEHOLDER.source, "gi"))].map((m) => m[1]) });
      }
    }
  };
  for (const f of FIELDS) add(draft[f]);
  for (const b of draft.tldr ?? []) add(b);
  return out.filter((s) => s.key);
}

/** The listed sites a sentence names, by name (whole word) or by a link to the site. */
function sitesNamed(s, sheet) {
  const filled = fill(s.raw, sheet.facts);
  return (sheet.names ?? []).filter((n) => {
    const url = trimUrl(n.url);
    if (url && [...filled.matchAll(/\]\(([^)\s]+)\)/g)].some((m) => trimUrl(m[1]) === url)) return true;
    const name = String(n.name ?? "").trim();
    return name && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name)}(?=$|[^\\p{L}\\p{N}])`, "u").test(stripLinks(filled));
  });
}

/** Marks each sentence with the sites it names and whether the sheet backs it. */
function classify(sentences, sheet) {
  const aboutOf = new Map((sheet.facts ?? []).filter((f) => f.about).map((f) => [f.id, trimUrl(f.about)]));
  for (const s of sentences) {
    s.named = sitesNamed(s, sheet);
    s.factIds = s.ids.filter((id) => (sheet.facts ?? []).some((f) => f.id === id));
    const aboutIds = new Set(s.factIds.map((id) => aboutOf.get(id)).filter(Boolean));
    const backed = s.named.length > 0 && s.named.every((n) => aboutIds.has(trimUrl(n.url)));
    const residual = s.named.reduce((t, n) => t.split(n.name).join(" "), s.text);
    s.ours = backed && !OUTSIDE_WORDS.test(residual);
    // Advice to the reader that points at an example ("Open your portfolio and improve X, the way [Name](url).",
    // a numbered Try this step) states nothing about the world, so code does not flag it on its own.
    const bare = s.named.reduce((t, n) => t.split(n.name).join(" "), stripLinks(s.raw).replace(new RegExp(PLACEHOLDER.source, "gi"), " "));
    s.advice = (/^\s*\d+\.\s/.test(s.raw) || /\byou(?:r|rs)?\b/i.test(residual)) && !OUTSIDE_WORDS.test(residual) && !/\d/.test(bare.replace(/^\s*\d+\.\s/, ""));
  }
  return sentences;
}

/**
 * Splits what the review flagged and what the code finds on its own.
 * Returns { check: [{ sentence, by }] (to search or cut), ours: [{ sentence, by,
 * facts }] (built only from sheet facts: not searched, not cut) }.
 * Every sentence that names a listed site without a sheet fact about it is
 * added to `check` with by "code", flagged or not.
 */
export function splitFlags(draft, sheet, reviewFlags) {
  const sentences = classify(draftSentences(draft, sheet.facts), sheet);
  const check = [];
  const ours = [];
  const covered = new Set();
  const seen = new Set();
  for (const flag of reviewFlags) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    const key = plain(flag);
    const hits = sentences.filter((s) => s.key.includes(key) || (s.key.length >= 12 && key.includes(s.key)));
    hits.forEach((h) => covered.add(h));
    if (hits.length && hits.every((h) => h.ours)) ours.push({ sentence: flag, by: "review", facts: [...new Set(hits.flatMap((h) => h.factIds))] });
    else check.push({ sentence: flag, by: "review" });
  }
  for (const s of sentences) {
    if (covered.has(s) || !s.named.length || s.ours || s.advice) continue;
    if (check.some((c) => plain(c.sentence) === s.key)) continue;
    check.push({ sentence: s.text, by: "code" });
  }
  return { check, ours };
}
