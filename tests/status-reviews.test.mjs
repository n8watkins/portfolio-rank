// The owner's review queue (lib/reviews/store.mjs): nothing changes until a
// row is confirmed; Confirm applies each case through the pipeline's own
// paths (a kept grade re-ranked, a cleared grade, an owner-only "not a
// portfolio" grade, health and capture retries, a delisted site queued for
// data/additions.json) and records who and when; Reject records only; a row
// is decided once; later grades keep the owner's verdict; the weekly data
// pull request adds confirmed relists (pipeline/review-additions.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import {
  OWNER_KIND,
  confirmedRelists,
  decideReviews,
  listReviews,
  ownerGrade,
  pendingReviewCount,
  planConfirm,
  withOwnerVerdict,
} from "../lib/reviews/store.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";

const NOW = new Date("2026-11-16T18:00:00Z");
const ACTOR = "admin:owner";

async function freshDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reviews-")), "db.sqlite")}` });
  await migrate(db);
  return db;
}

const GRADE = (o = {}) => ({
  tier: "B",
  is_portfolio: false,
  model: "gemini-3.1-flash-lite",
  judged_at: "2026-11-01T00:00:00Z",
  visual_design: { score: 3 },
  project_presentation: { score: 3 },
  writing: { score: 3 },
  quality_score: 60,
  ...o,
});

async function site(db, url, { rubric = null, status = "live", health = null, healthReason = null, delistedAt = null } = {}) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, ai_rubric, health, health_reason, health_fails, delisted_at, needs_review)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [url, `Name of ${url}`, status, rubric == null ? null : JSON.stringify(rubric), health, healthReason, health ? 2 : 0, delistedAt],
  });
}

let nextUrl = 0;
async function review(db, url, { proposed = "relist", agreed = 1, grp = "not_portfolio", current = "listed", reason = "Real projects and a clear role." } = {}) {
  const r = await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, shot_key, verdicts, signals, created_at)
          VALUES ('recheck-543', ?, ?, ?, ?, ?, ?, 0, 'abcdef0123456789', ?, ?, ?)`,
    args: [
      url,
      grp,
      current,
      proposed,
      agreed,
      reason,
      JSON.stringify({ gemini31: { batch: { is_portfolio: proposed === "relist", reason: "r" }, solo: null }, haiku: { batch: { is_portfolio: proposed === "relist", reason: "r" }, solo: null } }),
      JSON.stringify({ score: 4, names: ["name", "projects", "about", "contact"], junk_rule: null, capture: {} }),
      "2026-11-14T10:00:00Z",
    ],
  });
  return Number(r.lastInsertRowid);
}

const row = async (db, url) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url] })).rows[0];
const rubricOf = async (db, url) => {
  const r = await row(db, url);
  return r.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
};
const decide = (db, ids, action = "confirm", onFeed = () => true) => decideReviews(db, { ids, action, actor: ACTOR, onFeed, now: NOW });
const u = () => `https://site-${++nextUrl}.dev`;

test("nothing changes before a decision; the queue lists agreed rows first", async () => {
  const db = await freshDb();
  const a = u();
  const b = u();
  await site(db, a, { rubric: GRADE() });
  await site(db, b, { rubric: GRADE() });
  await review(db, a, { agreed: 0 });
  await review(db, b, { agreed: 1 });
  assert.equal(await pendingReviewCount(db), 2);
  const { pending, decided } = await listReviews(db);
  assert.deepEqual(pending.map((r) => [r.url, r.agreed]), [
    [b, true],
    [a, false],
  ]);
  assert.equal(decided.length, 0);
  assert.equal((await rubricOf(db, a)).is_portfolio, false, "the grade is untouched while pending");
});

