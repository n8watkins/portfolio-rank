// The owner's review queue (table status_reviews, lib/reviews/schema.mjs;
// page /admin/review; API /api/admin/review). A re-check writes one row per
// site whose listed or ranked state it would change; nothing changes until
// the owner confirms the row. Confirm applies the change through the paths
// the pipeline already uses, and records the owner's verdict so later grades
// keep it (ownerVerdict, read at the door, lib/reviews/door.mjs). Reject only
// records the decision, except that it settles a grade held for that
// decision (settleOnReject).
//
// What Confirm does, by case (planConfirm):
//
// relist (the site is a portfolio):
//   - a stored grade that says "not a portfolio" and has a tier: kept, with
//     is_portfolio true, the AI's own answer in ai_is_portfolio and the
//     owner's decision in review (kind "owner_confirmed"); ranked again with
//     rankForWrite and written with replaceGradeStatements, the same path a
//     night grade takes, so it rejoins tiers, boards, the sitemap and Play.
//   - such a grade without a tier (nothing to rank on): cleared, so the
//     nightly "grade new" queue grades the site again; the old grade is kept
//     in the row's `applied` record. The owner's verdict holds on that grade.
//   - no grade yet: the nightly grade queue grades it; the verdict holds.
//   - kept out by the health check only because the grade said "not a
//     portfolio" (health_reason "AI grading says ..."): health is set back
//     to live, since that page loaded and the reason is gone.
//   - confirmed down, or a failed capture: health "suspect" (one failed check
//     proves nothing) and retry_at now, so the next sync captures it again.
//     It stays hidden (lib/hidden.mjs) until that capture succeeds.
//   - delisted (it left the community list): still on data/feed.json, the
//     next roster sync lists it again; otherwise it goes to
//     data/additions.json (and out of data/excluded.json, when a "down" or
//     "not_portfolio" entry keeps it out) by the daily upstream sync
//     (pipeline/review-additions.mjs, also in the weekly health run), which
//     lists it again once its pull request merges.
// remove (the site is not a portfolio):
//   - a grade (or none, or an error sentinel): stored as "not a portfolio",
//     the AI's answer kept in ai_is_portfolio, with the owner's decision in
//     review. It leaves tiers, boards, the sitemap, the home page and Play.
//   - and off the list at once: health "down" with the reason the health
//     check gives such a grade (OWNER_NOT_PORTFOLIO), so lib/hidden.mjs hides
//     it now and the weekly health run moves it to data/excluded.json as kind
//     "not_portfolio", the existing path off the list.
//
// The owner's rule (REVIEW_AUTO_APPLY, worker/review.ts): a row that passes
// (passesRule: both models say portfolio, no code rule objects) is applied
// the same way without waiting, as status auto_applied by RULE_ACTOR. Every
// apply keeps the site's state before it (applied.before), so Undo
// (undoReviews) puts it back and returns the row to pending for the owner;
// the rule never applies an undone row again.
// review (the capture was blocked, so no grader saw the site): nothing to
//   apply; Confirm ("Mark checked" on the page) only records that a person
//   looked (applied {"action":"none"}), and it is never an owner's verdict.
// Both: needs_review is cleared (a person decided), the profile's edge cache
// and the games pool are purged by the API route.
//
// The door (owner, 2026-11-16; lib/reviews/door.mjs, docs/DECISIONS.md): the
// nightly grade of a new site writes rows here too. A Gemini "not a portfolio"
// is removed by DOOR_RULE_ACTOR through the same "remove" path (auto_applied,
// with Undo, behind the same REVIEW_AUTO_APPLY switch); a "no" the code
// disputes (STRONG_SIGNALS or more), a bot-walled site and a listed site whose
// signals collapsed wait as pending rows.
//
// Who decided (owner, 2026-11-16): a rule's decision is stored and shown as
// the rule's (review kind RULE_KIND, decided_by "rule:..."), never as the
// owner's. Only the owner's own confirmations are verdicts that hold over
// later grades (ownerVerdict); what a rule decided is weighed by the door
// instead (a later "no" against a rule's "portfolio" waits for the owner).

import { rankForWrite } from "../tiers-store.mjs";
import { AI_SAYS_NOT_PORTFOLIO, aiSaysPortfolio, guardedForReview } from "../../pipeline/portfolio-guard.mjs";
import { clearGradeStatements, parseRubric, replaceGradeStatements } from "../../pipeline/rubric-history.mjs";
import { ensureFreshnessSchema } from "../freshness.mjs";
import { REVIEW_COLUMNS, REVIEW_TABLES } from "./schema.mjs";
import { ruleName } from "./rule-names.mjs";

