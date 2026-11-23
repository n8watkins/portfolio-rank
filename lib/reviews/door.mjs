// "Is it a portfolio" is asked once, at the door (owner, 2026-11-16;
// docs/DECISIONS.md). The nightly grade of a site (pipeline/night.mjs
// gradeItem) passes Gemini's answer through atTheDoor, which decides what
// the answer does and writes the owner's record of it in status_reviews
// (./store.mjs, page /admin/review):
//
//   the owner already decided         the owner's verdict holds; no row
//   Gemini says portfolio             listed; no row, unless the address's
//                                     host is never a portfolio (pipeline/
//                                     junk-rules.mjs hostNotPortfolio: a code
//                                     host, a newsletter, a link-in-bio page):
//                                     then the same ladder as a "no" with a
//                                     junk rule below, decided in the address
//                                     rule's name (ADDRESS_RULE_ACTOR), never
//                                     Gemini's, with Gemini's "yes" kept
//   Gemini says no, and either a junk rule fires (pipeline/junk-rules.mjs:
//   an unedited template, a placeholder name, a parked page) or the code
//   finds fewer than STRONG_SIGNALS of the six portfolio signals
//                                     removed automatically: a row in group
//                                     door_not_portfolio, applied at once by
//                                     DOOR_RULE_ACTOR through the "remove"
//                                     path (with Undo), when REVIEW_AUTO_APPLY
//                                     is on; with the switch off it waits
//   Gemini says no, the code finds STRONG_SIGNALS or more (and no junk rule)
//                                     stays listed (the strong-signals guard);
//                                     a pending row, door_strong_signals
//   Gemini says no, but the owner undid or rejected an earlier removal, a
//   rule listed it before, or an earlier grade said portfolio (a re-grade)
//                                     stays listed, held; a pending row,
//                                     door_held. A rule never removes a site
//                                     the owner has taken back.
//
// Before any of that: a grade of a stored capture that does not show the site
// (./stored-capture.mjs: a bot check, a gate, a loader, a picker, an empty
// page, stored before the capture checked its screen in #235) is not stored
// and never removes the site; the site is set aside for a new capture
// (setAsideCapture), and a bot wall goes to the owner. The night checks this
// before it asks Gemini (pipeline/night.mjs); the door catches the rest.
// After the owner undoes or rejects a removal, the site waits for one fresh
// grade after its next capture (./store.mjs FRESH_GRADE_DUE); when he
// rejected it and Gemini says no again, his keep holds (outcome owner_kept).
//
// The grade is stored first as "held" (listed, the AI's "no" kept in
// ai_is_portfolio), so an automatic removal's applied.before is the listed
// site, and Undo puts it back listed with the row pending for the owner.
//
// Two more kinds of row wait for the owner, written by syncReviewRows on
// every night's free part (no Gemini):
//   bot_wall           a site whose capture never got past a bot or security
//                      check (pull request #235 marks it); proposed "review":
//                      Confirm ("Mark checked") records that he looked, and
//                      the capture keeps retrying with backoff, so once one
//                      gets through the site is graded at the door like any
//                      new site; Reject records it too. Nothing else changes.
// The capture job writes one more kind (blockedRefreshReview):
//   recapture_blocked  a listed site with a good capture whose re-capture met
//                      a bot check or a covering dialog; proposed "review",
//                      with the same decisions as a bot wall; it closes itself
//                      once a later capture gets through.
//   signals_collapsed  a listed, graded site whose weekly health check found
//                      NEEDS_REVIEW_MAX or fewer signals (it sets
//                      needs_review); proposed "remove": Confirm takes it off
//                      as the owner's verdict, Reject keeps it. Listed sites
//                      are never re-graded for it (health check only).
// And the address rule over the listed roster (addressRows): door rows for
// listed sites whose host is never a portfolio, at most
// ADDRESS_AUTO_PER_NIGHT applied by the rule a night (the brake).
import { HELD_SQL, STRONG_SIGNALS, SIGNAL_NAMES, aiSaysPortfolio, guardVerdict, guardedForReview, held, unguarded } from "../../pipeline/portfolio-guard.mjs";
import { ADDRESS_HOSTS, ADDRESS_HOST_FAMILIES, ADDRESS_RULE, hostNotPortfolio, junkCheck } from "../../pipeline/junk-rules.mjs";
import { NEEDS_REVIEW_MAX } from "../../pipeline/signals.mjs";
import { ACTIVE, LISTED_NOT_DOWN } from "../../pipeline/roster.mjs";
import { BLOCKED_PREFIX, BOT_WALL_REASON } from "../../pipeline/capture-blocked.mjs";
import {
  ADDRESS_RULE_ACTOR,
  DOOR_RULE_ACTOR,
  OPEN_CASE_SQL,
  OWNER_KEEPS_SQL,
  OWNER_KEPT_KIND,
  applyByRule,
  ensureReviewSchema,
  freshGradeDue,
  ownerGrade,
  ownerKeepsSite,
  ownerVerdict,
  reviewOf,
  ruleVerdict,
} from "./store.mjs";
import { isBotWall, parseObject, storedCaptureBlocked } from "./stored-capture.mjs";
import { parseRubric } from "../../pipeline/rubric-history.mjs";
import { ensureFreshnessSchema, markForced } from "../freshness.mjs";
import { storedMs } from "../stored-time.mjs";

