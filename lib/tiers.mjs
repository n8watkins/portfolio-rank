// Tiers by rank (owner decisions 2026-11-12): the tier letter a portfolio
// shows comes from where it ranks in the graded library, not from the
// letter Gemini picks. Gemini's own letter (grade.tier) stays in the stored
// grade: it still seeds the leaderboard's ratings (lib/ranking/engine.mjs)
// and breaks ties here, but it is never shown as the tier any more.
//
// How a portfolio is ranked, in plain words:
//   1. Its score (0-100): the five AI scores, averaged with the rubric's
//      weights (pipeline/rubric.mjs quality_score, 1-5, put on 0-100), count
//      for 80%; the code checks (resume, GitHub, contact, project links that
//      load, own domain, fresh footer, not a known template: checks_score,
//      0-100) count for 20%. A grade from before the code checks existed
//      counts the typical checks result (CHECKS_WHEN_UNKNOWN).
//   2. The library is put in one full order: score, then Gemini's own letter
//      (S above A ...), then people's ELO, then the address (a stable id),
//      so no two portfolios share a place.
//   3. The top places are counts: the first 3 are SSS and places 4 to 10
//      S+, exactly, whatever the ties.
//   4. The rest go by share of the library, where equal scores (with the
//      same Gemini letter) share a place, the middle of their group, and so
//      a tier: S down to the top 0.5%, S- to the top 1%; then A+, A and A-
//      split 1% to 15% in thirds, B+, B and B- split 15% to 70%, C+, C and
//      C- split 70% to 85%, and D is the bottom 15%.
//   5. A small library can't hand out tiers it has no room for: the count
//      tiers need COUNT_TIERS_MIN graded portfolios, and a share tier is
//      only given when its band holds at least one whole portfolio;
//      otherwise the next tier toward B.
//
// A tier's family is its letter (S, A, B, C, D; SSS counts as S): boards
// and filters group by family, the badge shows the plus or minus.
//
// The library is the listed, healthy, graded portfolios that are not
// flagged "not a portfolio" (the same pool "Grade my portfolio" compares
// against, lib/grader/report.mjs gradedPool). Everything here is pure: the
// database side is lib/tiers-store.mjs. No AI request is involved.
import { AI_CRITERIA } from "../pipeline/rubric.mjs";

// ---------------------------------------------------------------------------
// The owner's settings: change these to tune the tiers. A change takes
// effect at the next refresh (hourly, lib/tiers-store.mjs refreshTiers).
// ---------------------------------------------------------------------------

/**
 * The ladder, best first. A tier with `count` holds that many places in
 * total from the top (SSS the first 3, S+ up to place 10); a tier with `top`
 * reaches down to that "top N%" of the library. The plus and minus tiers
 * split their letter's band into thirds by rank.
 */
const third = (from, to, k) => Math.round((from + ((to - from) * k) / 3) * 1000) / 1000;
export const TIER_LADDER = [
  { tier: "SSS", count: 3, name: "Elite", note: "The top 3 portfolios." },
  { tier: "S+", count: 10, name: "Outstanding", note: "Places 4 to 10." },
  { tier: "S", top: 0.5, name: "Exceptional", note: "The rest of the top 0.5%." },
  { tier: "S-", top: 1, name: "Exceptional", note: "The rest of the top 1%." },
  { tier: "A+", top: third(1, 15, 1), name: "Strong", note: "1% to 15%, top third." },
  { tier: "A", top: third(1, 15, 2), name: "Strong", note: "1% to 15%, middle third." },
  { tier: "A-", top: 15, name: "Strong", note: "1% to 15%, bottom third." },
  { tier: "B+", top: third(15, 70, 1), name: "Solid", note: "15% to 70%, top third." },
  { tier: "B", top: third(15, 70, 2), name: "Solid", note: "15% to 70%, middle third." },
  { tier: "B-", top: 70, name: "Solid", note: "15% to 70%, bottom third." },
  { tier: "C+", top: 75, name: "Weak", note: "70% to 85%, top third." },
  { tier: "C", top: 80, name: "Weak", note: "70% to 85%, middle third." },
  { tier: "C-", top: 85, name: "Weak", note: "70% to 85%, bottom third." },
  { tier: "D", top: 100, name: "Needs work", note: "The bottom 15%." },
];

/** The letter families, best first, with what each means (boards and filters group by these). */
export const FAMILIES = [
  { family: "S", name: "Exceptional", note: "The top 1%." },
  { family: "A", name: "Strong", note: "1% to 15%." },
  { family: "B", name: "Solid", note: "15% to 70%." },
  { family: "C", name: "Weak", note: "70% to 85%." },
  { family: "D", name: "Needs work", note: "The bottom 15%." },
];

/** Bumped whenever the ladder changes, so stored report ranks are placed again (lib/tiers-store.mjs). */
export const LADDER_VERSION = 3;

/** The library needs at least this many graded portfolios before the count tiers (SSS, SS) are given. */
export const COUNT_TIERS_MIN = 100;