export const GROUPS = {
  not_portfolio: "Graded not a portfolio",
  delisted_graded: "Delisted after grading",
  delisted_ungraded: "Delisted before grading",
  broken: "Broken or dead, never graded",
  live_ungraded: "Live, not graded yet",
  // The door (lib/reviews/door.mjs).
  door_not_portfolio: "Gemini: not a portfolio",
  door_strong_signals: "Gemini says no, the code says portfolio",
  door_held: "Gemini says no, held for you",
  bot_wall: "Bot-walled, never captured",
  signals_collapsed: "Listed, portfolio signals collapsed",
};
export const OWNER_KIND = "owner_confirmed";
/** The review kind of a grade a rule decided (never OWNER_KIND). */
export const RULE_KIND = "rule_applied";
export { AI_SAYS_NOT_PORTFOLIO };
// The health reasons below reach data/excluded.json's `reason` (pipeline/exclusions.mjs) and the public
// Removed page, so they are plain statements of why the site is off the list, never admin wording.
// Who decided goes in excluded.json's `decided_by` (exclusions.mjs reads it from the review row).
/** The health reason a confirmed remove sets; it starts like the health check's own, so exclusions file it as not_portfolio. */
export const OWNER_NOT_PORTFOLIO = `${AI_SAYS_NOT_PORTFOLIO} (confirmed by the owner)`;
/** The same for a rule's remove (the door's): the health check's own words. */
export const RULE_NOT_PORTFOLIO = AI_SAYS_NOT_PORTFOLIO;
/** Statuses whose change was applied: the owner confirmed it, or a rule applied it. */
export const APPLIED = ["confirmed", "auto_applied"];
/** Who the review rule records as the decider. */
export const RULE_ACTOR = "rule:both-pass";
/** Who the door's rule records: Gemini's "not a portfolio" on a new site, removed (lib/reviews/door.mjs). */
export const DOOR_RULE_ACTOR = "rule:gemini-not-portfolio";
/** Whether a decider is a rule (anything recorded as "rule:..."), not a person. */
export const isRuleActor = (by) => String(by ?? "").startsWith("rule:");
const APPLIED_SQL = APPLIED.map((s) => `'${s}'`).join(", ");

// One case per site (owner, 2026-11-16, after the second review of #238): a site has at most one open
// (pending) row in status_reviews, whatever its group.
/** SQL (never NULL): the portfolios row aliased `p` has an open case. */
export const OPEN_CASE_SQL = (p) => `EXISTS (SELECT 1 FROM status_reviews o WHERE o.url = ${p}.url AND o.status = 'pending')`;

// The owner has decided to keep a site: he rejected a proposal to remove it (in any group), or he
// confirmed it is a portfolio himself. One definition, in JavaScript for the door and in SQL for the
// night's collapse rows; a rule's decision never counts.
const KEEP_ROW_SQL = (k) =>
  `((${k}.status = 'rejected' AND ${k}.proposed = 'remove') OR (${k}.status = 'confirmed' AND ${k}.proposed = 'relist' AND COALESCE(${k}.decided_by, '') NOT LIKE 'rule:%'))`;
/** Whether one review row (reviewOf) is the owner's decision to keep its site. */
export const keepsSite = (r) => (r.status === "rejected" && r.proposed === "remove") || (r.status === "confirmed" && r.proposed === "relist" && !isRuleActor(r.decidedBy));
/** Whether the owner has decided to keep the site these rows are about (ever). */
export const ownerKeepsSite = (rows) => rows.some(keepsSite);
/**
 * SQL (never NULL): the owner has decided to keep the portfolios row aliased
 * `p` since its current grade was made: a keeping row decided after the
 * grade, or a grade that already carries his decision to keep it (his
 * Reject, OWNER_KEPT_KIND, or his confirmed portfolio, OWNER_KIND).
 */
export const OWNER_KEEPS_SQL = (p) => `(
  COALESCE(json_valid(${p}.ai_rubric) AND json_extract(${p}.ai_rubric, '$.is_portfolio') = 1
           AND json_extract(${p}.ai_rubric, '$.review.kind') IN ('${OWNER_KEPT_KIND}', '${OWNER_KIND}'), 0)
  OR EXISTS (SELECT 1 FROM status_reviews k WHERE k.url = ${p}.url AND ${KEEP_ROW_SQL("k")}
             AND k.decided_at >= COALESCE(CASE WHEN json_valid(${p}.ai_rubric) THEN json_extract(${p}.ai_rubric, '$.judged_at') END, '')))`;

