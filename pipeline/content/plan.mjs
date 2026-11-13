// The post's plan, built by code (docs/audits/blog-engine.md, "Proposed
// pipeline"): which clauses (clauses.mjs) each section gets, the hook, the
// three TL;DR points, the callout fact, the Try this examples and the image
// slots. The writer only writes prose around this plan, so structure can't
// fail: no outline to retry, no sections without facts, no hero marker in
// the wrong place. Pure: no I/O, no Gemini.
import { clausesOf } from "./clauses.mjs";
import { lengthOf } from "./writer.mjs";

/** Clauses a section needs at least; fewer and the post gets fewer sections (never under 2). */
export const MIN_SECTION_CLAUSES = 2;

/** Old sheets name the top group by grade letters; the post never does. */
export const neutral = (s) =>
  String(s ?? "")
    .replace(/\bS and A portfolios\b/g, "the top-graded portfolios")
    .replace(/\bportfolios graded A or higher\b/gi, "the top-graded portfolios")
    .replace(/\bgraded S or A\b/g, "top-graded")
    .replace(/^the the /i, "the ");

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The plan of a post from its sheet:
 * { length, hook, sections: [{ n, clauses, image }], tldr: [clause ids],
 *   callout: { factId, text }, steps: [{ axis, name, url, factId? }],
 *   images: [slot briefs as writer.mjs RESPONSE_SCHEMA images] }
 */
