// The content-quality checks (owner decisions, 2026-11-10; see
// docs/content/POST_TEMPLATE.md): real paragraphs, superlatives that are
// true against the fact sheet (ties included), a callout that restates one
// fact with its scope, a hook from a notable fact, and Try this steps that
// point to a named positive example. Each returns { name, ok, problems }.
import { PLACEHOLDER, draftTexts } from "./writer.mjs";

const result = (name, problems) => ({ name, ok: problems.length === 0, problems });
const ids = (text) => [...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]);

const SENTENCE_END = /([.?!]["')\]]?)(?:\s+|$)/g;
/** Sentences in some lines of prose, whether or not each sits on its own line. */
export const countSentences = (lines) => lines.join(" ").split(SENTENCE_END).filter((x, i) => i % 2 === 0 && x.trim()).length;

/** Prose paragraphs of a body: blocks between blank lines that are not headings, quotes, lists or image markers. */
export function proseParagraphs(body) {
  const paras = [];
  let cur = [];
  const end = () => {
    if (cur.length) paras.push({ lines: cur, sentences: countSentences(cur) });
    cur = [];
  };
  for (const raw of String(body).split("\n")) {
    const l = raw.trim();
    if (!l || /^(#{1,6}\s|>|\d+\.\s|[-*]\s|\[\[image:)/.test(l)) end();
    else cur.push(l);
  }
  end();
  return paras;
}

/**
 * Real paragraphs: two to four sentences each, an opener before the first
 * subhead, a closing takeaway after Try this, and never mostly one-sentence
 * paragraphs.
 */
export function checkParagraphs(draft) {
  const p = [];
  const body = String(draft.body ?? "").trim();
  const paras = proseParagraphs(body);
  const single = paras.filter((x) => x.sentences < 2);
  if (paras.length && single.length * 2 > paras.length) p.push(`${single.length} of ${paras.length} paragraphs are a single sentence; write real paragraphs of 2 to 4 sentences`);
  for (const x of paras) if (x.sentences > 4) p.push(`a paragraph has ${x.sentences} sentences (starts "${x.lines[0].slice(0, 40)}"); 2 to 4 wanted, split it`);
  const firstHead = body.search(/^###\s/m);
  const opener = proseParagraphs(firstHead < 0 ? body : body.slice(0, firstHead))[0];
  if (!opener) p.push("the post needs an opening paragraph before the first subhead");
  else if (opener.sentences < 2) p.push("the opening paragraph needs 2 to 4 sentences, starting with the hook");
  const tryAt = body.search(/^###\s+Try this\s*$/im);
  if (tryAt >= 0) {
    const after = body.slice(tryAt).split("\n").slice(1);
    let last = after.length;
    while (last > 0 && !/^\s*\d+\.\s/.test(after[last - 1])) last--;
    const closing = proseParagraphs(after.slice(last).join("\n"));
    if (!closing.length) p.push("a closing paragraph with the takeaway is needed after Try this");
    else if (closing[0].sentences < 2) p.push("the closing takeaway needs 2 or 3 sentences");
  }
  return result("paragraphs", p);
}

const SUPERLATIVE = /\b(?:larg(?:est|er)|big(?:gest|ger)|wid(?:est|er)|great(?:est|er)|small(?:est|er)|narrow(?:est|er)|most|least|lowest|highest|only|sole|alone|unique)\b/i;
const TIE_WORD = /\b(?:tie[ds]?|tying|joint(?:ly)?|both|equal(?:ly)?|shared?|level)\b/i;
const sentencesOf = (text) => String(text).split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

/**
 * Superlatives must be true against the sheet, ties included: a sentence
 * that says largest, smallest, most or only about a fact whose extreme is
 * shared must name the tie (the tie placeholder, or "tied", "both" ...).
 */
export function checkSuperlatives(draft, sheet) {
  const p = [];
  const tied = (sheet.superlatives ?? []).filter((x) => x.tied);
  if (!tied.length) return result("superlatives", p);
  for (const [field, text] of draftTexts(draft)) {
    if (field.startsWith("images.") || field.startsWith("tags")) continue;
    for (const sentence of sentencesOf(text)) {
      if (!SUPERLATIVE.test(sentence)) continue;
      const here = new Set(ids(sentence));
      for (const t of tied) {
        if (!t.factIds.some((i) => here.has(i)) || here.has(t.tieFactId) || TIE_WORD.test(sentence)) continue;
        p.push(`${field}: "${sentence.slice(0, 110)}" gives the ${t.term} to one item, but the sheet shows a tie (use the tie facts and say tied)`);
      }
    }
  }
  return result("superlatives", p);
}

/** The callout restates exactly one numeric fact with its full scope. */
export function checkCallout(draft, sheet) {
  const p = [];
  const lines = String(draft.body ?? "").split("\n");
  const at = lines.findIndex((l) => /^>\s*\*\*[^*]+\*\*/.test(l));
  if (at < 0) return result("callout", p);
  const quote = [];
  for (let i = at; i < lines.length && /^>/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ""));
  const text = quote.join(" ");
  const byId = new Map(sheet.facts.map((f) => [f.id, f]));
  const numeric = [...new Set(ids(text))].map((i) => byId.get(i)).filter((f) => f && typeof f.value === "number");
  if (numeric.length !== 1) p.push(`the callout must restate exactly one numeric fact, it has ${numeric.length}`);
  const f = numeric[0];
  if (numeric.length === 1) {
    if (f.scope?.need && !new RegExp(f.scope.need, "i").test(text)) p.push(`the callout leaves out the scope of "${f.label}": say who the figure covers`);
    if (f.scope?.avoid && new RegExp(f.scope.avoid, "i").test(text)) p.push(`the callout gives "${f.label}" the wrong scope`);
  }
  return result("callout", p);
}

/** The first TL;DR bullet and the opener lead with a notable fact. */
export function checkHook(draft, sheet) {
  const notable = sheet.notable ?? [];
  if (!notable.length) return result("hook", []);
  const body = String(draft.body ?? "");
  const firstHead = body.search(/^###\s/m);
  const used = new Set(ids(`${(draft.tldr ?? [])[0] ?? ""}\n${firstHead < 0 ? body : body.slice(0, firstHead)}`));
  const ok = notable.some((n) => n.factIds.every((i) => used.has(i)));
  return result("hook", ok ? [] : ["lead with a notable fact: the opener and first TL;DR bullet must use all the placeholders of one fact listed under notable_facts"]);
}

/** Try this points to a named positive example where the sheet has one. */
export function checkActions(draft, sheet) {
  const examples = sheet.examples ?? [];
  const body = String(draft.body ?? "");
  const tryAt = body.search(/^###\s+Try this\s*$/im);
  if (!examples.length || tryAt < 0) return result("actions", []);
  const steps = body.slice(tryAt).split("\n").filter((l) => /^\s*\d+\.\s/.test(l));
  const links = steps.flatMap((l) => [...l.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1].replace(/\/$/, "")));
  const allowed = new Set(examples.map((e) => e.url.replace(/\/$/, "")));
  return result("actions", links.some((u) => allowed.has(u)) ? [] : ["at least one Try this step should point to a named example site from example_sites, as a Markdown link"]);
}
