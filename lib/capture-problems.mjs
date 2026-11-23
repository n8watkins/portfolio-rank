// Capture problems (owner, 2026-11-22): every listed site whose capture
// failed, is bad, or got worse, in one list for the admin's Capture problems
// page (app/admin/(tools)/capture-problems) and one line of the nightly owner
// alert (worker/night.ts). Four groups, each with its own rule:
//
//   A  refresh failed, old capture kept: a refresh_failures row
//      (pipeline/capture.mjs recordRefreshFailure) of a listed, live site,
//      with its reason, attempts, when it failed and when it is tried again.
//   B  first capture failed: a listed site with no good capture
//      (portfolios.status error, dead or parked), with its reason, attempts
//      and retry date.
//   C  the stored capture itself is bad: a listed, live, captured site whose
//      stored page text reads as a bot or security check (the capture's own
//      isBotWallPage, pipeline/capture-blocked.mjs), or is empty, or under
//      SHORT_TEXT characters. A capture with no page_text at all (NULL: made
//      before the capture stored page text, #57 on 2026-11-10) was never
//      measured, so it is not in C; it is counted apart (`unmeasured`).
//   D  got worse on a re-capture: an open capture_changes row of a listed
//      site (lib/pipeline-schema.mjs): the new capture lost a portfolio sign the
//      old one had (resume, github, contact in portfolios.facts), or its text
//      fell under TEXT_DROP_RATIO of an old text over TEXT_DROP_MIN_OLD
//      characters. Only facts of the same measuring version (facts.v) are
//      compared; a change that came with a version change is the measuring
//      code's, listed apart (`measuring`) and never counted.
//
// A site the health check marks down or suspect is not a capture problem: its
// state is shown on each row (health), never as a group of its own. Whether
// a site is on the owner's review list is whether it has an open (pending)
// status_reviews row, never portfolios.needs_review alone: the weekly health
// check rewrites that flag for every site whose page loaded.
//
// Plain JavaScript: the app (Workers), the night and the capture job share it.
import { isBotWallPage, BOT_CHECK_MAX_WORDS } from "../pipeline/capture-blocked.mjs";
import { CAPTURE_CHANGE_TABLES, applyTables } from "./pipeline-schema.mjs";
import { storedMs } from "./stored-time.mjs";

/** Stored text shorter than this many characters is a bad capture (group C). */
export const SHORT_TEXT = 200;
/** A re-capture's text under this share of the old text is worse (group D)... */
export const TEXT_DROP_RATIO = 0.3;
/** ...when the old text was over this many characters. */
export const TEXT_DROP_MIN_OLD = 500;
/** The portfolio signs a re-capture must not lose (portfolios.facts). */
export const SIGNS = ["resume", "github", "contact"];
/** What a lost text is called in capture_changes.lost. */
export const TEXT_LOST = "text";

export const GROUPS = ["A", "B", "C", "D"];

export async function ensureCaptureProblemSchema(db) {
  await applyTables(db, CAPTURE_CHANGE_TABLES);
}

/** A JSON column as an object, or null. */
function parse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

const signsOf = (facts) => Object.fromEntries(SIGNS.map((k) => [k, facts?.[k] === true ? true : facts?.[k] === false ? false : null]));
const versionOf = (facts) => (facts && Number.isFinite(Number(facts.v)) && facts.v != null ? Number(facts.v) : null);

/**
 * What a re-capture lost against the capture before it, or null when it lost
 * nothing. `prev` and `next` are { facts, chars }: the facts object (or null
 * when none was measured) and the stored text's length in characters.
 *   - A sign (SIGNS) counts as lost when the old facts say true and the new
 *     ones say false; a new capture without facts keeps the old ones
 *     (pipeline/capture.mjs), so it loses none.
 *   - The text counts as lost when the old text was over TEXT_DROP_MIN_OLD
 *     characters and the new one is under TEXT_DROP_RATIO of it.
 * Returns { lost, measuring, oldV, newV, oldSigns, newSigns, oldChars, newChars }:
 * `measuring` is true when both have facts of different versions (facts.v):
 * the measuring code changed, not the site.
 */
