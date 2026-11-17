// Outside claims fail closed (docs/audits/blog-engine.md, review of 2026-11-16):
// a sentence the review flags is always searched or cut, whatever names it
// holds; a review answer with no outside_claims list is a failed review; the
// weekly Tavily cap counts every search as it is reserved; and every way a
// claim check can end is a cut sentence or a failed run, never a passed claim.
// Mock writer, fake fetch, fake Gemini: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MONDAY, REVIEW_OK, contentCtx, fakeGemini, sheetAndRoster } from "./helpers/content-fixture.mjs";
import { mockAnswer } from "../pipeline/content/mock-writer.mjs";
import { runDraft } from "../pipeline/content/engine.mjs";
import { TAVILY_API, TAVILY_PER_WEEK } from "../pipeline/content/claims.mjs";
import { REVIEW_SCHEMA, reviewCheck } from "../pipeline/content/topic.mjs";
import { listPosts, tavilyThisWeek } from "../lib/content/store.mjs";
import { creditsFor } from "../lib/content/tavily-credits.mjs";
import { flagsOf } from "../pipeline/content/claim-flags.mjs";

const NIGHT = { kind: "top-grades", night: "2026-11-16", budget: 20 };
const CLAIM = "Recruiters spend about seven seconds on a portfolio before deciding.";
const inClosing = (text) => (_n, parts) => mockAnswer({ parts }).replace("=== CLOSING ===\n", `=== CLOSING ===\n${text}\n`);
const RESULT = { title: "Hiring study", url: "https://good.example/study", content: "Recruiters spend about seven seconds on a portfolio." };

/** A fake web: Tavily answers as `tavily` says (a Response, a function, or a throw), pages load. */
const web = ({ tavily = () => new Response(JSON.stringify({ results: [RESULT] })), page = "<p>Recruiters spend about seven seconds on a portfolio.</p>" } = {}) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    if (String(url) === TAVILY_API) return tavily(init);
    if (String(url).startsWith("https://good.example/")) return new Response(page);
    if (String(url).startsWith("https://gone.example/")) return new Response("gone", { status: 404 });
    return new Response("ok");
  };
  return { fetchImpl, seen, searches: () => seen.filter((u) => u === TAVILY_API).length };
};

/** A review answer that is fine except that it has no outside_claims field. */
function withoutClaimsList() {
  const r = { ...REVIEW_OK };
  delete r.outside_claims;
  return r;
}

async function postsOf(db) {
  return (await db.execute("SELECT status, body, checks FROM posts")).rows.map((r) => ({ status: String(r.status), body: String(r.body), checks: JSON.parse(String(r.checks ?? "{}")) }));
}

