// The content engine's pre-launch audit (2026-11-16), one test group per
// lettered finding (A to G): each was written to fail on the code as audited.
// Unit tests against the mock writer (pipeline/content/mock-writer.mjs); no
// network and no running site.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONDAY, REVIEW_OK, contentCtx, fakeGemini, fixture, sheetAndRoster } from "./helpers/content-fixture.mjs";
import { BUILDERS, KIND_LABELS, findIdeas, leaderboardMovement, topGrades, votePatterns } from "../pipeline/content/facts.mjs";
import { KIND_TOPIC } from "../pipeline/content/topic.mjs";
import { mockAnswer } from "../pipeline/content/mock-writer.mjs";
import { assemble, blocksToFix } from "../pipeline/content/compose.mjs";
import { planPost } from "../pipeline/content/plan.mjs";
import { checkLinksLoad } from "../pipeline/content/checks.mjs";
import { runDraft, contentJob, contentStage } from "../pipeline/content/engine.mjs";
import { listPosts } from "../lib/content/store.mjs";
import { automationDefaults, readAutomation, saveAutomation } from "../lib/content/automation.mjs";
import { createJob, finishJob, getJob, recentJobs, startJob } from "../lib/content/jobs.mjs";
import * as jobsModule from "../lib/content/jobs.mjs";
import { generationNeeded, pollsContent } from "../pipeline/polls.mjs";
import { chooseKind } from "../pipeline/content/manual.mjs";
import * as claimsModule from "../pipeline/content/claims.mjs";

const NIGHT = { kind: "top-grades", night: "2026-11-16", budget: 20 };

// ---------------------------------------------------------------------------
// A. Outside claims fail closed
// ---------------------------------------------------------------------------
/** A writer answer with `edit` applied to the mock's text. */
const writing = (edit) => (_n, parts) => edit(mockAnswer({ parts }));
const placeholderFor = async (db, label) => {
  const sheet = await topGrades(db, { now: MONDAY });
  const f = sheet.facts.find((x) => x.label === label);
  return { id: `{{${f.id}}}`, display: f.display };
};
const SHARE = "Share of all graded portfolios that are top-graded";

async function draftWith({ edit, claims }) {
  const { db } = await sheetAndRoster();
  const g = fakeGemini({ write: writing(edit), review: { ...REVIEW_OK, outside_claims: claims } });
  const { ctx } = contentCtx(db);
  const r = await runDraft(ctx, g, NIGHT);
  const [post] = await listPosts(db, { status: "draft" });
  return { r, post, db };
}

test("A: a claim in the subtitle is found and the draft does not pass with it", async () => {
  const claim = "Hiring managers say a portfolio without a resume gets ignored.";
  const { r, post } = await draftWith({ edit: (t) => t.replace(/(=== SUBTITLE ===\n)[^\n]+/, `$1${claim}`), claims: [claim] });
  assert.equal(r.status, "dropped", "the subtitle cannot lose its claim and stay a subtitle, so the draft is dropped");
  assert.equal(post, undefined, "nothing is stored as a draft that still holds the claim");
});

test("A: a claim that carries a filled figure is found in the filled text and cut", async () => {
  const { db } = await sheetAndRoster();
  const share = await placeholderFor(db, SHARE);
  const filledClaim = `Hiring managers agree, and ${share.display} of graded portfolios are top-graded.`;
  const unfilled = `Hiring managers agree, and ${share.id} of graded portfolios are top-graded.`;
  const { r, post } = await draftWith({ edit: (t) => t.replace("=== CLOSING ===\n", `=== CLOSING ===\n${unfilled}\n`), claims: [filledClaim] });
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.ok(!post.body.includes("Hiring managers agree"), "the sentence is cut");
});

test("A: a claim the review copies with a curly apostrophe is still found and cut", async () => {
  const claim = "A recruiter's first look lasts about seven seconds, studies say.";
  const { r, post } = await draftWith({ edit: (t) => t.replace("=== CLOSING ===\n", `=== CLOSING ===\n${claim}\n`), claims: [claim.replace("'", "’")] });
  assert.equal(r.status, "ok", r.failures?.join("; "));
  assert.ok(!post.body.includes("studies say"));
});

