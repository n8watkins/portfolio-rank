// Outside claims, third review of 2026-11-16 (pull request #253): one matcher
// for listed names, addresses and domains (case, spaces, the short-name guard),
// a boundary that refuses to send any of them to Tavily, one sentence splitter,
// Markdown that does not hide a flagged sentence, and a review prompt and token
// budget that fit what the review must now do.
// Mock writer, fake fetch, fake Gemini: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_OK, contentCtx, fakeGemini, sheetAndRoster } from "./helpers/content-fixture.mjs";
import { mockAnswer } from "../pipeline/content/mock-writer.mjs";
import { runDraft } from "../pipeline/content/engine.mjs";
import { GeminiIncompleteError } from "../pipeline/gemini.mjs";
import { TAVILY_API, checkClaims, cutClaimSentences, tavilySearch } from "../pipeline/content/claims.mjs";
import { listedSiteIn } from "../pipeline/content/checks.mjs";
import { MAX_REVIEW_CLAIMS, REVIEW_SCHEMA, buildReviewRequest } from "../pipeline/content/topic.mjs";
import { buildListRequest } from "../pipeline/content/claims.mjs";
import { flagCounts, labelOf } from "../pipeline/content/claim-flags.mjs";

const SITES = [
  { name: "Brittany Chiang", url: "https://brittanychiang.com", domain: "brittanychiang.com" },
  { name: "May", url: "https://may.dev", domain: "may.dev" },
];

/** A fake web recording every Tavily request body. */
const web = () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === TAVILY_API) {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ results: [] }));
    }
    return new Response("ok");
  };
  return { fetchImpl, bodies };
};
const run = (draft, flagged, extra = {}) => {
  const w = web();
  return checkClaims(draft, { tavilyKey: "k", fetchImpl: w.fetchImpl, budget: { gemini: 5, tavily: 10 }, generate: async () => ({}), flagged, sites: SITES, ...extra }).then((r) => ({ r, w }));
};

test("1: a listed name is matched case-insensitively, by domain and across non-breaking spaces, and never reaches Tavily", async () => {
  const cases = [
    "A LinkedIn study found brittany chiang was hired in a week.",
    "A LinkedIn study found brittanychiang.com is the most copied portfolio.",
    "A LinkedIn study found Brittany Chiang was hired in a week.",
    "A LinkedIn study found www.brittanychiang.com is the most copied portfolio.",
  ];
  for (const claim of cases) {
    const { r, w } = await run(claim, [claim]);
    assert.equal(w.bodies.length, 0, claim);
    assert.match(r.cut[0].reason, /names a listed site/, claim);
  }
});

test("1: a short single-word name does not make a sentence a named one (the checkNames guard)", async () => {
  assert.equal(listedSiteIn("A May 2025 survey shows recruiters read for seven seconds.", SITES), null);
  const claim = "A May 2025 survey shows recruiters read for seven seconds.";
  const { r, w } = await run(claim, [claim]);
  assert.equal(w.bodies.length, 1, "searched like any other claim");
  assert.equal(r.cut[0].reason, "no search results");
});

test("1: the search boundary refuses a query that holds a listed name or domain", async () => {
  let called = 0;
  const fetchImpl = async () => (called++, new Response(JSON.stringify({ results: [] })));
  for (const q of ["did brittany chiang get hired", "is brittanychiang.com copied", "see https://brittanychiang.com/about"]) {
    await assert.rejects(tavilySearch(q, { apiKey: "k", fetchImpl, sites: SITES }), /names a listed site/, q);
  }
  assert.equal(called, 0);
  assert.deepEqual(await tavilySearch("recruiters read for seven seconds", { apiKey: "k", fetchImpl, sites: SITES }), []);
  assert.equal(called, 1);
});

test("2: the review prompt says an outside claim is a statement of fact, and that advice, opinion, transitions and instructions are not", async () => {
  const { sheet } = await sheetAndRoster();
  const text = buildReviewRequest(sheet, "A post.").parts[0].text;
  assert.match(text, /states a FACT about the world which is not in the fact sheet/);
  assert.match(text, /Advice to the reader, opinion, transitions and instructions are not claims/);
  assert.match(text, /even when it names a site from the names list/);
  assert.doesNotMatch(text, /does nothing but restate/);
  assert.match(buildListRequest("x").parts[0].text, /advice to the reader, opinion, transitions and instructions/);
});

