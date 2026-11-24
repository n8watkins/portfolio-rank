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
// One more kind of row waits for the owner, written by syncReviewRows on
// every night's free part (no Gemini):
//   bot_wall           a site whose capture never got past a bot or security
//                      check (pull request #235 marks it); proposed "review":
//                      Confirm ("Mark checked") records that he looked, and
//                      the capture keeps retrying with backoff, so once one
//                      gets through the site is graded at the door like any
//                      new site; Reject records it too. Nothing else changes.
//                      Asked once (owner, 2026-11-23): once he decided it, no
//                      check writes another row for the wall, and the wall
//                      alone never pools the site; he is asked again only
//                      after the site failed a real health check and came back
//                      (pipeline/not-working.mjs health_returns).
// The capture job writes one more kind (blockedRefreshReview):
//   recapture_blocked  a listed site with a good capture whose re-capture met
//                      a bot check or a covering dialog; proposed "review",
//                      with the same decisions as a bot wall; a bot check is
//                      not asked about again once he decided the site's wall.
// Both close by themselves once a capture gets through (closeStaleReviews,
// closeBlockedRefreshReviews).
// No health failure writes a row (owner, 2026-11-23: failing sites go to the
// temporary pool, pipeline/not-working.mjs), and low portfolio signals never
// do: the old signals_collapsed rows close by themselves (closeStaleReviews).
// And the address rule over the listed roster (addressRows): door rows for
// listed sites whose host is never a portfolio, at most
// ADDRESS_AUTO_PER_NIGHT applied by the rule a night (the brake).
import { STRONG_SIGNALS, SIGNAL_NAMES, aiSaysPortfolio, guardVerdict, guardedForReview, held, unguarded } from "../../pipeline/portfolio-guard.mjs";
import { ADDRESS_HOSTS, ADDRESS_HOST_FAMILIES, ADDRESS_RULE, addressNotPortfolio, junkCheck } from "../../pipeline/junk-rules.mjs";
import { AI_WORK, LISTED_NOT_DOWN } from "../../pipeline/roster.mjs";
import { ensureHealthSchema } from "../../pipeline/not-working.mjs";
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
const ADDRESS_WORDS = "a code host profile, repository or gist, a newsletter or blog platform such as Substack or Medium, or a link-in-bio page such as Linktree";
/** "Its address is not a portfolio page (...)", or, for an address that forwards to one, where it ends. `hit`: addressNotPortfolio's. */
const addressWords = (hit) =>
  hit?.forwarded ? `Its address forwards to ${hit.url}, which is not a portfolio page (${ADDRESS_WORDS})` : `Its address is not a portfolio page (${ADDRESS_WORDS})`;

const parse = parseObject;

/**
 * Gemini's reason, in words: its own "is it a portfolio" reason (rubric v3,
 * pipeline/rubric.mjs portfolio_reason), and nothing else: no score or note
 * of Gemini's is shown anywhere (owner, 2026-11-23), so a grade from before
 * v3, which has no reason, says so.
 */
