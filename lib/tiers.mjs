// Tiers by ELO (owner decisions 2026-11-12 and 2026-11-13): the tier letter a
// portfolio shows is its place by its rating from face-off votes, not the AI
// grade. The Gemini grade is the report card (per-axis scores and notes, "how
// to improve", and the "not a portfolio" filter); it never sets the letter.
//
// How a portfolio gets its tier, in plain words:
//   1. Its rating ("the ELO") starts from automated checks: graded portfolios
//      are put in order by points from saved data (lib/check-points.mjs), and
//      each one's starting rating comes from its place, from MU + SEED_SPREAD
//      down to MU - SEED_SPREAD, with the high uncertainty of a fresh rating.
//      No vote is invented.
//   2. Real face-offs refine it: a person's vote counts fully and an AI
//      comparison counts AI_VOTE_WEIGHT of one (lib/tiers-rating.mjs).
//   3. Letters show from day one (owner, 2026-11-13). The face-off count only
//      says how settled a rating is (SETTLED_FACEOFFS); it is not a gate.
//   4. Ranked portfolios are put in order by a cautious rating (the rating
//      minus RATING_CAUTION times its uncertainty; equal ones by who was added
//      first), and that order sets the letter by share: A+, A and A- the top
//      30% in thirds, B+, B and B- 30% to 70%, C+, C and C- the rest. At launch
//      the order is the points order, so A is about 85 points and up, B about
//      75 to 85, C under 75.
//   5. S is earned, never given at the start: a portfolio in the top
//      S_TOP_PCT of the order with at least S_MIN_WINS face-off wins (an AI win
//      counts AI_VOTE_WEIGHT of one) is in the S band; SSS is the first 3 of
//      those, S+, S and S- split the rest in thirds. Falling out of the top 1%
//      loses it.
//   6. D is reserved for portfolios failing the must-haves (a name, a role, a
//      way forward) from the five-second checks: the hook (failsMustHaves) is
//      there, unused, so no one is D yet.
//   7. A small library can't hand out tiers it has no room for: the S band
//      needs COUNT_TIERS_MIN ranked portfolios, and a share tier is only given
//      when its band holds at least one whole portfolio; otherwise the next
//      tier toward B.
//
// A tier's family is its letter (S, A, B, C, D; SSS counts as S): boards and
// filters group by family, the badge shows the plus or minus.
//
// The library is the listed, healthy, graded portfolios that are not flagged
// "not a portfolio". Everything here is pure and safe in the browser: the
// replay of the face-offs is lib/tiers-rating.mjs, the database side
// lib/tiers-store.mjs and lib/tiers-db.mjs. No AI request is involved.
import { MU, SIGMA_UNSURE } from "./ranking/config.mjs";

// ---------------------------------------------------------------------------
// The owner's settings: change these to tune the tiers. A change takes
// effect at the next daily run or rebuild (lib/tiers-db.mjs, lib/tiers-store.mjs).
// ---------------------------------------------------------------------------

/**
 * Starting ratings from automated checks: the best portfolio by points
 * starts at MU + SEED_SPREAD and the last at MU - SEED_SPREAD, evenly by
 * place, each with the fresh uncertainty, so real votes move it as fast as a
 * new portfolio's.
 */
export const SEED_FROM_CHECKS = true;
export const SEED_SPREAD = 8;

/**
 * Face-offs after which a rating counts as settled (an AI face-off counts
 * AI_VOTE_WEIGHT of one). An indicator only: letters show from day one. A
 * site without a starting rank (not graded) still needs this many to rank.
 */
export const SETTLED_FACEOFFS = 10;
/** The same number under its old name (lib/play/draw.mjs draws portfolios below it more often). */
export const MIN_FACEOFFS = SETTLED_FACEOFFS;

/**
 * What one AI head-to-head comparison counts, as a share of one person's
 * vote: in the rating, the face-off count and the wins. Not yet confirmed by
 * the owner (2026-11-12): 0.25 is the proposed default.
 */
export const AI_VOTE_WEIGHT = 0.25;

/** The tier of a portfolio that has no place (outside the library, or a library too small to rank): the middle of the ladder. */
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

/** S is earned: a portfolio needs at least this many face-off wins (an AI win counts AI_VOTE_WEIGHT of one)... */
export const S_MIN_WINS = 3;
/** ...and a place in this top share of the order (percent). SSS is the first SSS_COUNT of the ones that qualify. */
export const S_TOP_PCT = 1;
export const SSS_COUNT = 3;

/**
 * D is reserved for portfolios failing the must-haves (a name, a role, a way
 * forward) from the five-second checks. Off until those checks feed it.
 */
export const D_FOR_MUST_HAVES = false;

