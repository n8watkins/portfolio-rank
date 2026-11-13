// Tiers by ELO (owner decisions 2026-11-12): the tier letter a portfolio
// shows is its place by its rating from face-off votes, not the AI grade.
// The Gemini grade is the report card (per-axis scores and notes, "how to
// improve", and the "not a portfolio" filter); it never sets the letter.
//
// How a portfolio gets its tier, in plain words:
//   1. Its rating ("the ELO") starts from automated checks (owner decision
//      2026-11-12): graded portfolios are put in order by points from saved
//      data (lib/check-points.mjs), and each one's starting rating comes from
//      its place, from MU + SEED_SPREAD down to MU - SEED_SPREAD, with the
//      high uncertainty of a fresh rating. No vote is invented.
//   2. Real face-offs refine it: a person's vote counts fully and an AI
//      comparison counts AI_VOTE_WEIGHT of one (lib/tiers-rating.mjs
//      replays them all). A portfolio without a starting rank (no grade)
//      stays at STARTING_TIER (B) until it has MIN_FACEOFFS face-offs.
//   3. Ranked portfolios are put in order by a cautious
//      rating: the rating minus RATING_CAUTION times its uncertainty, so a
//      portfolio with few face-offs needs a better record to rank as high.
//      That cautious rating, on a chess-like scale, is the ELO shown.
//   4. The S band is the top 1% of that order, by exact place: SSS the first
//      3, then S+, S and S- split the rest in thirds.
//   5. The rest go by share of that order (portfolios with the same rating
//      share a place, the middle of their group): A+, A and A- split 1% to
//      30% in thirds, B+, B and B- split 30% to 70%, C+, C and C- split 70%
//      to 85%, and D is the bottom 15%.
//   6. A small library can't hand out tiers it has no room for: the S band
//      needs COUNT_TIERS_MIN ranked portfolios, and a share tier is only
//      given when its band holds at least one whole portfolio; otherwise the
//      next tier toward B.
//
// A tier's family is its letter (S, A, B, C, D; SSS counts as S): boards
// and filters group by family, the badge shows the plus or minus.
//
// The library is the listed, healthy, graded portfolios that are not flagged
// "not a portfolio". Everything here is pure and safe in the browser: the
// replay of the face-offs is lib/tiers-rating.mjs, the database side
// lib/tiers-store.mjs. No AI request is involved.
import { MU, SIGMA_UNSURE } from "./ranking/config.mjs";

// ---------------------------------------------------------------------------
// The owner's settings: change these to tune the tiers. A change takes
// effect at the next refresh (hourly, lib/tiers-store.mjs refreshTiers).
// ---------------------------------------------------------------------------

/**
 * Starting ratings from automated checks: the best portfolio by points
 * starts at MU + SEED_SPREAD and the last at MU - SEED_SPREAD (the old AI
 * seeds' S to D range), evenly by place, each with the fresh uncertainty, so
 * real votes move it as fast as a new portfolio's.
 */
export const SEED_FROM_CHECKS = true;
export const SEED_SPREAD = 8;

/** Face-offs a portfolio without a starting rank needs before its tier moves off STARTING_TIER (an AI face-off counts AI_VOTE_WEIGHT of one). */
export const MIN_FACEOFFS = 10;

/**
 * What one AI head-to-head comparison counts, as a share of one person's
 * vote: in the rating and in the face-off count. Not yet confirmed by the
 * owner (2026-11-12): 0.25 is the proposed default.
 */
export const AI_VOTE_WEIGHT = 0.25;

/** The tier every portfolio shows until it has MIN_FACEOFFS face-offs: the middle of the ladder. */
export const STARTING_TIER = "B";

/**
 * How cautious the order is: portfolios are ranked by their rating minus
 * this many times its uncertainty (2: about 95% sure the true rating is at
 * least this high), so one with few face-offs needs a better record.
 */
export const RATING_CAUTION = 2;

/** The ELO everyone starts at, and how many ELO points one rating point is (about chess's scale: 400 points is roughly 10 to 1 odds). */
export const ELO_START = 1200;
export const ELO_PER_POINT = 30;

/**
 * The ladder, best first. The S band (`band: "S"`) is the top 1% by place:
 * SSS holds `count` places, and S+, S and S- split the rest in thirds. Every
 * other tier reaches down to its "top N%" of the ranked portfolios. The plus
 * and minus tiers split their letter's band into thirds by rank.
 */