const missingTable = (e) => /no such table/i.test(String(e?.message ?? e));
const json = (v) => {
  if (v == null) return null;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

export async function ensureReviewSchema(db) {
  for (const sql of REVIEW_TABLES) await db.execute(sql);
  for (const [table, def] of REVIEW_COLUMNS) {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${def}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  }
}

/** One row as the page and the API use it. */
export function reviewOf(r) {
  return {
    id: Number(r.id),
    batch: String(r.batch),
    url: String(r.url),
    group: String(r.grp),
    current: String(r.current),
    proposed: ["relist", "remove", "review"].includes(String(r.proposed)) ? String(r.proposed) : "review",
    agreed: Number(r.agreed) === 1,
    reason: r.reason == null ? null : String(r.reason),
    offList: Number(r.off_list) === 1,
    shotKey: r.shot_key == null ? null : String(r.shot_key),
    verdicts: json(r.verdicts) ?? {},
    signals: json(r.signals),
    status: String(r.status),
    decidedAt: r.decided_at == null ? null : String(r.decided_at),
    decidedBy: r.decided_by == null ? null : String(r.decided_by),
    applied: json(r.applied),
    createdAt: String(r.created_at),
    undoneAt: r.undone_at == null ? null : String(r.undone_at),
    undoneBy: r.undone_by == null ? null : String(r.undone_by),
  };
}

/**
 * The queue: pending rows (agreed first, then by group and address), the
 * latest rows the rule applied (autoApplied, each with Undo) and the latest
 * ones the owner decided. Empty when the table doesn't exist yet.
 */
export async function listReviews(db, { decidedLimit = 200 } = {}) {
  try {
    const pending = await db.execute(
      `SELECT * FROM status_reviews WHERE status = 'pending' ORDER BY agreed DESC, proposed, grp, url`
    );
    const auto = await db.execute({
      sql: `SELECT * FROM status_reviews WHERE status = 'auto_applied' ORDER BY decided_at DESC, id DESC LIMIT ?`,
      args: [decidedLimit],
    });
    const decided = await db.execute({
      // closed: a rule's waiting row that a newer decision made stale, closed without acting (applyByRule).
      sql: `SELECT * FROM status_reviews WHERE status IN ('confirmed', 'rejected', 'closed') ORDER BY decided_at DESC, id DESC LIMIT ?`,
      args: [decidedLimit],
    });
    return { pending: pending.rows.map(reviewOf), autoApplied: auto.rows.map(reviewOf), decided: decided.rows.map(reviewOf) };
  } catch (e) {
    if (missingTable(e)) return { pending: [], autoApplied: [], decided: [] };
    throw e;
  }
}

/**
 * The owner's rule (2026-11-14): "if something passes the test, I don't need
 * to review it; only if it fails". Pure. A row passes when it proposes a
 * relist, both models say it is a portfolio (each model's batched answer, or
 * its one-at-a-time answer when there is no batched one) and no code
 * exclusion fires (no junk rule, no blocked or failed capture). Anything
 * else waits for the owner: a "not a portfolio" verdict, a disagreement, a
 * model that never answered, a blocked or failed capture ("review" rows), or
 * a junk rule against the models' verdict. Returns { pass, why }.
 */
export function passesRule(review) {
  const fail = (why) => ({ pass: false, why });
  if (review.proposed !== "relist") return fail(review.proposed === "review" ? "the capture was blocked or never graded" : "the proposal is to remove it");
  const capture = review.signals?.capture ?? {};
  if (capture.blocked) return fail(`the capture was blocked: ${capture.blocked}`);
  if (capture.failed) return fail(`the capture failed: ${capture.failed}`);
  if (review.signals?.junk_rule) return fail(`a code rule says junk (${review.signals.junk_rule}) against the models' verdict`);
  const answer = (g) => g?.batch ?? g?.solo ?? null;
  const gemini = answer(review.verdicts?.gemini31);
  const haiku = answer(review.verdicts?.haiku);
  if (!gemini || !haiku) return fail("a model has no verdict");
  if (gemini.is_portfolio !== true || haiku.is_portfolio !== true) return fail(gemini.is_portfolio === haiku.is_portfolio ? "both models say not a portfolio" : "the models disagree");
  return { pass: true, why: "both models say it is a portfolio and no code rule objects" };
}

/**
 * The door's rule (owner, 2026-11-16: "If Gemini says it's not a portfolio,
 * I'm cool just saying it's not a portfolio"). Pure. A row passes when the
 * nightly grade wrote it as an automatic removal (group door_not_portfolio,
 * signals.door.auto: Gemini said no, fewer than STRONG_SIGNALS code signals or
 * a junk rule, no owner verdict, nothing the owner undid or rejected).
 */
export function passesDoorRule(review) {
  if (review.group !== "door_not_portfolio" || review.proposed !== "remove") return { pass: false, why: "not a door removal" };
  if (review.signals?.door?.auto !== true) return { pass: false, why: "held for the owner" };
  return { pass: true, why: "Gemini says not a portfolio and the code found too little to dispute it" };
}

/** Which rule applies a pending row, if any: { actor, why } or null. */
export function ruleFor(review) {
  if (review.undoneAt) return null;
  const door = passesDoorRule(review);
  if (door.pass) return { actor: DOOR_RULE_ACTOR, why: door.why };
  const both = passesRule(review);
  if (both.pass) return { actor: RULE_ACTOR, why: both.why };
  return null;
}

/** How many rows wait for the owner (0 without the table). */
export async function pendingReviewCount(db) {
  try {
    return Number((await db.execute("SELECT COUNT(*) AS n FROM status_reviews WHERE status = 'pending'")).rows[0]?.n ?? 0);
  } catch (e) {
    if (missingTable(e)) return 0;
    throw e;
  }
}

async function latestVerdict(db, url, where) {
  let r;
  try {
    r = (
      await db.execute({
        sql: `SELECT proposed, reason, decided_by, decided_at, batch FROM status_reviews
              WHERE url = ? AND proposed IN ('relist', 'remove') AND ${where}
              ORDER BY decided_at DESC, id DESC LIMIT 1`,
        args: [url],
      })
    ).rows[0];
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
  if (!r) return null;
  return {
    isPortfolio: String(r.proposed) !== "remove",
    reason: r.reason == null ? null : String(r.reason),
    by: r.decided_by == null ? null : String(r.decided_by),
    at: r.decided_at == null ? null : String(r.decided_at),
    batch: String(r.batch),
  };
}

/**
 * The owner's latest confirmed verdict on a site, or null:
 * { isPortfolio, reason, by, at, batch }. Only a person's Confirm counts; a
 * rule's automatic apply (auto_applied, decided_by "rule:...") is never the
 * owner's verdict (owner, 2026-11-16).
 */
export const ownerVerdict = (db, url) => latestVerdict(db, url, "status = 'confirmed' AND COALESCE(decided_by, '') NOT LIKE 'rule:%'");

/** The latest verdict a rule applied (and nobody undid), or null; the door weighs it on a later grade. */
export const ruleVerdict = (db, url) => latestVerdict(db, url, "status = 'auto_applied'");

/** The grade's review record for a verdict: the owner's, or the rule's when a rule decided. */
const verdictReview = (v) =>
  isRuleActor(v.by)
    ? {
        kind: RULE_KIND,
        reason: `Decided automatically by the rule "${ruleName(v.by)}" (${v.by}), not the owner: ${v.isPortfolio ? "a portfolio" : "not a portfolio"}${v.reason ? `. ${v.reason}` : "."}`,
        by: v.by,
        at: v.at,
        batch: v.batch,
      }
    : {
        kind: OWNER_KIND,
        reason: `The owner confirmed this ${v.isPortfolio ? "is" : "is not"} a portfolio${v.reason ? `: ${v.reason}` : "."}`,
        by: v.by,
        at: v.at,
        batch: v.batch,
      };

/**
 * A grade with the owner's verdict on top. Pure. Unchanged when there is no
 * verdict, or the grade is an error sentinel. When the grade's own answer
 * differs, is_portfolio follows the owner and ai_is_portfolio keeps the AI's
 * answer; a hold (pipeline/portfolio-guard.mjs: strong signals, or held for
 * the owner) that was settled becomes the decider's review. The decider is
 * verdict.by: the owner's review (OWNER_KIND) for a person, the rule's
 * (RULE_KIND) for "rule:...".
 */
export function ownerGrade(grade, verdict) {
  if (!verdict || !grade || typeof grade !== "object" || grade.error) return grade;
  const says = grade.is_portfolio !== false;
  if (says === verdict.isPortfolio && !guardedForReview(grade)) return grade;
  return {
    ...grade,
    is_portfolio: verdict.isPortfolio,
    ai_is_portfolio: grade.ai_is_portfolio ?? (typeof grade.is_portfolio === "boolean" ? grade.is_portfolio : null),
    review: verdictReview(verdict),
  };
}


const usableTier = (g) => Boolean(g && typeof g === "object" && !g.error && typeof g.tier === "string" && g.tier);

/**
 * What Confirm will do for one review, from the site's row now. Pure.
 * `row`: the portfolios row (url, ai_rubric, status, health, health_reason,
 * delisted_at) or null. `onFeed`: the site is on data/feed.json.
 * Returns { grade: "flip" | "clear" | "owner_only" | "keep", newGrade,
 * visibility: string[], feed: "on_feed" | "queued" | null, stmts }; newGrade
 * still needs rankForWrite when grade is "flip" (decideReview does it).
 */
export function planConfirm(review, row, { onFeed, now = new Date() }) {
  const at = now.toISOString();
  const url = review.url;
  const verdict = { isPortfolio: review.proposed !== "remove", reason: review.reason, by: review.decidedBy, at, batch: review.batch };
  const old = row?.ai_rubric == null ? null : json(row.ai_rubric);
  const stmts = [];
  const visibility = [];
  let grade = "keep";
  let newGrade = null;

  if (verdict.isPortfolio) {
    if (old && !old.error && old.is_portfolio === false) {
      if (usableTier(old)) {
        grade = "flip";
        newGrade = ownerGrade(old, verdict);
      } else {
        grade = "clear";
        stmts.push(...clearGradeStatements(url, row.ai_rubric, now));
      }
    } else if (old && guardedForReview(old)) {
      grade = "flip";
      newGrade = ownerGrade(old, verdict);
    }
    const health = row?.health == null ? "" : String(row.health);
    const status = row?.status == null ? "" : String(row.status);
    if (String(row?.health_reason ?? "").startsWith(AI_SAYS_NOT_PORTFOLIO)) {
      stmts.push({
        sql: "UPDATE portfolios SET health = 'live', health_reason = NULL, health_fails = 0, health_first_fail_at = NULL WHERE url = ?",
        args: [url],
      });
      visibility.push("health set back to live (it was failing only because the grade said not a portfolio)");
    } else if (health === "down") {
      stmts.push({ sql: "UPDATE portfolios SET health = 'suspect', retry_at = ? WHERE url = ?", args: [at, url] });
      visibility.push("health set to suspect and a new capture queued; it shows once that capture succeeds");
    } else if (["dead", "parked", "error"].includes(status)) {
      stmts.push({ sql: "UPDATE portfolios SET retry_at = ? WHERE url = ?", args: [at, url] });
      visibility.push("a new capture queued; it shows once that capture succeeds");
    }
  } else if (!old || old.error || old.is_portfolio !== false || guardedForReview(old)) {
    if (old && !old.error) {
      grade = "flip";
      newGrade = ownerGrade(old, verdict);
    } else {
      grade = "owner_only";
      newGrade = { is_portfolio: false, ai_is_portfolio: null, review: verdictReview(verdict), source: "owner_review", judged_at: at };
    }
  }
  if (!verdict.isPortfolio) {
    // Off the list now: confirmed down for the reason the health check itself
    // gives a "not a portfolio" grade, so the site is hidden at once
    // (lib/hidden.mjs) and the weekly health run moves it to
    // data/excluded.json as kind "not_portfolio" (pipeline/exclusions.mjs kindOf).
    stmts.push({
      sql: `UPDATE portfolios SET health = 'down', health_reason = ?, health_fails = MAX(COALESCE(health_fails, 0), 3),
              health_first_fail_at = COALESCE(health_first_fail_at, ?), health_checked_at = ? WHERE url = ?`,
      args: [isRuleActor(verdict.by) ? RULE_NOT_PORTFOLIO : OWNER_NOT_PORTFOLIO, at, at, url],
    });
    visibility.push("off the list, tiers, boards and the sitemap now; the weekly health run adds it to data/excluded.json");
  }

  let feed = null;
  if (verdict.isPortfolio && row?.delisted_at != null) {
    feed = onFeed ? "on_feed" : "queued";
    visibility.push(onFeed ? "listed again by the next roster sync" : "added to the list by the weekly data pull request (data/additions.json)");
  }
  stmts.push({ sql: "UPDATE portfolios SET needs_review = 0 WHERE url = ? AND needs_review != 0", args: [url] });
  return { grade, newGrade, visibility, feed, stmts, previous: old };
}

/**
 * Confirm or reject reviews. `ids`: the rows; `action`: "confirm" or
 * "reject"; `actor`: who ("admin:<login>"); `onFeed(url)`: whether the site
 * is on data/feed.json. Each row is claimed first (pending -> its new status,
 * so a double click or a second tab can't apply it twice), then applied; a
 * failed apply puts the row back to pending with the error.
 * Returns [{ id, url, ok, error?, applied? }].
 */
export async function decideReviews(db, { ids, action, actor, onFeed, now = new Date(), rank = rankForWrite, concurrency = DECIDE_CONCURRENCY }) {
  await ensureReviewSchema(db);
  const status = action === "confirm" ? "confirmed" : "rejected";
  const at = now.toISOString();
  // Rows are independent, so several apply at once (a bounded pool); each row's claim stays one conditional UPDATE.
  // One failing row never fails the rest of a selection: each row's own failure is its own result.
  return mapLimit(ids, concurrency, async (id) => {
    let review = null;
    try {
      const claim = await db.execute({
        sql: "UPDATE status_reviews SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
        args: [status, at, actor, id],
      });
      if (!claim.rowsAffected) return { id, ok: false, error: "wrong_status" };
      review = reviewOf((await db.execute({ sql: "SELECT * FROM status_reviews WHERE id = ?", args: [id] })).rows[0]);
      // Rejecting a removal of a site whose grade is held for this decision settles the grade (owner,
      // 2026-11-16): it stays listed as the owner's choice, and nothing re-flags it every week.
      if (action === "reject" && review.proposed === "remove") {
        const r = await settleOnReject(db, review, { actor, now, rank });
        if (r) return r;
      }
      // A row that only asks for a look (its capture was blocked, so no grader saw the site) has nothing to apply.
      if (action !== "confirm" || review.proposed === "review") {
        const applied = action === "confirm" ? { action: "none" } : { rejected: true };
        await db.execute({ sql: "UPDATE status_reviews SET applied = ? WHERE id = ?", args: [JSON.stringify(applied), id] });
        return { id, url: review.url, ok: true };
      }
      return await applyClaimed(db, review, { onFeed, now, rank });
    } catch (e) {
      // The same recovery as applyClaimed: the row waits for the owner again, with the error.
      const error = String(e?.message ?? e).slice(0, 300);
      await db
        .execute({
          sql: "UPDATE status_reviews SET status = 'pending', decided_at = NULL, decided_by = NULL, applied = ? WHERE id = ? AND status = ?",
          args: [JSON.stringify({ error, at }), id, status],
        })
        .catch(() => {});
      return { id, url: review?.url, ok: false, error };
    }
  });
}

/**
 * Why a waiting door removal no longer stands, or null when it does: the
 * site is gone or ungraded, its current grade is not the held "no" the row
 * was written for (a later grade, or one that says portfolio, or a hold the
 * owner settled), or the owner decided on the site since the row was written.
 */
export async function doorRowStale(db, review) {
  const row = (await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [review.url] })).rows[0];
  if (!row) return "the site has no row any more";
  const grade = row.ai_rubric == null ? null : json(row.ai_rubric);
  if (!grade || grade.error) return "the site has no grade any more";
  if (aiSaysPortfolio(grade)) return "the site's current grade says it is a portfolio";
  if (String(grade.judged_at ?? "") > review.createdAt) return "the site was graded again after this row was written";
  if (!guardedForReview(grade)) return "the site's grade is no longer held for this decision";
  const owner = (
    await db.execute({
      sql: `SELECT decided_at FROM status_reviews WHERE url = ? AND id != ? AND status IN ('confirmed', 'rejected')
              AND COALESCE(decided_by, '') NOT LIKE 'rule:%' AND decided_at > ? LIMIT 1`,
      args: [review.url, review.id, review.createdAt],
    })
  ).rows[0];
  if (owner) return `the owner decided on this site on ${String(owner.decided_at).slice(0, 10)}, after this row was written`;
  // One open case per site: another open row means this one no longer describes the site's case alone.
  const other = (await db.execute({ sql: "SELECT id FROM status_reviews WHERE url = ? AND id != ? AND status = 'pending' LIMIT 1", args: [review.url, review.id] })).rows[0];
  if (other) return `another case for this site is open (row ${Number(other.id)})`;
  return null;
}