/** The capture's isBotWallReason (pipeline/capture-blocked.mjs) in SQL (never NULL), on the column `col`: the reason starts with BOT_WALL_REASON. */
const BOT_WALL_SQL = (col) => `COALESCE(substr(${col}, 1, ${BOT_WALL_REASON.length}) = '${BOT_WALL_REASON.replace(/'/g, "''")}', 0)`;

/** The rows the door writes (their groups in ./store.mjs GROUPS). */
export const DOOR_GROUPS = ["door_not_portfolio", "door_strong_signals", "door_held"];
/** Who closes an open row the nightly grade's decision replaced or superseded. */
export const DOOR_ACTOR = "rule:door";
/** What the address rule (pipeline/junk-rules.mjs hostNotPortfolio) catches, in the owner's words. */
const ADDRESS_WORDS = "a code host profile, repository or gist, a newsletter, or a link-in-bio page";

const parse = parseObject;

/**
 * Gemini's reason, in words. The rubric answer has no reason field for
 * is_portfolio (pipeline/rubric.mjs RESPONSE_SCHEMA), so this is its own
 * notes on the page, criterion by criterion; a reason field, when the prompt
 * gains one, comes first.
 */
export function geminiReason(grade) {
  const own = grade?.is_portfolio_reason ?? grade?.portfolio_reason ?? grade?.reason;
  const notes = Object.entries(grade ?? {})
    .filter(([, v]) => v && typeof v === "object" && typeof v.note === "string" && v.note)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v.note.replace(/[.\s]+$/, "")}`);
  const parts = [typeof own === "string" && own ? own.replace(/[.\s]+$/, "") : null, ...notes].filter(Boolean);
  return parts.length ? `${parts.join("; ").slice(0, 600)}.` : "Gemini gave no notes.";
}

/** The code's portfolio signals for a site: the grade's facts, else the weekly health check's. */
export function signalsOf(row, grade) {
  const s = grade?.facts?.signals ?? parse(row?.facts)?.signals ?? parse(row?.signals);
  if (!s || typeof s !== "object") return { score: 0, names: [], known: false };
  const names = SIGNAL_NAMES.filter((k) => s[k] === true);
  return { score: Number(s.score ?? names.length) || 0, names, known: true };
}

/**
 * Every row about a site, in every group, for the door: its open rows (one
 * case per site), and whether the owner has decided to keep it
 * (store.mjs ownerKeepsSite) or undid a removal of it.
 */
async function caseHistory(db, url) {
  const rows = (await db.execute({ sql: "SELECT * FROM status_reviews WHERE url = ? ORDER BY id", args: [url] })).rows.map(reviewOf);
  return {
    takenBack: ownerKeepsSite(rows) || rows.some((r) => r.undoneAt && r.proposed === "remove"),
    open: rows.filter((r) => r.status === "pending"),
  };
}

/**
 * The door's decision for one new grade. Pure. `grade`: the grade as
 * gradeRecord made it (the strong-signals guard applied); `owner`: the
 * owner's verdict or null; `rule`: the latest verdict a rule applied, or null;
 * `takenBack`: the owner undid or rejected an earlier automatic removal;
 * `previous`: the site's earlier real grade, or null; `row`: url, name,
 * page_text, facts, signals.
 * Returns { outcome, grade, group?, why?, auto? } where outcome is
 * "owner" | "portfolio" | "remove" | "strong_signals" | "held".
 */
export function doorDecision({ grade, owner = null, rule = null, takenBack = false, previous = null, openCase = false, row, autoApply = true }) {
  if (owner) return { outcome: "owner", grade: ownerGrade(grade, owner) };
  // The address rule runs on every grade (owner, 2026-11-23: "Someone's GitHub is not a portfolio page"):
  // Gemini's "yes" on such an address takes the same ladder as its "no" with a junk rule.
  // Only a host match (the owner's ruling was about hosts); an admin or login path stays a junk rule beside a "no".
  const address = aiSaysPortfolio(grade) && hostNotPortfolio(row.url);
  if (aiSaysPortfolio(grade) && !address) return { outcome: "portfolio", grade };
  const base = unguarded(grade);
  // Held for the decision, listed meanwhile. Under the address rule Gemini's own "yes" stays in ai_is_portfolio.
  const hold = (text) => (address ? { ...held(base, text, { address: true }), ai_is_portfolio: true } : held(base, text));
  // The one fresh grade after the owner rejected a removal (store.mjs FRESH_GRADE_DUE): he kept the site,
  // so a "no" again keeps it as his choice, now with the fresh grade's scores, and asks him nothing new.
  if (freshGradeDue(previous) && previous.review?.kind === OWNER_KEPT_KIND) {
    return { outcome: "owner_kept", grade: { ...base, is_portfolio: true, ai_is_portfolio: address, review: previous.review } };
  }
  const sig = signalsOf(row, grade);
  const junk = junkCheck({ url: row.url, name: row.name, page_text: row.page_text });
  const found = sig.known ? `; the code found ${sig.score} of ${SIGNAL_NAMES.length} portfolio signals` : "";
  const said = address
    ? `Gemini said this is a portfolio, but its address is not a portfolio page (${ADDRESS_WORDS})${found}.`
    : `Gemini said this is not a portfolio${found}${junk.junk ? ` and a junk rule fired (${junk.rule})` : ""}.`;
  // Anything the owner or a rule said before wins over a removal by the rule.
  const earlier =
    takenBack
      ? "You undid or rejected an earlier automatic removal of this site, so the rule never removes it again."
      : rule?.isPortfolio
        ? `A rule (${rule.by}) listed it as a portfolio on ${String(rule.at).slice(0, 10)}.`
        : previous && previous.is_portfolio !== false && !guardedForReview(previous)
          ? `An earlier grade (${String(previous.judged_at ?? "").slice(0, 10) || "date unknown"}) said it is a portfolio.`
          : // A case from another group (a re-check's disagreement, a collapse) was already waiting for
            // the owner: the rule never decides over his head. That row is closed and this one carries on.
            openCase
            ? "Another case for this site was already waiting for the owner's decision."
            : null;
  if (earlier) {
    return { outcome: "held", group: "door_held", grade: hold(`${said} ${earlier} It stays listed until the owner decides.`), why: `${said} ${earlier}`, sig, junk, auto: false, address };
  }
  // Signals the code never measured are not "too little to dispute it": the owner decides (no junk rule fired).
  if (!junk.junk && !sig.known) {
    const why = `${said} The code never measured this site's portfolio signals, so nothing disputes or confirms it.`;
    return { outcome: "held", group: "door_held", grade: held(base, `${why} It stays listed until the owner decides.`), why, sig, junk, auto: false };
  }
  if (!junk.junk && sig.score >= STRONG_SIGNALS) {
    const kept = guardVerdict(base, { ...(grade?.facts?.signals ?? {}), score: sig.score, ...Object.fromEntries(sig.names.map((n) => [n, true])) });
    return { outcome: "strong_signals", group: "door_strong_signals", grade: kept, why: `${said} It stays listed until the owner decides.`, sig, junk, auto: false };
  }
  return {
    outcome: "remove",
    group: "door_not_portfolio",
    // Held until the rule applies the removal, so Undo brings back a listed site. The text says what
    // happens, not what happened: the removal is a separate write (see /admin/review for its state).
    grade: hold(`${said} The rule takes it off the list${autoApply ? "" : " once automatic decisions are on"}; the owner can undo it.`),
    why: said,
    sig,
    junk,
    auto: true,
    address,
  };
}