export function geminiReason(grade) {
  const own = grade?.is_portfolio_reason ?? grade?.portfolio_reason;
  return typeof own === "string" && own.trim() ? `${own.trim().replace(/[.\s]+$/, "").slice(0, 600)}.` : "Gemini gave no reason (a grade from before it was asked for one).";
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
  // The listed address, or the one it ends at after its redirects (pipeline/junk-rules.mjs addressNotPortfolio).
  const hit = addressNotPortfolio(row);
  const address = aiSaysPortfolio(grade) && Boolean(hit);
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
  // With where the address ends (final_url, else the capture's facts), so the junk rule's address part reads it too.
  const junk = junkCheck({ url: row.url, name: row.name, page_text: row.page_text, final_url: row.final_url, facts: row.facts });
  const found = sig.known ? `; the code found ${sig.score} of ${SIGNAL_NAMES.length} portfolio signals` : "";
  const said = address
    ? `Gemini said this is a portfolio, but ${addressWords(hit).replace(/^Its/, "its")}${found}.`
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
    reason: `${d.why} Gemini's reason: ${reason}`,
    shot_key: shotKey ?? null,
    verdicts: {
      gemini35: {
        solo: {
          // Gemini's own answer: "no", or its "yes" the address rule overruled.
          is_portfolio: Boolean(d.address),
          reason,
          // No Gemini score is copied into a review row (owner, 2026-11-23); the answer and its reason are.
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
      door: { auto: d.auto, outcome: d.outcome, ...(d.address ? { address: true } : {}), ...(d.brake ? { brake: true } : {}) },
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
  // A case from another group, or a door row already held for the owner (the brake's among them), is an
  // earlier argument: a new grade never decides over a row that waits for him.
  const openCase = past.open.some((r) => !DOOR_GROUPS.includes(r.group) || r.group === "door_held");
  let d = doorDecision({ grade, owner, rule, takenBack: past.takenBack, previous: previous && !previous.error ? previous : null, openCase, row, autoApply });
  // The address rule's removals at the door count against the same brake as the roster pass's.
  if (d.address && d.outcome === "remove") {
    const b = await addressBrake(db, now, { rows: 1, autos: 1 });
    if (b) {
      const why = `${d.why} ${b.why}`;
      d = { ...d, outcome: "held", group: "door_held", auto: false, brake: true, why, grade: { ...d.grade, review: { ...d.grade.review, reason: `${why} It stays listed until the owner decides.` } } };
    }
  }
  // A held row that replaces one the brake held keeps its mark, so the owner alert stands while it waits.
  if (d.group === "door_held" && past.open.some((r) => r.signals?.door?.brake === true)) d = { ...d, brake: true };
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
  if (row.captured_at !== undefined && row.meta !== undefined && row.final_url !== undefined) return row;
  const r = (await db.execute({ sql: "SELECT captured_at, meta, final_url FROM portfolios WHERE url = ?", args: [String(row.url)] })).rows[0];
  const keep = (k) => (row[k] !== undefined ? row[k] : r?.[k] ?? null);
  // final_url: where the address ends after its redirects, for the address rule (addressNotPortfolio).
  return { ...row, captured_at: keep("captured_at"), meta: keep("meta"), final_url: keep("final_url") };
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
  await ensureHealthSchema(db);
  const site = (
    await db.execute({
      sql: `SELECT p.status, p.shot_key, p.captured_at, p.ai_rubric, p.delisted_at, ${OPEN_CASE_SQL("p")} AS open_case,
              ${WALL_ASKED_SQL("p")} AS wall_asked,
              (SELECT MAX(r.created_at) FROM status_reviews r WHERE r.url = p.url AND r.grp = ?) AS last_wall
            FROM portfolios p WHERE p.url = ?`,
      args: [RECAPTURE_BLOCKED, url],
    })
  ).rows[0];
  if (!site || String(site.status) !== "live" || site.shot_key == null || site.delisted_at != null) return null;
  if (Number(site.open_case) === 1) return null;
  const dialog = /^still a dialog on top/.test(String(reason ?? "").replace(BLOCKED_PREFIX, ""));
  // A bot wall is asked about once (owner, 2026-11-23): once he decided this site's wall, a re-capture that
  // meets it again writes nothing, until the site fails a real health check and comes back.
  if (!dialog && Number(site.wall_asked) === 1) return null;
  const captured = storedMs(site.captured_at);
  const lastWall = storedMs(site.last_wall);
  if (lastWall != null && (captured == null || lastWall >= captured)) return null;
  const at = now.toISOString();
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
 * Closes the open rows blockedRefreshReview wrote for `url`, and its open
 * bot-wall row, once a capture of the site got through (pipeline/capture.mjs,
 * after a good capture is stored): the block is over, so there is nothing
 * left to look at. A row the owner's Undo put back is left to him. Returns
 * how many rows it closed (0 on a database without the review table yet).
 */
export async function closeBlockedRefreshReviews(db, url, { now = new Date() } = {}) {
  try {
    const r = await db.batch(
      [
        {
          sql: `UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = ?, applied = ?
                WHERE url = ? AND status = 'pending' AND grp = ? AND undone_at IS NULL`,
          args: [now.toISOString(), RECAPTURE_ACTOR, JSON.stringify({ closed: "a later re-capture got through" }), url, RECAPTURE_BLOCKED],
        },
        {
          sql: `UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = ?, applied = ?
                WHERE url = ? AND status = 'pending' AND grp = 'bot_wall' AND undone_at IS NULL`,
          args: [now.toISOString(), RECAPTURE_ACTOR, JSON.stringify({ closed: STALE_REASONS.bot_wall }), url],
        },
        // The bot wall's mark for the owner is answered with it (an ungraded site has no hold of its own).
        clearWallMark(url),
      ],
      "write"
    );
    return r.slice(0, 2).reduce((n, x) => n + Number(x.rowsAffected ?? 0), 0);
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return 0;
    throw e;
  }
}

/**
 * SQL (never NULL): the owner has already been asked about a bot wall on the
 * portfolios row aliased `p` (a bot_wall row, or a bot-check re-capture row,
 * pending or decided) since its last return from the temporary pool
 * (health_returns): asked once; a real health failure and a return start a
 * new episode. Rows closed without a decision do not count.
 */
const WALL_ASKED_SQL = (p) => `EXISTS (SELECT 1 FROM status_reviews w WHERE w.url = ${p}.url
    AND (w.grp = 'bot_wall' OR (w.grp = '${RECAPTURE_BLOCKED}' AND COALESCE(json_valid(w.signals) AND json_extract(w.signals, '$.capture.failed') = 'a bot check on re-capture', 0)))
    AND w.status != 'closed'
    AND w.created_at >= COALESCE((SELECT MAX(h.at) FROM health_returns h WHERE h.url = ${p}.url AND h.from_where = 'pool'), ''))`;

/**
 * The night's free part: closes the rows whose reason no longer holds
 * (closeStaleReviews), then writes rows for bot-walled sites (#235's marker)
 * and the address rule over the roster (addressRows), one open case per
 * site. `skipUrls`: the sites tonight's grade will take, which the door
 * decides itself. A site failing its health checks (on the ladder of
 * pipeline/not-working.mjs) gets no bot-wall row: failing sites never reach
 * the owner.
 * Returns { botWall: [url], collapsed: [] (no longer written), address: [url], addressBrake, closed }.
 */
export async function syncReviewRows(db, { now, limit = 200, skipUrls = null }) {
  // health_returns (WALL_ASKED_SQL) is the schema's (lib/schema.mjs, every deploy; pipeline/roster.mjs ensureRosterSchema).
  await ensureReviewSchema(db);
  const closed = await closeStaleReviews(db, { now });
  const at = now.toISOString();
  const open = `NOT ${OPEN_CASE_SQL("p")}`;
  const inserts = [];
  const walled = (
    await db.execute({
      sql: `SELECT p.url FROM portfolios p
            WHERE p.status = 'error' AND ${BOT_WALL_SQL("p.reason")} AND ${open}
              -- Never captured: a site with a good capture or a grade is not "no grader has seen it".
              AND p.captured_at IS NULL AND p.shot_key IS NULL AND p.ai_rubric IS NULL
              -- Listed and not failing its health checks (a failing one is the temporary pool's, not the owner's).
              AND ${AI_WORK("p")}
              AND NOT ${WALL_ASKED_SQL("p")}
            ORDER BY p.url LIMIT ?`,
      args: [limit],
    })
  ).rows.map((r) => String(r.url));
  for (const url of walled) {
    inserts.push({
      // Its own batch per episode (the night's time): a second ask, after a return, never meets the first row's (batch, url).
      batch: `bot-wall:${at}`,
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
  // Low portfolio signals never write a row (owner's default, 2026-11-23): a site that loads stays listed and
  // is recorded as one the code could not read (pipeline/health.mjs).
  const caseless = new Set(walled);
  const found = await addressRows(db, { now, limit, skipUrls });
  const address = found.rows.filter((r) => !caseless.has(r.url));
  inserts.push(...address);
  // Every new row in one round trip (a site is in at most one list: every query skips sites with an open case).
  if (inserts.length) await db.batch(inserts.map(insertStatement), "write");
  return { botWall: walled, collapsed: [], address: address.map((r) => r.url), addressBrake: found.brake, closed };
}

/**
 * Clears portfolios.needs_review of `url` right after a statement that closed
 * its bot-wall row (changes() is that statement's count), when the site has
 * no grade: the mark was the wall's. A graded site's mark may be a hold's.
 */
const clearWallMark = (url) => ({ sql: "UPDATE portfolios SET needs_review = 0 WHERE url = ? AND ai_rubric IS NULL AND needs_review != 0 AND changes() > 0", args: [url] });

/** Who closes a pending row whose reason no longer holds (closeStaleReviews). */
export const STALE_ACTOR = "rule:no-longer-holds";
/** The recorded reasons, by kind of row. */
export const STALE_REASONS = {
  signals_collapsed: "low portfolio signals no longer go to review (owner, 2026-11-23): the site stays listed as long as it loads, and failing health checks go to the temporary pool",
  bot_wall: "a capture got through the bot wall",
  recapture_blocked: "a later re-capture got through",
};

/**
 * Closes every pending row whose reason no longer holds, with the reason
 * recorded (status closed, decided_by STALE_ACTOR, applied { closed }):
 *   signals_collapsed  every pending one: low signals no longer go to review
 *   bot_wall           a capture of the site got through since the row was
 *                      written (status live, captured after the row)
 *   recapture_blocked  a re-capture got through since the row was written
 * Only pending rows the owner never decided, and never an undone row (an Undo
 * puts a decision back for him). It is also the one-time migration of the
 * queue as it stood on 2026-11-23: the first night closes the old rows, and
 * every night after finds none, so running it twice changes nothing.
 * `dryRun` counts and writes nothing. Returns { signals_collapsed, bot_wall,
 * recapture_blocked, ids }.
 */
export async function closeStaleReviews(db, { now = new Date(), dryRun = false } = {}) {
  const out = { signals_collapsed: 0, bot_wall: 0, recapture_blocked: 0, ids: [] };
  let rows;
  try {
    rows = (
      await db.execute(
        `SELECT r.id, r.url, r.grp, r.created_at, p.status AS site_status, p.captured_at FROM status_reviews r LEFT JOIN portfolios p ON p.url = r.url
         WHERE r.status = 'pending' AND r.undone_at IS NULL AND r.grp IN ('signals_collapsed', 'bot_wall', '${RECAPTURE_BLOCKED}')
         ORDER BY r.id`
      )
    ).rows;
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return out;
    throw e;
  }
  const stmts = [];
  for (const r of rows) {
    const grp = String(r.grp);
    let stale = grp === "signals_collapsed";
    if (!stale) {
      // A capture that got through after the row was written (both times read by lib/stored-time.mjs: the
      // capture's are SQLite's "YYYY-MM-DD HH:MM:SS", the row's ISO text).
      const captured = storedMs(r.captured_at);
      const written = storedMs(r.created_at);
      stale = String(r.site_status ?? "") === "live" && captured != null && written != null && captured > written;
    }
    if (!stale) continue;
    out[grp]++;
    out.ids.push(Number(r.id));
    stmts.push({
      sql: "UPDATE status_reviews SET status = 'closed', decided_at = ?, decided_by = ?, applied = ? WHERE id = ? AND status = 'pending' AND undone_at IS NULL",
      args: [now.toISOString(), STALE_ACTOR, JSON.stringify({ closed: STALE_REASONS[grp] }), Number(r.id)],
    });
    if (grp === "bot_wall") stmts.push(clearWallMark(String(r.url)));
  }
  if (!dryRun && stmts.length) await db.batch(stmts, "write");
  return out;
}

/** SQL prefilter for the address rule: every address hostNotPortfolio catches matches it (the rule then decides). */
const ADDRESS_LIKE = (col) => [...ADDRESS_HOSTS, ...ADDRESS_HOST_FAMILIES].map((s) => `${col} LIKE '%${s}%'`).join(" OR ");

/**
 * The brake on the address rule (addressBrake). Today's list has one such
 * address at most, and the community list adds a handful of sites a night, so:
 *   ADDRESS_AUTO_PER_NIGHT  more than 5 rows the rule writes in one night
 *                           (held or automatic, the roster pass's and the
 *                           door's) means something changed (a host added to
 *                           the list, a bad sync), not that many sites turned bad
 *   ADDRESS_AUTO_PER_WEEK   more than 10 automatic removals in 7 days is a
 *                           slow leak of the same kind (5 a night, every night),
 *                           twice what a busy week of new sites could bring
 * Above either, no address removal is applied without the owner: every row of
 * that night waits on the review page, marked signals.door.brake, and the owner
 * alert "address-rule-brake" stands while any such row waits
 * (pipeline/alerts.mjs addressBrakeConditions).
 */
export const ADDRESS_AUTO_PER_NIGHT = 5;
export const ADDRESS_AUTO_PER_WEEK = 10;

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
 *   taken by tonight's grade (skipUrls)        no row: the door decides it in minutes
 *   an earlier grade said portfolio, or a rule
 *   listed it                                   door_held, pending: the owner decides
 *   never graded                                door_not_portfolio, auto: the hourly
 *                                               rule (REVIEW_AUTO_APPLY) applies it as
 *                                               ADDRESS_RULE_ACTOR, with Undo; when
 *                                               the brake holds (addressBrake), every
 *                                               one is held for the owner
 * Nothing about the site changes here. Returns { rows, brake } where brake is
 * addressBrake's answer when it held the night's removals, else null.
 */
export async function addressRows(db, { now, limit = 200, skipUrls = null }) {
  const at = now.toISOString();
  const sites = (
    await db.execute({
      sql: `SELECT p.url, p.final_url, p.ai_rubric, p.shot_key, p.facts, p.signals FROM portfolios p
            WHERE ${LISTED_NOT_DOWN("p")}
              AND (${ADDRESS_LIKE("p.url")} OR ${ADDRESS_LIKE("COALESCE(p.final_url, '')")} OR ${ADDRESS_LIKE("COALESCE(CASE WHEN json_valid(p.facts) THEN json_extract(p.facts, '$.final_url') END, '')")})
              AND NOT ${OPEN_CASE_SQL("p")} AND NOT ${OWNER_KEEPS_SQL("p")}
              AND NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url
                              AND ((r.status != 'closed' AND COALESCE(json_valid(r.signals) AND json_extract(r.signals, '$.door.address') = 1, 0))
                                   OR (r.proposed = 'remove' AND (r.undone_at IS NOT NULL OR r.status = 'rejected'))
                                   OR (r.status = 'confirmed' AND COALESCE(r.decided_by, '') NOT LIKE 'rule:%')))
            ORDER BY p.url`,
    })
  ).rows.filter((r) => {
    // The listed address, or the address it ends at after its redirects (addressNotPortfolio).
    if (!addressNotPortfolio(r) || skipUrls?.has(String(r.url))) return false;
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
    const said = `${addressWords(addressNotPortfolio(s))}${sig.known ? `; the code found ${sig.score} of ${SIGNAL_NAMES.length} portfolio signals` : ""}.`;
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
  // The brake: every row tonight counts (held and automatic), and the week's automatic removals too.
  const autos = out.filter((r) => r.signals.door.auto).length;
  const brake = await addressBrake(db, now, { rows: out.length, autos });
  if (!brake) return { rows: out, brake: null };
  const rows = out.map((r) =>
    r.signals.door.auto
      ? { ...r, grp: "door_held", reason: r.reason.replace(/The rule takes it off the list; the owner can undo it\.$/, `${brake.why} It stays listed until the owner decides.`), signals: { ...r.signals, door: { ...r.signals.door, auto: false, outcome: "held", brake: true } } }
      : { ...r, signals: { ...r.signals, door: { ...r.signals.door, brake: true } } }
  );
  return { rows, brake };
}

/** A night, for the brake: the roster pass and that night's grades all fall inside it. */
const NIGHT_MS = 12 * 3600000;
const WEEK_MS = 7 * 86400000;

/**
 * Whether the address rule's brake holds `adding` more rows (`autos` of them
 * automatic removals) at `now`: null when they may go ahead, else
 * { tonight, week, limit, weekLimit, why }. Every row the rule wrote tonight
 * counts (held or automatic, the roster pass's and the door's), and so does
 * every automatic removal of the last 7 days, waiting or applied, that the
 * owner did not undo. Tonight's limit holds even when none of the rows is an
 * automatic removal, so the owner alert stands for a flood of held rows too.
 */
export async function addressBrake(db, now, { rows, autos }) {
  // Nothing new tonight: nothing to hold or flag, and no reads.
  if (rows === 0 && autos === 0) return null;
  const at = now.getTime();
  const isAddress = "COALESCE(json_valid(signals) AND json_extract(signals, '$.door.address') = 1, 0)";
  const n = async (sql, args) => Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
  const tonight = (await n(`SELECT COUNT(*) AS n FROM status_reviews WHERE ${isAddress} AND created_at >= ?`, [new Date(at - NIGHT_MS).toISOString()])) + rows;
  // A night with many rows and no automatic removal still raises the brake (#286 review, R2): so many at
  // once usually means the host list or the sync changed, and the owner alert must say so.
  if (autos === 0) {
    if (tonight <= ADDRESS_AUTO_PER_NIGHT) return null;
    return { tonight, week: 0, limit: ADDRESS_AUTO_PER_NIGHT, weekLimit: ADDRESS_AUTO_PER_WEEK, why: `The address rule found ${tonight} listed sites tonight, more than its limit of ${ADDRESS_AUTO_PER_NIGHT} a night, so none is taken off without you.` };
  }
  // A removal the owner undid is not one the rule "has taken off" (#286 review, R1): an Undo puts the row
  // back to pending with undone_at set, and it never counts toward the week again.
  const week =
    (await n(
      `SELECT COUNT(*) AS n FROM status_reviews WHERE ${isAddress} AND json_extract(signals, '$.door.auto') = 1 AND status IN ('pending', 'auto_applied') AND undone_at IS NULL AND created_at >= ?`,
      [new Date(at - WEEK_MS).toISOString()]
    )) + autos;
  if (tonight <= ADDRESS_AUTO_PER_NIGHT && week <= ADDRESS_AUTO_PER_WEEK) return null;
  const why =
    tonight > ADDRESS_AUTO_PER_NIGHT
      ? `The address rule found ${tonight} listed sites tonight, more than its limit of ${ADDRESS_AUTO_PER_NIGHT} a night, so none is taken off without you.`
      : `The address rule has taken off ${week - autos} sites in the last 7 days and would pass its limit of ${ADDRESS_AUTO_PER_WEEK} a week, so none is taken off without you.`;
  return { tonight, week, limit: ADDRESS_AUTO_PER_NIGHT, weekLimit: ADDRESS_AUTO_PER_WEEK, why };
}