export function captureChange(prev, next) {
  const oldFacts = parse(prev?.facts);
  const newFacts = parse(next?.facts);
  const oldV = versionOf(oldFacts);
  const newV = versionOf(newFacts);
  const oldSigns = signsOf(oldFacts);
  const newSigns = newFacts ? signsOf(newFacts) : oldSigns;
  const lost = newFacts ? SIGNS.filter((k) => oldSigns[k] === true && newSigns[k] === false) : [];
  const oldChars = prev?.chars == null ? null : Number(prev.chars);
  const newChars = next?.chars == null ? null : Number(next.chars);
  if (oldChars != null && newChars != null && oldChars > TEXT_DROP_MIN_OLD && newChars < oldChars * TEXT_DROP_RATIO) lost.push(TEXT_LOST);
  if (!lost.length) return null;
  const measuring = Boolean(oldFacts && newFacts && oldV !== newV);
  return { lost, measuring, oldV, newV, oldSigns, newSigns, oldChars, newChars };
}

/**
 * Records what a new good capture did to a site that had one before
 * (pipeline/capture.mjs, after the new capture is stored). `prev` is the
 * stored capture it replaced ({ facts, chars }), `next` the new one. The
 * comparison's baseline is the site's open same-version record when there is
 * one (its old values: a sign lost two captures ago is still lost), else
 * `prev`. Then:
 *   - nothing lost: the open record, if any, is cleared (the site got it back);
 *   - lost, same version: the open record is updated, or one is written;
 *   - lost, with a version change: any open record is cleared and a
 *     `measuring` one written (shown apart, not a problem).
 * Returns "cleared", "recorded", "measuring" or null (nothing to do).
 */