/** The review kind of a grade the owner kept listed by rejecting a removal: settled, never re-flagged. */
export const OWNER_KEPT_KIND = "owner_kept";

// One fresh grade after the owner takes a removal back (owner, 2026-11-16, after the review of #238).
// A "not a portfolio" grade the owner undid or rejected may have been made on a capture that never
// showed the site, so its scores are not the site's grade: they go to rubric_history, the profile
// shows no grade, a new capture is asked for (site_freshness.forced_at, the nightly refresh's queue),
// and the night's "grade new sites" stage grades the site once after a capture newer than this
// (pipeline/night.mjs UNGRADED). That is the one grade the site never properly had, not a re-grade.
//   Undo    ai_rubric becomes { error: FRESH_GRADE_DUE, judged_at, reason }: no grade, listed.
//   Reject  ai_rubric becomes the owner's keep with no tier or scores ({ is_portfolio: true,
//           ai_is_portfolio: false, review: owner_kept, fresh_grade: "due" }): his decision holds
//           (OWNER_KEEPS_SQL), and the fresh grade keeps it (lib/reviews/door.mjs doorDecision).
/** The error marker of a grade the owner's Undo set aside, waiting for one fresh grade. */
export const FRESH_GRADE_DUE = "fresh_grade_due";
/** SQL (never NULL): the grade of the portfolios row aliased `p` waits for one fresh grade (Undo or Reject above). */
export const FRESH_GRADE_DUE_SQL = (p = "p") =>
  `COALESCE(json_valid(${p}.ai_rubric) AND (json_extract(${p}.ai_rubric, '$.error') = '${FRESH_GRADE_DUE}' OR json_extract(${p}.ai_rubric, '$.fresh_grade') = 'due'), 0)`;
