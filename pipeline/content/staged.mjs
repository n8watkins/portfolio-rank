// The staged writer (WRITER_MODE "staged"; owner request, 2026-11-10). The
// single-request writer asks for a whole post at once; this one writes it
// in steps, each with a narrower job and only the facts it needs:
//   1. outline: the hook (a notable fact), the title and alt titles, the
//      three TL;DR bullets, the sections with their fact ids and intent,
//      the callout fact, the three actions and the images. Code checks its
//      structure and asks again (once) before any section is written.
//   2. sections: each written from only its facts as paragraphs of 2 to 4
//      sentences; one section per request.
//   3. finish: one request assembles the opener, callout, Try this and
//      closing around the sections, smooths transitions, removes repetition
//      and finalises the titles.
// 5 requests when the outline passes (6 after a retry); facts stay
// {{placeholders}} throughout, and every code check runs on the result.
import { OPTIONS, RESPONSE_SCHEMA, sheetForWriter, PLACEHOLDER } from "./writer.mjs";

/** Writer modes (the Worker variable WRITER_MODE). */
export const WRITER_MODES = ["single", "staged"];
/** The mode used when WRITER_MODE is unset or unknown. */
export const DEFAULT_WRITER_MODE = "staged";
export class OutlineError extends Error {}
export const SECTIONS = 3;
// One section per request (owner, 2026-11-12): asked for two at once,
// Flash-Lite wrote each far shorter than asked and drafts came back at
// about 400 words.
export const SECTIONS_PER_REQUEST = 1;

/** Words in some prose (placeholders count as one word each). */
const countWords = (t) =>
  String(t ?? "")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}{]/u.test(w)).length;
/** Requests the staged write takes when the outline passes first time. */
export const STAGED_REQUESTS = 1 + Math.ceil(SECTIONS / SECTIONS_PER_REQUEST) + 1;

export function writerMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return WRITER_MODES.includes(v) ? v : DEFAULT_WRITER_MODE;
}

const STR = { type: "STRING" };
const STRS = { type: "ARRAY", items: STR };

export const OUTLINE_SCHEMA = {
  type: "OBJECT",
  properties: {
    hook_fact_ids: STRS,
    title: STR,
    alt_title_a: STR,
    alt_title_b: STR,
    subtitle: STR,
    tags: STRS,
    share_line: STR,
    newsletter_blurb: STR,
    tldr: STRS,
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { subhead: STR, intent: STR, fact_ids: STRS },
        required: ["subhead", "intent", "fact_ids"],
        propertyOrdering: ["subhead", "intent", "fact_ids"],
      },
    },
    callout_fact_id: STR,
    actions: STRS,
    images: RESPONSE_SCHEMA.properties.images,
  },
  required: ["hook_fact_ids", "title", "alt_title_a", "alt_title_b", "subtitle", "tags", "share_line", "newsletter_blurb", "tldr", "sections", "callout_fact_id", "actions", "images"],
  propertyOrdering: ["hook_fact_ids", "title", "alt_title_a", "alt_title_b", "subtitle", "tags", "share_line", "newsletter_blurb", "tldr", "sections", "callout_fact_id", "actions", "images"],
};

export const SECTIONS_SCHEMA = {
  type: "OBJECT",
  properties: { sections: { type: "ARRAY", items: { type: "OBJECT", properties: { subhead: STR, paragraphs: STRS }, required: ["subhead", "paragraphs"], propertyOrdering: ["subhead", "paragraphs"] } } },
  required: ["sections"],
};

const STAGE_OPTIONS = { ...OPTIONS, maxOutputTokens: 3072 };
const json = (x) => JSON.stringify(x, null, 1);

export function buildOutlineRequest(sheet, problems = [], previous = null) {
  const text = [
    "Plan one post from this fact sheet. Do not write the body yet.",
    `Plan: hook_fact_ids are the placeholder ids (like f3, without braces) of ONE notable fact to lead with; title and alt titles; subtitle; tags (2 to 4); share_line and newsletter_blurb; tldr with exactly three bullets, each containing at least one {{placeholder}}, the first built on the hook, every bullet a point one of the sections makes with the same placeholders; exactly ${SECTIONS} sections, each with a subhead that says what it proves, a one-line intent that matches the subhead and the ids of the facts it will use (every fact id exists in the sheet, no fact in two sections; spread the named sites' positive facts over the sections so at least three named sites are each linked in a section when the sheet names three or more); callout_fact_id: the id of ONE numeric fact for the pull quote; actions: three concrete steps a reader can do today (where example_sites lists a site strong on the step's axis, say which site to point to); images: a hero and 2 or 3 inline images as described in the rules.`,
    ...(problems.length ? ["", "Your earlier plan failed these checks:", ...problems.map((p) => `- ${p}`), "<earlier_plan>", json(previous), "</earlier_plan>"] : []),
    "",
    "<fact_sheet>",
    json(sheetForWriter(sheet)),
    "</fact_sheet>",
  ].join("\n");
  return { parts: [{ text }], schema: OUTLINE_SCHEMA, options: STAGE_OPTIONS };
}

