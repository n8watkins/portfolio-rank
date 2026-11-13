// The content writer (docs/audits/blog-engine.md, "Proposed pipeline";
// owner, 2026-11-13). Code owns everything deterministic, Gemini writes prose:
//
//   1. plan (plan.mjs): sections, their finished clauses (clauses.mjs), the
//      hook, the TL;DR points, the callout fact, the Try this examples and
//      the image slots. No request.
//   2. write: plain-text Markdown in delimited blocks (=== NAME ===), up to
//      three sections a call, so a long post takes two calls. 1 to 2 requests.
//   3. assemble and repair by code: sections verbatim, the takeaway placed,
//      paragraphs split or merged, sentences with stray numbers or unknown
//      placeholders cut, missing links added, TL;DR bullets checked against
//      their clauses. No request.
//   4. code checks (checks.mjs); if any still fail, one targeted fix call
//      that rewrites only the blocks with problems. 0 to 1 request.
//   5. one review (topic.mjs): topic, tone, names, voice, and the
//      outside-claim sentences, which go to Tavily (the owner's gate 2) only
//      when flagged; code cuts what isn't supported. 1 request, plus 1 to
//      judge flagged claims when there are any.
//
// Length is a soft gate: a body below 85% of its profile's minimum fails.
import { CTA, PLACEHOLDER, fill, normalizeDraft } from "./writer.mjs";
import { planPost } from "./plan.mjs";
import { checkLinksLoad, codeChecks, urlsIn, wordCount } from "./checks.mjs";
import { buildReviewRequest, reviewCheck } from "./topic.mjs";
import { checkClaims } from "./claims.mjs";

/** The writer's standing rules: voice and safety only; the shape is code's. */
export const WRITE_SYSTEM = [
  "You write blog posts for PortfolioRank, a site that ranks developer portfolio websites, from finished facts its code computed.",
  "Rules:",
  "- Keep every {{placeholder}} exactly as given (code fills in the numbers) and never type a digit of your own.",
  "- Keep every Markdown link [Name](url) you are given, with its exact url, and add no other links than those and the related posts offered. Name a person or site only from the clauses you are given.",
  "- Rephrase the clauses freely so the text reads like a person wrote it, but keep each figure with the group it belongs to. Never put two figures side by side so they look like one comparison.",
  "- Say \"the top-graded portfolios\" and \"everyone else\"; never grade letters. Never describe how many portfolios there are in words (\"thousands\").",
  "- Explain what each measure means for a portfolio and why a reader should care; that, the named sites and concrete advice make the length. No outside claims about hiring, recruiters, the job market or studies.",
  "- Positive and practical: what the best portfolios do and how a reader can do the same. Never mock anyone. Never write about how PortfolioRank is built or run.",
  "- Voice: plain, short sentences, first person plural (we), no hype, no em dashes, no exclamation marks. Vary how sentences start; never two in a row with the same first word.",
  "- Paragraphs of two to four sentences, one sentence per line, a blank line between paragraphs.",
  "- Answer only with the blocks asked for, each starting with its === NAME === line.",
].join("\n");

// prompt: the id the Gemini request log records (#148); the client ignores it until then.
const WRITE_OPTIONS = { prompt: "content-write-v2", systemInstruction: WRITE_SYSTEM, thinkingLevel: "low", maxOutputTokens: 6144, temperature: 0.7 };
/** Sections written by one request: a long post (5 sections) takes two. */
export const SECTIONS_PER_CALL = 3;

const mid = (L) => Math.round((L.min + L.max) / 2);
/** Words each section should carry: the body's target less the opener, steps and closing. */
export const sectionWords = (plan) => Math.max(120, Math.round((mid(plan.length) - 220) / plan.sections.length));

const clauseLines = (cs) => cs.map((c) => `- ${c.text}`).join("\n");