const third = (from, to, k) => Math.round((from + ((to - from) * k) / 3) * 1000) / 1000;
export const TIER_LADDER = [
  { tier: "SSS", band: "S", count: 3, top: 1, name: "Elite", note: "The top 3 portfolios." },
  { tier: "S+", band: "S", top: 1, name: "Exceptional", note: "The rest of the top 1%, top third." },
  { tier: "S", band: "S", top: 1, name: "Exceptional", note: "The rest of the top 1%, middle third." },
  { tier: "S-", band: "S", top: 1, name: "Exceptional", note: "The rest of the top 1%, bottom third." },
  { tier: "A+", top: third(1, 30, 1), name: "Strong", note: "1% to 30%, top third." },
  { tier: "A", top: third(1, 30, 2), name: "Strong", note: "1% to 30%, middle third." },
  { tier: "A-", top: 30, name: "Strong", note: "1% to 30%, bottom third." },
  { tier: "B+", top: third(30, 70, 1), name: "Solid", note: "30% to 70%, top third." },
  { tier: "B", top: third(30, 70, 2), name: "Solid", note: "30% to 70%, middle third. Every portfolio starts here." },
  { tier: "B-", top: 70, name: "Solid", note: "30% to 70%, bottom third." },
  { tier: "C+", top: 75, name: "Weak", note: "70% to 85%, top third." },
  { tier: "C", top: 80, name: "Weak", note: "70% to 85%, middle third." },
  { tier: "C-", top: 85, name: "Weak", note: "70% to 85%, bottom third." },
  { tier: "D", top: 100, name: "Needs work", note: "The bottom 15%." },
];

/** The letter families, best first, with what each means (boards and filters group by these). */
export const FAMILIES = [
  { family: "S", name: "Exceptional", note: "The top 1%." },
  { family: "A", name: "Strong", note: "1% to 30%." },
  { family: "B", name: "Solid", note: "30% to 70%, and everyone with under 10 face-offs." },
  { family: "C", name: "Weak", note: "70% to 85%." },
  { family: "D", name: "Needs work", note: "The bottom 15%." },
];

/** Bumped whenever the ladder or the way it is placed changes, so stored report ranks are placed again (lib/tiers-store.mjs). */
export const LADDER_VERSION = 6;

/** The library needs at least this many ranked portfolios (MIN_FACEOFFS or more) before the S band (SSS to S-) is given. */
export const COUNT_TIERS_MIN = 100;

/** The last tier whose letter is shown publicly (SSS through B-); lower ones read "Graded, below the top tiers". */
export const PUBLIC_THROUGH = "B-";

// ---------------------------------------------------------------------------

/** Every tier, best first. */
export const TIERS = TIER_LADDER.map((t) => t.tier);
/** The tiers shown publicly, best first. */
export const PUBLIC_TIERS = TIERS.slice(0, TIERS.indexOf(PUBLIC_THROUGH) + 1);
/** What a lower tier says in public, instead of its letter. */
export const BELOW_TOP_TIERS = "Graded, below the top tiers";

/** True for one of the tier letters (SSS to D). */
export const isTier = (t) => typeof t === "string" && TIERS.includes(t);
/** True for a tier whose letter is shown publicly. */
export const isPublicTier = (t) => typeof t === "string" && PUBLIC_TIERS.includes(t);
/** A tier as text people read: the minus as a real minus sign ("A−"), so it never looks like a dash or a hyphenation. */
export const tierLabel = (t) => (typeof t === "string" ? t.replace(/-$/, "−") : t);
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
/** A tier as a number for averages and comparisons: D 1 up to SSS 14; null for anything else. */
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

// ---------------------------------------------------------------------------
// The rating and the order
// ---------------------------------------------------------------------------

/** The cautious rating: the mean minus RATING_CAUTION uncertainties. */
export const cautious = (r) => r.mu - RATING_CAUTION * r.sigma;
const START_CAUTIOUS = cautious({ mu: MU, sigma: SIGMA_UNSURE });

/** The ELO shown for a rating ({ mu, sigma }): ELO_START for a portfolio with no face-offs, higher as it wins and as it settles. */
export const eloOf = (r) => Math.round(ELO_START + ELO_PER_POINT * (cautious(r) - START_CAUTIOUS));

