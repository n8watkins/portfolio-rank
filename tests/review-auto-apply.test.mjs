// The owner's rule for the review queue (lib/reviews/store.mjs): "if
// something passes the test, I don't need to review it; only if it fails".
// A pass (both models say portfolio, no code rule objects) is applied by the
// hourly cron, behind REVIEW_AUTO_APPLY, through the same paths as Confirm and
// recorded as auto_applied; every other case waits for the owner. Undo puts
// the site back exactly and returns the row to pending for good. A confirmed
// remove takes the site off the list at once; relists reach
// data/additions.json (and leave it when undone).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { OWNER_NOT_PORTFOLIO, RULE_ACTOR, autoApplyReviews, confirmedRelists, decideReviews, listReviews, passesRule, undoReviews, withOwnerVerdict } from "../lib/reviews/store.mjs";
import { reviewAutoApplyEnabled } from "../lib/reviews/flag.ts";
import { planExclusions } from "../pipeline/exclusions.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";

const NOW = new Date("2026-11-16T18:00:00Z");
const LATER = new Date("2026-11-16T20:00:00Z");

async function freshDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "auto-")), "db.sqlite")}` });
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
const V = (is) => ({ is_portfolio: is, reason: "r" });
const VERDICTS = (g, h) => ({ gemini31: g, haiku: h, prompt: "portfolio-definition-v2.1" });
const SIGNALS = (o = {}) => ({ score: 4, names: ["name", "projects", "about", "contact"], junk_rule: null, capture: {}, ...o });
const R = (o = {}) => ({ proposed: "relist", verdicts: VERDICTS({ batch: V(true), solo: null }, { batch: V(true), solo: V(true) }), signals: SIGNALS(), ...o });

let n = 0;
const u = () => `https://auto-${++n}.dev`;

async function site(db, url, { rubric = null, status = "live", health = null, healthReason = null, delistedAt = null } = {}) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, ai_rubric, health, health_reason, health_fails, delisted_at, needs_review)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [url, `Name of ${url}`, status, rubric == null ? null : JSON.stringify(rubric), health, healthReason, health ? 2 : 0, delistedAt],
  });
}