/** Whether a stored grade (parsed) waits for one fresh grade. */
export const freshGradeDue = (g) => Boolean(g && typeof g === "object" && (g.error === FRESH_GRADE_DUE || g.fresh_grade === "due"));

/** Asks for a new capture of `url` (the admin's "Re-measure" path, lib/freshness.mjs markForced), as a statement. */
const forceCaptureStatement = (url, now) => ({
  sql: `INSERT INTO site_freshness (url, forced_at) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET forced_at = excluded.forced_at`,
  args: [url, now.getTime()],
});

/**
 * Reject of a "remove" row whose site carries a held grade (the guard, or
 * held for the owner), or the Undo's FRESH_GRADE_DUE marker: the site stays
 * listed as the owner's choice (OWNER_KEPT_KIND), with no tier or scores until
 * its one fresh grade (FRESH_GRADE_DUE above; Gemini's "no" kept in
 * ai_is_portfolio, the old grade in rubric_history), a new capture is asked
 * for, needs_review is cleared, and the state before is kept so Undo restores
 * it. Returns the result, or null when there is no held grade to settle.
 */
async function settleOnReject(db, review, { actor, now, rank }) {
  const row = (await db.execute({ sql: `SELECT url, ${BEFORE.join(", ")} FROM portfolios WHERE url = ?`, args: [review.url] })).rows[0];
  const grade = row?.ai_rubric == null ? null : json(row.ai_rubric);
  if (!grade || !(guardedForReview(grade) || grade.error === FRESH_GRADE_DUE)) return null;
  const at = now.toISOString();
  const settled = {
    is_portfolio: true,
    ai_is_portfolio: false,
    review: {
      kind: OWNER_KEPT_KIND,
      reason: "The owner kept it listed: he rejected the removal Gemini's answer proposed. It is graded once more after its next capture.",
      by: actor,
      at,
      batch: review.batch,
    },
    source: "owner_review",
    fresh_grade: "due",
    judged_at: at,
  };
  const before = Object.fromEntries(BEFORE.map((k) => [k, row[k] == null ? null : typeof row[k] === "bigint" ? Number(row[k]) : row[k]]));
  const graded = await rank(db, settled, { url: review.url, now: now.getTime() });
  await ensureFreshnessSchema(db);
  await db.batch(
    [
      // No tier: rankForWrite took it out of the tiers until the fresh grade.
      ...replaceGradeStatements(review.url, row.ai_rubric, graded, now),
      { sql: "UPDATE portfolios SET needs_review = 0 WHERE url = ?", args: [review.url] },
      forceCaptureStatement(review.url, now),
      { sql: "UPDATE status_reviews SET applied = ? WHERE id = ?", args: [JSON.stringify({ rejected: true, grade: "settled", fresh_grade: "due", before }), review.id] },
    ],
    "write"
  );
  return { id: review.id, url: review.url, ok: true };
}