test("3: the review lists at most MAX_REVIEW_CLAIMS sentences and has the token budget for them", async () => {
  const { sheet } = await sheetAndRoster();
  assert.equal(REVIEW_SCHEMA.properties.outside_claims.maxItems, MAX_REVIEW_CLAIMS);
  assert.ok(buildReviewRequest(sheet, "A post.").options.maxOutputTokens >= 4096);
});

test("3: a review answer that was cut off fails the draft with a clear reason, and nothing is stored as passed", async () => {
  const { db } = await sheetAndRoster();
  const g = fakeGemini({ review: () => { throw new GeminiIncompleteError("cut off", "MAX_TOKENS"); } });
  const { ctx } = contentCtx(db, { keys: {} });
  const r = await runDraft(ctx, g, { kind: "top-grades", night: "2026-11-16", budget: 20 });
  assert.equal(r.status, "dropped");
  assert.match(r.failures.join("; "), /cut off before it finished, so outside claims were not checked/);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM posts WHERE status IN ('draft', 'published')")).rows[0].n), 0);
});

test("4: a name in the next sentence is not attributed to a flagged sentence, and cutting one leaves the other", async () => {
  const draft = "Intro.\nRecruiters spend seven seconds on a portfolio. **Brittany Chiang** earns a 5 on clarity.";
  const flagged = ["Recruiters spend seven seconds on a portfolio."];
  const { r, w } = await run(draft, flagged);
  assert.equal(w.bodies.length, 1, "the first sentence names nobody, so it is searched");
  assert.equal(r.cut[0].reason, "no search results");
  const cut = cutClaimSentences({ body: draft }, [], flagged);
  assert.equal(cut.draft.body, "Intro.\n**Brittany Chiang** earns a 5 on clarity.");
  // The same holds after a curly quote or a lower-case word.
  const cut2 = cutClaimSentences({ body: "Recruiters spend seven seconds. “Brittany” earns a 5." }, [], ["Recruiters spend seven seconds."]);
  assert.equal(cut2.draft.body, "“Brittany” earns a 5.");
  const cut3 = cutClaimSentences({ body: "Recruiters spend seven seconds. a lower-case start follows." }, [], ["Recruiters spend seven seconds."]);
  assert.equal(cut3.draft.body, "a lower-case start follows.");
});

test("5: a plain-text copy of a sentence with emphasis, code and a link whose address holds parentheses is found in the post", async () => {
  const draft = "Intro.\nRecruiters spend **seven seconds** on a [portfolio](https://en.wikipedia.org/wiki/Portfolio_(finance)), says `a survey`.";
  const flagged = ["Recruiters spend seven seconds on a portfolio, says a survey."];
  const { r } = await run(draft, flagged);
  assert.equal(r.listedNotFound, undefined);
  assert.equal(r.cut.length, 1);
  const cut = cutClaimSentences({ body: draft }, [], flagged);
  assert.equal(cut.notFound.length, 0);
});

test("6: every outcome has a plain label, and the counts are kept and cut", () => {
  assert.deepEqual(["supported", "cut"].map((outcome) => labelOf({ outcome })), ["Kept, with a source", "Cut"]);
  assert.equal(labelOf({ outcome: "not found in the post" }), "Not found in the post, so the draft was dropped");
  assert.deepEqual(flagCounts([{ outcome: "supported" }, { outcome: "cut" }, { outcome: "cut" }]), { kept: 1, cut: 2 });
});

test("a draft whose title has been flagged still names the field (alternative titles are read)", async () => {
  const { db } = await sheetAndRoster();
  const claim = "Recruiters read portfolios for seven seconds, studies say";
  const write = (_n, parts) => mockAnswer({ parts }).replace(/(=== TITLE ===\n[^\n]*\n[^\n]*\n)[^\n]*/, `$1${claim}`);
  const g = fakeGemini({ write, review: { ...REVIEW_OK, outside_claims: [claim] } });
  const { ctx } = contentCtx(db, { keys: {} });
  const r = await runDraft(ctx, g, { kind: "top-grades", night: "2026-11-16", budget: 20 });
  assert.equal(r.status, "dropped");
  assert.match(r.failures.join("; "), /alternative title/);
});