/** The write requests of a plan: one per group of up to SECTIONS_PER_CALL sections; the first adds the frame, the last the ending. */
export function buildWriteRequests(sheet, plan) {
  const groups = [];
  for (let i = 0; i < plan.sections.length; i += SECTIONS_PER_CALL) groups.push(plan.sections.slice(i, i + SECTIONS_PER_CALL));
  const byId = new Map(plan.clauses.map((c) => [c.id, c]));
  const per = sectionWords(plan);
  return groups.map((group, gi) => {
    const first = gi === 0;
    const last = gi === groups.length - 1;
    const ask = [];
    const lines = [
      `Post: ${sheet.headline}${sheet.focus ? `\nThe owner's angle for this post: ${sheet.focus}` : ""}`,
      `Data as of ${String(sheet.dataAsOf ?? "").slice(0, 10)}. The post is ${plan.sections.length} sections, about ${mid(plan.length)} words in all.`,
      "",
    ];
    // The owner's standing guidelines and notes on an earlier version (lib/content/guidelines.mjs, "Rewrite with these notes").
    if (sheet.guidelines?.length) lines.push("The editor's guidelines; follow every one:", ...sheet.guidelines.map((x) => `- ${x}`), "");
    if (sheet.ownerNotes) lines.push(`The owner's notes on the previous version of this post; fix every point: ${sheet.ownerNotes}`, "");
    if (first) {
      lines.push(
        `The hook (lead with it): ${plan.hook?.why ?? ""}`,
        "TL;DR points, one bullet each, in this order (keep their placeholders and links):",
        ...plan.tldr.map((id, i) => `${i + 1}. ${byId.get(id)?.text ?? ""}`),
        ""
      );
      ask.push(
        "=== TITLE ===\nthree lines: the title (under 70 characters, specific, with the main keyword), then two alternative titles",
        "=== SUBTITLE ===\none sentence that works as the page's description",
        "=== TAGS ===\ntwo to four tags, comma separated",
        "=== SHARE ===\none line under 240 characters to share the post, with no link",
        "=== NEWSLETTER ===\none sentence for the newsletter",
        "=== TLDR ===\nthree lines starting with \"- \", one per TL;DR point above",
        "=== OPENER ===\ntwo or three sentences that start with the hook",
        "=== TAKEAWAY ===\none sentence to the reader (\"you\", \"your portfolio\") that tells them the one thing to do"
      );
    }
    for (const s of group) {
      lines.push(`Section ${s.n} uses these facts:`, clauseLines(s.clauses), "");
      ask.push(`=== SECTION ${s.n} ===\na first line "## " with a subhead that says what the section shows (only what its facts cover), then about ${per} words in paragraphs of two to four sentences`);
    }
    if (last) {
      if (plan.callout) ask.push(`=== CALLOUT ===\none sentence of context for the key figure "${plan.callout.text}", with no number in it`);
      lines.push(
        "Try this examples, one step each:",
        ...plan.steps.map((st, i) => `${i + 1}. ${st.axis ? `on ${st.axis}` : "a step"}${st.url ? `, pointing to [${st.name}](${st.url})` : ""}`),
        ""
      );
      ask.push(
        "=== STEPS ===\nthree numbered lines (\"1. \", \"2. \", \"3. \"), each a concrete change a reader can make today, specific to this post, with its example link",
        "=== CLOSING ===\ntwo or three sentences with the takeaway"
      );
    }
    if (!first) lines.push("These blocks continue a post already started; don't repeat its opener.", "");
    // Interlinks (owner, 2026-11-12): published posts the sections may link once where they fit.
    const related = (sheet.relatedPosts ?? []).slice(0, 6);
    if (related.length) lines.push("Other PortfolioRank posts you may link once where a section touches the same subject, with the exact url (or not at all):", ...related.map((p) => `- [${p.title}](${p.url})`), "");
    lines.push("Write these blocks:", ...ask);
    return { parts: [{ text: lines.join("\n") }], options: WRITE_OPTIONS, sections: group.map((s) => s.n), first, last };
  });
}

/** The blocks of a plain-text answer: { TITLE: "...", "SECTION 2": "...", ... }. */
export function parseBlocks(text) {
  const out = {};
  let name = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = line.trim().match(/^={2,}\s*([A-Z;]+(?:\s+\d+)?)\s*={2,}$/);
    if (m) {
      name = m[1].replace(/\s+/g, " ");
      out[name] = [];
    } else if (name) out[name].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n").trim()]));
}