/**
 * The ladder, best first. The S band (`band: "S"`) is earned (S_MIN_WINS and
 * S_TOP_PCT), never given by place alone. Every other tier reaches down to
 * its "top N%" of the ranked portfolios; the plus and minus tiers split their
 * letter's band into thirds. D (`reserved`) is not given by place.
 */
const third = (from, to, k) => Math.round((from + ((to - from) * k) / 3) * 1000) / 1000;
export const TIER_LADDER = [
  { tier: "SSS", band: "S", name: "Elite", note: "The top 3 of the portfolios that earned S." },
  { tier: "S+", band: "S", name: "Exceptional", note: "Earned: 3 face-off wins and a place in the top 1%, top third." },
  { tier: "S", band: "S", name: "Exceptional", note: "Earned: 3 face-off wins and a place in the top 1%, middle third." },
  { tier: "S-", band: "S", name: "Exceptional", note: "Earned: 3 face-off wins and a place in the top 1%, bottom third." },
  { tier: "A+", top: third(0, 30, 1), name: "Strong", note: "The top 30%, top third." },
  { tier: "A", top: third(0, 30, 2), name: "Strong", note: "The top 30%, middle third." },
  { tier: "A-", top: 30, name: "Strong", note: "The top 30%, bottom third." },
  { tier: "B+", top: third(30, 70, 1), name: "Solid", note: "30% to 70%, top third." },
  { tier: "B", top: third(30, 70, 2), name: "Solid", note: "30% to 70%, middle third." },
  { tier: "B-", top: 70, name: "Solid", note: "30% to 70%, bottom third." },
  { tier: "C+", top: third(70, 100, 1), name: "Weak", note: "The bottom 30%, top third." },
  { tier: "C", top: third(70, 100, 2), name: "Weak", note: "The bottom 30%, middle third." },
  { tier: "C-", top: 100, name: "Weak", note: "The bottom 30%, bottom third." },
  { tier: "D", reserved: true, name: "Needs work", note: "Reserved for portfolios missing the must-haves. No one is D yet." },
];

/** The letter families, best first, with what each means (boards and filters group by these). */
export const FAMILIES = [
  { family: "S", name: "Exceptional", note: "Earned with face-off wins in the top 1%." },
  { family: "A", name: "Strong", note: "The top 30%." },
  { family: "B", name: "Solid", note: "30% to 70%." },
  { family: "C", name: "Weak", note: "The bottom 30%." },
  { family: "D", name: "Needs work", note: "Reserved, not given yet." },
];

/** Bumped whenever the ladder or the way it is placed changes, so stored report ranks are placed again (lib/tiers-store.mjs). */
export const LADDER_VERSION = 7;

/** The library needs at least this many ranked portfolios before the S band (SSS to S-) is given. */
export const COUNT_TIERS_MIN = 100;

/** The last tier whose letter is shown publicly (SSS through B-); lower ones read "Graded, below the top tiers". */
export const PUBLIC_THROUGH = "B-";

/**
 * The D hook: true when a portfolio fails the must-haves from the five-second
 * checks ({ name, role, cta }: a name, a role, a way forward). Unused for now:
 * D_FOR_MUST_HAVES is off, so it always says no and no one is D.
 * @param {{ name?: boolean, role?: boolean, cta?: boolean } | null | undefined} facts
 */
export const failsMustHaves = (facts) => D_FOR_MUST_HAVES && Boolean(facts) && !(facts?.name && facts?.role && facts?.cta);

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
 * rating; a fresh one without face-offs), faceoffs (weighted count), wins
 * (weighted face-off wins: what S needs), first (when it was added, ms:
 * breaks equal ratings, earliest first), key (the grade's key,
 * lib/grade-score.mjs: the starting order's tie-break), seeded (it has a
 * starting rank from automated checks), points (those checks' points),
 * votes (real face-offs, people's and the AI's, each counted once), rating
 * (the cautious rating the order uses), elo }.
 */