test("A: a claim in the body copied word for word is still cut (the case that worked)", async () => {
  const claim = "Recruiters spend about seven seconds on a portfolio before deciding.";
  const { r, post } = await draftWith({ edit: (t) => t.replace("=== CLOSING ===\n", `=== CLOSING ===\n${claim}\n`), claims: [claim] });
  assert.equal(r.status, "ok");
  assert.ok(!post.body.includes("seven seconds"));
});

test("A: a flagged claim that is nowhere in the post drops the draft, never stored as passed", async () => {
  const { r, post } = await draftWith({ edit: (t) => t, claims: ["Nine of ten employers read a portfolio before a resume."] });
  assert.equal(r.status, "dropped");
  assert.ok(r.failures.some((f) => /claim/i.test(f)), r.failures.join("; "));
  assert.equal(post, undefined);
});

test("A: claims are matched in the TL;DR, the share line and the newsletter blurb too", async () => {
  const draft = {
    title: "T",
    subtitle: "Sub.",
    tldr: ["Hiring managers love {{f1}} portfolios.", "Plain point {{f1}}.", "Another {{f2}}."],
    share_line: "Recruiters read for seven seconds.",
    newsletter_blurb: "Blurb.",
    body: "One.\nTwo.",
  };
  const facts = [{ id: "f1", display: "7" }, { id: "f2", display: "8" }];
  const tldr = claimsModule.cutClaimSentences(draft, facts, ["Hiring managers love 7 portfolios."]);
  assert.equal(tldr.notFound.length, 0);
  assert.equal(tldr.draft.tldr.length, 2);
  const share = claimsModule.cutClaimSentences(draft, facts, ["Recruiters read for seven seconds."]);
  assert.equal(share.draft.share_line, "");
  const missing = claimsModule.cutClaimSentences(draft, facts, ["Not anywhere."]);
  assert.deepEqual(missing.notFound, ["Not anywhere."]);
});

// ---------------------------------------------------------------------------
// B. Only real people's votes count
// ---------------------------------------------------------------------------
const addVotes = async (db, n, raterType, from = 1) => {
  for (let i = from; i < from + n; i++) {
    await db.execute({ sql: "INSERT INTO votes (winner, loser, rater_type, rater_id) VALUES (?, ?, ?, ?)", args: [`https://top-${i}.dev`, `https://low-${i}.dev`, raterType, `${raterType}-${i}`] });
  }
};

test("B: AI and practice votes are not people's votes", async () => {
  const db = await fixture();
  await addVotes(db, 30, "ai");
  await addVotes(db, 15, "anon");
  const s = await votePatterns(db, { now: MONDAY });
  assert.equal(s.ready, false, "45 votes, none of them a person's");
  assert.match(s.reason, /^0 people's votes/);
});

test("B: only the human votes are counted, beside AI and practice votes", async () => {
  const db = await fixture();
  await addVotes(db, 30, "human");
  await addVotes(db, 15, "human", 31 - 15);
  await addVotes(db, 30, "ai");
  await addVotes(db, 15, "anon");
  const s = await votePatterns(db, { now: MONDAY });
  assert.equal(s.ready, true, s.reason);
  assert.equal(s.facts.find((f) => f.label === "People's votes between two graded portfolios").display, "45");
});

// ---------------------------------------------------------------------------
// C. Kinds with no data source
// ---------------------------------------------------------------------------
const seedHistory = async (db) => {
  for (const week of ["2026-W45", "2026-W46"]) {
    for (let i = 1; i <= 30; i++) await db.execute({ sql: "INSERT INTO rank_history (view, week, url, rank, mu, sigma) VALUES ('merged', ?, ?, ?, 0, 0)", args: [week, `https://top-${i}.dev`, week === "2026-W46" ? 31 - i : i] });
  }
};

test("C: regrade-changes can no longer be picked or written", async () => {
  assert.ok(!("regrade-changes" in BUILDERS));
  assert.ok(!("regrade-changes" in KIND_LABELS));
  assert.ok(!("regrade-changes" in KIND_TOPIC));
});

test("C: leaderboard-movement is not ready while the ranking flag is off, and is when on", async () => {
  const db = await fixture();
  await seedHistory(db);
  const off = await leaderboardMovement(db, { now: MONDAY });
  assert.equal(off.ready, false);
  assert.match(off.reason, /RANKING_V2/);
  const on = await leaderboardMovement(db, { now: MONDAY, rankingV2: true });
  assert.equal(on.ready, true, on.reason);
  // The idea finder, the manual picker and the writer all go through the flag.
  assert.ok(!(await findIdeas(db, { now: MONDAY })).ideas.some((i) => i.kind === "leaderboard-movement"));
  assert.ok((await findIdeas(db, { now: MONDAY, rankingV2: true })).ideas.some((i) => i.kind === "leaderboard-movement"));
  assert.match((await chooseKind(db, { kind: "leaderboard-movement", now: MONDAY })).error, /RANKING_V2/);
  assert.equal((await chooseKind(db, { kind: "leaderboard-movement", now: MONDAY, rankingV2: true })).kind, "leaderboard-movement");
  const g = fakeGemini({ review: REVIEW_OK });
  const { ctx } = contentCtx(db);
  assert.equal((await runDraft(ctx, g, { ...NIGHT, kind: "leaderboard-movement" })).status, "skipped", "the writer refuses it with the flag off");
  assert.equal(g.calls.length, 0);
});

test("C: the replay fixtures exercise only kinds that can be written, vote-patterns among them", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/content-replay");
  const kinds = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).kind);
  assert.equal(kinds.length, 10);
  for (const k of kinds) assert.ok(["top-grades", "page-craft", "vote-patterns"].includes(k), k);
  for (const k of ["top-grades", "page-craft", "vote-patterns"]) assert.ok(kinds.includes(k), `no ${k} fixture`);
});