/** Structure checks on an outline: problems as strings (empty means fine). */
export function checkOutline(o, sheet) {
  const p = [];
  const ids = new Set(sheet.facts.map((f) => f.id));
  const byId = new Map(sheet.facts.map((f) => [f.id, f]));
  const known = (id) => ids.has(String(id).replace(/[{}]/g, ""));
  if (!o?.title?.trim()) p.push("title is empty");
  if (!o?.alt_title_a?.trim() || !o?.alt_title_b?.trim()) p.push("two alternative titles are needed");
  if ((o?.tldr ?? []).length !== 3) p.push(`tldr has ${(o?.tldr ?? []).length} bullets, exactly 3 needed`);
  (o?.tldr ?? []).forEach((b, i) => {
    const ph = [...String(b).matchAll(PLACEHOLDER)];
    if (!ph.length) p.push(`tldr bullet ${i + 1} has no placeholder`);
    for (const m of ph) if (!ids.has(m[1])) p.push(`tldr bullet ${i + 1}: unknown placeholder ${m[0]}`);
  });
  const secs = o?.sections ?? [];
  if (secs.length !== SECTIONS) p.push(`${secs.length} sections, exactly ${SECTIONS} needed`);
  const used = new Map();
  secs.forEach((s, i) => {
    if (!String(s.subhead ?? "").trim()) p.push(`section ${i + 1} has no subhead`);
    if (!(s.fact_ids ?? []).length) p.push(`section ${i + 1} has no facts`);
    for (const id of s.fact_ids ?? []) {
      if (!known(id)) p.push(`section ${i + 1}: unknown fact ${id}`);
      else if (used.has(id)) p.push(`fact ${id} is in sections ${used.get(id)} and ${i + 1}`);
      else used.set(id, i + 1);
    }
  });
  const hook = (o?.hook_fact_ids ?? []).map((i) => String(i).replace(/[{}]/g, ""));
  if (!(sheet.notable ?? []).length) {
    /* nothing to lead with */
  } else if (!(sheet.notable ?? []).some((n) => n.factIds.every((i) => hook.includes(i)))) p.push("the hook must use all the facts of one notable fact");
  // Every TL;DR placeholder is planned into a section, so the body covers it.
  const planned = new Set([...used.keys()].map((i) => String(i).replace(/[{}]/g, "")));
  (o?.tldr ?? []).forEach((b, i) => {
    const missing = [...String(b).matchAll(PLACEHOLDER)].map((m) => m[1]).filter((id) => ids.has(id) && !planned.has(id) && !hook.includes(id));
    if (missing.length) p.push(`tldr bullet ${i + 1} uses ${missing.map((m) => `{{${m}}}`).join(", ")}, which no section covers: plan it into a section`);
  });
  // At least three named sites (when the sheet names three), each through one of its positive facts.
  const sites = new Set(sheet.names.map((n) => n.url));
  const need = Math.min(3, sites.size);
  const linked = new Set([...planned].map((id) => byId.get(id)).filter((f) => f?.tone === "positive" && sites.has(f.about)).map((f) => f.about));
  if (linked.size < need) p.push(`sections plan the positive facts of ${linked.size} named site(s); plan at least ${need}, so each can be linked with what it does well`);
  const c = byId.get(String(o?.callout_fact_id ?? "").replace(/[{}]/g, ""));
  if (!c || typeof c.value !== "number") p.push("callout_fact_id must be a numeric fact in the sheet");
  if ((o?.actions ?? []).length !== 3) p.push(`${(o?.actions ?? []).length} actions, exactly 3 needed`);
  const slots = (o?.images ?? []).map((i) => i.slot);
  if (!slots.includes("hero") || slots.filter((s) => s !== "hero").length < 2) p.push("images need a hero and 2 or 3 inline slots");
  return p;
}

/** The facts a section may use, as the writer sees them. */
function factsFor(sheet, ids) {
  const view = sheetForWriter(sheet);
  const want = new Set(ids.map((i) => `{{${String(i).replace(/[{}]/g, "")}}}`));
  return { facts: view.facts.filter((f) => want.has(f.placeholder)), ties: view.ties.filter((t) => t.facts.some((x) => want.has(x))) };
}

