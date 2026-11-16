// "Is it a portfolio" is asked once, at the door (owner, 2026-11-16;
// docs/DECISIONS.md). The nightly grade of a site (pipeline/night.mjs
// gradeItem) passes Gemini's answer through atTheDoor, which decides what
// the answer does and writes the owner's record of it in status_reviews
// (./store.mjs, page /admin/review):
//
//   Gemini says portfolio             listed; no row
//   the owner already decided         the owner's verdict holds; no row
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
//   signals_collapsed  a listed, graded site whose weekly health check found
//                      NEEDS_REVIEW_MAX or fewer signals (it sets
//                      needs_review); proposed "remove": Confirm takes it off
//                      as the owner's verdict, Reject keeps it. Listed sites
//                      are never re-graded for it (health check only).
import { STRONG_SIGNALS, SIGNAL_NAMES, aiSaysPortfolio, guardVerdict, guardedForReview, held, unguarded } from "../../pipeline/portfolio-guard.mjs";
import { junkCheck } from "../../pipeline/junk-rules.mjs";
import { NEEDS_REVIEW_MAX } from "../../pipeline/signals.mjs";
import { ACTIVE } from "../../pipeline/roster.mjs";
import { DOOR_RULE_ACTOR, applyByRule, ensureReviewSchema, ownerGrade, ownerVerdict, reviewOf, ruleVerdict } from "./store.mjs";

/**
 * The stored capture failure reason of a bot-walled, never-captured site.
 * Pull request #235 writes it (pipeline/capture-blocked.mjs: BLOCKED_PREFIX +
 * BOT_WALL, isBotWallReason); that file is not on this branch's base, so the
 * string is matched here. Share isBotWallReason once both are merged.
 */
export const BOT_WALL_REASON = "capture blocked: a bot or security check stood in for the site";

/** The rows the door writes (their groups in ./store.mjs GROUPS). */
export const DOOR_GROUPS = ["door_not_portfolio", "door_strong_signals", "door_held"];
const DOOR_SQL = DOOR_GROUPS.map((g) => `'${g}'`).join(", ");

const parse = (v) => {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

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

/** What the owner and the rules said before about a site, for the door. */
async function history(db, url) {
  const rows = (
    await db.execute({ sql: `SELECT * FROM status_reviews WHERE url = ? AND grp IN (${DOOR_SQL}) ORDER BY id`, args: [url] })
  ).rows.map(reviewOf);
  return {
    takenBack: rows.some((r) => r.undoneAt || (r.status === "rejected" && r.proposed === "remove")),
    pending: rows.find((r) => r.status === "pending") ?? null,
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
export function doorDecision({ grade, owner = null, rule = null, takenBack = false, previous = null, row, autoApply = true }) {
  if (owner) return { outcome: "owner", grade: ownerGrade(grade, owner) };
  if (aiSaysPortfolio(grade)) return { outcome: "portfolio", grade };
  const base = unguarded(grade);
  const sig = signalsOf(row, grade);
  const junk = junkCheck({ url: row.url, name: row.name, page_text: row.page_text });
  const said = `Gemini said this is not a portfolio${sig.known ? `; the code found ${sig.score} of ${SIGNAL_NAMES.length} portfolio signals` : ""}${junk.junk ? ` and a junk rule fired (${junk.rule})` : ""}.`;
  // Anything the owner or a rule said before wins over a removal by the rule.
  const earlier =
    takenBack
      ? "You undid or rejected an earlier automatic removal of this site, so the rule never removes it again."
      : rule?.isPortfolio
        ? `A rule (${rule.by}) listed it as a portfolio on ${String(rule.at).slice(0, 10)}.`
        : previous && previous.is_portfolio !== false && !guardedForReview(previous)
          ? `An earlier grade (${String(previous.judged_at ?? "").slice(0, 10) || "date unknown"}) said it is a portfolio.`
          : null;
  if (earlier) {
    return { outcome: "held", group: "door_held", grade: held(base, `${said} ${earlier} It stays listed until the owner decides.`), why: `${said} ${earlier}`, sig, junk, auto: false };
  }
  if (!junk.junk && sig.score >= STRONG_SIGNALS) {
    const kept = guardVerdict(base, { ...(grade?.facts?.signals ?? {}), score: sig.score, ...Object.fromEntries(sig.names.map((n) => [n, true])) });
    return { outcome: "strong_signals", group: "door_strong_signals", grade: kept, why: `${said} It stays listed until the owner decides.`, sig, junk, auto: false };
  }
  return {
    outcome: "remove",
    group: "door_not_portfolio",
    // Held until the rule applies the removal, so Undo brings back a listed site.
    grade: held(base, `${said} ${autoApply ? "Removed automatically by the rule" : "The rule removes it once REVIEW_AUTO_APPLY is on"}; Undo on /admin/review puts it back.`),
    why: said,
    sig,
    junk,
    auto: true,
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
          is_portfolio: false,
          reason,
          scores: { visual_design: gemini?.visual_design?.score, writing: gemini?.writing?.score },
        },
      },
      model: gemini?.model ?? null,
      prompt: gemini?.rubric_version ? `grade-v${gemini.rubric_version}` : undefined,
    },
    signals: { score: d.sig.score, names: d.sig.names, junk_rule: d.junk.junk ? d.junk.rule : null, capture: {}, door: { auto: d.auto, outcome: d.outcome } },
    created_at: now.toISOString(),
  };
}