export async function recordCaptureChange(db, { url, prev, next, capturedAt = null, now = Date.now() }) {
  const open = (
    await db.execute({ sql: "SELECT id, measuring, old_v, old_signs, old_chars FROM capture_changes WHERE url = ? AND cleared_at IS NULL ORDER BY id DESC LIMIT 1", args: [url] })
  ).rows[0];
  const sameKind = open && Number(open.measuring) === 0;
  // An open record's old values stand in for the facts they came from (only the signs and the version are compared).
  const baseline = sameKind
    ? { facts: { ...(parse(open.old_signs) ?? {}), ...(open.old_v == null ? {} : { v: Number(open.old_v) }) }, chars: open.old_chars == null ? null : Number(open.old_chars) }
    : prev;
  const change = captureChange(baseline, next);
  const clear = (id) => ({ sql: "UPDATE capture_changes SET cleared_at = ? WHERE id = ?", args: [now, id] });
  if (!change) {
    if (!open) return null;
    await db.execute(clear(open.id));
    return "cleared";
  }
  const values = [now, capturedAt, change.oldV, change.newV, JSON.stringify(change.oldSigns), JSON.stringify(change.newSigns), change.oldChars, change.newChars, JSON.stringify(change.lost), change.measuring ? 1 : 0];
  const insert = {
    sql: `INSERT INTO capture_changes (url, at, captured_at, old_v, new_v, old_signs, new_signs, old_chars, new_chars, lost, measuring)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [url, ...values],
  };
  if (sameKind && !change.measuring) {
    await db.execute({
      sql: `UPDATE capture_changes SET at = ?, captured_at = ?, old_v = ?, new_v = ?, old_signs = ?, new_signs = ?, old_chars = ?, new_chars = ?, lost = ?, measuring = ? WHERE id = ?`,
      args: [...values, open.id],
    });
    return "recorded";
  }
  await db.batch(open ? [clear(open.id), insert] : [insert], "write");
  return change.measuring ? "measuring" : "recorded";
}

// ---------------------------------------------------------------------------
// Reasons in plain words
// ---------------------------------------------------------------------------

const PHONE = " (phone view)";
const PLAIN = [
  [/^capture blocked: a bot or security check stood in for the site/, "bot", "A bot or security check stood in for the site."],
  [/^capture blocked: still a gate or loader/, "cover", "A gate or loader still covered the page after we clicked through."],
  [/^capture blocked: still a dialog on top/, "cover", "A dialog still covered the page after we tried to close it."],
  [/^capture blocked: still a mode picker/, "cover", "A mode picker still covered the page after we picked one."],
  [/^capture blocked: a blank screen/, "blank", "A blank screen: no text and nothing drawn."],
  [/^capture blocked: (\d+) words and no outbound links/, "words", (m) => `Only ${m[1]} words on the page and no links to other sites.`],
  [/^needs owner review: only a canvas, video or image/, "media", "Only a canvas, video or image, with no text or links."],
  [/^needs owner review: the page shows a site but answered with an error status(?: \(HTTP (\d+)\))?/, "noanswer", (m) => `The page shows a site but answered with an error${m[1] ? ` (HTTP ${m[1]})` : ""}.`],
  [/^renders blank/, "blank", "The page rendered blank."],
  [/^HTTP (\d+) \(rate limited\)/, "noanswer", (m) => `The site turned us away for now (HTTP ${m[1]}, rate limited).`],
  [/^HTTP (\d+)/, "noanswer", (m) => `The site answered with an error (HTTP ${m[1]}).`],
  [/^capture timed out after (\d+)s/, "ours", (m) => `Our capture timed out after ${Math.round(Number(m[1]) / 60) || 1} minutes.`],
  [/^the browser crashed on this site/, "ours", "Our browser crashed on this site, also when it was captured alone."],
  [/^redirects to (.+)/, "noanswer", (m) => `It redirects to ${m[1]}, a parked domain.`],
  [/^parking phrase/, "noanswer", "The page reads as a parked domain."],
];

/**
 * A stored failure reason in plain words: { text, kind, phoneOnly, raw }.
 * A refresh's reason starts with its status ("error: ..."); a reason marked
 * "(phone view)" was seen only on the capture's second, phone-size visit,
 * after the desktop view showed the site. `kind`: bot, cover, media, words,
 * blank, noanswer, ours or other.
 */
export function plainReason(raw) {
  let r = String(raw ?? "").trim();
  const status = r.match(/^(error|dead|parked|pending): /);
  if (status) r = r.slice(status[0].length);
  const phoneOnly = r.endsWith(PHONE);
  if (phoneOnly) r = r.slice(0, -PHONE.length);
  for (const [re, kind, say] of PLAIN) {
    const m = r.match(re);
    if (!m) continue;
    const text = typeof say === "function" ? say(m) : say;
    return {
      text: phoneOnly ? `${text.replace(/\.$/, "")}, only on our second visit at phone size; the desktop view showed the site.` : text,
      kind,
      phoneOnly,
      raw: String(raw ?? ""),
    };
  }
  const text = r ? `${r.charAt(0).toUpperCase()}${r.slice(1)}${/[.!?)]$/.test(r) ? "" : "."}` : "No reason recorded.";
  return { text: phoneOnly ? `${text} (only on the phone-size visit)` : text, kind: status?.[1] === "dead" ? "noanswer" : "other", phoneOnly, raw: String(raw ?? "") };
}

// ---------------------------------------------------------------------------
// The groups
// ---------------------------------------------------------------------------

/** The portfolios columns every row shows, on the row aliased `p`. */
const SITE = (p = "p") => `${p}.name, ${p}.status, ${p}.shot_key, ${p}.captured_at, ${p}.ai_rubric, ${p}.health, ${p}.health_reason,
  ${p}.delisted_at,
  (SELECT MAX(r.id) FROM status_reviews r WHERE r.url = ${p}.url AND r.status = 'pending') AS review_id`;

const str = (v) => (v == null ? null : String(v));
const iso = (ms) => (ms == null || !Number.isFinite(Number(ms)) ? null : new Date(Number(ms)).toISOString());
/** A stored SQLite or ISO time as ISO 8601, or null. */
const isoOf = (v) => {
  const ms = storedMs(v);
  return ms == null ? null : new Date(ms).toISOString();
};

/** What Gemini's grade says, for a row: { state: none | portfolio | not_portfolio | failed, tier }. */
export function gradeOf(aiRubric) {
  const g = parse(aiRubric);
  if (!g) return { state: "none", tier: null };
  if (g.error) return { state: "failed", tier: null };
  const tier = typeof g.tier === "string" && g.tier ? g.tier : null;
  if (g.is_portfolio === false || g.is_portfolio === 0) return { state: "not_portfolio", tier };
  return { state: "portfolio", tier };
}

/** The columns every group's row has. */
function siteOf(r) {
  const shotKey = str(r.shot_key);
  return {
    url: String(r.url),
    name: str(r.name) ?? "",
    status: str(r.status),
    listed: r.status != null && r.delisted_at == null,
    shotKey,
    capturedAt: shotKey ? isoOf(r.captured_at) : null,
    grade: gradeOf(r.ai_rubric),
    health: str(r.health),
    healthReason: str(r.health_reason),
    // An open review row is the record (see the header); the flag alone is not.
    onReview: r.review_id != null,
    reviewId: r.review_id == null ? null : Number(r.review_id),
  };
}

/** Group A: the refresh_failures rows of listed, live sites, newest failure first. */
export async function refreshFailureRows(db) {
  const res = await db.execute(`SELECT f.url, f.attempts, f.failed_at, f.retry_at, f.reason, ${SITE("p")}
    FROM refresh_failures f JOIN portfolios p ON p.url = f.url
    WHERE p.status = 'live' AND p.delisted_at IS NULL
    ORDER BY f.failed_at DESC, f.url`);
  return res.rows.map((r) => ({
    group: "A",
    ...siteOf(r),
    reason: plainReason(r.reason),
    attempts: Number(r.attempts ?? 0),
    at: iso(r.failed_at),
    retryAt: iso(r.retry_at),
  }));
}

/** Group B: listed sites with no good capture (status error, dead or parked), newest check first. */
export async function firstCaptureFailureRows(db) {
  const res = await db.execute(`SELECT p.url, p.reason, p.capture_attempts, p.retry_at, p.checked_at, ${SITE("p")}
    FROM portfolios p
    WHERE p.status IN ('error', 'dead', 'parked') AND p.delisted_at IS NULL
    ORDER BY p.checked_at DESC, p.url`);
  return res.rows.map((r) => ({
    group: "B",
    ...siteOf(r),
    reason: plainReason(`${r.status}: ${r.reason ?? ""}`),
    attempts: Number(r.capture_attempts ?? 0),
    at: isoOf(r.checked_at),
    retryAt: isoOf(r.retry_at),
  }));
}

/**
 * Whitespace characters in the text column `col`, in SQL. A stored text is
 * normalized (pipeline/rubric.mjs normalizePageText: one space or newline
 * between words), so a page of BOT_CHECK_MAX_WORDS words has about that
 * many; WS_SLACK times as many leaves room for older, unnormalized rows. It
 * only narrows what is read: isBotWallPage decides.
 */
const WS_SQL = (col) => `(length(${col}) - length(replace(replace(replace(${col}, ' ', ''), char(10), ''), char(9), '')))`;
const WS_SLACK = 4;

/**
 * Why a stored capture is bad (group C), or null. `row` has page_text and
 * facts. No page_text at all (NULL) is not measured, not bad: null too.
 */
export function badStoredCapture(row) {
  if (row.page_text == null) return null;
  if (String(row.page_text).trim() === "") return { text: "The capture read no text on the page.", kind: "words" };
  const text = String(row.page_text);
  const facts = parse(row.facts) ?? {};
  // The same reading of the stored facts as lib/reviews/stored-capture.mjs.
  if (isBotWallPage({ text, title: "", siteLinks: Number(facts.internal_pages) || 0, contactLinks: facts.contact === true ? 1 : 0 })) {
    return { text: "The stored page text reads as a bot or security check.", kind: "bot" };
  }
  const n = text.trim().length;
  if (n < SHORT_TEXT) return { text: `Only ${n} characters of page text were stored.`, kind: "words" };
  return null;
}

/** Group C: listed, live, captured sites whose stored capture is bad (badStoredCapture), newest capture first. */
export async function badStoredCaptureRows(db) {
  const res = await db.execute({
    sql: `SELECT p.url, p.page_text, p.facts, ${SITE("p")}
      FROM portfolios p
      WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND p.delisted_at IS NULL
        AND p.page_text IS NOT NULL AND (length(trim(p.page_text)) < ? OR ${WS_SQL("p.page_text")} <= ?)
      ORDER BY p.captured_at DESC, p.url`,
    args: [SHORT_TEXT, BOT_CHECK_MAX_WORDS * WS_SLACK],
  });
  const out = [];
  for (const r of res.rows) {
    const why = badStoredCapture(r);
    if (!why) continue;
    const site = siteOf(r);
    out.push({ group: "C", ...site, reason: { text: why.text, kind: why.kind, phoneOnly: false, raw: "" }, attempts: null, at: site.capturedAt, retryAt: null });
  }
  return out;
}

/** Listed, live, captured sites with no stored page text (NULL): captured before #57, never measured, not in group C. */
export async function unmeasuredCaptureCount(db) {
  const res = await db.execute(`SELECT COUNT(*) AS n FROM portfolios p
    WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND p.delisted_at IS NULL AND p.page_text IS NULL`);
  return Number(res.rows[0]?.n ?? 0);
}

const SIGN_WORDS = { resume: "résumé", github: "GitHub", contact: "contact" };

/** A capture_changes row's loss in plain words. */
export function lossText(row) {
  const lost = parse(row.lost) ?? [];
  const signs = lost.filter((k) => k !== TEXT_LOST).map((k) => SIGN_WORDS[k] ?? k);
  const parts = [];
  if (signs.length) parts.push(`lost its ${signs.join(", ").replace(/, ([^,]*)$/, " and $1")} link${signs.length === 1 ? "" : "s"}`);
  if (lost.includes(TEXT_LOST)) parts.push(`kept ${Number(row.new_chars ?? 0).toLocaleString("en-US")} of ${Number(row.old_chars ?? 0).toLocaleString("en-US")} characters of text`);
  const say = `The new capture ${parts.join(" and ")}.`;
  if (Number(row.measuring) !== 1) return say;
  return `${say} It came with new measuring code (facts v${row.old_v ?? "?"} to v${row.new_v ?? "?"}), so it is the code, not the site.`;
}

/** Group D (and the measuring-code changes beside it): open capture_changes rows, newest first. */
export async function worseCaptureRows(db) {
  const res = await db.execute(`SELECT c.url, c.at, c.lost, c.old_chars, c.new_chars, c.old_v, c.new_v, c.measuring, ${SITE("p")}
    FROM capture_changes c JOIN portfolios p ON p.url = c.url
    WHERE c.cleared_at IS NULL AND p.delisted_at IS NULL
    ORDER BY c.at DESC, c.id DESC`);
  const rows = res.rows.map((r) => ({
    group: "D",
    ...siteOf(r),
    reason: { text: lossText(r), kind: Number(r.measuring) === 1 ? "measuring" : "worse", phoneOnly: false, raw: "" },
    lost: parse(r.lost) ?? [],
    measuring: Number(r.measuring) === 1,
    attempts: null,
    at: iso(r.at),
    retryAt: null,
  }));
  return { worse: rows.filter((r) => !r.measuring), measuring: rows.filter((r) => r.measuring) };
}

/** A read of a table that may not exist yet (a database migrated before it): no rows. */
async function orNone(read, empty) {
  try {
    return await read();
  } catch (e) {
    if (/no such (table|column)/i.test(String(e?.message ?? e))) return empty;
    throw e;
  }
}

/**
 * Every group: { A, B, C, D, measuring, counts, sites, unmeasured }. `counts`
 * has one number per group (a site can be in more than one); `sites` is the
 * number of different sites across the four groups, each counted once;
 * `measuring` lists the changes that came with new measuring code, which are
 * not counted; `unmeasured` is how many live captures have no stored page
 * text to check (unmeasuredCaptureCount), not counted either.
 */
export async function captureProblems(db) {
  const [A, B, C, d, unmeasured] = await Promise.all([
    orNone(() => refreshFailureRows(db), []),
    orNone(() => firstCaptureFailureRows(db), []),
    orNone(() => badStoredCaptureRows(db), []),
    orNone(() => worseCaptureRows(db), { worse: [], measuring: [] }),
    orNone(() => unmeasuredCaptureCount(db), 0),
  ]);
  const sites = new Set([...A, ...B, ...C, ...d.worse].map((r) => r.url)).size;
  return { A, B, C, D: d.worse, measuring: d.measuring, counts: { A: A.length, B: B.length, C: C.length, D: d.worse.length }, sites, unmeasured };
}

// ---------------------------------------------------------------------------
// The nightly owner alert line
// ---------------------------------------------------------------------------

export const ALERT_KEY = "capture-problems";
export const PAGE_PATH = "/admin/capture-problems";
export const GROUP_LABELS = {
  A: "Refresh failed, old capture kept",
  B: "First capture failed",
  C: "Stored capture is bad",
  D: "Got worse on a re-capture",
};

const countsLine = (c) => GROUPS.map((g) => `${g} ${c[g]}`).join(" · ");
/** The counts an earlier alert title carries (alertTitle), or null. */
export function countsOfTitle(title) {
  const m = String(title ?? "").match(/A (\d+) · B (\d+) · C (\d+) · D (\d+)/);
  return m ? { A: Number(m[1]), B: Number(m[2]), C: Number(m[3]), D: Number(m[4]) } : null;
}

/** The alert's title: one line with the count of each group. */
export function alertTitle(counts) {
  return `Capture problems: ${countsLine(counts)}`;
}

const ZERO = Object.freeze({ A: 0, B: 0, C: 0, D: 0 });
/** Counts per group from a stored JSON object, or null. */
const countsOf = (v) => {
  const o = parse(v);
  return o && GROUPS.every((g) => Number.isFinite(Number(o[g]))) ? Object.fromEntries(GROUPS.map((g) => [g, Number(o[g])])) : null;
};

/**
 * What tonight's counts are compared with (per group), from the alert's
 * owner_alerts row (`alert`: sent_title, sends, cleared_at, or null) and the
 * capture_problem_alert row (`state`: low, sends, or null). Pure.
 *   - No email sent yet, or the alert cleared since (every count reached
 *     zero): zero, so a problem that reappears is emailed.
 *   - An email went out since the state was written (owner_alerts.sends
 *     moved): that email's counts (countsOfTitle of sent_title).
 *   - Otherwise the lowest count per group since the last email (state.low),
 *     so a count that falls and then rises again is emailed.
 */
export function alertBaseline(alert, state) {
  if (!alert || alert.cleared_at != null || !alert.sent_title) return { ...ZERO };
  const sent = countsOfTitle(alert.sent_title) ?? { ...ZERO };
  if (!state || Number(state.sends) !== Number(alert.sends ?? 0)) return sent;
  return countsOf(state.low) ?? sent;
}

/**
 * The night's capture-problems alert (pipeline/alerts.mjs reconcileAlerts):
 * one condition with the count of open problems per group and the page's
 * link while any count is above zero, and none once every count is zero (the
 * alert clears). It is emailed only on a night a group's count rose above
 * `baseline` (alertBaseline: the lowest count since the last email, zero
 * after a clear); the other nights it is `quiet`: recorded and shown to the
 * admin, not emailed. About 100 old re-capture failures in group A must not
 * mean an email every night.
 */
export function captureProblemCondition(counts, baseline, siteUrl = "") {
  const total = GROUPS.reduce((n, g) => n + counts[g], 0);
  if (total === 0) return [];
  const told = baseline ?? ZERO;
  const rose = GROUPS.filter((g) => counts[g] > told[g]);
  const page = `${String(siteUrl ?? "").replace(/\/+$/, "")}${PAGE_PATH}`;
  // Said only against a baseline with something in it (not a first email, or one after a clear).
  const since =
    rose.length && GROUPS.some((g) => told[g] > 0) ? ` Up since the last email (from the lowest count since): ${rose.map((g) => `${g} ${told[g]} to ${counts[g]}`).join(", ")}.` : "";
  return [
    {
      key: ALERT_KEY,
      kind: "problem",
      title: alertTitle(counts),
      detail: `${GROUPS.map((g) => `${g}. ${GROUP_LABELS[g]}: ${counts[g]}`).join("; ")}.${since}\n${page}`,
      quiet: rose.length === 0,
      repeats: false,
    },
  ];
}

/**
 * captureProblemCondition for the database's problems now, against
 * alertBaseline; then stores the new lowest counts (each group's lower of the
 * baseline and tonight's) with the alert's sends, for the next night. A
 * night whose email goes out moves sends, so the next night starts from that
 * email's counts; one whose email failed keeps the baseline and tries again.
 */
export async function captureProblemConditions(db, { siteUrl = "", now = Date.now() } = {}) {
  await ensureCaptureProblemSchema(db);
  const { counts } = await captureProblems(db);
  const alert = await orNone(async () => (await db.execute({ sql: "SELECT sent_title, sends, cleared_at FROM owner_alerts WHERE key = ?", args: [ALERT_KEY] })).rows[0] ?? null, null);
  const state = (await db.execute({ sql: "SELECT low, sends FROM capture_problem_alert WHERE k = ?", args: [ALERT_KEY] })).rows[0] ?? null;
  const baseline = alertBaseline(alert, state);
  const low = Object.fromEntries(GROUPS.map((g) => [g, Math.min(baseline[g], counts[g])]));
  await db.execute({
    sql: `INSERT INTO capture_problem_alert (k, low, sends, at) VALUES (?, ?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET low = excluded.low, sends = excluded.sends, at = excluded.at`,
    args: [ALERT_KEY, JSON.stringify(low), Number(alert?.sends ?? 0), now],
  });
  return captureProblemCondition(counts, baseline, siteUrl);
}

/**
 * captureProblemConditions for the night's owner alerts (worker/night.ts),
 * where its failure must not hold up the other alerts: { conditions,
 * failed }. A failure is passed to `log` (the error's message) and gives no
 * conditions; the caller leaves the alert as it was instead of clearing it.
 * @param {{ execute: Function }} db
 * @param {{ siteUrl?: string, log?: (error: string) => void }} [options]
 */
export async function captureProblemConditionsOrLog(db, { siteUrl = "", log = () => {} } = {}) {
  try {
    return { conditions: await captureProblemConditions(db, { siteUrl }), failed: false };
  } catch (e) {
    log(String(e?.message ?? e).slice(0, 200));
    return { conditions: [], failed: true };
  }
}
