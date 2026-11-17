// Outside claims, second review of 2026-11-16 (pull request #253): the code
// does not depend on the reviewer for sentences that name a listed site (a
// sentence is "ours" only when a sheet fact about that site backs it), the
// review prompt says what makes an outside claim, and the weekly Tavily count
// is one counter (tavily_searches) that no failure path can lose.
// Mock writer, fake fetch, fake Gemini: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MONDAY, REVIEW_OK, SUNDAY, contentCtx, fakeGemini, sheetAndRoster } from "./helpers/content-fixture.mjs";
import { mockAnswer } from "../pipeline/content/mock-writer.mjs";
import { contentSummaryConditions, runDraft } from "../pipeline/content/engine.mjs";
import { TAVILY_API, checkClaims } from "../pipeline/content/claims.mjs";
import { buildReviewRequest } from "../pipeline/content/topic.mjs";
import { tavilyThisWeek } from "../lib/content/store.mjs";
import { creditsFor } from "../lib/content/tavily-credits.mjs";
import { CONTENT_TABLES } from "../lib/content/schema.mjs";
import { flagsOf } from "../pipeline/content/claim-flags.mjs";
import { pruneLogs } from "../pipeline/retention.mjs";
import { renderPreview } from "../pipeline/content/preview.mjs";

const NIGHT = { kind: "top-grades", night: "2026-11-16", budget: 20 };
const CLAIM = "Recruiters spend about seven seconds on a portfolio before deciding.";
const RESULT = { title: "Hiring study", url: "https://good.example/study", content: "Recruiters spend about seven seconds on a portfolio." };
const inClosing = (text) => (_n, parts) => mockAnswer({ parts }).replace("=== CLOSING ===\n", `=== CLOSING ===\n${text}\n`);
const count = async (db, table) => Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

/** A fake web: Tavily answers as `tavily` says; pages load. */
const web = ({ tavily = () => new Response(JSON.stringify({ results: [RESULT] })) } = {}) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    if (String(url) === TAVILY_API) return tavily(init);
    if (String(url).startsWith("https://good.example/")) return new Response("<p>Recruiters spend about seven seconds on a portfolio.</p>");
    return new Response("ok");
  };
  return { fetchImpl, seen, searches: () => seen.filter((u) => u === TAVILY_API).length };
};
const noResults = () => new Response(JSON.stringify({ results: [] }));

async function postsOf(db) {
  return (await db.execute("SELECT status, body, checks FROM posts")).rows.map((r) => ({ status: String(r.status), body: String(r.body), checks: JSON.parse(String(r.checks ?? "{}")) }));
}

/** A sentence that names the sheet's first listed site and rests on a sheet fact about it. */
function ownSentence(sheet) {
  const site = sheet.names[0];
  const fact = sheet.facts.find((f) => f.about === site.url);
  return { site, fact, raw: `Consider [${site.name}](${site.url}), who earns {{${fact.id}}} on visual design.`, plain: `Consider ${site.name}, who earns ${fact.display} on visual design.` };
}

// ---------------------------------------------------------------------------
// 1 and 2. The prompt, and the code-side check that does not trust the reviewer
// ---------------------------------------------------------------------------
test("1: the review prompt says an outside claim is about where the information comes from, not who is named", async () => {
  const { sheet } = await sheetAndRoster();
  const text = buildReviewRequest(sheet, "A post.").parts[0].text;
  assert.match(text, /where its information comes from, not who it mentions/);
  assert.match(text, /even when it names a site from the names list/);
  assert.doesNotMatch(text, /about a named site is not one/);
});