export function buildSectionsRequest(sheet, outline, indexes) {
  const text = [
    "Write these sections of a blog post. Each section is two or three paragraphs; every paragraph has two to four sentences, with each sentence on its own line and no paragraph of one sentence. Use only the facts listed for that section, written as their {{placeholders}}; never type a digit. Where a tie is listed, say the items tie. Be concrete, no filler, nothing about how PortfolioRank is built or run. Each section is at least 200 and at most 260 words (three paragraphs is usual),  written like a person (never copy a fact label, never \"a share of\", call the top group \"the top-graded portfolios\", no tier letters, no sizes in words); where the section has named example sites, link each as [Name](site_url) and say what it does well; the whole post must stay under 1,000 words.",
    "",
    `Post title: ${outline.title}`,
    ...indexes.flatMap((i) => {
      const s = outline.sections[i];
      return ["", `<section n="${i + 1}">`, `subhead: ${s.subhead}`, `intent: ${s.intent}`, "facts:", json(factsFor(sheet, s.fact_ids)), "</section>"];
    }),
  ].join("\n");
  return { parts: [{ text }], schema: SECTIONS_SCHEMA, options: STAGE_OPTIONS };
}

export function buildFinishRequest(sheet, outline, sections) {
  const text = [
    "Finish this post. Write the body in Markdown from the plan and the sections below: an opener paragraph that starts with the hook and ends with the one takeaway the reader can use on their own portfolio, addressed to them: its last sentence says \"you\" and asks them to do one thing on their portfolio, within the first 150 words (two to four sentences), then the three sections exactly as written below, at their full length (keep every paragraph; only smooth the transitions and drop a sentence that repeats another word for word; keep each paragraph two to four sentences and keep their {{placeholders}}; never summarise or shorten a section), the callout of two quote lines, \"### Try this\" with the three numbered steps, and a closing takeaway paragraph of two or three sentences. Put [[image:inline-1]], [[image:inline-2]] (and inline-3 if planned) after the paragraph each supports. Finalise the title and alt titles. Return the whole post in the response shape; tldr, tags, share_line, newsletter_blurb and images may stay as planned. Total body: 700 to 1,000 words; under 665 or over 1,050 fails, count the words of the sections below: they already make most of the length, so keep them whole. Check before returning: every TL;DR bullet is covered in the body with the same placeholder, each subhead matches its section, at least three named example sites are linked when the sheet has three, and no two sentences in a row start with the same word.",
    "",
    "<plan>",
    json({ ...outline, sections: outline.sections.map((s, i) => ({ ...s, written: sections[i] })) }),
    "</plan>",
    "",
    "<fact_sheet>",
    json(sheetForWriter(sheet)),
    "</fact_sheet>",
  ].join("\n");
  return { parts: [{ text }], schema: RESPONSE_SCHEMA, options: { ...OPTIONS, maxOutputTokens: 6144 } };
}

/**
 * Writes a draft in steps through `generate` (a request budget counter).
 * Returns { draft, outline, requests }; throws if the outline still fails
 * its structure checks after one retry (before any section is written).
 */
export async function stagedWrite(sheet, generate, { onOutlineFail = () => {}, log = () => {} } = {}) {
  let requests = 0;
  const call = async (req) => (requests++, generate(req));
  let outline = await call(buildOutlineRequest(sheet));
  let problems = checkOutline(outline, sheet);
  if (problems.length) {
    onOutlineFail(problems);
    outline = await call(buildOutlineRequest(sheet, problems, outline));
    problems = checkOutline(outline, sheet);
    if (problems.length) throw new OutlineError(`outline failed its checks after a retry: ${problems.slice(0, 4).join("; ")}`);
  }
  const written = [];
  for (let i = 0; i < SECTIONS; i += SECTIONS_PER_REQUEST) {
    const idx = Array.from({ length: Math.min(SECTIONS_PER_REQUEST, SECTIONS - i) }, (_, k) => i + k);
    const out = await call(buildSectionsRequest(sheet, outline, idx));
    idx.forEach((n, k) => written.push(out.sections?.[k] ?? { subhead: outline.sections[n].subhead, paragraphs: [] }));
  }
  // Word counts per stage, so a short draft shows where the words went.
  const sectionWords = written.map((s) => countWords((s.paragraphs ?? []).join(" ")));
  const draft = await call(buildFinishRequest(sheet, outline, written));
  log(`words: sections ${sectionWords.join(" + ")} = ${sectionWords.reduce((a, b) => a + b, 0)}; finished body ${countWords(draft?.body)}`);
  return { draft, outline, requests, words: { sections: sectionWords, body: countWords(draft?.body) } };
}