test("confirm relist of a graded 'not a portfolio' with a tier: kept, flipped, re-ranked, with history and who/when", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE(), health: "suspect", healthReason: "AI grading says this is not a portfolio" });
  const id = await review(db, url);
  const [res] = await decide(db, [id]);
  assert.equal(res.ok, true);
  assert.equal(res.applied.grade, "flip");
  const g = await rubricOf(db, url);
  assert.equal(g.is_portfolio, true);
  assert.equal(g.ai_is_portfolio, false);
  assert.equal(g.review.kind, OWNER_KIND);
  assert.equal(g.review.by, ACTOR);
  assert.ok(g.rank, "ranked through rankForWrite");
  const r = await row(db, url);
  assert.equal(r.health, "live", "the health check held it out only for the grade");
  assert.equal(Number(r.health_fails), 0);
  assert.equal(Number(r.needs_review), 0);
  assert.equal(Number((await db.execute({ sql: "SELECT member FROM tier_ratings WHERE url = ?", args: [url] })).rows[0].member), 1);
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM rubric_history WHERE url = ?", args: [url] })).rows[0].n), 1);
  const rv = (await listReviews(db)).decided[0];
  assert.deepEqual([rv.status, rv.decidedBy, rv.decidedAt], ["confirmed", ACTOR, NOW.toISOString()]);
});

test("confirm relist of a tierless 'not a portfolio' grade clears it for the nightly grade queue, keeping the old one", async () => {
  const db = await freshDb();
  const url = u();
  const old = { is_portfolio: false, model: "gemini-3.1-flash-lite", judged_at: "2026-11-01T00:00:00Z" };
  await site(db, url, { rubric: old });
  const [res] = await decide(db, [await review(db, url)]);
  assert.equal(res.applied.grade, "clear");
  assert.equal(await rubricOf(db, url), null);
  assert.deepEqual((await listReviews(db)).decided[0].applied.previous_grade, old);
});

test("confirm relist of a broken site queues a capture; a confirmed-down one becomes suspect", async () => {
  const db = await freshDb();
  const dead = u();
  const down = u();
  await site(db, dead, { status: "dead" });
  await site(db, down, { status: "live", health: "down", healthReason: "HTTP 503" });
  const res = await decide(db, [await review(db, dead, { grp: "broken", current: "hidden" }), await review(db, down, { grp: "broken", current: "hidden" })]);
  assert.ok(res.every((r) => r.ok));
  assert.equal(String((await row(db, dead)).retry_at), NOW.toISOString());
  assert.equal(String((await row(db, down)).health), "suspect");
  assert.equal(String((await row(db, down)).retry_at), NOW.toISOString());
});

test("confirm relist of a delisted site off the feed queues it for data/additions.json", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE({ is_portfolio: true }), delistedAt: "2026-11-10" });
  const [res] = await decide(db, [await review(db, url, { grp: "delisted_graded", current: "delisted" })], "confirm", () => false);
  assert.equal(res.applied.feed, "queued");
  assert.equal(res.applied.grade, "keep", "the grade already said portfolio");
  assert.deepEqual((await confirmedRelists(db)).map((r) => [r.url, r.name]), [[url, `Name of ${url}`]]);
});

test("confirm remove: a portfolio grade flips to not a portfolio; an ungraded site gets the owner's grade", async () => {
  const db = await freshDb();
  const graded = u();
  const ungraded = u();
  await site(db, graded, { rubric: GRADE({ is_portfolio: true }) });
  await site(db, ungraded);
  const res = await decide(db, [await review(db, graded, { proposed: "remove", current: "ranked" }), await review(db, ungraded, { proposed: "remove", grp: "live_ungraded" })]);
  assert.deepEqual(res.map((r) => r.applied.grade), ["flip", "owner_only"]);
  const g = await rubricOf(db, graded);
  assert.equal(g.is_portfolio, false);
  assert.equal(g.ai_is_portfolio, true);
  assert.equal(g.rank, undefined, "out of the library");
  const o = await rubricOf(db, ungraded);
  assert.equal(o.is_portfolio, false);
  assert.equal(o.source, "owner_review");
  assert.equal(o.tier, undefined, "no tier: never shown as a grade");
  assert.deepEqual(await confirmedRelists(db), []);
});