const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * One library member as the order compares it: { url, mu, sigma (its
 * rating; a fresh one without face-offs), faceoffs (weighted count), first
 * (when it was first graded, ms; only breaks exact ties), key (the grade's
 * key, lib/grade-score.mjs: the starting order's tie-break and the ranked
 * board's display order among exact ties), seeded (it has a starting rank
 * from automated checks), points (those checks' points), votes (real
 * face-offs, people's and the AI's, each counted once), rating (the cautious
 * rating the order uses), elo }.
 */
export function entryOf({ url, mu = null, sigma = null, faceoffs = null, first = null, key = null, seeded = false, points = null, votes = null }) {
  const r = { mu: num(mu, MU), sigma: num(sigma, SIGMA_UNSURE) };
  return {
    url,
    mu: r.mu,
    sigma: r.sigma,
    faceoffs: Math.max(0, num(faceoffs, 0)),
    first: num(first, Number.MAX_SAFE_INTEGER),
    key: num(key, null),
    seeded: seeded === true || seeded === 1,
    points: num(points, null),
    votes: Math.max(0, num(votes, 0)),
    rating: cautious(r),
    elo: eloOf(r),
  };
}

const isEntry = (e) => e && typeof e === "object" && "rating" in e && "faceoffs" in e && "first" in e;
const asEntry = (e) => (isEntry(e) ? e : entryOf(e ?? {}));

/**
 * True when an entry's tier comes from its place: it has a starting rank from
 * automated checks, or enough face-offs (the float sum of quarters is rounded first).
 */
/**
 * Whether a portfolio's tier is earned in face-offs (MIN_FACEOFFS or more),
 * not a starting rank: only then does a report show its letter beside the
 * grade's own standing, so a letter never contradicts the "top N%" (owner,
 * 2026-11-13: "top 54% should never be an A"). `r` is a stored rank
 * ({ provisional, faceoffs }) or a report view with the same fields.
 */
export const tierSettled = (r) => !!r && r.provisional !== true && Math.floor(num(r.faceoffs, 0)) >= MIN_FACEOFFS;
export const isRanked = (e) => e?.seeded === true || Math.round(num(e?.faceoffs, 0) * 1000) / 1000 >= MIN_FACEOFFS;

/**
 * The order the starting ranks come from: points from automated checks
 * (lib/check-points.mjs), then the Gemini score (the grade key), then the
 * date first graded, then the address. Negative when `a` comes first.
 */