// ---------------------------------------------------------------------------
// D. Raising the cap switches on one thing at a time
// ---------------------------------------------------------------------------
test("D: scheduled drafts are off until the owner has saved Automation settings", async () => {
  const env = { CONTENT_MODE: "dry-run", CONTENT_DRAFTS_PER_WEEK: "2" };
  assert.equal(automationDefaults(env).enabled, false);
  const db = await fixture();
  const read = await readAutomation(db, env);
  assert.equal(read.saved, null);
  assert.equal(read.settings.enabled, false);
  assert.equal(read.settings.engineMode, "off");
  const { ctx } = contentCtx(db, { now: MONDAY });
  const job = await contentJob(ctx);
  assert.equal(job.job, null);
  assert.match(job.reason, /automation is off/);
  // Saved on, it runs.
  await saveAutomation(db, { enabled: true, mode: "review", days: [1, 3], perWeek: 2 }, { env: { CONTENT_MODE: "dry-run", CONTENT_DRAFTS_PER_WEEK: "2" }, by: "owner" });
  assert.equal((await readAutomation(db, env)).settings.enabled, true);
});

test("D: Gemini poll generation has its own switch, off unless POLL_GENERATION_ENABLED is true", async () => {
  const db = await fixture();
  const { ctx } = contentCtx(db, { now: MONDAY });
  const stage = { night: "2026-11-16" };
  assert.equal((await generationNeeded(ctx)).n, 1, "there is a gap to fill");
  assert.equal(await pollsContent.count(ctx), 0, "but the switch is off");
  assert.deepEqual(await pollsContent.next(ctx, stage, 5), []);
  assert.deepEqual(await contentStage.next(ctx, { night: "2026-11-16" }, 5), [], "the content stage starts neither polls nor drafts");
  const on = { ...ctx, flags: { ...ctx.flags, pollGeneration: "true" } };
  assert.equal(await pollsContent.count(on), 1);
  assert.equal((await pollsContent.next(on, { night: "2026-11-16" }, 5)).length, 1);
});

// ---------------------------------------------------------------------------
// E. A missing section can be repaired, and the default subhead has no digit
// ---------------------------------------------------------------------------
test("E: the default subhead has no digit, and a fix call may ask for a missing section", async () => {
  const { sheet } = await sheetAndRoster();
  const plan = planPost(sheet);
  const { draft } = assemble(sheet, plan, {});
  const heads = [...draft.body.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1]);
  assert.ok(heads.length >= plan.sections.length);
  for (const h of heads) assert.ok(!/\d/.test(h), `subhead "${h}" has a digit`);
  const which = blocksToFix({}, ["template: body has 100 words; 700 to 1000 wanted: add about 600 words of substance"], plan);
  assert.ok(which.includes("SECTION 1"), which.join(","));
});

