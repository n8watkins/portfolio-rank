// The owner's review queue (table status_reviews, lib/reviews/schema.mjs;
// page /admin/review; API /api/admin/review). A re-check writes one row per
// site whose listed or ranked state it would change; nothing changes until
// the owner confirms the row. Confirm applies the change through the paths
// the pipeline already uses, and records the owner's verdict so later grades
// keep it (withOwnerVerdict). Reject only records the decision.
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

import { rankForWrite } from "../tiers-store.mjs";
import { clearGradeStatements, replaceGradeStatements } from "../../pipeline/rubric-history.mjs";
import { REVIEW_COLUMNS, REVIEW_TABLES } from "./schema.mjs";

export const GROUPS = {
  not_portfolio: "Graded not a portfolio",
  delisted_graded: "Delisted after grading",
  delisted_ungraded: "Delisted before grading",
  broken: "Broken or dead, never graded",
  live_ungraded: "Live, not graded yet",
};
export const OWNER_KIND = "owner_confirmed";
export const AI_SAYS_NOT_PORTFOLIO = "AI grading says this is not a portfolio";
/** The health reason a confirmed remove sets; it starts like the health check's own, so exclusions file it as not_portfolio. */
export const OWNER_NOT_PORTFOLIO = `${AI_SAYS_NOT_PORTFOLIO} (confirmed by the owner)`;
/** Statuses whose change was applied: the owner confirmed it, or the review rule applied a pass. */
export const APPLIED = ["confirmed", "auto_applied"];
/** Who the review rule records as the decider. */
export const RULE_ACTOR = "rule:both-pass";
const APPLIED_SQL = APPLIED.map((s) => `'${s}'`).join(", ");

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
      sql: `SELECT * FROM status_reviews WHERE status IN ('confirmed', 'rejected') ORDER BY decided_at DESC, id DESC LIMIT ?`,
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

/** How many rows wait for the owner (0 without the table). */
export async function pendingReviewCount(db) {
  try {
    return Number((await db.execute("SELECT COUNT(*) AS n FROM status_reviews WHERE status = 'pending'")).rows[0]?.n ?? 0);
  } catch (e) {
    if (missingTable(e)) return 0;
    throw e;
  }
}

/**
 * The owner's latest confirmed verdict on a site, or null:
 * { isPortfolio, reason, by, at, batch }.
 */