/** How many rows a decision applies at once. */
export const DECIDE_CONCURRENCY = 8;

/** fn over items, at most `limit` at a time; results in the items' order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The site's columns a change can touch, kept in `applied.before` so Undo can put them back. */
const BEFORE = ["ai_rubric", "status", "health", "health_reason", "health_fails", "health_first_fail_at", "health_checked_at", "retry_at", "needs_review", "delisted_at"];

/**
 * Applies a claimed row (its status already set) through planConfirm, and
 * records what it did and the site's state before. A failure puts the row
 * back to pending with the error. Returns { id, url, ok, error?, applied? }.
 */
async function applyClaimed(db, review, { onFeed, now, rank }) {
  const at = now.toISOString();
  try {
    const row = (await db.execute({ sql: `SELECT url, ${BEFORE.join(", ")} FROM portfolios WHERE url = ?`, args: [review.url] })).rows[0];
    if (!row) throw new Error("not_found: the site has no row in portfolios");
    const plan = planConfirm(review, row, { onFeed: onFeed(review.url), now });
    const stmts = [];
    if (plan.newGrade) {
      // The same write a night grade makes: ranked (or out of the library), then stored with history.
      const graded = await rank(db, plan.newGrade, { url: review.url, now: now.getTime() });
      stmts.push(...replaceGradeStatements(review.url, row.ai_rubric, graded, now));
    }
    stmts.push(...plan.stmts);
    const before = Object.fromEntries(BEFORE.map((k) => [k, row[k] == null ? null : typeof row[k] === "bigint" ? Number(row[k]) : row[k]]));
    const applied = { grade: plan.grade, visibility: plan.visibility, feed: plan.feed, ...(plan.grade === "clear" ? { previous_grade: plan.previous } : {}), before };
    stmts.push({ sql: "UPDATE status_reviews SET applied = ? WHERE id = ?", args: [JSON.stringify(applied), review.id] });
    await db.batch(stmts, "write");
    return { id: review.id, url: review.url, ok: true, applied };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    await db.execute({
      sql: "UPDATE status_reviews SET status = 'pending', decided_at = NULL, decided_by = NULL, applied = ? WHERE id = ?",
      args: [JSON.stringify({ error, at }), review.id],
    });
    return { id: review.id, url: review.url, ok: false, error };
  }
}