export function entryOf({ url, mu = null, sigma = null, faceoffs = null, wins = null, first = null, key = null, seeded = false, points = null, votes = null }) {
  const r = { mu: num(mu, MU), sigma: num(sigma, SIGMA_UNSURE) };
  return {
    url,
    mu: r.mu,
    sigma: r.sigma,
    faceoffs: Math.max(0, num(faceoffs, 0)),
    wins: Math.max(0, num(wins, 0)),
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
const round3 = (x) => Math.round(num(x, 0) * 1000) / 1000;

/**
 * True when an entry's tier comes from its place: it has a starting rank
 * from automated checks (every graded member does, from day one), or, without
 * one, SETTLED_FACEOFFS face-offs.
 */
export const isRanked = (e) => e?.seeded === true || round3(e?.faceoffs) >= SETTLED_FACEOFFS;

/** True when a rating counts as settled: SETTLED_FACEOFFS face-offs or more (an indicator, never a gate). */
export const isSettled = (faceoffs) => round3(faceoffs) >= SETTLED_FACEOFFS;

/** True when an entry has won enough face-offs to earn S (S_MIN_WINS; an AI win counts AI_VOTE_WEIGHT of one). */
export const hasSWins = (e) => round3(e?.wins) >= S_MIN_WINS;

/**
 * The order the starting ranks come from: points from automated checks
 * (lib/check-points.mjs), then the Gemini score (the grade key), then the
 * date added, then the address. Negative when `a` comes first.
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
 * The order: the cautious rating; an equal rating breaks by who was added
 * first (owner, 2026-11-13), then the address, so the order is total.
 * Negative when `a` ranks above `b`.
 */
export function compareEntries(a, b) {
  return b.rating - a.rating || a.first - b.first || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/** The library in its full order, best first: every member, ranked or not (rankLibrary tells them apart). */
export const orderLibrary = (entries) => entries.map(asEntry).filter((e) => typeof e.url === "string" && e.url).sort(compareEntries);

const S_TIERS = TIER_LADDER.filter((t) => t.band === "S");
/** The tiers given by share of the order: A+ down to C- (S is earned, D reserved). */
const SHARE_TIERS = TIER_LADDER.filter((t) => !t.band && !t.reserved);

/** The place as a share of the ranked portfolios (0-100]: the middle of the portfolio's slot. */
const shareAt = (position, total) => (100 * (position - 0.5)) / total;

/** How many of the first places can earn S among `total` ranked portfolios: the top S_TOP_PCT, none below COUNT_TIERS_MIN. */
export const sPlaces = (total) => (total >= COUNT_TIERS_MIN ? Math.floor((total * S_TOP_PCT) / 100) : 0);

/**
 * How the portfolios that earned S split, best first: SSS the first
 * SSS_COUNT, then S+, S and S- the rest in thirds (the first third gets any
 * extra one). [{ tier, n }].
 */
export function sSplit(earned) {
  const out = [];
  let left = Math.max(0, earned);
  for (const t of S_TIERS) {
    const n = t.tier === "SSS" ? Math.min(SSS_COUNT, left) : Math.ceil(left / (S_TIERS.length - out.length));
    out.push({ tier: t.tier, n: Math.min(n, left) });
    left -= Math.min(n, left);
  }
  return out;
}

/**
 * The share tier (A+ down to C-) at a place among `total` ranked portfolios.
 * A tier above B needs its band ("top N%") to hold at least one portfolio,
 * and one below B its bottom share; otherwise the next tier toward B.
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

/** "Top N%" for a place: whole percent, rounded up so it never claims more than the tier (1 at least). */
export const topPctAt = (position, total) => Math.max(1, Math.min(100, Math.ceil(shareAt(position, total) - 1e-9)));

/** What a portfolio outside the ranking gets: the starting tier, no place. */
const provisional = (e) => ({ tier: STARTING_TIER, provisional: true, top: null, place: null, position: null, ranked: null, elo: e.elo, faceoffs: e.faceoffs, wins: e.wins, votes: e.votes, seeded: e.seeded, points: e.points, settled: isSettled(e.faceoffs) });

/** The S tiers of the ranked portfolios in order (best first): url -> tier, for the ones that earned S. */
function earnedS(ranked) {
  const total = ranked.length;
  const earned = ranked.slice(0, sPlaces(total)).filter(hasSWins);
  const out = new Map();
  let k = 0;
  for (const s of sSplit(earned.length)) for (let i = 0; i < s.n; i++) out.set(earned[k++].url, s.tier);
  return out;
}

/**
 * Every member's tier in an ordered library (orderLibrary): url -> { tier,
 * provisional, top, place, position, ranked, elo, faceoffs, wins, settled }.
 * A ranked member (every graded one) gets its share tier from its place, or
 * an S tier when it earned one; anyone else is provisional: STARTING_TIER, no place.
 */
export function rankLibrary(order) {
  const out = new Map();
  const ranked = order.filter(isRanked);
  const total = ranked.length;
  const s = earnedS(ranked);
  ranked.forEach((e, i) => {
    const place = i + 1;
    out.set(e.url, {
      tier: s.get(e.url) ?? tierAt(place, total),
      provisional: false,
      top: topPctAt(place, total),
      place,
      position: place,
      ranked: total,
      elo: e.elo,
      faceoffs: e.faceoffs,
      wins: e.wins,
      votes: e.votes,
      seeded: e.seeded,
      points: e.points,
      settled: isSettled(e.faceoffs),
    });
  });
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
  const ranked = [...order.filter((e) => isRanked(e) && e.url !== entry.url), entry].sort(compareEntries);
  return rankLibrary(ranked).get(entry.url);
}

/** The rank stored in a grade (grade.rank) from a placement: { tier, elo, faceoffs, votes, top, place, of, provisional, seeded, points }. */
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

/** How many members are ranked. */
export const rankedCount = (order) => order.filter(isRanked).length;

// ---------------------------------------------------------------------------
// Tiers from cutoffs (incremental, lib/tiers-db.mjs): once a day the rating
// (and date added) at each share tier's last place is found, and the S band
// from the few portfolios that earned it; any site's tier is then its rating
// against those cutoffs, on read.
// ---------------------------------------------------------------------------

/**
 * The last place (1 = best) of every share tier that has room among `n`
 * ranked portfolios, best first: [{ tier, last }]. S is earned, not placed.
 */
export function boundaryPlaces(n) {
  const out = [];
  if (!(n > 0)) return out;
  let prev = null;
  const edges = new Set([n]);
  for (const t of SHARE_TIERS) for (const d of [-1, 0, 1]) edges.add(Math.min(n, Math.max(1, Math.floor((t.top * n) / 100 + 0.5) + d)));
  // Between two edges the tier can't change, so checking each edge and the place after it is exact.
  const checks = [...new Set([...edges].filter((p) => p >= 1).flatMap((p) => [p, Math.min(n, p + 1)]))].sort((a, b) => a - b);
  let last = 0;
  for (const p of checks) {
    const t = tierAt(p, n);
    if (prev !== null && t !== prev) out.push({ tier: prev, last });
    prev = t;
    last = p;
  }
  out.push({ tier: prev, last: n });
  return out;
}

/**
 * How many of `n` ranked portfolios each tier holds: { tier: count }. With
 * `sCounts` ({ tier: n } of the S band, from the daily run), the ones that
 * earned S are moved out of the share tiers above them.
 */
/**
 * @param {number} n
 * @param {Record<string, number> | null} [sCounts]
 * @returns {Record<string, number>}
 */
export function tierCounts(n, sCounts = null) {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let from = 0;
  for (const b of boundaryPlaces(n)) {
    out[b.tier] += b.last - from;
    from = b.last;
  }
  if (sCounts) {
    let earned = 0;
    for (const [t, k] of Object.entries(sCounts)) {
      out[t] = (out[t] ?? 0) + k;
      earned += k;
    }
    // They sit in the top 1%, so in the first share tier(s).
    for (const t of SHARE_TIERS.map((x) => x.tier)) {
      const take = Math.min(earned, out[t]);
      out[t] -= take;
      earned -= take;
      if (!earned) break;
    }
  }
  return out;
}

const MAX = Number.MAX_SAFE_INTEGER;
/**
 * True when a site (rating, first, url) is at or above a cutoff's place ({ min, first, url }, the last place of a
 * tier): a better rating, or the same and added earlier, or the same date and the address first (compareEntries).
 */
const reaches = (rating, first, url, c) => {
  if (c.min == null || rating > c.min) return true;
  if (rating < c.min) return false;
  const f = first ?? MAX;
  const cf = c.first ?? MAX;
  if (f !== cf) return f < cf;
  return c.url == null || url == null || url <= c.url;
};

/**
 * A rating's share tier against the cutoffs ([{ tier, min, first, url }] best
 * first: the rating, date added and address of that tier's last place): the
 * first tier it reaches. Null without cutoffs.
 */
export function tierForRating(rating, cutoffs, first = null, url = null) {
  if (!Array.isArray(cutoffs) || !cutoffs.length || typeof rating !== "number") return null;
  for (const c of cutoffs) if (reaches(rating, first, url, c)) return c.tier;
  return cutoffs[cutoffs.length - 1].tier;
}

/**
 * The S tier a portfolio earned, from the daily S band (meta.sBand: { cut:
 * the last place of the top S_TOP_PCT, tiers: [{ tier, min, first, url }]
 * the last of each S tier, best first }): enough wins and a place in the top
 * 1%, then the S tier its place reaches. Null when it has not earned S.
 */
export function sTierFor(rating, wins, first, url, sBand) {
  if (!sBand?.cut || !Array.isArray(sBand.tiers) || !sBand.tiers.length || typeof rating !== "number") return null;
  if (round3(wins) < S_MIN_WINS || !reaches(rating, first, url, sBand.cut)) return null;
  for (const t of sBand.tiers) if (reaches(rating, first, url, t)) return t.tier;
  return sBand.tiers[sBand.tiers.length - 1].tier;
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