test("reject records only; a row is decided once; a failed apply goes back to pending", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE() });
  const id = await review(db, url);
  const [rej] = await decide(db, [id], "reject");
  assert.equal(rej.ok, true);
  assert.equal((await rubricOf(db, url)).is_portfolio, false, "a rejection changes nothing");
  const [again] = await decide(db, [id]);
  assert.deepEqual([again.ok, again.error], [false, "wrong_status"]);

  const missing = await review(db, "https://no-row.dev");
  const [fail] = await decide(db, [missing]);
  assert.equal(fail.ok, false);
  assert.match(fail.error, /not_found/);
  const back = (await listReviews(db)).pending.find((r) => r.id === missing);
  assert.equal(back.status, "pending");
  assert.match(back.applied.error, /not_found/);
});

test("later grades keep the owner's verdict", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE() });
  assert.deepEqual(await withOwnerVerdict(db, url, GRADE()), GRADE(), "no verdict: unchanged");
  await decide(db, [await review(db, url)]);
  const next = await withOwnerVerdict(db, url, GRADE({ judged_at: "2026-12-01T00:00:00Z" }));
  assert.equal(next.is_portfolio, true);
  assert.equal(next.ai_is_portfolio, false);
  assert.equal(next.review.kind, OWNER_KIND);
  assert.deepEqual(ownerGrade({ error: "no_usable_captures" }, { isPortfolio: true }), { error: "no_usable_captures" }, "sentinels stay");
  // A strong-signals hold (pipeline/portfolio-guard.mjs) the owner settled becomes the owner's.
  const held = ownerGrade({ ...GRADE({ is_portfolio: true, ai_is_portfolio: false }), review: { kind: "strong_signals" } }, { isPortfolio: true, by: ACTOR });
  assert.equal(held.review.kind, OWNER_KIND);
});

test("planConfirm is pure and says what it will do", () => {
  const p = planConfirm({ url: "https://x.dev", proposed: "relist", reason: null, batch: "b", decidedBy: ACTOR }, { url: "https://x.dev", ai_rubric: null, status: "live", health: null, health_reason: null, delisted_at: "2026-11-10" }, { onFeed: true, now: NOW });
  assert.equal(p.grade, "keep");
  assert.equal(p.feed, "on_feed");
  assert.match(p.visibility.join(" "), /next roster sync/);
});

test("the weekly data pull request adds confirmed relists; owner requests and duplicates stay out", () => {
  const plan = planReviewAdditions({
    relists: [
      { url: "https://back.dev", name: "Back" },
      { url: "https://down.dev/", name: "Down" },
      { url: "https://owner.dev", name: "Owner" },
      { url: "https://www.listed.dev", name: "Listed" },
    ],
    additions: [],
    excluded: [
      { url: "https://down.dev", kind: "down", reason: "HTTP 503" },
      { url: "https://owner.dev", kind: "owner_request", reason: "owner request" },
    ],
    feed: [{ name: "Listed", url: "https://listed.dev" }],
  });
  assert.deepEqual(plan.added, [
    { name: "Back", url: "https://back.dev", source: "review" },
    { name: "Down", url: "https://down.dev/", source: "review" },
  ]);
  assert.deepEqual(plan.unexcluded, ["https://down.dev"]);
  assert.deepEqual(plan.blocked, [{ url: "https://owner.dev", kind: "owner_request" }]);
  assert.deepEqual(plan.excluded.map((e) => e.url), ["https://owner.dev"]);
  assert.equal(plan.feed.length, 3);
});

test("a blocked capture's 'review' row: Mark checked records only, and is never an owner's verdict", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE() });
  const id = await review(db, url, { proposed: "review", agreed: 0, grp: "broken", current: "hidden" });
  assert.equal((await listReviews(db)).pending[0].proposed, "review");
  const [res] = await decide(db, [id]);
  assert.equal(res.ok, true);
  const done = (await listReviews(db)).decided[0];
  assert.deepEqual([done.status, done.applied], ["confirmed", { action: "none" }]);
  assert.equal((await rubricOf(db, url)).is_portfolio, false, "nothing applied");
  assert.equal(Number((await row(db, url)).needs_review), 1);
  assert.deepEqual(await withOwnerVerdict(db, url, GRADE()), GRADE(), "no verdict from a review row");
  assert.deepEqual(await confirmedRelists(db), []);
});