export function compareSeed(a, b) {
  return (b.points ?? -Infinity) - (a.points ?? -Infinity) || (b.key ?? -1) - (a.key ?? -1) || a.first - b.first || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/** The starting rating of the place-th (1 = best) of `total` by points: evenly from MU + SEED_SPREAD down to MU - SEED_SPREAD, fresh uncertainty. */
export function seedRating(place, total) {
  const at = total > 1 ? (place - 1) / (total - 1) : 0.5;
  return { mu: Math.round((MU + SEED_SPREAD * (1 - 2 * at)) * 1e4) / 1e4, sigma: SIGMA_UNSURE };
}

/**
 * The order: the cautious rating, then more face-offs, then the date first
 * graded (earlier first), then the address, so the order is total. Negative
 * when `a` ranks above `b`.
 */
export function compareEntries(a, b) {
  return b.rating - a.rating || b.faceoffs - a.faceoffs || a.first - b.first || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/** The library in its full order, best first: every member, ranked or not (rankLibrary tells them apart). */
export const orderLibrary = (entries) => entries.map(asEntry).filter((e) => typeof e.url === "string" && e.url).sort(compareEntries);

const S_TIERS = TIER_LADDER.filter((t) => t.band === "S");
const SHARE_TIERS = TIER_LADDER.filter((t) => !t.band);
/** The S band's share of the library ("top 1%"). */
const S_BAND_TOP = S_TIERS[S_TIERS.length - 1].top;

/** The place as a share of the ranked portfolios (0-100]: the middle of the portfolio's slot. */
const shareAt = (position, total) => (100 * (position - 0.5)) / total;

/**
 * How many places each S-band tier holds among `total` ranked portfolios:
 * SSS the first 3, then the rest of the top 1% in thirds by place (the first
 * third gets any extra place). None below COUNT_TIERS_MIN.
 */
export function sBand(total) {
  if (total < COUNT_TIERS_MIN) return [];
  const band = Math.floor((total * S_BAND_TOP) / 100);
  const out = [];
  let left = band;
  for (const t of S_TIERS) {
    const n = t.count ?? Math.ceil(left / (S_TIERS.length - out.length));
    out.push({ tier: t.tier, n: Math.min(n, left) });
    left -= Math.min(n, left);
  }
  return out;
}

/** The S-band tier of a place (1 = best), or null past the band. */
function sTierAt(place, total) {
  let to = 0;
  for (const s of sBand(total)) {
    to += s.n;
    if (place <= to) return s.tier;
  }
  return null;
}

/**
 * The share tier (A+ down to D) at a position (the middle of a group of
 * equals; may be fractional) among `total` ranked portfolios. A tier above B
 * needs its band ("top N%") to hold at least one portfolio, and one below B
 * its bottom share; otherwise the next tier toward B.
 */
export function tierAt(position, total) {
  if (!(total > 0)) return null;
  const share = shareAt(position, total);
  let i = SHARE_TIERS.findIndex((t) => share <= t.top);
  if (i < 0) i = SHARE_TIERS.length - 1;
  const mid = SHARE_TIERS.findIndex((t) => t.tier === STARTING_TIER);
  while (i < mid && (SHARE_TIERS[i].top * total) / 100 < 1) i++;
  while (i > mid && ((100 - SHARE_TIERS[i - 1].top) * total) / 100 < 1) i--;
  return SHARE_TIERS[i].tier;
}

/** "Top N%" for a position: whole percent, rounded up so it never claims more than the tier (1 at least). */
export const topPctAt = (position, total) => Math.max(1, Math.min(100, Math.ceil(shareAt(position, total) - 1e-9)));

/** What a portfolio without enough face-offs gets: the starting tier, no place. */
const provisional = (e) => ({ tier: STARTING_TIER, provisional: true, top: null, place: null, position: null, ranked: null, elo: e.elo, faceoffs: e.faceoffs, votes: e.votes, seeded: e.seeded, points: e.points });

/**
 * Every member's tier in an ordered library (orderLibrary): url -> { tier,
 * provisional, top, place, position, ranked, elo, faceoffs }. A member with
 * MIN_FACEOFFS face-offs gets its tier from its place among the `ranked`
 * ones: `place` is its own place (what the S band uses), `position` the
 * middle of its group of equal ratings (what the share tiers and "top N%"
 * use). Any other member is provisional: STARTING_TIER, no place.
 */
export function rankLibrary(order) {
  const out = new Map();
  const ranked = order.filter(isRanked);
  const total = ranked.length;
  let i = 0;
  while (i < total) {
    let j = i;
    while (j < total && ranked[j].rating === ranked[i].rating) j++;
    const position = i + (j - i + 1) / 2;
    const shared = tierAt(position, total);
    for (let k = i; k < j; k++) {
      const place = k + 1;
      const s = sTierAt(place, total);
      const e = ranked[k];
      out.set(e.url, { tier: s ?? shared, provisional: false, top: topPctAt(s ? place : position, total), place, position, ranked: total, elo: e.elo, faceoffs: e.faceoffs, votes: e.votes, seeded: e.seeded, points: e.points });
    }
    i = j;
  }
  for (const e of order) if (!out.has(e.url)) out.set(e.url, provisional(e));
  return out;
}

/**
 * Where a newcomer lands in an ordered library (a grade just written, a
 * visitor's report, a delisted site), placed as if added: `input` is an
 * entry (entryOf) or its fields. Returns the same shape as rankLibrary.
 */
export function placeNew(order, input) {
  const entry = asEntry(input);
  if (!entry.url) entry.url = "￿";
  if (!isRanked(entry)) return provisional(entry);
  const ranked = order.filter((e) => isRanked(e) && e.url !== entry.url);
  const total = ranked.length + 1;
  let place = 1;
  let above = 0;
  let equal = 0;
  for (const e of ranked) {
    if (compareEntries(e, entry) < 0) place++;
    if (e.rating > entry.rating) above++;
    else if (e.rating === entry.rating) equal++;
  }
  const position = above + (equal + 2) / 2;
  const s = sTierAt(place, total);
  return { tier: s ?? tierAt(position, total), provisional: false, top: topPctAt(s ? place : position, total), place, position, ranked: total, elo: entry.elo, faceoffs: entry.faceoffs, votes: entry.votes, seeded: entry.seeded, points: entry.points };
}

/** The rank stored in a grade (grade.rank) from a placement: { tier, elo, faceoffs, top, place, of, provisional }. */
export const storedRank = (p) => ({
  tier: p.tier,
  elo: p.elo,
  faceoffs: Math.round(p.faceoffs * 100) / 100,
  votes: p.votes ?? 0,
  top: p.top,
  place: p.place,
  of: p.ranked,
  provisional: p.provisional,
  // Its starting rank came from automated checks (lib/check-points.mjs), with these points.
  seeded: p.seeded === true,
  points: p.points ?? null,
});

/** How many of a library get each tier: { tier: count }. */
export function distribution(order) {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const p of rankLibrary(order).values()) out[p.tier]++;
  return out;
}

/** How many members have enough face-offs to be ranked. */
export const rankedCount = (order) => order.filter(isRanked).length;

// ---------------------------------------------------------------------------
// Tiers from cutoffs (owner decision 2026-11-13: incremental, not a full
// recompute): once a day lib/tiers-db.mjs finds the rating at each tier's last
// place, and any site's tier is its rating against those cutoffs, on read.
// ---------------------------------------------------------------------------

/**
 * The last place (1 = best) of every tier that has room among `n` ranked
 * portfolios, best first: [{ tier, last }]. The same ladder as rankLibrary
 * (the S band by exact place, the rest by share), without ties.
 */
export function boundaryPlaces(n) {
  const out = [];
  if (!(n > 0)) return out;
  let prev = null;
  // Walk the band edges only: the tier changes at most at each S place and at each share cut-off.
  const edges = new Set([n]);
  let to = 0;
  for (const s of sBand(n)) {
    to += s.n;
    if (s.n) edges.add(to);
  }
  for (const t of SHARE_TIERS) for (const d of [-1, 0, 1]) edges.add(Math.min(n, Math.max(1, Math.floor((t.top * n) / 100 + 0.5) + d)));
  const sorted = [...edges].filter((p) => p >= 1).sort((a, b) => a - b);
  // Between two edges the tier can't change, so checking each edge and the place after it is exact.
  const tierAtPlace = (p) => sTierAt(p, n) ?? tierAt(p, n);
  const checks = [...new Set(sorted.flatMap((p) => [p, Math.min(n, p + 1)]))].sort((a, b) => a - b);
  let last = 0;
  for (const p of checks) {
    // Fill any gap exactly (a gap only happens inside one tier).
    const t = tierAtPlace(p);
    if (prev !== null && t !== prev) out.push({ tier: prev, last });
    prev = t;
    last = p;
  }
  out.push({ tier: prev, last: n });
  return out;
}

/** How many of `n` ranked portfolios each tier holds: { tier: count }. */
export function tierCounts(n) {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let from = 0;
  for (const b of boundaryPlaces(n)) {
    out[b.tier] += b.last - from;
    from = b.last;
  }
  return out;
}

/**
 * A rating's tier against the cutoffs ([{ tier, min }] best first, `min` the
 * rating at that tier's last place): the first tier whose cutoff it reaches.
 * Equal ratings at a boundary take the better tier. Null without cutoffs.
 */
export function tierForRating(rating, cutoffs) {
  if (!Array.isArray(cutoffs) || !cutoffs.length || typeof rating !== "number") return null;
  for (const c of cutoffs) if (c.min == null || rating >= c.min) return c.tier;
  return cutoffs[cutoffs.length - 1].tier;
}

/**
 * "Top N%" and the approximate place of a rating among the ranked
 * portfolios, from the daily histogram (meta.hist: [[bucket, count]] best
 * first, buckets of 1 / perPoint rating points): the ones in better buckets,
 * plus half its own bucket. { place, top } or null.
 */
export function placeForRating(rating, meta) {
  if (!meta?.n || !Array.isArray(meta.hist) || typeof rating !== "number") return null;
  const b = Math.floor(rating * (meta.perPoint ?? 4));
  let above = 0;
  let mine = 0;
  for (const [bucket, count] of meta.hist) {
    if (bucket > b) above += count;
    else if (bucket === b) mine = count;
  }
  const position = above + (mine + 1) / 2;
  return { place: Math.max(1, Math.round(position)), top: topPctAt(Math.max(1, position), meta.n) };
}