/**
 * The owner's rules, applied (worker/review.ts, hourly, only with
 * REVIEW_AUTO_APPLY): every pending row that a rule passes (ruleFor: the
 * both-pass rule, or the door's removal) and was never undone is claimed as
 * auto_applied by that rule and applied through the same paths as Confirm.
 * Returns [{ id, url, ok, error?, applied? }].
 */
export async function autoApplyReviews(db, { onFeed, now = new Date(), rank = rankForWrite, limit = 200 }) {
  await ensureReviewSchema(db);
  const rows = (
    await db.execute({ sql: "SELECT * FROM status_reviews WHERE status = 'pending' AND undone_at IS NULL ORDER BY id LIMIT ?", args: [limit * 5] })
  ).rows.map(reviewOf);
  const out = [];
  for (const review of rows.filter((r) => ruleFor(r)).slice(0, limit)) {
    const r = await applyByRule(db, review, { actor: ruleFor(review).actor, onFeed, now, rank });
    if (r) out.push(r);
  }
  return out;
}

/**
 * One pending, never-undone row applied by `actor` (a rule): claimed as
 * auto_applied, then applied like a Confirm. The night applies the door's
 * removals with it at once (lib/reviews/door.mjs). Returns the apply's result,
 * or null when the row was not pending any more (or was undone).
 */
export async function applyByRule(db, review, { actor, onFeed = () => true, now = new Date(), rank = rankForWrite }) {
  // A waiting door removal may be stale by the time the rule runs (REVIEW_AUTO_APPLY was off): it is
  // closed without acting, with the reason, instead of acting against a newer decision.
  const stale = actor === DOOR_RULE_ACTOR ? await doorRowStale(db, review) : null;
  if (stale) {
    const closed = await db.execute({
      sql: "UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = ?, applied = ? WHERE id = ? AND status = 'pending' AND undone_at IS NULL",
      args: [now.toISOString(), actor, JSON.stringify({ closed: stale }), review.id],
    });
    return closed.rowsAffected ? { id: review.id, url: review.url, ok: false, closed: true, error: `stale: ${stale}` } : null;
  }
  const claim = await db.execute({
    sql: "UPDATE status_reviews SET status = 'auto_applied', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending' AND undone_at IS NULL",
    args: [now.toISOString(), actor, review.id],
  });
  if (!claim.rowsAffected) return null;
  return applyClaimed(db, { ...review, decidedBy: actor }, { onFeed, now, rank });
}

/**
 * What Undo reverses for a decided row (pure): "nothing" when the decision
 * changed nothing on the site (a rejection, a "Mark checked", a row a rule
 * decided with nothing applied); "exact" when the apply kept the site's state
 * before it (applied.before, every apply since #220); "legacy" for an apply
 * from before that, where only the grade can be put back (from
 * rubric_history, or applied.previous_grade) and the health, capture-retry
 * and needs_review changes stay. "wrong_status" for a pending row.
 */
export function planUndo(review) {
  if (!["confirmed", "rejected", "auto_applied"].includes(review.status)) return { kind: "wrong_status" };
  const a = review.applied;
  // A rejection changed nothing, unless it settled a held grade (settleOnReject keeps the state before).
  if (review.proposed === "review" || !a || a.action === "none" || (a.rejected && !a.before)) return { kind: "nothing" };
  if (a.before) return { kind: "exact" };
  return { kind: "legacy", grade: a.grade ?? "keep", visibility: a.visibility ?? [] };
}

/** Whether undoing `review` takes back a removal the door's rows applied (lib/reviews/door.mjs DOOR_GROUPS: groups "door_..."). */
const takesBackRemoval = (review) => review.proposed === "remove" && APPLIED.includes(review.status) && review.group.startsWith("door_");

/**
 * Undo of any decided row (the owner's, the review rule's, or another rule's
 * such as rule:duplicate): what the decision applied is reversed (planUndo),
 * and the row goes back to pending for the owner, with undone_at and
 * undone_by recorded. A grade that comes back is written with history and its
 * tier membership follows; the rule never auto-applies an undone row again.
 * Returns [{ id, url, ok, error?, reversed?, note? }].
 */