export function planPost(sheet) {
  const L = lengthOf(sheet);
  const all = clausesOf(sheet);
  const notable = sheet.notable?.[0] ? { ...sheet.notable[0], why: neutral(sheet.notable[0].why) } : null;
  const hookFacts = new Set(notable?.factIds ?? []);
  const isHook = (c) => c.facts.some((f) => hookFacts.has(f));
  const byFact = new Map((sheet.facts ?? []).map((f) => [f.id, f]));
  // A comparison's weight: the gap between its two figures, so the biggest differences come first.
  const gap = (c) => {
    const [a, b] = c.facts.map((f) => byFact.get(f)?.value);
    return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) : 0;
  };

  // How many clauses fit the length: about one clause and its explanation per 65 words.
  const n = Math.max(2, Math.min(L.sections, Math.floor(all.length / MIN_SECTION_CLAUSES)));
  const quota = n * Math.max(MIN_SECTION_CLAUSES, Math.round((Math.round((L.min + L.max) / 2) - 220) / n / 65));
  const examplesAll = all.filter((c) => c.kind === "example");
  const pick = [
    ...all.filter(isHook),
    ...examplesAll.slice(0, Math.max(3, Math.round(quota / 3))),
    ...all.filter((c) => c.kind === "tie"),
    ...all.filter((c) => c.kind === "compare").sort((x, y) => gap(y) - gap(x)),
    ...all.filter((c) => c.kind === "count").slice(0, 2),
    ...examplesAll,
  ].filter((c, i, a) => a.indexOf(c) === i);
  const chosen = new Set(pick.slice(0, Math.max(quota, all.filter(isHook).length + 3)));
  const clauses = all.filter((c) => chosen.has(c));
  const compare = clauses.filter((c) => c.kind === "compare" || c.kind === "tie");
  const counts = clauses.filter((c) => c.kind === "count");
  const examples = clauses.filter((c) => c.kind === "example");

  // Sections: the comparisons spread evenly, hook-related ones first; the
  // counts go to the first section (they set the scene); examples one per
  // section, round robin, so every section names a site where there are any.
  const body = [...compare.filter(isHook), ...compare.filter((c) => !isHook(c))];
  const sections = Array.from({ length: n }, (_, i) => ({ n: i + 1, clauses: [], image: null }));
  sections[0].clauses.push(...counts);
  body.forEach((c, i) => sections[Math.floor((i * n) / Math.max(1, body.length))].clauses.push(c));
  examples.forEach((c, i) => sections[i % n].clauses.push(c));

  // Images: the chart in the section with the most comparisons, then
  // screenshots of the named sites in the sections that link them, then
  // library pictures to reach the profile's minimum. The hero is a picture.
  const images = [{ slot: "hero", purpose: short(`A calm illustration for: ${sheet.headline}`, 120), kind: "picture", mood: "calm, confident", keywords: [...new Set([...(sheet.tags ?? []), "portfolio", "developer", "web design", "data"])].slice(0, 5), alt: short(`Illustration for ${sheet.headline}`, 120) }];
  let k = 0;
  const slotFor = () => `inline-${++k}`;
  const chart = sheet.charts?.[0];
  if (chart) {
    const at = sections.reduce((best, s) => (s.clauses.filter((c) => c.kind === "compare").length > best.clauses.filter((c) => c.kind === "compare").length ? s : best), sections[0]);
    at.image = { slot: slotFor(), purpose: chart.title, kind: "chart", chart_id: chart.id, alt: chart.alt ?? chart.title };
    images.push(at.image);
  }
  const shots = new Map((sheet.screenshots ?? []).map((s) => [s.url, s]));
  for (const s of sections) {
    if (k >= L.inline[1]) break;
    if (s.image) continue;
    const ex = s.clauses.find((c) => c.kind === "example" && shots.has(c.about));
    if (!ex) continue;
    s.image = { slot: slotFor(), purpose: `${ex.name}'s portfolio, a positive example`, kind: "screenshot", site_url: ex.about, alt: `The first screen of ${ex.name}'s portfolio.` };
    images.push(s.image);
  }
  for (const s of sections) {
    if (k >= L.inline[0]) break;
    if (s.image) continue;
    s.image = { slot: slotFor(), purpose: short(`An illustration for a section about ${sheet.headline}`, 120), kind: "picture", mood: "calm", keywords: ["portfolio", "developer", "design", "career", "web"], alt: short(`Illustration for ${sheet.headline}`, 120) };
    images.push(s.image);
  }

  // TL;DR: the hook, then the next two strongest points (a comparison, then
  // an example or a count), each a clause the body also carries.
  const hook = clauses.find(isHook) ?? body[0] ?? counts[0] ?? examples[0];
  const pool = [...body, ...examples, ...counts].filter((c) => c !== hook);
  const tldr = [hook, ...pool.filter((c) => c.kind !== hook?.kind).slice(0, 1), ...pool].filter(Boolean).filter((c, i, a) => a.indexOf(c) === i).slice(0, 3);

  // Callout: one numeric fact restated with its own scope (the share of the
  // top group when there is one, else the biggest comparison or count).
  const byId = new Map((sheet.facts ?? []).map((f) => [f.id, f]));
  // Only a clause with exactly one numeric figure can be the callout (checks.mjs checkCallout).
  const oneNumber = (c) => c.facts.filter((f) => typeof byId.get(f)?.value === "number").length === 1;
  const calloutClause =
    all.find((c) => c.kind === "count" && /of graded portfolios are top-graded/.test(c.text)) ??
    clauses.find((c) => c.kind === "tie" && oneNumber(c) && !(sheet.superlatives ?? []).some((s) => s.tied && c.facts.includes(s.factIds[0]))) ??
    all.find((c) => c.kind === "count" && oneNumber(c)) ??
    clauses.find(oneNumber) ??
    null;
  const calloutFact = calloutClause?.facts.find((f) => typeof byId.get(f)?.value === "number") ?? calloutClause?.facts[0] ?? null;

  // Try this: three examples, different sites where the sheet allows.
  const steps = [];
  for (const e of sheet.examples ?? []) {
    if (steps.length >= 3) break;
    if (steps.some((s) => s.url === e.url) && (sheet.examples ?? []).some((x) => !steps.some((s) => s.url === x.url) && x !== e)) continue;
    steps.push({ axis: e.axis, name: e.name, url: e.url, factId: e.factId });
  }
  for (const c of examples) {
    if (steps.length >= 3) break;
    if (!steps.some((s) => s.url === c.about)) steps.push({ axis: c.axes?.[0] ?? null, name: c.name, url: c.about });
  }
  // Without named examples (an aggregate-only sheet), a step per measure.
  for (const c of body) {
    if (steps.length >= 3) break;
    if (c.axis && !steps.some((s) => s.axis === c.axis)) steps.push({ axis: c.axis, name: null, url: null });
  }

  return {
    length: L,
    hook: notable ? { factIds: notable.factIds, why: notable.why } : hook ? { factIds: hook.facts, why: hook.text } : null,
    clauses,
    sections,
    tldr: tldr.map((c) => c.id),
    callout: calloutClause ? { factId: calloutFact, text: calloutClause.text.replace(/\.$/, "") } : null,
    steps,
    images,
  };
}