async function insertReview(db, r) {
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, shot_key, verdicts, signals, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?) ON CONFLICT(batch, url) DO NOTHING`,
    args: [r.batch, r.url, r.grp, r.current, r.proposed, r.agreed, r.reason, r.shot_key, JSON.stringify(r.verdicts), JSON.stringify(r.signals), r.created_at],
  });
  const row = (await db.execute({ sql: "SELECT * FROM status_reviews WHERE batch = ? AND url = ?", args: [r.batch, r.url] })).rows[0];
  return row ? reviewOf(row) : null;
}

/**
 * The door for one grade (pipeline/night.mjs gradeItem). `grade`: Gemini's
 * grade (gradeRecord); `row`: the site (url, name, shot_key, page_text,
 * facts, signals, ai_rubric). `write(grade)` stores the grade (ranked, with
 * history) and resolves when it is written. Returns { outcome, reviewId,
 * applied } where outcome is that of doorDecision, or "review" for a removal
 * that waits (REVIEW_AUTO_APPLY off, or a pending row already open).
 */
export async function atTheDoor(db, { grade, row, night, now, autoApply, write, rank }) {
  await ensureReviewSchema(db);
  const url = String(row.url);
  const previous = parse(row.ai_rubric);
  const [owner, rule, past] = await Promise.all([ownerVerdict(db, url), ruleVerdict(db, url), history(db, url)]);
  const d = doorDecision({ grade, owner, rule, takenBack: past.takenBack, previous: previous && !previous.error ? previous : null, row, autoApply });
  await write(d.grade);
  if (d.outcome === "owner" || d.outcome === "portfolio") return { outcome: d.outcome, reviewId: null, applied: false };
  // One open case per site: a pending row already asks the owner.
  if (past.pending) return { outcome: d.outcome === "remove" ? "review" : d.outcome, reviewId: past.pending.id, applied: false, pendingBefore: true };
  const review = await insertReview(db, reviewRowOf(d, { url, shotKey: row.shot_key, batch: `door:${night}`, now, gemini: grade }));
  if (!review) return { outcome: d.outcome, reviewId: null, applied: false };
  if (d.outcome !== "remove") return { outcome: d.outcome, reviewId: review.id, applied: false };
  if (!autoApply) return { outcome: "review", reviewId: review.id, applied: false };
  const r = await applyByRule(db, review, { actor: DOOR_RULE_ACTOR, now, ...(rank ? { rank } : {}) });
  return { outcome: r?.ok ? "remove" : "review", reviewId: review.id, applied: Boolean(r?.ok), error: r && !r.ok ? r.error : undefined };
}

/**
 * The night's free part: rows for bot-walled sites (#235's marker) and for
 * listed, graded sites whose signals collapsed, one open case per site.
 * Returns { botWall: [url], collapsed: [url] }.
 */
export async function syncReviewRows(db, { now, limit = 200 }) {
  await ensureReviewSchema(db);
  const at = now.toISOString();
  const open = `NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url AND r.status = 'pending')`;
  const walled = (
    await db.execute({
      sql: `SELECT p.url FROM portfolios p
            WHERE p.status = 'error' AND p.reason = ? AND p.delisted_at IS NULL AND ${open}
              AND NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url AND r.grp = 'bot_wall')
            ORDER BY p.url LIMIT ?`,
      args: [BOT_WALL_REASON, limit],
    })
  ).rows.map((r) => String(r.url));
  for (const url of walled) {
    await insertReview(db, {
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
              AND COALESCE(json_extract(p.ai_rubric, '$.review.kind'), '') NOT IN ('strong_signals', 'held_for_owner')
              AND ${open}
              AND NOT EXISTS (SELECT 1 FROM status_reviews r WHERE r.url = p.url AND r.grp = 'signals_collapsed'
                              AND r.created_at >= COALESCE(json_extract(p.signals, '$.checked_at'), ''))
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
    const row = await insertReview(db, {
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
    if (row) done.push(String(r.url));
  }
  return { botWall: walled, collapsed: done };
}