/** The last tier whose letter is shown publicly (SSS through B-); lower ones read "Graded, below the top tiers". */
export const PUBLIC_THROUGH = "B-";

/** The tier the share tiers fall back toward in a small library: the middle of the ladder. */
const MIDDLE = "B";

/** How much of the score each part makes up (they sum to 1). */
export const SCORE_WEIGHTS = { quality: 0.8, checks: 0.2 };

/** The checks score counted for a grade without code checks (rubric v1): about the library's median (87 on 2026-11-12). */
export const CHECKS_WHEN_UNKNOWN = 85;

// ---------------------------------------------------------------------------

/** Every tier, best first. */
export const TIERS = TIER_LADDER.map((t) => t.tier);
/** The tiers shown publicly, best first. */
export const PUBLIC_TIERS = TIERS.slice(0, TIERS.indexOf(PUBLIC_THROUGH) + 1);
/** What a lower tier says in public, instead of its letter. */
export const BELOW_TOP_TIERS = "Graded, below the top tiers";

/** Gemini's letters, which break ties (S above A ...). */
const AI_LETTER_VALUE = { S: 4, A: 3, B: 2, C: 1, D: 0 };

/** True for one of the tier letters (SSS to D). */
export const isTier = (t) => typeof t === "string" && TIERS.includes(t);
/** True for a tier whose letter is shown publicly. */
export const isPublicTier = (t) => typeof t === "string" && PUBLIC_TIERS.includes(t);
/** A tier as text people read: the minus as a real minus sign ("A−"), so it never looks like a dash or a hyphenation. */
export const tierLabel = (t) => (typeof t === "string" ? t.replace(/-$/, "\u2212") : t);
/** A tier's letter family: S for SSS and S+ to S-, then A, B, C, D; null for anything else. */
export const familyOf = (t) => (isTier(t) ? t[0] : null);
/** A tier's plus or minus: "+", "-" or "" (SSS and the plain letters have none). */
export const modifierOf = (t) => (isTier(t) && t !== "SSS" && t.length === 2 ? t[1] : "");
/** True when a tier is in `family` or a better one (atLeast("A+", "A") is true, atLeast("B+", "A") false). */
export const atLeast = (t, family) => {
  const i = TIERS.indexOf(t);
  if (i < 0) return false;
  const last = TIERS.reduce((at, x, k) => (familyOf(x) === family ? k : at), -1);
  return i <= last;
};
/** The tier's place on the ladder, 0 for SSS; -1 for anything else. */
export const tierIndex = (t) => TIERS.indexOf(t);
/** A tier as a number for averages and comparisons: D 1 up to SSS 7; null for anything else. */
export const tierValue = (t) => (isTier(t) ? TIERS.length - TIERS.indexOf(t) : null);
/** The tier nearest a value from tierValue (an average), or null. */
export const tierOfValue = (v) =>
  typeof v === "number" && Number.isFinite(v) ? TIERS[TIERS.length - Math.min(TIERS.length, Math.max(1, Math.round(v)))] : null;

/**
 * The tier a stored grade shows: its rank tier (grade.rank.tier, written by
 * lib/tiers-store.mjs), or null when it has none yet, is not a portfolio or
 * is an error sentinel. Never Gemini's own letter.
 */
export function tierOf(grade) {
  if (!grade || typeof grade !== "object" || grade.error || grade.is_portfolio === false) return null;
  const t = grade.rank?.tier;
  return isTier(t) ? t : null;
}

/** The AI quality score (1-5) of a grade: stored by rubric v2, else the weighted mean of the AI axes (v1 grades). */
export function qualityOf(grade) {
  if (typeof grade?.quality_score === "number") return grade.quality_score;
  let sum = 0;
  let of = 0;
  for (const c of AI_CRITERIA) {
    const v = grade?.[c.id];
    const s = typeof v === "number" ? v : v?.score;
    if (typeof s !== "number") continue;
    sum += s * c.weight;
    of += c.weight;
  }
  return of ? sum / of : null;
}

/**
 * A grade's score, 0-100 with two decimals, or null when the grade can't be
 * ranked (an error sentinel, no AI scores, or "not a portfolio").
 */
export function rankScore(grade) {
  if (!grade || typeof grade !== "object" || grade.error || grade.is_portfolio === false) return null;
  const q = qualityOf(grade);
  if (typeof q !== "number") return null;
  const quality = Math.min(100, Math.max(0, (q - 1) * 25));
  const checks = typeof grade.checks_score === "number" ? Math.min(100, Math.max(0, grade.checks_score)) : CHECKS_WHEN_UNKNOWN;
  return Math.round((SCORE_WEIGHTS.quality * quality + SCORE_WEIGHTS.checks * checks) * 100) / 100;
}

/**
 * The sort key of a grade: its score, then Gemini's letter, as one integer
 * (higher is better; equal keys are equal places). Null when unrankable.
 */