// ------------------------------------------------------------------ repairs

const SENT = /(?<=[.!?])\s+(?=[A-Z0-9"[{(])/;
/** The sentences of some prose (one per line or run together). */
export const sentencesOf = (text) =>
  String(text ?? "")
    .split("\n")
    .flatMap((l) => l.trim().split(SENT))
    .map((s) => s.trim())
    .filter(Boolean);

/** Paragraphs of 2 to 4 sentences: a lone sentence joins its neighbour, a long one is split. */
export function reflow(text) {
  const paras = String(text ?? "")
    .split(/\n\s*\n/)
    .map((p) => sentencesOf(p))
    .filter((p) => p.length);
  const out = [];
  for (const p of paras) {
    if (p.length === 1 && out.length && out.at(-1).length < 4) out.at(-1).push(p[0]);
    else out.push([...p]);
  }
  if (out.length > 1 && out[0].length === 1) out[1].unshift(...out.shift());
  const split = out.flatMap((p) => {
    if (p.length <= 4) return [p];
    const chunks = [];
    for (let i = 0; i < p.length; ) {
      const left = p.length - i;
      const take = left === 5 ? 3 : Math.min(3, left);
      chunks.push(p.slice(i, i + take));
      i += take;
    }
    return chunks;
  });
  return split.map((p) => p.join("\n")).join("\n\n");
}

const ALLOWED_DIGITS = /\b(?:19|20)\d\d\b|\b1\s?(?:to|-)\s?5\b|\b\d\.\d\s+Flash(?:-Lite)?\b/g;
/** Whether a sentence has a digit that didn't come from a placeholder (urls and allowed forms aside). */
const strayDigit = (s, names = []) => /\d/.test(names.reduce((t, n) => (n ? t.split(n).join(" ") : t), s).replace(PLACEHOLDER_G(), "").replace(/\]\([^)]*\)/g, "]").replace(ALLOWED_DIGITS, ""));
function PLACEHOLDER_G() {
  return new RegExp(PLACEHOLDER.source, "g");
}