export async function ownerVerdict(db, url) {
  let r;
  try {
    r = (
      await db.execute({
        sql: `SELECT proposed, reason, decided_by, decided_at, batch FROM status_reviews
              WHERE url = ? AND status IN (${APPLIED_SQL}) AND proposed IN ('relist', 'remove')
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

const ownerReview = (v) => ({
  kind: OWNER_KIND,
  reason: `The owner confirmed this ${v.isPortfolio ? "is" : "is not"} a portfolio${v.reason ? `: ${v.reason}` : "."}`,
  by: v.by,
  at: v.at,
  batch: v.batch,
});

/**
 * A grade with the owner's verdict on top. Pure. Unchanged when there is no
 * verdict, or the grade is an error sentinel. When the grade's own answer
 * differs, is_portfolio follows the owner and ai_is_portfolio keeps the AI's
 * answer; a strong-signals hold (pipeline/portfolio-guard.mjs) the owner
 * settled becomes the owner's review.
 */
export function ownerGrade(grade, verdict) {
  if (!verdict || !grade || typeof grade !== "object" || grade.error) return grade;
  const says = grade.is_portfolio !== false;
  if (says === verdict.isPortfolio && grade.review?.kind !== "strong_signals") return grade;
  return {
    ...grade,
    is_portfolio: verdict.isPortfolio,
    ai_is_portfolio: grade.ai_is_portfolio ?? (typeof grade.is_portfolio === "boolean" ? grade.is_portfolio : null),
    review: ownerReview(verdict),
  };
}

/**
 * For every grade writer (pipeline/night.mjs, pipeline/judge.mjs, the
 * re-check scripts): a new grade for `url` with the owner's verdict applied,
 * so a later grade never undoes a decision the owner made.
 */
export async function withOwnerVerdict(db, url, grade) {
  return ownerGrade(grade, await ownerVerdict(db, url));
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
    } else if (old && old.review?.kind === "strong_signals") {
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
  } else if (!old || old.error || old.is_portfolio !== false || old.review?.kind === "strong_signals") {
    if (old && !old.error) {
      grade = "flip";
      newGrade = ownerGrade(old, verdict);
    } else {
      grade = "owner_only";
      newGrade = { is_portfolio: false, ai_is_portfolio: null, review: ownerReview(verdict), source: "owner_review", judged_at: at };
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
      args: [OWNER_NOT_PORTFOLIO, at, at, url],
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
export async function decideReviews(db, { ids, action, actor, onFeed, now = new Date(), rank = rankForWrite }) {
  await ensureReviewSchema(db);
  const out = [];
  const status = action === "confirm" ? "confirmed" : "rejected";
  for (const id of ids) {
    const at = now.toISOString();
    const claim = await db.execute({
      sql: "UPDATE status_reviews SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
      args: [status, at, actor, id],
    });
    if (!claim.rowsAffected) {
      out.push({ id, ok: false, error: "wrong_status" });
      continue;
    }
    const review = reviewOf((await db.execute({ sql: "SELECT * FROM status_reviews WHERE id = ?", args: [id] })).rows[0]);
    // A row that only asks for a look (its capture was blocked, so no grader saw the site) has nothing to apply.
    if (action !== "confirm" || review.proposed === "review") {
      const applied = action === "confirm" ? { action: "none" } : { rejected: true };
      await db.execute({ sql: "UPDATE status_reviews SET applied = ? WHERE id = ?", args: [JSON.stringify(applied), id] });
      out.push({ id, url: review.url, ok: true });
      continue;
    }
    out.push(await applyClaimed(db, review, { onFeed, now, rank }));
  }
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
 * The owner's rule, applied (worker/review.ts, hourly, only with
 * REVIEW_AUTO_APPLY): every pending row that passes (passesRule) and was
 * never undone is claimed as auto_applied by RULE_ACTOR and applied through
 * the same paths as Confirm. Returns [{ id, url, ok, error?, applied? }].
 */
export async function autoApplyReviews(db, { onFeed, now = new Date(), rank = rankForWrite, limit = 200 }) {
  await ensureReviewSchema(db);
  const rows = (
    await db.execute({ sql: "SELECT * FROM status_reviews WHERE status = 'pending' AND undone_at IS NULL ORDER BY id LIMIT ?", args: [limit * 5] })
  ).rows.map(reviewOf);
  const out = [];
  for (const review of rows.filter((r) => passesRule(r).pass).slice(0, limit)) {
    const at = now.toISOString();
    const claim = await db.execute({
      sql: "UPDATE status_reviews SET status = 'auto_applied', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending' AND undone_at IS NULL",
      args: [at, RULE_ACTOR, review.id],
    });
    if (!claim.rowsAffected) continue;
    out.push(await applyClaimed(db, { ...review, decidedBy: RULE_ACTOR }, { onFeed, now, rank }));
  }
  return out;
}

/**
 * Undo of a row the rule applied: the site's columns go back to what they
 * were (applied.before; a grade that was changed is written back with
 * history and its tier membership follows), and the row goes back to pending
 * for the owner, with undone_at and undone_by recorded; the rule never
 * applies it again. Returns [{ id, url, ok, error? }].
 */
export async function undoReviews(db, { ids, actor, now = new Date(), rank = rankForWrite }) {
  await ensureReviewSchema(db);
  const out = [];
  for (const id of ids) {
    const at = now.toISOString();
    const r = (await db.execute({ sql: "SELECT * FROM status_reviews WHERE id = ? AND status = 'auto_applied'", args: [id] })).rows[0];
    if (!r) {
      out.push({ id, ok: false, error: "wrong_status" });
      continue;
    }
    const review = reviewOf(r);
    const before = review.applied?.before;
    try {
      if (!before) throw new Error("nothing to restore: the row has no record of the state before");
      const current = (await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [review.url] })).rows[0];
      if (!current) throw new Error("not_found: the site has no row in portfolios");
      const stmts = [];
      if (String(current.ai_rubric ?? "") !== String(before.ai_rubric ?? "")) {
        const old = before.ai_rubric == null ? null : json(before.ai_rubric);
        if (old) stmts.push(...replaceGradeStatements(review.url, current.ai_rubric, await rank(db, old, { url: review.url, now: now.getTime() }), now));
        else {
          stmts.push(...clearGradeStatements(review.url, current.ai_rubric, now));
          stmts.push({ sql: "UPDATE tier_ratings SET member = 0, dirty = 1 WHERE url = ? AND member = 1", args: [review.url] });
        }
      }
      // Only what an apply can change: the list membership (status, delisted_at) is the roster sync's.
      const cols = BEFORE.filter((k) => !["ai_rubric", "status", "delisted_at"].includes(k));
      stmts.push({ sql: `UPDATE portfolios SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE url = ?`, args: [...cols.map((k) => before[k] ?? null), review.url] });
      const applied = { ...review.applied, undo: { at, by: actor } };
      stmts.push({
        sql: `UPDATE status_reviews SET status = 'pending', decided_at = NULL, decided_by = NULL, undone_at = ?, undone_by = ?, applied = ?
              WHERE id = ? AND status = 'auto_applied'`,
        args: [at, actor, JSON.stringify(applied), id],
      });
      await db.batch(stmts, "write");
      out.push({ id, url: review.url, ok: true });
    } catch (e) {
      out.push({ id, url: review.url, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return out;
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