async function review(db, url, { proposed = "relist", verdicts = R().verdicts, signals = SIGNALS(), grp = "not_portfolio" } = {}) {
  const r = await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, verdicts, signals, created_at)
          VALUES ('recheck-543', ?, ?, 'listed', ?, 1, 'why', 0, ?, ?, '2026-11-14T10:00:00Z')`,
    args: [url, grp, proposed, JSON.stringify(verdicts), JSON.stringify(signals)],
  });
  return Number(r.lastInsertRowid);
}

const row = async (db, url) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url] })).rows[0];
const reviewRow = async (db, id) => (await db.execute({ sql: "SELECT * FROM status_reviews WHERE id = ?", args: [id] })).rows[0];
const rubricOf = async (db, url) => {
  const r = await row(db, url);
  return r.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
};
const member = async (db, url) => Number((await db.execute({ sql: "SELECT member FROM tier_ratings WHERE url = ?", args: [url] })).rows[0]?.member ?? 0);
const auto = (db, now = NOW, onFeed = () => true) => autoApplyReviews(db, { onFeed, now });

test("the switch: off unless REVIEW_AUTO_APPLY is exactly true (any case)", () => {
  assert.equal(reviewAutoApplyEnabled({}), false);
  assert.equal(reviewAutoApplyEnabled({ REVIEW_AUTO_APPLY: "false" }), false);
  assert.equal(reviewAutoApplyEnabled({ REVIEW_AUTO_APPLY: "1" }), false);
  assert.equal(reviewAutoApplyEnabled({ REVIEW_AUTO_APPLY: "TRUE" }), true);
  const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
  assert.equal((wrangler.match(/"REVIEW_AUTO_APPLY": "false"/g) ?? []).length, 2, "off in production and on staging");
  assert.doesNotMatch(wrangler, /"REVIEW_AUTO_APPLY": "true"/);
});

test("the pass rule: both models say portfolio (batched, else one at a time) and no code rule objects", () => {
  assert.deepEqual(passesRule(R()).pass, true);
  assert.equal(passesRule(R({ verdicts: VERDICTS({ batch: null, solo: V(true) }, { batch: V(true), solo: null }) })).pass, true, "a model's solo answer stands in when it has no batched one");
  assert.equal(passesRule(R({ verdicts: VERDICTS({ batch: V(true), solo: V(false) }, { batch: V(true), solo: V(false) }) })).pass, true, "the batched answers decide");
});

test("everything else waits for the owner", () => {
  const cases = {
    "a fail: both say not a portfolio": R({ verdicts: VERDICTS({ batch: V(false) }, { batch: V(false) }) }),
    "a disagreement": R({ verdicts: VERDICTS({ batch: V(true) }, { batch: V(false) }) }),
    "the other disagreement": R({ verdicts: VERDICTS({ batch: V(false) }, { batch: V(true) }) }),
    "a model never answered": R({ verdicts: VERDICTS({ batch: V(true) }, { batch: null, solo: null }) }),
    "no verdicts at all": R({ verdicts: {} }),
    "a blocked capture (review)": R({ proposed: "review", verdicts: VERDICTS({ batch: null }, { batch: null }), signals: SIGNALS({ capture: { blocked: "still a gate" } }) }),
    "a blocked capture on a relist row": R({ signals: SIGNALS({ capture: { blocked: "still a gate" } }) }),
    "a failed capture": R({ signals: SIGNALS({ capture: { failed: "timeout" } }) }),
    "a junk rule against the models": R({ signals: SIGNALS({ junk_rule: "parked" }) }),
    "a remove proposal": R({ proposed: "remove", verdicts: VERDICTS({ batch: V(false) }, { batch: V(false) }) }),
    "a remove proposal both models call a portfolio": R({ proposed: "remove" }),
  };
  for (const [name, r] of Object.entries(cases)) {
    const got = passesRule(r);
    assert.equal(got.pass, false, name);
    assert.ok(got.why.length > 5, `${name}: says why`);
  }
});

test("auto-apply: passes are applied like Confirm and recorded; the rest stay pending; a second run does nothing", async () => {
  const db = await freshDb();
  const pass = u();
  const fail = u();
  const blocked = u();
  await site(db, pass, { rubric: GRADE(), health: "suspect", healthReason: "AI grading says this is not a portfolio" });
  await site(db, fail, { rubric: GRADE() });
  await site(db, blocked, { status: "dead" });
  const idPass = await review(db, pass);
  const idFail = await review(db, fail, { verdicts: VERDICTS({ batch: V(true) }, { batch: V(false) }) });
  const idBlocked = await review(db, blocked, { proposed: "review", grp: "broken", verdicts: {}, signals: SIGNALS({ capture: { blocked: "gate" } }) });

  const res = await auto(db);
  assert.deepEqual(res.map((r) => [r.id, r.ok]), [[idPass, true]]);
  const r = await reviewRow(db, idPass);
  assert.deepEqual([r.status, r.decided_by, r.decided_at], ["auto_applied", RULE_ACTOR, NOW.toISOString()]);
  const applied = JSON.parse(String(r.applied));
  assert.equal(applied.grade, "flip");
  assert.equal(applied.before.health, "suspect", "the state before is kept for Undo");
  assert.ok(JSON.parse(String(r.verdicts)).gemini31, "the verdicts stay on the row");
  const g = await rubricOf(db, pass);
  assert.deepEqual([g.is_portfolio, g.ai_is_portfolio, g.review.by], [true, false, RULE_ACTOR]);
  assert.equal(String((await row(db, pass)).health), "live");
  assert.equal(await member(db, pass), 1);
  assert.equal(String((await reviewRow(db, idFail)).status), "pending");
  assert.equal(String((await reviewRow(db, idBlocked)).status), "pending");
  assert.deepEqual(await auto(db, LATER), [], "nothing left that passes");

  const lists = await listReviews(db);
  assert.deepEqual(lists.autoApplied.map((x) => x.id), [idPass]);
  assert.deepEqual(lists.decided, [], "the owner's own decisions are listed apart");
  assert.equal((await withOwnerVerdict(db, pass, GRADE())).is_portfolio, true, "later grades keep the applied verdict");
});

test("undo puts the site back exactly, returns the row to pending for good, and logs who and when", async () => {
  const db = await freshDb();
  const url = u();
  const before = GRADE();
  await site(db, url, { rubric: before, health: "suspect", healthReason: "AI grading says this is not a portfolio" });
  const id = await review(db, url);
  await auto(db);
  assert.equal(await member(db, url), 1);

  const [res] = await undoReviews(db, { ids: [id], actor: "admin:owner", now: LATER });
  assert.equal(res.ok, true);
  const r = await reviewRow(db, id);
  assert.deepEqual([r.status, r.decided_by, r.undone_by, r.undone_at], ["pending", null, "admin:owner", LATER.toISOString()]);
  assert.deepEqual(JSON.parse(String(r.applied)).undo, { at: LATER.toISOString(), by: "admin:owner", reversed: "exact" });
  const back = await rubricOf(db, url);
  assert.equal(back.is_portfolio, false);
  assert.equal(back.review, undefined, "the grade is the one before");
  assert.equal(await member(db, url), 0, "out of the library again");
  const p = await row(db, url);
  assert.deepEqual([p.health, p.health_reason, Number(p.health_fails), Number(p.needs_review)], ["suspect", "AI grading says this is not a portfolio", 2, 1]);
  assert.equal(await withOwnerVerdict(db, url, GRADE()).then((g) => g.is_portfolio), false, "no verdict once undone");
  assert.deepEqual(await auto(db, new Date("2026-11-17T00:00:00Z")), [], "the rule never applies an undone row again");
  assert.deepEqual((await undoReviews(db, { ids: [id], actor: "admin:owner", now: LATER }))[0].error, "wrong_status", "a pending row has nothing to undo");

  // The owner can still decide it.
  const [c] = await decideReviews(db, { ids: [id], action: "confirm", actor: "admin:owner", onFeed: () => true, now: LATER });
  assert.equal(c.ok, true);
});

test("undo of a site that had no grade clears the grade the apply wrote", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE({ is_portfolio: false, tier: undefined }) });
  const id = await review(db, url);
  await auto(db);
  assert.equal(await rubricOf(db, url), null, "a tierless grade is cleared for a fresh grade");
  await undoReviews(db, { ids: [id], actor: "admin:owner", now: LATER });
  assert.equal((await rubricOf(db, url)).is_portfolio, false, "and comes back on undo");
});

test("immediate effect: a confirmed remove is off the list at once and lands in excluded.json as not_portfolio", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE({ is_portfolio: true }) });
  const id = await review(db, url, { proposed: "remove", verdicts: VERDICTS({ batch: V(false) }, { batch: V(false) }) });
  assert.deepEqual(await auto(db), [], "a remove is never automatic");
  await decideReviews(db, { ids: [id], action: "confirm", actor: "admin:owner", onFeed: () => true, now: NOW });
  const p = await row(db, url);
  assert.deepEqual([p.health, p.health_reason], ["down", OWNER_NOT_PORTFOLIO]);
  const hidden = (await db.execute({ sql: `SELECT url FROM portfolios WHERE url = ? AND (${HIDDEN_WHERE})`, args: [url] })).rows;
  assert.equal(hidden.length, 1, "hidden now (lib/hidden.mjs)");
  // A list of 20, so one exclusion stays under the 10% guard.
  const feed = [{ name: "x", url }, ...Array.from({ length: 19 }, (_, i) => ({ name: "y", url: `https://other-${i}.dev` }))];
  const plan = await planExclusions({ db, excluded: [], feed, now: NOW });
  assert.deepEqual(plan.added.map((e) => [e.url, e.kind]), [[url, "not_portfolio"]]);
});