test("E: a long post whose writer left out sections is repaired by the one fix call, not dropped", async () => {
  const { db } = await sheetAndRoster();
  // As the audit saw it: the sections' blocks are missing, so the default subhead
  // (with a digit then) failed the stray-number check, and no fix call was made.
  let section = "";
  const g = fakeGemini({
    write: (n, parts) => {
      const full = mockAnswer({ parts });
      if (n === 1) section = full.match(/=== SECTION 1 ===\n([\s\S]*?)(?=\n=== |$)/)[1];
      if (n <= 2) return full.replace(/=== SECTION [345] ===[\s\S]*?(?=\n=== |$)/g, "");
      // The fix call: a section block each for the sections it was asked for.
      return [...parts[0].text.matchAll(/^=== (SECTION \d+) ===$/gm)]
        .map((m, i) => `=== ${m[1]} ===\n## Another angle on the data, ${["first", "second", "third"][i] ?? "next"}\n${section.split("\n").slice(1).join("\n")}`)
        .join("\n\n");
    },
    review: REVIEW_OK,
  });
  const { ctx } = contentCtx(db);
  const r = await runDraft(ctx, g, { ...NIGHT, length: "long" });
  const writes = g.calls.filter((c) => c.kind === "write");
  assert.equal(writes.length, 3, "two writes for a long post and the one fix");
  assert.match(writes[2].parts[0].text, /=== SECTION 3 ===/, "the missing section is asked for");
  assert.equal(r.status, "ok", r.failures?.join("; "));
});

// ---------------------------------------------------------------------------
// F. A bot wall is not a broken link
// ---------------------------------------------------------------------------
test("F: a 401 or 403 from a named portfolio is inconclusive, like a 429", async () => {
  const answer = (status) => async () => new Response("", { status });
  for (const status of [200, 401, 403, 429]) assert.equal((await checkLinksLoad(["https://a.dev"], answer(status))).ok, true, String(status));
  for (const status of [404, 410, 500, 503]) assert.equal((await checkLinksLoad(["https://a.dev"], answer(status))).ok, false, String(status));
});

// ---------------------------------------------------------------------------
// G. A job that never finished is marked failed
// ---------------------------------------------------------------------------
test("G: a job running longer than the limit is marked failed, with a reason the page can show", async () => {
  const db = await fixture();
  const t0 = Date.parse("2026-11-16T18:00:00Z");
  const at = (min) => new Date(t0 + min * 60000);
  await createJob(db, { id: "a".repeat(16), by: "admin:o", now: at(0) });
  await startJob(db, "a".repeat(16), { now: at(0) });
  await createJob(db, { id: "b".repeat(16), by: "admin:o", now: at(jobsModule.STALE_JOB_MINUTES - 10) });
  await startJob(db, "b".repeat(16), { now: at(jobsModule.STALE_JOB_MINUTES - 10) });
  // Read after the first one's limit: only that one has failed.
  const jobs = await recentJobs(db, { limit: 10, now: at(jobsModule.STALE_JOB_MINUTES + 1) });
  const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
  assert.equal(byId["a".repeat(16)].status, "failed");
  assert.match(byId["a".repeat(16)].message, /did not finish|stopped/i);
  assert.ok(byId["a".repeat(16)].finishedAt);
  assert.equal(byId["b".repeat(16)].status, "running");
  // A finish that arrives later changes nothing.
  await finishJob(db, "a".repeat(16), { status: "done", message: "late" });
  assert.equal((await getJob(db, "a".repeat(16))).status, "failed");
});

test("G: starting a new job clears a stale one first, and a queued job that never started goes too", async () => {
  const db = await fixture();
  const t0 = Date.parse("2026-11-16T18:00:00Z");
  await createJob(db, { id: "c".repeat(16), by: "admin:o", now: new Date(t0) });
  const later = new Date(t0 + (jobsModule.STALE_JOB_MINUTES + 5) * 60000);
  const made = await createJob(db, { id: "d".repeat(16), by: "admin:o", now: later });
  assert.ok(made.job);
  assert.equal((await getJob(db, "c".repeat(16))).status, "failed");
  assert.equal((await getJob(db, "d".repeat(16))).status, "queued");
});

test("Write a draft now runs in production only, at its daily cap", () => {
  assert.deepEqual(jobsModule.draftNowPolicy({ SITE_ENV: "production" }), { cap: jobsModule.MANUAL_PER_DAY });
  for (const env of [{ SITE_ENV: "test" }, { SITE_ENV: "staging", GEMINI_API_KEY: "k" }, { SITE_ENV: "Production" }, {}]) {
    assert.deepEqual(jobsModule.draftNowPolicy(env), { error: "production_only" }, JSON.stringify(env));
  }
});