export async function undoReviews(db, { ids, actor, now = new Date(), rank = rankForWrite }) {
  await ensureReviewSchema(db);
  const out = [];
  for (const id of ids) {
    const at = now.toISOString();
    const r = (await db.execute({ sql: "SELECT * FROM status_reviews WHERE id = ?", args: [id] })).rows[0];
    const review = r ? reviewOf(r) : null;
    const plan = review ? planUndo(review) : { kind: "wrong_status" };
    if (plan.kind === "wrong_status") {
      out.push({ id, ok: false, error: "wrong_status" });
      continue;
    }
    try {
      const stmts = [];
      let reversed = plan.kind;
      let note = null;
      const current = plan.kind === "nothing" ? null : (await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [review.url] })).rows[0];
      if (plan.kind !== "nothing" && !current && review.proposed === "remove" && APPLIED.includes(review.status)) {
        // The row was purged (pipeline/roster.mjs purgeDelisted, 30 days after the weekly export took the site
        // off the list): nothing is left to put back here. The undone removal itself restores the site: the
        // daily sync lists it again through undoneRemovals (pipeline/review-additions.mjs), and it comes back
        // as a new site, captured and graded once at the door, where the rule never removes it again.
        reversed = "relist";
        note =
          "The site's row was purged after it left the list, so it comes back as a new site: the daily sync lists it again, then it is captured and graded once, and the rule never removes it again.";
      } else if (plan.kind !== "nothing") {
        if (!current) throw new Error("not_found: the site has no row in portfolios");
        // The grade comes back with history, and its tier membership follows.
        const putGrade = async (oldJson) => {
          if (String(current.ai_rubric ?? "") === String(oldJson ?? "")) return;
          const old = oldJson == null ? null : json(oldJson);
          if (old) stmts.push(...replaceGradeStatements(review.url, current.ai_rubric, await rank(db, old, { url: review.url, now: now.getTime() }), now));
          else {
            stmts.push(...clearGradeStatements(review.url, current.ai_rubric, now));
            stmts.push({ sql: "UPDATE tier_ratings SET member = 0, dirty = 1 WHERE url = ? AND member = 1", args: [review.url] });
          }
        };
        if (plan.kind === "exact") {
          const before = review.applied.before;
          const old = parseRubric(before.ai_rubric);
          if (takesBackRemoval(review) && old && !aiSaysPortfolio(old)) {
            // The "not a portfolio" grade behind the removal is not put back as the site's grade: the site
            // waits for one fresh grade after its next capture (FRESH_GRADE_DUE), listed and ungraded.
            await ensureFreshnessSchema(db);
            await putGrade(JSON.stringify({ error: FRESH_GRADE_DUE, judged_at: at, reason: `The owner undid the removal (review ${review.id}); graded once more after the next capture.` }));
            stmts.push(forceCaptureStatement(review.url, now));
          } else await putGrade(before.ai_rubric);
          // Only what an apply can change: the list membership (status, delisted_at) is the roster sync's.
          const cols = BEFORE.filter((k) => !["ai_rubric", "status", "delisted_at"].includes(k));
          stmts.push({ sql: `UPDATE portfolios SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE url = ?`, args: [...cols.map((k) => before[k] ?? null), review.url] });
        } else {
          // An apply from before the state was kept: the grade it replaced went to rubric_history at the decision's time.
          if (plan.grade === "flip") {
            const h = (
              await db.execute({
                sql: "SELECT rubric FROM rubric_history WHERE url = ? AND replaced_at = ? ORDER BY id DESC LIMIT 1",
                args: [review.url, review.decidedAt],
              })
            ).rows[0];
            if (!h) throw new Error("cannot reverse: the grade this decision replaced is not in rubric_history");
            await putGrade(String(h.rubric));
          } else if (plan.grade === "clear") await putGrade(review.applied.previous_grade == null ? null : JSON.stringify(review.applied.previous_grade));
          else if (plan.grade === "owner_only") await putGrade(null);
          if (plan.visibility.length) {
            reversed = "grade only";
            note = `Not reversed (no record of the state before): ${plan.visibility.join("; ")}.`;
          }
        }
      }
      const applied = { ...(review.applied ?? {}), undo: { at, by: actor, reversed, ...(note ? { note } : {}) } };
      stmts.push({
        sql: `UPDATE status_reviews SET status = 'pending', decided_at = NULL, decided_by = NULL, undone_at = ?, undone_by = ?, applied = ?
              WHERE id = ? AND status = ?`,
        args: [at, actor, JSON.stringify(applied), id, review.status],
      });
      await db.batch(stmts, "write");
      out.push({ id, url: review.url, ok: true, reversed, ...(note ? { note } : {}) });
    } catch (e) {
      out.push({ id, url: review.url, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return out;
}

/**
 * Removals taken back: a "remove" row that was applied and then undone (by
 * the owner, from the rule's or his own decision), and that no later applied
 * removal of the same site replaced. Undo puts the site's grade and health
 * back at once; when the weekly export already moved it to
 * data/excluded.json and off the feed, the daily sync brings it back through
 * these (pipeline/review-additions.mjs). [{ url, name, decidedAt }]
 */
export async function undoneRemovals(db) {
  try {
    return (
      await db.execute(
        `SELECT r.url, r.undone_at AS at, p.name FROM status_reviews r LEFT JOIN portfolios p ON p.url = r.url
         WHERE r.proposed = 'remove' AND r.undone_at IS NOT NULL AND r.status IN ('pending', 'rejected')
           AND NOT EXISTS (SELECT 1 FROM status_reviews x WHERE x.url = r.url AND x.proposed = 'remove' AND x.status IN (${APPLIED_SQL})
                           AND x.decided_at > r.undone_at)
         GROUP BY r.url ORDER BY r.url`
      )
    ).rows.map((r) => ({ url: String(r.url), name: r.name == null ? null : String(r.name), decidedAt: String(r.at) }));
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

/**
 * Confirmed relists of sites that are off data/feed.json, for the weekly data
 * pull request (pipeline/review-additions.mjs): [{ url, name, decidedAt }].
 */
export async function confirmedRelists(db) {
  try {
    return (
      await db.execute(
        `SELECT r.url, r.decided_at AS at, p.name FROM status_reviews r LEFT JOIN portfolios p ON p.url = r.url
         WHERE r.status IN (${APPLIED_SQL}) AND r.proposed = 'relist'
           AND NOT EXISTS (SELECT 1 FROM status_reviews x WHERE x.url = r.url AND x.status IN (${APPLIED_SQL})
                           AND (x.decided_at > r.decided_at OR (x.decided_at = r.decided_at AND x.id > r.id)))
         ORDER BY at, r.url`
      )
    ).rows.map((r) => ({ url: String(r.url), name: r.name == null ? null : String(r.name), decidedAt: String(r.at) }));
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}