/** The status_reviews row for a decision (outcome remove, strong_signals or held). */
function reviewRowOf(d, { url, shotKey, batch, now, gemini }) {
  const reason = geminiReason(gemini);
  return {
    batch,
    url,
    grp: d.group,
    // Graded and kept listed (held) when the row is written: in the tiers until a removal applies.
    current: "ranked",
    proposed: "remove",
    // Never pre-ticked for "Confirm all where everyone agrees": the code and Gemini are not two graders.
    agreed: 0,
    reason: `${d.why} Gemini's notes: ${reason}`,
    shot_key: shotKey ?? null,
    verdicts: {
      gemini35: {
        solo: {
          // Gemini's own answer: "no", or its "yes" the address rule overruled.
          is_portfolio: Boolean(d.address),
          reason,
          scores: { visual_design: gemini?.visual_design?.score, writing: gemini?.writing?.score },
        },
      },
      model: gemini?.model ?? null,
      prompt: gemini?.rubric_version ? `grade-v${gemini.rubric_version}` : undefined,
    },
    signals: {
      score: d.sig.score,
      names: d.sig.names,
      junk_rule: d.address ? ADDRESS_RULE : d.junk.junk ? d.junk.rule : null,
      capture: {},
      door: { auto: d.auto, outcome: d.outcome, ...(d.address ? { address: true } : {}) },
    },
    created_at: now.toISOString(),
  };
}

