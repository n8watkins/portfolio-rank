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
//     "not_portfolio" entry keeps it out) in the weekly health workflow's
//     data pull request (pipeline/review-additions.mjs), and the daily
//     upstream sync lists it once that merges.
// remove (the site is not a portfolio):
//   - a grade (or none, or an error sentinel): stored as "not a portfolio",
//     the AI's answer kept in ai_is_portfolio, with the owner's decision in
//     review. It leaves tiers, boards, the sitemap, the home page and Play at
//     once; the weekly health check then counts it as failing ("AI grading
//     says this is not a portfolio") and, once confirmed, moves it to
//     data/excluded.json as kind "not_portfolio", the existing path off the
//     list.
// review (the capture was blocked, so no grader saw the site): nothing to
//   apply; Confirm ("Mark checked" on the page) only records that a person
//   looked (applied {"action":"none"}), and it is never an owner's verdict.
// Both: needs_review is cleared (a person decided), the profile's edge cache
// and the games pool are purged by the API route.

import { rankForWrite } from "../tiers-store.mjs";
import { clearGradeStatements, replaceGradeStatements } from "../../pipeline/rubric-history.mjs";
import { REVIEW_TABLES } from "./schema.mjs";

export const GROUPS = {
  not_portfolio: "Graded not a portfolio",
  delisted_graded: "Delisted after grading",
  delisted_ungraded: "Delisted before grading",
  broken: "Broken or dead, never graded",
  live_ungraded: "Live, not graded yet",
};
export const OWNER_KIND = "owner_confirmed";
export const AI_SAYS_NOT_PORTFOLIO = "AI grading says this is not a portfolio";

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
  };
}

/**
 * The queue: pending rows (agreed first, then by group and address) and the
 * latest decided ones. Empty when the table doesn't exist yet.
 */
export async function listReviews(db, { decidedLimit = 200 } = {}) {
  try {
    const pending = await db.execute(
      `SELECT * FROM status_reviews WHERE status = 'pending' ORDER BY agreed DESC, proposed, grp, url`
    );
    const decided = await db.execute({
      sql: `SELECT * FROM status_reviews WHERE status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?`,
      args: [decidedLimit],
    });
    return { pending: pending.rows.map(reviewOf), decided: decided.rows.map(reviewOf) };
  } catch (e) {
    if (missingTable(e)) return { pending: [], decided: [] };
    throw e;
  }
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
              WHERE url = ? AND status = 'confirmed' AND proposed IN ('relist', 'remove')
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
    visibility.push("out of tiers, boards and the sitemap now; off the list once the weekly health check confirms it");
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
    try {
      const row = (
        await db.execute({
          sql: "SELECT url, ai_rubric, status, health, health_reason, delisted_at FROM portfolios WHERE url = ?",
          args: [review.url],
        })
      ).rows[0];
      if (!row) throw new Error("not_found: the site has no row in portfolios");
      const plan = planConfirm(review, row, { onFeed: onFeed(review.url), now });
      const stmts = [];
      if (plan.newGrade) {
        // The same write a night grade makes: ranked (or out of the library), then stored with history.
        const graded = await rank(db, plan.newGrade, { url: review.url, now: now.getTime() });
        stmts.push(...replaceGradeStatements(review.url, row.ai_rubric, graded, now));
      }
      stmts.push(...plan.stmts);
      const applied = { grade: plan.grade, visibility: plan.visibility, feed: plan.feed, ...(plan.grade === "clear" ? { previous_grade: plan.previous } : {}) };
      stmts.push({ sql: "UPDATE status_reviews SET applied = ? WHERE id = ?", args: [JSON.stringify(applied), id] });
      await db.batch(stmts, "write");
      out.push({ id, url: review.url, ok: true, applied });
    } catch (e) {
      const error = String(e?.message ?? e).slice(0, 300);
      await db.execute({
        sql: "UPDATE status_reviews SET status = 'pending', decided_at = NULL, decided_by = NULL, applied = ? WHERE id = ?",
        args: [JSON.stringify({ error, at }), id],
      });
      out.push({ id, url: review.url, ok: false, error });
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
         WHERE r.status = 'confirmed' AND r.proposed = 'relist'
           AND NOT EXISTS (SELECT 1 FROM status_reviews x WHERE x.url = r.url AND x.status = 'confirmed'
                           AND (x.decided_at > r.decided_at OR (x.decided_at = r.decided_at AND x.id > r.id)))
         ORDER BY at, r.url`
      )
    ).rows.map((r) => ({ url: String(r.url), name: r.name == null ? null : String(r.name), decidedAt: String(r.at) }));
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}