/** Cuts sentences with stray digits or placeholders the sheet doesn't have; returns the text and what was cut. */
export function cutBadSentences(text, factIds, names = []) {
  const cut = [];
  const keep = (s) => {
    const unknown = [...s.matchAll(PLACEHOLDER_G())].some((m) => !factIds.has(m[1]));
    if (unknown || strayDigit(s, names)) {
      cut.push(s);
      return false;
    }
    return true;
  };
  const out = String(text ?? "")
    .split(/\n\s*\n/)
    .map((p) => sentencesOf(p).filter(keep).join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return { text: out, cut };
}

const clean = (s) =>
  String(s ?? "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/!+/g, ".")
    .replace(/^#+\s*/gm, "")
    .trim();

/** One line from a block (the first non-empty one). */
const line1 = (s) => clean(String(s ?? "").split("\n").find((l) => l.trim()) ?? "");

/** The post's draft (writer.mjs shape) from the plan and the answers' blocks, repaired by code. */
export function assemble(sheet, plan, blocks) {
  const factIds = new Set((sheet.facts ?? []).map((f) => f.id));
  const names = (sheet.names ?? []).map((n) => n.name).filter(Boolean);
  const byId = new Map(plan.clauses.map((c) => [c.id, c]));
  const notes = [];
  const fix = (text, where) => {
    const r = cutBadSentences(clean(text), factIds, names);
    for (const s of r.cut) notes.push(`${where}: cut "${s.slice(0, 80)}"`);
    return r.text;
  };

  // Titles and meta.
  const titles = String(blocks.TITLE ?? "").split("\n").map((l) => clean(l).replace(/^[-\d.\s]+/, "").replace(/^"|"$/g, "")).filter(Boolean);
  const title = titles[0] ?? sheet.headline;
  const tags = String(blocks.TAGS ?? "").split(/[,\n]/).map((t) => clean(t).replace(/^#/, "")).filter(Boolean).slice(0, 4);

  // TL;DR: each bullet keeps its clause's placeholders, else the clause itself.
  const bullets = String(blocks.TLDR ?? "").split("\n").map((l) => l.replace(/^\s*[-*\d.]+\s*/, "").trim()).filter(Boolean);
  const tldr = plan.tldr.map((id, i) => {
    const c = byId.get(id);
    const b = clean(bullets[i] ?? "");
    const ids = [...b.matchAll(PLACEHOLDER_G())].map((m) => m[1]);
    const ok = b && c.facts.every((f) => ids.includes(f)) && ids.every((f) => c.facts.includes(f)) && !strayDigit(b, names);
    if (!ok) notes.push(`TL;DR ${i + 1}: used the clause`);
    return ok ? b : c.text;
  });

  // The opener starts with the hook and ends with the takeaway.
  let opener = fix(blocks.OPENER ?? "", "opener");
  const hookIds = plan.hook?.factIds ?? [];
  if (hookIds.length && !hookIds.every((f) => opener.includes(`{{${f}}}`))) {
    const hookClause = plan.clauses.find((c) => hookIds.every((f) => c.facts.includes(f))) ?? byId.get(plan.tldr[0]);
    opener = `${hookClause.text}\n${opener}`.trim();
    notes.push("opener: put the hook first");
  }
  let takeaway = fix(line1(blocks.TAKEAWAY), "takeaway");
  if (!/\byou(r)?\b/i.test(takeaway)) {
    takeaway = "Check your own portfolio against these numbers and fix the weakest one first.";
    notes.push("takeaway: used the default");
  }
  const openerPara = sentencesOf(`${opener}\n${takeaway}`).slice(-4).join("\n");

  // Sections, verbatim apart from the repairs, with their images.
  const calloutAfter = Math.max(1, Math.floor(plan.sections.length / 2));
  const parts = [openerPara];
  const written = plan.sections.map((s) => {
    const lines = String(blocks[`SECTION ${s.n}`] ?? "").split("\n");
    const headIdx = lines.findIndex((l) => l.trim());
    return {
      subhead: clean(lines[headIdx] ?? "").replace(/[.:]$/, "") || `What the data shows, part ${s.n}`,
      text: fix(lines.slice(headIdx + 1).join("\n"), `section ${s.n}`),
    };
  });
  // A clause the writer left out everywhere (its figures nowhere in the post,
  // or a named site's link dropped) goes back into its section as code wrote
  // it, so the data, the TL;DR's points and the linked examples are all there.
  const everything = [openerPara, ...written.map((w) => w.text)].join("\n");
  plan.sections.forEach((s, i) => {
    for (const c of s.clauses) {
      const missing = c.kind === "example" ? !everything.includes(`](${c.about})`) : !c.facts.every((f) => everything.includes(`{{${f}}}`));
      if (missing) {
        // The other wording when the section's last sentence opens the same way.
        const first = (s) => String(s).trim().split(/\s+/)[0]?.toLowerCase();
        const last = sentencesOf(written[i].text).at(-1) ?? "";
        const put = c.alt && first(last) === first(c.text) ? c.alt : c.text;
        written[i].text = `${written[i].text}\n\n${put}`;
        notes.push(`section ${s.n}: put back ${c.name ?? c.id}`);
      }
    }
  });
  for (const [i, s] of plan.sections.entries()) {
    const { subhead, text } = written[i];
    const paras = reflow(text).split("\n\n");
    if (s.image) paras.splice(1, 0, `[[image:${s.image.slot}]]`);
    parts.push(`### ${subhead}`, ...paras);
    if (s.n === calloutAfter && plan.callout) {
      const ctx = line1(blocks.CALLOUT);
      const context = ctx && !/\d|\{\{/.test(ctx) ? ctx : "This is the group the rest of this post compares with everyone else.";
      parts.push(`> **${plan.callout.text}**\n> ${context}`);
    }
  }

  // Try this: three steps, each with its example link.
  const stepLines = String(blocks.STEPS ?? "").split("\n").map((l) => clean(l.replace(/^\s*\d+[.)]\s*/, ""))).filter(Boolean);
  const steps = plan.steps.slice(0, 3).map((st, i) => {
    let t = stepLines[i] ?? (st.axis ? `Look at your own ${st.axis} and change one thing this week.` : "Pick one thing from this post and change it this week.");
    t = cutBadSentences(t, factIds, names).text.replace(/\n/g, " ") || "Pick one thing from this post and change it this week.";
    if (st.url && !t.includes(`](${st.url})`)) t = `${t} See how [${st.name}](${st.url}) does it.`;
    return `${i + 1}. ${t}`;
  });
  while (steps.length < 3) steps.push(`${steps.length + 1}. Check your portfolio against one figure in this post and change one thing.`);
  parts.push(`### Try this\n${steps.join("\n")}`);
  const closing = sentencesOf(fix(blocks.CLOSING ?? "", "closing"));
  parts.push((closing.length >= 2 ? closing : [...closing, "Small changes add up when a reviewer has only seconds."]).slice(0, 3).join("\n"));

  const draft = normalizeDraft({
    title,
    alt_title_a: titles[1] ?? title,
    alt_title_b: titles[2] ?? titles[1] ?? title,
    subtitle: line1(blocks.SUBTITLE) || sheet.headline,
    tags: tags.length >= 2 ? tags : ["portfolios", "data"],
    share_line: line1(blocks.SHARE).slice(0, 240) || title,
    newsletter_blurb: line1(blocks.NEWSLETTER) || line1(blocks.SUBTITLE) || title,
    tldr,
    body: parts.join("\n\n"),
    images: plan.images,
  });
  return { draft, notes };
}

/** The fix request: only the blocks with problems, rewritten. */
export function buildFixRequest(sheet, plan, blocks, problems, names) {
  const text = [
    "Some blocks of this blog post failed checks. Rewrite only the blocks listed below, fixing every problem; keep their {{placeholders}} and links exactly, and answer with the same === NAME === blocks.",
    "",
    "Problems:",
    ...problems.map((p) => `- ${p}`),
    "",
    ...names.flatMap((n) => [`=== ${n} ===`, blocks[n] ?? "", ""]),
    `The post's sections should each be about ${sectionWords(plan)} words.`,
  ].join("\n");
  return { parts: [{ text }], options: { ...WRITE_OPTIONS, prompt: "content-fix-v1" } };
}

/** Which blocks a set of check problems points at (text quoted in a problem, or the shortest sections for length). */
export function blocksToFix(blocks, problems, plan) {
  const names = new Set();
  const sections = plan.sections.map((s) => `SECTION ${s.n}`);
  for (const p of problems) {
    const quoted = [...p.matchAll(/"([^"]{6,})"/g)].map((m) => m[1].slice(0, 40));
    for (const [n, text] of Object.entries(blocks)) if (quoted.some((q) => text.includes(q))) names.add(n);
    if (/words; .* wanted: (add|cut)/.test(p)) {
      const cut = /wanted: cut/.test(p);
      // Every section under (or, to cut, over) its share of the words.
      const per = sectionWords(plan);
      const off = sections.filter((n) => (cut ? wordCount(blocks[n] ?? "") > per * 1.1 : wordCount(blocks[n] ?? "") < per * 0.9));
      const shortest = off.length ? off : sections;
      shortest.forEach((n) => names.add(n));
    }
    if (/takeaway|payoff|first 150 words/i.test(p)) names.add("TAKEAWAY").add("OPENER");
    if (/hook/i.test(p)) names.add("OPENER");
    if (/subhead/i.test(p)) sections.forEach((n) => names.add(n));
  }
  return [...names].filter((n) => n in blocks);
}

/**
 * Writes a draft from a sheet. ctx: { generate(request) -> answer (budgeted),
 * left() -> requests left, roster, tavilyKey, fetchImpl, credits, tavilyLeft,
 * log }. Returns { passed, draft, plan, history, failures, supported,
 * requests, searches, words }.
 */
export async function composeDraft(sheet, ctx) {
  const log = ctx.log ?? (() => {});
  const phase = async (name, detail = null) => (ctx.onPhase ? ctx.onPhase(name, detail) : undefined);
  const plan = planPost(sheet);
  let requests = 0;
  const call = async (req) => (requests++, ctx.generate(req));
  const history = [];
  const names = (sheet.names ?? []).map((n) => n.name);

  // 2. Write.
  const blocks = {};
  for (const req of buildWriteRequests(sheet, plan)) Object.assign(blocks, parseBlocks(await call(req)));
  let { draft, notes } = assemble(sheet, plan, blocks);
  const sectionWordsOut = plan.sections.map((s) => wordCount(blocks[`SECTION ${s.n}`] ?? ""));
  log(`words: sections ${sectionWordsOut.join(" + ")} = ${sectionWordsOut.reduce((a, b) => a + b, 0)}; body ${wordCount(fill(draft.body, sheet.facts))}; repairs: ${notes.length}`);

  // 4. Checks, then one targeted fix.
  await phase("checking");
  let code = codeChecks(draft, sheet, { roster: ctx.roster ?? [] });
  history.push({ round: 0, checks: code.checks, repairs: notes, claims: { supported: [], cut: [], unchecked: false } });
  if (!code.ok && ctx.left() >= 2) {
    const which = blocksToFix(blocks, code.failures, plan);
    if (which.length) {
      log(`fix: ${which.join(", ")} for ${code.failures.length} problem(s)`);
      await phase("revising", which.join(", "));
      Object.assign(blocks, parseBlocks(await call(buildFixRequest(sheet, plan, blocks, code.failures, which))));
      ({ draft, notes } = assemble(sheet, plan, blocks));
      code = codeChecks(draft, sheet, { roster: ctx.roster ?? [] });
      history.push({ round: 1, checks: code.checks, repairs: notes, claims: { supported: [], cut: [], unchecked: false } });
    }
  }
  const words = wordCount(fill(draft.body, sheet.facts));
  if (!code.ok) return { passed: false, draft, plan, history, failures: code.failures, supported: [], requests, searches: 0, words };
  // External links load (checked once a draft, not every round).
  if (ctx.fetchImpl) {
    const links = await checkLinksLoad([fill(draft.body, sheet.facts)].flatMap((t) => urlsIn(t)), ctx.fetchImpl);
    history.at(-1).checks.push(links);
    if (!links.ok) return { passed: false, draft, plan, history, failures: links.problems.map((p) => `links-load: ${p}`), supported: [], requests, searches: 0, words };
  }

  // 5. One review; outside claims it flags go to Tavily, the unsupported are cut.
  if (ctx.left() < 1) return { passed: false, draft, plan, history, failures: ["review: no budget left for the review"], supported: [], requests, searches: 0, words };
  const filled = `# ${fill(draft.title, sheet.facts)}\n\n${fill(draft.subtitle, sheet.facts)}\n\n${fill(draft.body, sheet.facts)}`;
  await phase("checking", "the review");
  const answer = await call(buildReviewRequest(sheet, filled));
  const review = reviewCheck(answer);
  history.at(-1).checks.push(review);
  if (!review.ok) return { passed: false, draft, plan, history, failures: review.problems.map((p) => `review: ${p}`), supported: [], requests, searches: 0, words };
  const flagged = (answer.outside_claims ?? []).map((s) => String(s).trim()).filter(Boolean);
  let supported = [];
  let searches = 0;
  if (flagged.length) {
    await phase("researching");
    const claims = await checkClaims(draft.body, {
      flagged,
      names,
      tavilyKey: ctx.tavilyKey,
      fetchImpl: ctx.fetchImpl,
      credits: ctx.credits,
      budget: { gemini: ctx.left(), tavily: ctx.tavilyLeft ?? 0 },
      generate: async (req) => (requests++, ctx.generate(req)),
    });
    searches = claims.searches;
    supported = claims.supported;
    history.at(-1).claims = { supported: claims.supported, cut: claims.cut, unchecked: false };
    if (claims.cut.length) {
      let body = draft.body;
      for (const c of claims.cut) body = body.split(c.sentence).join("");
      draft = normalizeDraft({ ...draft, body: body.replace(/\n{3,}/g, "\n\n") });
      log(`claims: cut ${claims.cut.length}, kept ${claims.supported.length}`);
    }
  }
  return { passed: true, draft, plan, history, failures: [], supported, requests, searches, words: wordCount(fill(draft.body, sheet.facts)) };
}

export { CTA };