test("1+2: a reviewer that follows the OLD wording (leaves out a sentence that names a listed site) does not let the claim through", async () => {
  const { db, sheet } = await sheetAndRoster();
  const claim = `Recruiters at Google hired ${sheet.names[0].name} within a week, a LinkedIn study found.`;
  const g = fakeGemini({ write: inClosing(claim), review: { ...REVIEW_OK, outside_claims: [] } });
  const w = web({ tavily: noResults });
  const { ctx } = contentCtx(db, { mode: "publish", keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
  ctx.flags.publishGate = "none";
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.equal(w.searches(), 1, "the code checked it");
  const [post] = await postsOf(db);
  assert.ok(!post.body.includes("LinkedIn study"));
  assert.deepEqual(flagsOf(post.checks.history).map((f) => [f.by, f.outcome]), [["code", "cut"]]);
});

test("2: a sentence built from a sheet fact about the site it names is ours, even when the review flags nothing", async () => {
  const { db, sheet } = await sheetAndRoster();
  const own = ownSentence(sheet);
  const g = fakeGemini({ write: inClosing(own.raw), review: { ...REVIEW_OK, outside_claims: [] } });
  const w = web();
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.equal(w.searches(), 0);
  assert.ok((await postsOf(db))[0].body.includes(own.site.name));
});

// ---------------------------------------------------------------------------
// 3. A flagged sentence that is only the site's data is "ours"
// ---------------------------------------------------------------------------
test("3: a flagged sentence built only from sheet facts is recorded as ours with its fact, not searched, not cut", async () => {
  const { db, sheet } = await sheetAndRoster();
  const own = ownSentence(sheet);
  // The review copies it as plain text, without the Markdown link.
  const g = fakeGemini({ write: inClosing(own.raw), review: { ...REVIEW_OK, outside_claims: [own.plain] } });
  const w = web();
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.equal(w.searches(), 0, "the listed person's name is never sent to Tavily");
  assert.ok(!g.calls.some((c) => c.kind === "judge"));
  const [post] = await postsOf(db);
  assert.ok(post.body.includes(own.site.name), "the sentence stays");
  assert.deepEqual(flagsOf(post.checks.history).map((f) => [f.outcome, f.facts]), [["ours", [own.fact.id]]]);
});

test("3: a flagged sentence that names a listed site and also states something about the world is not ours", async () => {
  const { db, sheet } = await sheetAndRoster();
  const own = ownSentence(sheet);
  const mixed = `${own.raw.replace(/\.$/, "")}, and recruiters at Google hired them for it.`;
  const g = fakeGemini({ write: inClosing(mixed), review: { ...REVIEW_OK, outside_claims: [] } });
  const w = web({ tavily: noResults });
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.equal(w.searches(), 1);
  assert.ok(!(await postsOf(db))[0].body.includes("recruiters at Google"));
});

test("3: the presence test ignores Markdown link markup on both sides", async () => {
  const draft = "Intro.\nConsider [Top Person 1](https://top-1.dev), who earns 4.8 on visual design.\nRecruiters spend [seven seconds](https://x.example) on it.";
  const flagged = ["Consider Top Person 1, who earns 4.8 on visual design.", "Recruiters spend seven seconds on it."];
  const r = await checkClaims(draft, { tavilyKey: null, budget: { gemini: 5, tavily: 5 }, generate: async () => ({}), flagged });
  assert.equal(r.listedNotFound, undefined);
  assert.equal(r.cut.length, 2);
});

// ---------------------------------------------------------------------------
// 4 to 8, 10. The weekly counter
// ---------------------------------------------------------------------------
test("4: a Tavily key that is refused (401) with six flagged claims counts no search anywhere", async () => {
  const { db } = await sheetAndRoster();
  const claims = ["One, recruiters read for seven seconds, studies say.", "Two, managers skim the top screen, surveys show.", "Three, companies screen with software, analysts report.", "Four, reviewers decide fast, experts say.", "Five, case studies win calls, recruiters report.", "Six, sites load slowly on phones, a survey found."];
  const credits = creditsFor(db, { cap: 200, weekCap: 50, now: () => new Date(MONDAY) });
  const w = web({ tavily: () => new Response("no", { status: 401 }) });
  const r = await checkClaims(claims.join("\n"), { tavilyKey: "bad", fetchImpl: w.fetchImpl, budget: { gemini: 5, tavily: 10 }, generate: async () => ({}), credits, flagged: claims });
  assert.equal(r.cut.length, 6);
  assert.equal(r.searches, 0, "no answered search");
  assert.equal(credits.kept(), 0);
  assert.equal(await count(db, "tavily_searches"), 0);
  assert.equal(await tavilyThisWeek(db, MONDAY), 0);
});

test("4: a refused key through a whole draft leaves the run record at zero searches too", async () => {
  const { db } = await sheetAndRoster();
  const g = fakeGemini({ write: inClosing(CLAIM), review: { ...REVIEW_OK, outside_claims: [CLAIM] } });
  const { ctx } = contentCtx(db, { keys: { tavily: "bad" }, fetchImpl: web({ tavily: () => new Response("no", { status: 401 }) }).fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.equal(r.searches, 0);
  assert.equal(Number((await db.execute("SELECT COALESCE(SUM(tavily), 0) AS n FROM content_runs")).rows[0].n), 0);
});

test("5: a draft that throws after searching records its searches on the run, on the error and in the weekly summary", async () => {
  const { db } = await sheetAndRoster();
  const g = fakeGemini({ write: inClosing(CLAIM), review: { ...REVIEW_OK, outside_claims: [CLAIM] }, judge: () => { throw new Error("gemini answered 500"); } });
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: web().fetchImpl });
  await assert.rejects(runDraft(ctx, g, NIGHT), (e) => e.spent.tavily === 1);
  assert.equal(Number((await db.execute("SELECT tavily FROM content_runs WHERE status = 'failed'")).rows[0].tavily), 1);
  const [alert] = await contentSummaryConditions(db, { now: SUNDAY + 3600000, mode: "dry-run" });
  assert.match(alert.detail, /Tavily searches: 1 of 50/);
});

test("5: the weekly count is the reserved rows alone; the run record does not add to it", async () => {
  const { db } = await sheetAndRoster();
  await db.execute({ sql: "INSERT INTO content_runs (night, at, week, step, mode, status, tavily) VALUES ('x', ?, 'w', 'draft', 'dry-run', 'ok', 40)", args: [new Date(MONDAY - 1000).toISOString()] });
  assert.equal(await tavilyThisWeek(db, MONDAY), 0);
  const credits = creditsFor(db, { cap: 200, weekCap: 50, now: () => new Date(MONDAY) });
  assert.equal(await credits.reserve(), true);
  assert.equal(await tavilyThisWeek(db, MONDAY), 1);
});

test("6: a database error other than a missing table is not read as zero searches", async () => {
  await assert.rejects(tavilyThisWeek({ execute: async () => { throw new Error("database is locked"); } }, MONDAY), /locked/);
  assert.equal(await tavilyThisWeek({ execute: async () => { throw new Error("no such table: tavily_searches"); } }, MONDAY), 0);
});

test("7: a throw between the weekly and the monthly step leaves neither counter holding a search", async () => {
  const { db } = await sheetAndRoster();
  const sqlOf = (q) => String(q.sql ?? q);
  const used = async () => Number((await db.execute("SELECT used FROM tavily_credits")).rows[0].used);
  const monthFails = { execute: async (q) => (sqlOf(q).startsWith("UPDATE tavily_credits SET used = used +") ? Promise.reject(new Error("boom")) : db.execute(q)) };
  await assert.rejects(creditsFor(monthFails, { cap: 200, weekCap: 50, now: () => new Date(MONDAY) }).reserve(), /boom/);
  assert.equal(await tavilyThisWeek(db, MONDAY), 0, "the weekly row was given back");
  // A release whose weekly step throws still gives the month's credit back.
  const weekFails = { execute: async (q) => (sqlOf(q).startsWith("DELETE FROM tavily_searches") ? Promise.reject(new Error("boom")) : db.execute(q)) };
  const held = creditsFor(weekFails, { cap: 200, weekCap: 50, now: () => new Date(MONDAY) });
  assert.equal(await held.reserve(), true);
  assert.equal(await used(), 1);
  await assert.rejects(held.release(), /boom/);
  assert.equal(await used(), 0, "the monthly credit was released anyway");
});

test("8: migrating backfills the last 7 days of recorded searches, once", async () => {
  const { db } = await sheetAndRoster();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const old = new Date(Date.now() - 20 * 86400000).toISOString();
  await db.execute("DELETE FROM tavily_searches WHERE id > 0");
  for (const [at, n] of [[recent, 3], [old, 5]]) await db.execute({ sql: "INSERT INTO content_runs (night, at, week, step, mode, status, tavily) VALUES ('x', ?, 'w', 'draft', 'dry-run', 'ok', ?)", args: [at, n] });
  for (let k = 0; k < 2; k++) for (const sql of CONTENT_TABLES.filter((q) => q.includes("tavily_searches"))) await db.execute(sql);
  assert.equal(await count(db, "tavily_searches"), 3, "three recent searches, none from 20 days ago, and a second migration adds nothing");
});

test("10: the weekly rows are pruned after the window plus a day", async () => {
  const { db } = await sheetAndRoster();
  for (const days of [0.5, 7.5, 9]) await db.execute({ sql: "INSERT INTO tavily_searches (at) VALUES (?)", args: [new Date(MONDAY - days * 86400000).toISOString()] });
  const out = await pruneLogs(db, { now: new Date(MONDAY) });
  assert.equal(out.tavilySearches, 1, "only the row older than 8 days");
  assert.equal(await count(db, "tavily_searches"), 2);
});

// ---------------------------------------------------------------------------
// 9. The owner sees every flag
// ---------------------------------------------------------------------------
test("9: the owner's preview lists every flag with its outcome, source, reason and fact", async () => {
  const { db, sheet } = await sheetAndRoster();
  const own = ownSentence(sheet);
  const second = "Hiring managers read the first screen only, surveys show.";
  const flagged = [own.plain, CLAIM, second];
  const g = fakeGemini({ write: inClosing(`${own.raw}\n${CLAIM}\n${second}`), review: { ...REVIEW_OK, outside_claims: flagged }, judge: { verdicts: [{ claim: 0, supported: true, source_url: RESULT.url }] } });
  let n = 0;
  const w = web({ tavily: () => new Response(JSON.stringify({ results: n++ === 0 ? [RESULT] : [] })) });
  const { ctx } = contentCtx(db, { keys: { tavily: "k" }, fetchImpl: w.fetchImpl });
  const r = await runDraft(ctx, g, NIGHT);
  assert.equal(r.status, "ok", r.failures?.join("; "));
  const [row] = await postsOf(db);
  const post = { title: "T", subtitle: "", body: "x", status: "draft", kind: "k", requests: 1, publishAt: null, aiLine: "", aiNote: "", altTitles: [], tags: [], shareLine: "", newsletterBlurb: "", images: [], claims: [], facts: { facts: [], names: [] }, checks: row.checks };
  const html = renderPreview(post);
  assert.match(html, /Ours: built from the sheet/);
  assert.match(html, /Kept, with a source/);
  assert.match(html, /Cut<\/strong>/);
  assert.match(html, new RegExp(`facts ${own.fact.id}`));
  assert.match(html, /good\.example/);
  assert.match(html, /no search results/);
  assert.equal(flagsOf(row.checks.history).length, 3, "each sentence once");
});