test("relists from the rule reach data/additions.json; an undone one comes back out", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE({ is_portfolio: true }), delistedAt: "2026-11-10" });
  const id = await review(db, url, { grp: "delisted_graded" });
  const [res] = await autoApplyReviews(db, { onFeed: () => false, now: NOW });
  assert.equal(res.applied.feed, "queued");
  const relists = await confirmedRelists(db);
  assert.deepEqual(relists.map((r) => r.url), [url]);
  const first = planReviewAdditions({ relists, additions: [], excluded: [], feed: [] });
  assert.deepEqual(first.additions, [{ name: `Name of ${url}`, url, source: "review" }]);
  assert.deepEqual(first.feed, [{ name: `Name of ${url}`, url }]);

  await undoReviews(db, { ids: [id], actor: "admin:owner", now: LATER });
  const second = planReviewAdditions({ relists: await confirmedRelists(db), additions: first.additions, excluded: [], feed: first.feed });
  assert.deepEqual(second.withdrawn, [url]);
  assert.deepEqual([second.additions, second.feed], [[], []]);
  // Entries anyone else added (a direct submission) are never withdrawn.
  const keep = planReviewAdditions({ relists: [], additions: [{ name: "Sub", url: "https://sub.dev" }], excluded: [], feed: [] });
  assert.deepEqual(keep.withdrawn, []);
});
