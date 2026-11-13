// A deterministic stand-in for Gemini, for the tests and the offline replay
// harness (scripts/content-replay.mjs): it answers the writer's plain-text
// requests (compose.mjs) by rewording the clauses it is given into the
// blocks asked for, padded with neutral explanation to the asked length,
// and answers the review as a pass with no outside claims. It shows that
// code's side of the pipeline (plan, assembly, repairs, checks) works; it
// says nothing about how well a real model writes. No network.
import { TOPICS } from "./topic.mjs";

const EXPLAIN = [
  "That gap shows up on the first screen, before a reviewer reads a word of the projects.",
  "It is also one of the easier things to change in an afternoon.",
  "Reviewers notice it because it sets the tone for everything below.",
  "Small changes here tend to lift the whole page, not just one score.",
  "Most of the work is removing things rather than adding them.",
  "Every figure here comes from the same grading run, so they compare like for like.",
  "This pattern holds across very different kinds of developers and stacks.",
  "None of it needs a new framework or a bigger budget.",
];

const clausesIn = (text, header) => {
  const at = text.indexOf(header);
  if (at < 0) return [];
  // The "- " lines right under the header, up to the first other line.
  const lines = text.slice(at + header.length).split("\n").slice(1);
  const end = lines.findIndex((l) => !l.startsWith("- "));
  return (end < 0 ? lines : lines.slice(0, end)).map((l) => l.slice(2));
};

function sectionText(clauses, words, seed) {
  const out = [];
  let n = 0;
  let k = seed;
  // Each clause followed by a sentence of explanation, as a writer would.
  for (const c of clauses) {
    const s = EXPLAIN[k++ % EXPLAIN.length];
    out.push(c, s);
    n += c.split(/\s+/).length + s.split(/\s+/).length;
  }
  while (n < words) {
    const s = EXPLAIN[k++ % EXPLAIN.length];
    out.push(s);
    n += s.split(/\s+/).length;
  }
  // Paragraphs of three sentences.
  const paras = [];
  for (let i = 0; i < out.length; i += 3) paras.push(out.slice(i, i + 3).join("\n"));
  return paras.join("\n\n");
}

/** The mock's answer to one request (compose write/fix requests, or the JSON review). */
export function mockAnswer(req) {
  const text = req.parts?.[0]?.text ?? "";
  if (req.schema) return { topic: TOPICS[1], on_topic: true, positive: true, names_ok: true, voice_ok: true, problems: [], outside_claims: [] };
  const words = Number(text.match(/about (\d+) words in paragraphs/)?.[1] ?? 200);
  const blocks = [];
  if (text.includes("=== TITLE ===")) {
    const tldr = [...text.matchAll(/^\d+\. (.+)$/gm)].slice(0, 3).map((m) => m[1]);
    blocks.push(
      "=== TITLE ===\nWhat the best developer portfolios do differently\nWhere top portfolios pull ahead\nThe portfolio habits that score",
      "=== SUBTITLE ===\nWe compared the AI judge's scores of the top-graded portfolios with everyone else.",
      "=== TAGS ===\nportfolios, data, design",
      "=== SHARE ===\nWhat the top-graded developer portfolios do, from our own grades.",
      "=== NEWSLETTER ===\nWhat the top-graded portfolios share, and what to copy.",
      `=== TLDR ===\n${tldr.map((t) => `- ${t}`).join("\n")}`,
      `=== OPENER ===\n${text.match(/The hook \(lead with it\): (.+)/)?.[1]?.replace(/^./, (c) => c.toUpperCase()) ?? "The data has a clear lead."}.\nWe looked at where the best portfolios pull ahead.`,
      "=== TAKEAWAY ===\nIf you change one thing on your portfolio this week, start with the gap below."
    );
  }
  for (const m of text.matchAll(/^Section (\d+) uses these facts:$/gm)) {
    const n = Number(m[1]);
    blocks.push(`=== SECTION ${n} ===\n## What this part of the data shows\n${sectionText(clausesIn(text, m[0]), words, n * 3)}`);
  }
  // A fix request: give each listed section block more words.
  for (const m of text.matchAll(/^=== (SECTION \d+|OPENER|TAKEAWAY) ===$/gm)) {
    if (text.includes("Write these blocks:")) break;
    const name = m[1];
    if (name.startsWith("SECTION")) {
      const body = text.slice(m.index + m[0].length).split(/^=== /m)[0].trim();
      // Asked to cut: keep the subhead and the first two paragraphs; else add a paragraph.
      const cut = /wanted: cut/.test(text);
      const kept = cut ? body.split(/\n\s*\n/).slice(0, 2).join("\n\n") : `${body}\n\n${sectionText([], Math.round(words / 2), 5)}`;
      blocks.push(`=== ${name} ===\n${kept}`);
    } else if (name === "TAKEAWAY") blocks.push("=== TAKEAWAY ===\nIf you change one thing on your portfolio this week, start with the gap below.");
  }
  if (text.includes("=== STEPS ===")) {
    const steps = [...text.matchAll(/^\d+\. (?:on (.+?))?(?:, pointing to (\[[^\]]+\]\([^)]+\)))?$/gm)].slice(-3);
    blocks.push(
      `=== CALLOUT ===\nThat is the group the rest of this post compares with everyone else.`,
      `=== STEPS ===\n${steps.map((s, i) => `${i + 1}. Open your portfolio and improve ${s[1] ?? "one thing from this post"} this week, the way ${s[2] ?? "the best sites do"}.`).join("\n")}`,
      "=== CLOSING ===\nThe best portfolios are not louder, they are clearer.\nPick one change and ship it this week."
    );
  }
  return blocks.join("\n\n");
}