/** A new pending row; RETURNING gives its id in the same round trip (no read-back). */
const insertStatement = (r) => ({
  sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, shot_key, verdicts, signals, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?) ON CONFLICT(batch, url) DO NOTHING RETURNING id`,
  args: [r.batch, r.url, r.grp, r.current, r.proposed, r.agreed, r.reason, r.shot_key, JSON.stringify(r.verdicts), JSON.stringify(r.signals), r.created_at],
});

/** The row as reviewOf gives it, from what was inserted and its id. */
const insertedReview = (r, id) =>
  reviewOf({ ...r, id, verdicts: JSON.stringify(r.verdicts), signals: JSON.stringify(r.signals), off_list: 0, status: "pending" });

/** Closes an open row without acting, with the reason (status closed; only a pending, never-decided row). */
const closeStatement = (id, why, at) => ({
  sql: "UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = ?, applied = ? WHERE id = ? AND status = 'pending'",
  args: [at, DOOR_ACTOR, JSON.stringify({ closed: why }), id],
});

/**
 * The door for one grade (pipeline/night.mjs gradeItem, pipeline/judge.mjs).
 * `grade`: Gemini's grade (gradeRecord); `row`: the site (url, name,
 * shot_key, page_text, facts, signals, ai_rubric). `gradeStatements(grade)`
 * resolves to the statements that store the grade (ranked, with history).
 * The grade and its review row are written in one batch, so a held grade
 * never exists without its row; the rule's removal is a second write, and
 * when that one fails the row waits pending (the hourly rule applies it).
 * The caller has run ensureReviewSchema (startNight, judge.mjs runRubric).
 * One open case per site, across every group (owner, 2026-11-16, after the
 * second review of #238): a held grade always has exactly one open row,
 * describing the current grade. So when the site already has open rows, the
 * same write closes them with the reason: an older door row is replaced by
 * this grade's, and a row from another group (a collapse case, an older
 * re-check) is superseded by the newer, better-evidenced door decision. A
 * grade that says portfolio (or follows the owner) closes an open door row.
 * Returns { outcome, reviewId, applied } where outcome is that of
 * doorDecision, or "review" for a removal that waits (REVIEW_AUTO_APPLY off,
 * or the apply failed).
 */
export async function atTheDoor(db, { grade: answer, row: given, now, autoApply, gradeStatements, rank, captureChecked = false }) {
  const url = String(given.url);
  const at = now.toISOString();
  // A grade of a stored capture that never showed the site (./stored-capture.mjs) is not stored and
  // never removes the site; the site is set aside for a new capture (setAsideCapture). The night and the
  // fallback grader check before they ask Gemini and say so (captureChecked); this catches the rest.
  const row = captureChecked ? given : await withCaptureColumns(db, given);
  const blocked = captureChecked ? null : storedCaptureBlocked(row);
  if (blocked) {
    const s = await setAsideCapture(db, { row, why: blocked, now });
    return { outcome: "unusable_capture", reviewId: s.reviewId, applied: false, why: blocked, botWall: s.botWall };
  }
  // The capture the grade read, so a later Undo or Reject knows whether the capture had been checked
  // (./stored-capture.mjs gradedOnCheckedCapture).
  const grade = row.captured_at != null && answer && typeof answer === "object" ? { ...answer, capture_at: String(row.captured_at) } : answer;
  const previous = parse(row.ai_rubric);
  const [owner, rule, past] = await Promise.all([ownerVerdict(db, url), ruleVerdict(db, url), caseHistory(db, url)]);
  const openCase = past.open.some((r) => !DOOR_GROUPS.includes(r.group));
  const d = doorDecision({ grade, owner, rule, takenBack: past.takenBack, previous: previous && !previous.error ? previous : null, openCase, row, autoApply });
  const stmts = await gradeStatements(d.grade);
  const decided = d.outcome === "owner" || d.outcome === "portfolio" || d.outcome === "owner_kept";
  const settledBy = { owner: "the owner's verdict", portfolio: "Gemini says portfolio", owner_kept: "the owner kept it, and this is its fresh grade" }[d.outcome];
  // A settled grade closes the open door rows, and a bot wall's row: a capture got through and was graded.
  // Not a blocked re-capture's (RECAPTURE_BLOCKED): this grade may read the old stored capture, so the
  // block is not over; only a capture that gets through (closeBlockedRefreshReviews) or the owner closes it.
  const settles = (r) => DOOR_GROUPS.includes(r.group) || r.group === "bot_wall";
  const closes = decided
    ? past.open.filter(settles).map((r) => closeStatement(r.id, `a newer grade settled it (${settledBy})`, at))
    : past.open.map((r) => closeStatement(r.id, DOOR_GROUPS.includes(r.group) ? "replaced by the row for a newer grade" : "superseded by the nightly grade's decision at the door", at));
  // The bot wall's needs_review (pipeline/capture.mjs) is answered once the site is graded and settled.
  const clears = decided && past.open.some((r) => r.group === "bot_wall") ? [{ sql: "UPDATE portfolios SET needs_review = 0 WHERE url = ?", args: [url] }] : [];
  // Each grade's row is its own (batch per grade), so a re-grade never collides with an older decided row.
  const spec = decided ? null : reviewRowOf(d, { url, shotKey: row.shot_key, batch: `door:${at}`, now, gemini: grade });
  const results = await db.batch([...stmts, ...closes, ...clears, ...(spec ? [insertStatement(spec)] : [])], "write");
  if (decided) return { outcome: d.outcome, reviewId: null, applied: false };
  const id = results.at(-1)?.rows?.[0]?.id;
  if (id == null) return { outcome: d.outcome, reviewId: null, applied: false };
  const review = insertedReview(spec, Number(id));
  if (d.outcome !== "remove") return { outcome: d.outcome, reviewId: review.id, applied: false };
  if (!autoApply) return { outcome: "review", reviewId: review.id, applied: false };
  let r;
  try {
    r = await applyByRule(db, review, { actor: d.address ? ADDRESS_RULE_ACTOR : DOOR_RULE_ACTOR, now, ...(rank ? { rank } : {}) });
  } catch (e) {
    // The grade and its row are stored; the row waits pending and the hourly rule applies it.
    r = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
  return { outcome: r?.ok ? "remove" : "review", reviewId: review.id, applied: Boolean(r?.ok), error: r && !r.ok ? r.error : undefined };
}

/** The row with the capture's columns the check reads (captured_at, meta), from the table when the caller had none. */
export async function withCaptureColumns(db, row) {
  if (row.captured_at !== undefined && row.meta !== undefined) return row;
  const r = (await db.execute({ sql: "SELECT captured_at, meta FROM portfolios WHERE url = ?", args: [String(row.url)] })).rows[0];
  return { ...row, captured_at: row.captured_at !== undefined ? row.captured_at : r?.captured_at ?? null, meta: row.meta !== undefined ? row.meta : r?.meta ?? null };
}

/**
 * Sets aside a site whose stored capture does not show the site (`why`, from
 * ./stored-capture.mjs storedCaptureBlocked): it is never graded on that
 * capture and never removed for it. Returns { url, why, botWall, reviewId,
 * recapture } where recapture says how a new capture comes:
 *   "failed"   the site has no real grade: the stored capture is recorded the
 *              way the capture records a blocked one for a site without a
 *              good capture (pipeline/capture.mjs, since #235): status
 *              'error', reason BLOCKED_PREFIX + why, retry_at now, so the
 *              next capture run takes it as a new site and either stores a
 *              good capture (back to 'live', graded at the door) or records
 *              the failure with its backoff; the weekly health check reads
 *              the reason like any blocked capture's. A bot wall also sets
 *              needs_review and gets its bot_wall row for the owner now, as
 *              the capture would have sent it (the night's syncReviewRows
 *              only finds never-captured sites).
 *   "refresh"  the site has a real grade, kept as it is: a new capture is
 *              asked for (site_freshness.forced_at, the nightly refresh's
 *              queue), and nothing else changes.
 */
export async function setAsideCapture(db, { row, why, now }) {
  return (await setAsideCaptures(db, [{ row, why }], { now }))[0];
}

/**
 * setAsideCapture for many sites at once (the night's check of every waiting
 * site): one read of their open review rows, one write for all of them, and a
 * capture asked for each graded one. `items`: [{ row, why }].
 */
export async function setAsideCaptures(db, items, { now }) {
  if (!items.length) return [];
  const at = now.toISOString();
  const urls = items.map((i) => String(i.row.url));
  const ph = urls.map(() => "?").join(",");
  const missing = items.filter((i) => i.row.ai_rubric === undefined).map((i) => String(i.row.url));
  const rubrics = new Map(
    missing.length
      ? (await db.execute({ sql: `SELECT url, ai_rubric FROM portfolios WHERE url IN (${missing.map(() => "?").join(",")})`, args: missing })).rows.map((r) => [String(r.url), r.ai_rubric])
      : []
  );
  const walls = items.filter((i) => isBotWall(i.why)).map((i) => String(i.row.url));
  // A bot wall gets its row unless the site has an open case (one per site) or had a bot_wall row before.
  const covered = new Set(
    walls.length
      ? (await db.execute({ sql: `SELECT DISTINCT url FROM status_reviews WHERE url IN (${ph}) AND (status = 'pending' OR grp = 'bot_wall')`, args: urls })).rows.map((r) => String(r.url))
      : []
  );
  const stmts = [];
  const specs = [];
  const out = [];
  const refresh = [];
  for (const { row, why } of items) {
    const url = String(row.url);
    const botWall = isBotWall(why);
    const graded = parseRubric(row.ai_rubric === undefined ? rubrics.get(url) : row.ai_rubric);
    if (graded) {
      refresh.push(url);
      out.push({ url, why, botWall, reviewId: null, recapture: "refresh" });
      continue;
    }
    stmts.push({
      sql: `UPDATE portfolios SET status = 'error', reason = ?, retry_at = ?, needs_review = MAX(COALESCE(needs_review, 0), ?)
            WHERE url = ? AND status = 'live'`,
      args: [`${BLOCKED_PREFIX}${why}`, at, botWall ? 1 : 0, url],
    });
    const result = { url, why, botWall, reviewId: null, recapture: "failed" };
    if (botWall && !covered.has(url)) {
      covered.add(url);
      const spec = {
        batch: "bot-wall",
        url,
        grp: "bot_wall",
        current: "hidden",
        proposed: "review",
        agreed: 0,
        reason:
          "The stored capture (made before the capture checked for this) shows a bot or security check, not the site, so no grader has seen it and it was not graded. Open it yourself. Mark checked records that you looked; the capture keeps retrying, and once one gets through the site is graded like any new site.",
        shot_key: row.shot_key == null ? null : String(row.shot_key),
        verdicts: {},
        signals: { capture: { blocked: why, stored: true } },
        created_at: at,
      };
      specs.push({ index: stmts.length, result });
      stmts.push(insertStatement(spec));
    }
    out.push(result);
  }
  if (refresh.length) {
    await ensureFreshnessSchema(db);
    for (const url of refresh) await markForced(db, url, { now: now.getTime() });
  }
  if (stmts.length) {
    const results = await db.batch(stmts, "write");
    for (const { index, result } of specs) {
      const id = results[index]?.rows?.[0]?.id;
      result.reviewId = id == null ? null : Number(id);
    }
  }
  return out;
}

/** The review group of a blocked re-capture's row (./store.mjs GROUPS). */
export const RECAPTURE_BLOCKED = "recapture_blocked";
/**
 * The batch prefix of such a row. Each row gets its own batch (the prefix
 * and the time), so a later episode never meets an older, decided row's
 * (batch, url) and is silently dropped.
 */
export const REFRESH_BLOCKED_BATCH = "recapture-blocked";
/** Who closes such a row when a later capture of the site got through (closeBlockedRefreshReviews). */
export const RECAPTURE_ACTOR = "rule:recapture-got-through";

/**
 * A re-capture of a listed site with a good stored capture that met a bot or
 * security check, or a page still covered by a dialog (pipeline/capture.mjs
 * refreshNeedsReview decides; owner, 2026-11-22: such re-captures go to his
 * review list). Writes one pending RECAPTURE_BLOCKED row (proposed "review":
 * Mark checked records that he looked and nothing is applied; ./store.mjs),
 * worded for a listed site whose capture and grade stay as they are. The
 * row, not portfolios.needs_review, is the record: Mark checked leaves that
 * flag as it is, and the weekly health check rewrites it for every site
 * whose page loaded.
 * Writes nothing when the site is not live and listed, already has an open
 * case (one per site), or already had a RECAPTURE_BLOCKED row since its
 * stored capture was made (he has seen this episode; a capture that gets
 * through starts a new one). `reason` is the capture's own (BLOCKED_PREFIX ...).
 * Returns the new row's id, or null.
 */
export async function blockedRefreshReview(db, { url, reason, now = new Date() }) {
  await ensureReviewSchema(db);
  const site = (
    await db.execute({
      sql: `SELECT p.status, p.shot_key, p.captured_at, p.ai_rubric, p.delisted_at, ${OPEN_CASE_SQL("p")} AS open_case,
              (SELECT MAX(r.created_at) FROM status_reviews r WHERE r.url = p.url AND r.grp = ?) AS last_wall
            FROM portfolios p WHERE p.url = ?`,
      args: [RECAPTURE_BLOCKED, url],
    })
  ).rows[0];
  if (!site || String(site.status) !== "live" || site.shot_key == null || site.delisted_at != null) return null;
  if (Number(site.open_case) === 1) return null;
  const captured = storedMs(site.captured_at);
  const lastWall = storedMs(site.last_wall);
  if (lastWall != null && (captured == null || lastWall >= captured)) return null;
  const at = now.toISOString();
  const dialog = /^still a dialog on top/.test(String(reason ?? "").replace(BLOCKED_PREFIX, ""));
  const met = dialog ? "was still covered by a dialog after we tried to close it" : "met a bot or security check instead of the site";
  const graded = parseRubric(site.ai_rubric);
  const day = site.captured_at == null ? null : String(site.captured_at).slice(0, 10);
  const spec = {
    batch: `${REFRESH_BLOCKED_BATCH}:${at}`,
    url,
    grp: RECAPTURE_BLOCKED,
    current: graded && graded.is_portfolio !== false ? "ranked" : "listed",
    proposed: "review",
    agreed: 0,
    reason:
      `A nightly re-capture of this listed site ${met}. ` +
      `The stored capture${day ? ` from ${day}` : ""} is kept, so the site stays listed${graded ? " with its grade" : ""} and nothing about it changes. ` +
      "Open the site yourself to see what a visitor meets. Mark checked records that you looked; the re-capture keeps trying after a growing wait, and this row closes by itself once one gets through.",
    shot_key: String(site.shot_key),
    verdicts: {},
    // Shown as "Capture failed: ..." in a one-line tag on the review page: kept short.
    signals: { capture: { failed: dialog ? "a dialog on re-capture" : "a bot check on re-capture", refresh: true } },
    created_at: at,
  };
  const results = await db.batch([insertStatement(spec)], "write");
  const id = results[0]?.rows?.[0]?.id;
  return id == null ? null : Number(id);
}

/**
 * Closes the open rows blockedRefreshReview wrote for `url` once a capture of
 * the site got through (pipeline/capture.mjs, after a good capture is
 * stored): the block is over, so there is nothing left to look at. Returns
 * how many rows it closed (0 on a database without the review table yet).
 */
export async function closeBlockedRefreshReviews(db, url, { now = new Date() } = {}) {
  try {
    const r = await db.execute({
      sql: `UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = ?, applied = ?
            WHERE url = ? AND status = 'pending' AND grp = ?`,
      args: [now.toISOString(), RECAPTURE_ACTOR, JSON.stringify({ closed: "a later re-capture got through" }), url, RECAPTURE_BLOCKED],
    });
    return Number(r.rowsAffected ?? 0);
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return 0;
    throw e;
  }
}

/**
 * The night's free part: rows for bot-walled sites (#235's marker) and for
 * listed, graded sites whose signals collapsed, and the address rule over the
 * roster (addressRows), one open case per site. `skipSql(p)`: the sites the
 * night grades tonight, which the door decides itself.
 * Returns { botWall: [url], collapsed: [url], address: [url], addressBrake }.
 */
export async function syncReviewRows(db, { now, limit = 200, skipSql = null }) {
  await ensureReviewSchema(db);
  const at = now.toISOString();
  const open = `NOT ${OPEN_CASE_SQL("p")}`;
  const inserts = [];
  const walled = (
    await db.execute({
      sql: `SELECT p.url FROM portfolios p
            WHERE p.status = 'error' AND ${BOT_WALL_SQL("p.reason")} AND p.delisted_at IS NULL AND ${open}
              -- Never captured: a site with a good capture or a grade is not "no grader has seen it".
              AND p.captured_at IS NULL AND p.shot_key IS NULL AND p.ai_rubric IS NULL
              AND NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url AND r.grp = 'bot_wall')
            ORDER BY p.url LIMIT ?`,
      args: [limit],
    })
  ).rows.map((r) => String(r.url));
  for (const url of walled) {
    inserts.push({
      batch: "bot-wall",
      url,
      grp: "bot_wall",
      current: "hidden",
      proposed: "review",
      agreed: 0,
      reason:
        "The capture never got past a bot or security check, so no grader has seen this site. Open it yourself. Mark checked records that you looked; the capture keeps retrying, and once one gets through the site is graded like any new site.",
      shot_key: null,
      verdicts: {},
      signals: { capture: { blocked: "a bot or security check stood in for the site" } },
      created_at: at,
    });
  }
  // Collapsed: the health check's needs_review on a listed site graded a portfolio (not held: a held one has its row).
  const collapsed = (
    await db.execute({
      sql: `SELECT p.url, p.signals, p.ai_rubric, p.shot_key FROM portfolios p
            WHERE p.status = 'live' AND ${ACTIVE("p")} AND p.needs_review = 1
              AND json_valid(p.signals) AND CAST(json_extract(p.signals, '$.score') AS INTEGER) <= ${NEEDS_REVIEW_MAX}
              AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.error') IS NULL AND json_extract(p.ai_rubric, '$.is_portfolio') = 1
              AND NOT ${HELD_SQL("p.ai_rubric")}
              AND ${open}
              AND NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url AND r.grp = 'signals_collapsed'
                              AND r.created_at >= COALESCE(json_extract(p.signals, '$.checked_at'), ''))
              -- Settled: the owner has decided to keep this site (store.mjs OWNER_KEEPS_SQL, the one definition).
              AND NOT ${OWNER_KEEPS_SQL("p")}
            ORDER BY p.url LIMIT ?`,
      args: [limit],
    })
  ).rows;
  const done = [];
  for (const r of collapsed) {
    const s = parse(r.signals) ?? {};
    const g = parse(r.ai_rubric) ?? {};
    const names = SIGNAL_NAMES.filter((k) => s[k] === true);
    const checked = String(s.checked_at ?? "").slice(0, 10);
    done.push(String(r.url));
    inserts.push({
      batch: `signals-collapsed:${checked || at.slice(0, 10)}`,
      url: String(r.url),
      grp: "signals_collapsed",
      current: "ranked",
      proposed: "remove",
      agreed: 0,
      reason: `The site's portfolio signals collapsed: the weekly health check${checked ? ` on ${checked}` : ""} found ${Number(s.score ?? 0)} of ${SIGNAL_NAMES.length}. It was graded a portfolio${g.judged_at ? ` on ${String(g.judged_at).slice(0, 10)}` : ""} and is not graded again. Take it off, or reject to keep it listed.`,
      shot_key: r.shot_key == null ? null : String(r.shot_key),
      verdicts: {},
      signals: { score: Number(s.score ?? 0), names, junk_rule: null, capture: {} },
      created_at: at,
    });
  }
  const caseless = new Set([...walled, ...done]);
  const found = await addressRows(db, { now, limit, skipSql });
  const address = found.rows.filter((r) => !caseless.has(r.url));
  inserts.push(...address);
  // Every new row in one round trip (a site is in at most one list: every query skips sites with an open case).
  if (inserts.length) await db.batch(inserts.map(insertStatement), "write");
  return { botWall: walled, collapsed: done, address: address.map((r) => r.url), addressBrake: found.brake };
}