// ---------------------------------------------------------------------------
// a. A flagged claim that names a listed portfolio is still checked or cut
// ---------------------------------------------------------------------------
test("a: a flagged outside claim that names a listed site is searched and cut, and its outcome is recorded", async () => {
  for (const mode of ["dry-run", "publish"]) {
    const { db, sheet } = await sheetAndRoster();
    const name = sheet.names[0].name;
    const claim = `Recruiters at Google hired ${name} within a week, a LinkedIn study found.`;
    const g = fakeGemini({ write: inClosing(claim), review: { ...REVIEW_OK, outside_claims: [claim] } });
    const w = web({ tavily: () => new Response(JSON.stringify({ results: [] })) });
    const { ctx } = contentCtx(db, { mode, keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
    ctx.flags.publishGate = "none";
    const r = await runDraft(ctx, g, NIGHT);
    assert.equal(r.status, "ok", `${mode}: ${r.failures?.join("; ")}`);
    assert.equal(w.searches(), 1, `${mode}: the claim was searched`);
    const [post] = await postsOf(db);
    assert.ok(!post.body.includes("LinkedIn study"), `${mode}: the claim is not in the stored post`);
    const claims = post.checks.history.at(-1).claims;
    assert.deepEqual(claims.flagged.map((f) => [f.sentence, f.outcome]), [[claim, "cut"]]);
  }
});

test("a: a supported flagged claim is recorded with its source", async () => {
  const { db } = await sheetAndRoster();
  const g = fakeGemini({ write: inClosing(CLAIM), review: { ...REVIEW_OK, outside_claims: [CLAIM] }, judge: { verdicts: [{ claim: 0, supported: true, source_url: RESULT.url }] } });
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: web().fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  const flagged = (await postsOf(db))[0].checks.history.at(-1).claims.flagged;
  assert.deepEqual(flagged.map((f) => [f.sentence, f.outcome, f.url]), [[CLAIM, "supported", RESULT.url]]);
});

// ---------------------------------------------------------------------------
// b. A review with no outside_claims list is a failed review
// ---------------------------------------------------------------------------
test("b: outside_claims is required by the review schema", () => {
  assert.ok(REVIEW_SCHEMA.required.includes("outside_claims"));
});

test("b: a review answer without outside_claims (missing, null, not a list) fails; nothing is stored as passed", async () => {
  for (const bad of [undefined, null, "none", CLAIM, { 0: CLAIM }, [42]]) {
    const rest = withoutClaimsList();
    const review = bad === undefined ? rest : { ...rest, outside_claims: bad };
    assert.equal(reviewCheck(review).ok, false, JSON.stringify(bad));
    const { db } = await sheetAndRoster();
    const g = fakeGemini({ write: inClosing(CLAIM), review });
    const { ctx } = contentCtx(db, { keys: { tavily: "k" } });
    const r = await runDraft(ctx, g, NIGHT);
    assert.equal(r.status, "dropped", JSON.stringify(bad));
    assert.ok(r.failures.some((f) => /outside_claims/.test(f)), r.failures.join("; "));
    assert.equal((await listPosts(db, { status: "draft" })).length, 0, "no draft, so no passed post");
    assert.equal((await listPosts(db, { status: "published" })).length, 0);
  }
  assert.equal(reviewCheck({ ...REVIEW_OK, outside_claims: [] }).ok, true);
});

// ---------------------------------------------------------------------------
// c. The weekly Tavily cap counts searches as they are reserved
// ---------------------------------------------------------------------------
test("c: drafts whose judge call fails still count their searches against the week", async () => {
  const { db } = await sheetAndRoster();
  const claims = ["Recruiters spend about seven seconds on a portfolio before deciding.", "Hiring managers read the first screen only, surveys show.", "Most companies now screen portfolios with software, analysts report."];
  let searches = 0;
  for (let i = 0; i < 3; i++) {
    const g = fakeGemini({ write: inClosing(claims.join("\n")), review: { ...REVIEW_OK, outside_claims: claims }, judge: () => { throw new Error("gemini answered 500"); } });
    const w = web();
    const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
    await assert.rejects(runDraft(ctx, g, { ...NIGHT, night: `2026-11-1${i}` }), /gemini answered 500/);
    searches += w.searches();
  }
  assert.equal(searches, 9);
  assert.equal(await tavilyThisWeek(db, MONDAY + 1000), 9, "every search was counted though no run recorded them");
  assert.equal(Number((await db.execute("SELECT used FROM tavily_credits")).rows[0].used), 9, "as the month counts them");
});

test("c: no search is made past the weekly cap, even when the runs recorded none of the searches", async () => {
  const { db } = await sheetAndRoster();
  const credits = creditsFor(db, { cap: 200, weekCap: 2, now: () => new Date(MONDAY) });
  assert.equal(await credits.reserve(), true);
  assert.equal(await credits.reserve(), true);
  assert.equal(await credits.reserve(), false, "the third is refused");
  await credits.release();
  assert.equal(await credits.reserve(), true, "a search Tavily did not answer is given back");
  // The month refusing gives the week's search back too.
  const monthly = creditsFor(db, { cap: 0, weekCap: 50, now: () => new Date(MONDAY) });
  assert.equal(await monthly.reserve(), false);
  assert.equal(await tavilyThisWeek(db, MONDAY), 2);
  // A week later the searches no longer count.
  assert.equal(await tavilyThisWeek(db, MONDAY + 8 * 86400000), 0);
});

test("c: a full week of reserved searches means a draft searches nothing and cuts its claim", async () => {
  const { db } = await sheetAndRoster();
  const at = new Date(MONDAY - 3600000).toISOString();
  for (let i = 0; i < TAVILY_PER_WEEK; i++) await db.execute({ sql: "INSERT INTO tavily_searches (at) VALUES (?)", args: [at] });
  const g = fakeGemini({ write: inClosing(CLAIM), review: { ...REVIEW_OK, outside_claims: [CLAIM] } });
  const w = web();
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok");
  assert.equal(w.searches(), 0);
  assert.ok(!(await postsOf(db))[0].body.includes("seven seconds"));
});

// ---------------------------------------------------------------------------
// Every way a claim check can end: the sentence is cut and recorded, or the
// run fails and nothing is stored as passed. Never "passed with the claim".
// ---------------------------------------------------------------------------
const supportedBy = (url) => ({ verdicts: [{ claim: 0, supported: true, source_url: url }] });
const ENDINGS = [
  { name: "no Tavily key", keys: {}, outcome: "cut", reason: /TAVILY_API_KEY/ },
  { name: "Tavily answers 401", web: { tavily: () => new Response("no", { status: 401 }) }, outcome: "cut", reason: /search failed/ },
  { name: "Tavily answers 500", web: { tavily: () => new Response("no", { status: 500 }) }, outcome: "cut", reason: /search failed/ },
  { name: "Tavily times out", web: { tavily: () => { throw new DOMException("timed out", "TimeoutError"); } }, outcome: "cut", reason: /search failed/ },
  { name: "monthly cap reached", monthly: 0, outcome: "cut", reason: /cap reached/ },
  { name: "weekly cap reached", weekFull: true, outcome: "cut", reason: /cap reached/ },
  { name: "zero results", web: { tavily: () => new Response(JSON.stringify({ results: [] })) }, outcome: "cut", reason: /no search results/ },
  { name: "judge answers nothing", judge: { verdicts: [] }, outcome: "cut", reason: /not supported/ },
  { name: "judge names a source that is not in its results", judge: supportedBy("https://evil.example/x"), outcome: "cut", reason: /not one of its search results/ },
  { name: "the judged source does not load", judge: supportedBy("https://gone.example/x"), web: { tavily: () => new Response(JSON.stringify({ results: [{ ...RESULT, url: "https://gone.example/x" }] })) }, outcome: "cut", reason: /did not load/ },
  { name: "judge throws", judge: () => { throw new Error("gemini answered 500"); }, outcome: "throws" },
  { name: "review answer is not an object", review: "no claims", outcome: "dropped" },
  { name: "review answer has no outside_claims", review: withoutClaimsList(), outcome: "dropped" },
  { name: "review flags a sentence that is not in the post", flagged: ["Nine of ten employers read a portfolio before a resume."], outcome: "dropped" },
];

test("every ending of a claim check is a cut sentence or a failed run, never a passed claim", async () => {
  for (const e of ENDINGS) {
    const { db } = await sheetAndRoster();
    if (e.weekFull) for (let i = 0; i < TAVILY_PER_WEEK; i++) await db.execute({ sql: "INSERT INTO tavily_searches (at) VALUES (?)", args: [new Date(MONDAY - 1000).toISOString()] });
    const flagged = e.flagged ?? [CLAIM];
    const g = fakeGemini({ write: inClosing(CLAIM), review: e.review ?? { ...REVIEW_OK, outside_claims: flagged }, judge: e.judge ?? { verdicts: [] } });
    const w = web(e.web);
    const { ctx } = contentCtx(db, { keys: "keys" in e ? e.keys : { tavily: "k" }, fetchImpl: w.fetchImpl });
    if ("monthly" in e) ctx.content.tavilyMonthlyCredits = e.monthly;
    let r = null;
    let thrown = null;
    try {
      r = await runDraft(ctx, g, NIGHT);
    } catch (err) {
      thrown = err;
    }
    const posts = await postsOf(db);
    const passedWithClaim = posts.filter((p) => p.status !== "dropped" && p.body.includes("seven seconds"));
    assert.deepEqual(passedWithClaim, [], `${e.name}: a post kept the claim`);
    if (e.outcome === "cut") {
      assert.equal(thrown, null, e.name);
      assert.equal(r.status, "ok", `${e.name}: ${r?.failures?.join("; ")}`);
      const flags = flagsOf(posts.find((p) => p.status === "draft").checks.history);
      assert.deepEqual(flags.map((f) => f.outcome), ["cut"], e.name);
      assert.match(flags[0].reason, e.reason, e.name);
    } else if (e.outcome === "throws") {
      assert.ok(thrown, `${e.name}: the run fails`);
      assert.equal(posts.length, 0, `${e.name}: nothing stored`);
    } else {
      assert.equal(thrown, null, e.name);
      assert.equal(r.status, "dropped", e.name);
      assert.equal(posts.filter((p) => p.status === "draft").length, 0, `${e.name}: no passed draft`);
    }
  }
});