export function rankKey(grade) {
  const score = rankScore(grade);
  if (score == null) return null;
  const letter = AI_LETTER_VALUE[String(grade.tier ?? "").toUpperCase()] ?? 0;
  return Math.round(score * 100) * 10 + letter;
}

/** People's ELO for the tie-break: a site without a rating counts the starting 1200 (lib/elo). */
const ELO_DEFAULT = 1200;
const eloOf = (e) => (typeof e?.elo === "number" && Number.isFinite(e.elo) ? e.elo : ELO_DEFAULT);

/** The full order: score and Gemini's letter (the key), then ELO, then the address. Negative when `a` ranks above `b`. */
export function compareEntries(a, b) {
  return b.key - a.key || eloOf(b) - eloOf(a) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/**
 * The library in its full order, best first: `entries` are { url, key,
 * elo } (key from rankKey; entries without one are left out).
 */
export const orderLibrary = (entries) => entries.filter((e) => typeof e?.key === "number").sort(compareEntries);

const COUNT_TIERS = TIER_LADDER.filter((t) => t.count);
const SHARE_TIERS = TIER_LADDER.filter((t) => !t.count);

/** The place as a share of the library (0-100]: the middle of the portfolio's slot. */
const shareAt = (position, total) => (100 * (position - 0.5)) / total;

/** The count tier of a place (1 = best), or null when the place is past them or the library is too small. */
function countTierAt(place, total) {
  if (total < COUNT_TIERS_MIN) return null;
  return COUNT_TIERS.find((t) => place <= t.count)?.tier ?? null;
}

/**
 * The share tier at a position (the middle of a group of equals; may be
 * fractional) in a library of `total`. A share tier above B needs its band
 * ("top N%") to hold at least one portfolio, and one below B its bottom
 * share; otherwise the next tier toward B.
 */
export function tierAt(position, total) {
  if (!(total > 0)) return null;
  const share = shareAt(position, total);
  let i = SHARE_TIERS.findIndex((t) => share <= t.top);
  if (i < 0) i = SHARE_TIERS.length - 1;
  const mid = SHARE_TIERS.findIndex((t) => t.tier === MIDDLE);
  while (i < mid && (SHARE_TIERS[i].top * total) / 100 < 1) i++;
  while (i > mid && ((100 - SHARE_TIERS[i - 1].top) * total) / 100 < 1) i--;
  return SHARE_TIERS[i].tier;
}

/** "Top N%" for a position: whole percent, rounded up so it never claims more than the tier (1 at least). */
export const topPctAt = (position, total) => Math.max(1, Math.min(100, Math.ceil(shareAt(position, total) - 1e-9)));

/**
 * Every member's place in an ordered library (orderLibrary): url -> { tier,
 * top, place, position, total }. `place` is its own place in the full order
 * (what the count tiers use); `position` is the middle of its group of equal
 * keys (what the share tiers and "top N%" use).
 */
export function rankLibrary(order) {
  const out = new Map();
  const total = order.length;
  let i = 0;
  while (i < total) {
    let j = i;
    while (j < total && order[j].key === order[i].key) j++;
    const position = i + (j - i + 1) / 2;
    const shared = tierAt(position, total);
    for (let k = i; k < j; k++) {
      const place = k + 1;
      const counted = countTierAt(place, total);
      out.set(order[k].url, { tier: counted ?? shared, top: topPctAt(counted ? place : position, total), place, position, total });
    }
    i = j;
  }
  return out;
}

/**
 * Where a newcomer lands in an ordered library (a visitor's grade, a
 * delisted site, a grade just written), placed as if added: `entry` is {
 * url, key, elo }. Returns { tier, top, place, position, rank, total } or
 * null without a key.
 */
export function placeNew(order, input) {
  if (typeof input?.key !== "number") return null;
  // Without an address (a visitor's grade in the abstract), it loses a full tie.
  const entry = { ...input, url: input.url || "\uffff" };
  const total = order.length + 1;
  // Its place in the full order: everyone it doesn't beat is above it (binary search).
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (compareEntries(order[m], entry) < 0) lo = m + 1;
    else hi = m;
  }
  const place = lo + 1;
  let above = 0;
  let equal = 0;
  for (const e of order) {
    if (e.key > entry.key) above++;
    else if (e.key === entry.key) equal++;
    else break;
  }
  const position = above + (equal + 2) / 2;
  const counted = countTierAt(place, total);
  const tier = counted ?? tierAt(position, total);
  return { tier, top: topPctAt(counted ? place : position, total), place, position, rank: place, total };
}

/**
 * The stored rank of a newcomer's grade placed in a library: { tier, score,
 * top } (what lib/tiers-store.mjs writes into the grade as `rank`), or null.
 */
export function rankOf(grade, order, { url = "", elo = null } = {}) {
  const place = placeNew(order, { url, key: rankKey(grade), elo });
  return place ? { tier: place.tier, score: rankScore(grade), top: place.top } : null;
}

/** How many of a library get each tier: { tier: count }. */
export function distribution(order) {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const p of rankLibrary(order).values()) out[p.tier]++;
  return out;
}