/** SQL prefilter for the address rule: every address hostNotPortfolio catches matches it (the rule then decides). */
const ADDRESS_LIKE = (col) => [...ADDRESS_HOSTS, ...ADDRESS_HOST_FAMILIES].map((s) => `${col} LIKE '%${s}%'`).join(" OR ");

/**
 * The most removals the roster pass lets the hourly rule apply on its own in
 * one night. Today's list has a handful of such addresses at most, so more in
 * one night means something changed (a host added to the list, a bad sync),
 * not that many sites turned bad; then every row of that night waits for the
 * owner instead, and the night records one owner alert (addressBrake).
 */
export const ADDRESS_AUTO_PER_NIGHT = 5;

/**
 * The address rule over the listed roster (the night's free part, so every
 * address synced in is seen the night it arrives, graded or not): the rows
 * for listed sites whose host is never a portfolio (pipeline/junk-rules.mjs
 * hostNotPortfolio; an admin or login path acts only beside a Gemini "no"),
 * by the door's own ladder:
 *   the owner decided on it, kept it or took a removal back, a case is open,
 *   or the rule already wrote a row for it that was decided or is waiting
 *                                               no row (one per site; a row closed
 *                                               without acting does not count)
 *   queued for tonight's grade (skipSql)       no row: the door decides it in minutes
 *   an earlier grade said portfolio, or a rule
 *   listed it                                   door_held, pending: the owner decides
 *   never graded                                door_not_portfolio, auto: the hourly
 *                                               rule (REVIEW_AUTO_APPLY) applies it as
 *                                               ADDRESS_RULE_ACTOR, with Undo; above
 *                                               ADDRESS_AUTO_PER_NIGHT in one night,
 *                                               every one is held for the owner
 * Nothing about the site changes here. Returns { rows, brake } where brake is
 * { removals, limit } when the brake held the night's removals, else null.
 */
