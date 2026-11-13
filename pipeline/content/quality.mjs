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

// Phrasing that reads like a spreadsheet or misstates the data (the owner's
// grade of the first staging posts, 2026-11-12), each with how to fix it.
const ROBOTIC = [
  [/\ba share of\b/i, 'drop "a share of": say "{{f3}} of the top-graded portfolios ..."'],
  [/\bthe average (?:the )?[a-z -]+ score of\b/i, 'rewrite "the average <axis> score of <group> is": put the group first ("the top-graded portfolios average {{f4}} on visual design")'],
  [/\brepresenting a tie\b|\ba tie across\b/i, 'say which items tie and at what, never "a tie across N axes"'],
  [/\b(?:S and A|S or A|A and S)\b|\btop tier S\b|\btier S\b|\bS-tier\b|\bS tier\b/, 'call the top group "the top-graded portfolios" or "the top {{share}}", never by tier letters'],
  [/\b(?:thousands|hundreds|dozens) of (?:sites|portfolios|developer)/i, "give the size of the data only with its count placeholder"],
];

/**
 * Substance (owner, 2026-11-12): no robotic or garbled phrasing, every
 * TL;DR point made in the body with the same placeholder, no subhead without
 * content under it, no two sentences in a row starting with the same word,
 * and at least three named, linked example sites when the sheet names three.
 */
export function checkSubstance(draft, sheet) {
  const p = [];
  const body = String(draft.body ?? "");
  const prose = [body, ...(draft.tldr ?? []), draft.title ?? "", draft.subtitle ?? ""].join("\n");
  for (const [re, fix] of ROBOTIC) {
    const m = prose.match(re);
    if (m) p.push(`"${m[0]}": ${fix}`);
  }
  const inBody = new Set(ids(body));
  (draft.tldr ?? []).forEach((b, i) => {
    const missing = ids(b).filter((id) => !inBody.has(id));
    if (missing.length) p.push(`TL;DR bullet ${i + 1} uses ${missing.map((m) => `{{${m}}}`).join(", ")}, which the body never mentions: make that point in the body too, or change the bullet`);
  });
  const lines = body.split("\n");
  lines.forEach((l, i) => {
    if (!/^###\s/.test(l)) return;
    const next = lines.slice(i + 1).findIndex((x) => /^###\s/.test(x));
    const under = lines.slice(i + 1, next < 0 ? undefined : i + 1 + next).filter((x) => x.trim() && !/^\[\[image:/.test(x.trim()));
    if (!under.length) p.push(`subhead "${l.slice(4).trim()}" has nothing under it`);
  });
  const starts = lines
    .filter((l) => l.trim() && !/^(#|>|\[\[|\d+\.|[-*]\s)/.test(l.trim()))
    .map((l) => l.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z{}0-9]/g, ""));
  for (let i = 1; i < starts.length; i++) {
    // Articles open sentences naturally; repeating any other first word in a row reads robotic.
    if (starts[i] && starts[i] === starts[i - 1] && !starts[i].startsWith("{{") && !["the", "a", "an"].includes(starts[i])) {
      p.push(`two sentences in a row start with "${starts[i]}": vary how sentences begin`);
      break;
    }
  }
  const sites = new Set((sheet.names ?? []).map((n) => String(n.url).replace(/\/$/, "")));
  const need = Math.min(3, sites.size);
  const linked = new Set([...body.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1].replace(/\/$/, "")).filter((u) => sites.has(u)));
  if (linked.size < need) p.push(`${linked.size} named example site(s) linked; link at least ${need} from the names list as [Name](site_url), each with what it does well`);
  return result("substance", p);
}