export async function addressRows(db, { now, limit = 200, skipSql = null }) {
  const at = now.toISOString();
  const sites = (
    await db.execute({
      sql: `SELECT p.url, p.ai_rubric, p.shot_key, p.facts, p.signals FROM portfolios p
            WHERE ${LISTED_NOT_DOWN("p")} AND (${ADDRESS_LIKE("p.url")})
              AND NOT ${OPEN_CASE_SQL("p")} AND NOT ${OWNER_KEEPS_SQL("p")}
              ${skipSql ? `AND NOT (${skipSql("p")})` : ""}
              AND NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url
                              AND ((r.status != 'closed' AND COALESCE(json_valid(r.signals) AND json_extract(r.signals, '$.door.address') = 1, 0))
                                   OR (r.proposed = 'remove' AND (r.undone_at IS NOT NULL OR r.status = 'rejected'))
                                   OR (r.status = 'confirmed' AND COALESCE(r.decided_by, '') NOT LIKE 'rule:%')))
            ORDER BY p.url`,
    })
  ).rows.filter((r) => {
    if (!hostNotPortfolio(String(r.url))) return false;
    // A "not a portfolio" grade or a hold is the door's own case already (the health check takes it off).
    const graded = parseRubric(r.ai_rubric);
    return !(graded && (graded.is_portfolio === false || guardedForReview(graded)));
  });
  const out = [];
  for (const s of sites.slice(0, limit)) {
    const url = String(s.url);
    const graded = parseRubric(s.ai_rubric);
    const rule = graded ? null : await ruleVerdict(db, url);
    const earlier = graded
      ? `An earlier grade (${String(graded.judged_at ?? "").slice(0, 10) || "date unknown"}) said it is a portfolio.`
      : rule?.isPortfolio
        ? `A rule (${rule.by}) listed it as a portfolio on ${String(rule.at).slice(0, 10)}.`
        : null;
    const sig = signalsOf(s, null);
    const said = `Its address is not a portfolio page (${ADDRESS_WORDS})${sig.known ? `; the code found ${sig.score} of ${SIGNAL_NAMES.length} portfolio signals` : ""}.`;
    out.push({
      batch: `address:${at}`,
      url,
      grp: earlier ? "door_held" : "door_not_portfolio",
      current: graded ? "ranked" : "listed",
      proposed: "remove",
      agreed: 0,
      reason: earlier
        ? `${said} ${earlier} It stays listed until the owner decides.`
        : `${said} It was never graded. The rule takes it off the list; the owner can undo it.`,
      shot_key: s.shot_key == null ? null : String(s.shot_key),
      verdicts: {},
      signals: { score: sig.score, names: sig.names, junk_rule: ADDRESS_RULE, capture: {}, door: { auto: !earlier, outcome: earlier ? "held" : "remove", address: true, roster: true } },
      created_at: at,
    });
  }
  // The brake: more automatic removals than ADDRESS_AUTO_PER_NIGHT in one night, and none of them is automatic.
  const removals = out.filter((r) => r.signals.door.auto).length;
  if (removals <= ADDRESS_AUTO_PER_NIGHT) return { rows: out, brake: null };
  const why = `The address rule found ${removals} listed sites to take off tonight, more than its limit of ${ADDRESS_AUTO_PER_NIGHT} a night, so none is taken off without you.`;
  const rows = out.map((r) =>
    r.signals.door.auto
      ? { ...r, grp: "door_held", reason: r.reason.replace(/The rule takes it off the list; the owner can undo it\.$/, `${why} It stays listed until the owner decides.`), signals: { ...r.signals, door: { ...r.signals.door, auto: false, outcome: "held", brake: true } } }
      : r
  );
  return { rows, brake: { removals, limit: ADDRESS_AUTO_PER_NIGHT } };
}
