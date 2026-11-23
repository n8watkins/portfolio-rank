// The full rebuild of tiers by ELO (lib/tiers.mjs), and placing one site:
//
//   refreshTiers   the whole library, from scratch: points from automated
//                  checks (lib/check-points.mjs, saved data only), a starting
//                  rating from each member's place by points, every
//                  real face-off replayed on top (lib/tiers-rating.mjs), all
//                  written into tier_ratings (lib/tiers-db.mjs), then the
//                  cutoffs and each Gemini grade's `rank` = { tier, elo, faceoffs,
//                  votes, top, place, of, provisional, seeded, points, check }.
//                  At each deploy on staging and by hand
//                  (scripts/refresh-tiers.mjs); day to day, votes and the daily
//                  run (dailyRun) keep it current without it.
//   rankFromCode   one site as soon as it is measured (pipeline/capture.mjs, after
//                  a stored capture): its Starting rank from the Code checks
//                  score, from a few reads by key. No Gemini grade needed.
//   dailyRun       once a day (worker/tiers.ts): members measured since that have
//                  no Starting rank yet get one (seedNewcomers), then the
//                  cutoffs and the letters that changed (lib/tiers-db.mjs dailyTiers).
//   rankForWrite   one new Gemini grade, as it is written (the nightly grader, the
//                  judge script): its site's row and rank, from a few reads by key.
//                  A site that already has a Starting rank keeps it; "not a
//                  portfolio" takes it out of the order.
//   placeGrade     a visitor's report: its rank from its site's row or its points.
//
// The library (owner, 2026-11-22: "the starting rank you get is based off of
// clear verifiable code measurements"; libraryMember): a listed site that is
// not hidden and not graded "not a portfolio", which Gemini graded "a
// portfolio", or which has a good capture with measured facts and at least
// STRONG_SIGNALS of the six portfolio signals (or the owner kept it). Gemini's
// grade never sets the order: the Code checks score, then the date first
// measured, then the address (lib/tiers.mjs compareSeed).
//
// No AI request anywhere.
import { LISTED_NOT_DOWN, NOT_PORTFOLIO } from "../pipeline/roster.mjs";
import { SIGNAL_NAMES, STRONG_SIGNALS } from "../pipeline/portfolio-guard.mjs";
import { readVoteComparisons } from "./ranking/store.mjs";
import { LADDER_VERSION, SEED_FROM_CHECKS, TIERS, cautious, compareSeed, entryOf, seedRating, storedRank } from "./tiers.mjs";
import { COLS, bucketOf, computeCutoffs, dailyTiers, ensureTierSchema, readSiteRow, readTierMeta, rowOf, standingOf, writeTierMeta } from "./tiers-db.mjs";
import { rateFaceoffs } from "./tiers-rating.mjs";
import { gradeKey } from "./grade-score.mjs";
import { checkPoints, checkShares, libraryMedians } from "./check-points.mjs";
import { checksReading } from "./fresh-facts.mjs";
import { CAPTURED_BEFORE_CHECK_SQL, storedCaptureBlocked } from "./reviews/stored-capture.mjs";
import { KEEP_ROW_SQL } from "./reviews/keep.mjs";
import { storedMs } from "./stored-time.mjs";

/** Reports of "Grade my portfolio" given a rank per refresh (the backlog clears over a few hours). */
export const JOBS_PER_REFRESH = 500;

const parse = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};
const noTable = (e) => /no such table/i.test(String(e?.message ?? e));

const RANK_FIELDS = ["tier", "elo", "faceoffs", "votes", "top", "place", "of", "provisional", "seeded", "points"];
const sameRank = (a, b) =>
  (a == null && b == null) ||
  (a != null && b != null && RANK_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null)) && JSON.stringify(a.check ?? null) === JSON.stringify(b.check ?? null));

/** The points breakdown as stored with a rank: [item, points, measured (1/0)] rows, in CHECK_ITEMS order. */
const packCheck = (pts) => (pts ? pts.items.map((i) => [i.id, i.points, i.measured ? 1 : 0]) : null);

/** Gemini answered, and its answer (or a verdict on top of it) is "a portfolio". */
export const geminiYes = (g) => Boolean(g && typeof g === "object" && !g.error && typeof g.tier === "string" && g.tier && g.is_portfolio !== false);
/** The stored grade says "not a portfolio": Gemini's answer as the Removal rule acted on it, or the owner's verdict. */
export const saysNotPortfolio = (g) => Boolean(g && typeof g === "object" && !g.error && g.is_portfolio === false);
const usable = geminiYes;

/**
 * The site waits for its one fresh Gemini grade (lib/reviews/store.mjs FRESH_GRADE_DUE: the owner undid a
 * removal whose grade was made on an unchecked capture, or kept a site for a fresh grade): out of the tiers
 * until that grade, as before this rule. Spelled here, not imported, as the review queue imports this module.
 */
const freshGradeWaits = (g) => Boolean(g && typeof g === "object" && (g.error === "fresh_grade_due" || g.fresh_grade === "due"));

/** SQL (never NULL): the portfolios row aliased `p` has a Gemini grade that says "a portfolio" (geminiYes). */
export const GEMINI_YES_SQL = (p) =>
  `COALESCE(json_valid(${p}.ai_rubric) AND json_extract(${p}.ai_rubric, '$.tier') IS NOT NULL AND json_extract(${p}.ai_rubric, '$.error') IS NULL
    AND COALESCE(json_extract(${p}.ai_rubric, '$.is_portfolio'), 1) != 0, 0)`;
/** SQL: the row's portfolio signals count, the capture's facts first, else the health check's (signalScore). */
export const SIGNALS_SQL = (p) =>
  `COALESCE(CASE WHEN json_valid(${p}.facts) THEN CAST(json_extract(${p}.facts, '$.signals.score') AS INTEGER) END,
    CASE WHEN json_valid(${p}.signals) THEN CAST(json_extract(${p}.signals, '$.score') AS INTEGER) END, 0)`;

/**
 * How many of the six code-measured portfolio signals a site has
 * (pipeline/signals.mjs): the capture's facts, else the health check's
 * (as lib/reviews/door.mjs signalsOf reads them). Null when never measured.
 */
export function signalScore(facts, rowSignals) {
  const s = parse(facts)?.signals ?? parse(rowSignals);
  if (!s || typeof s !== "object") return null;
  const n = Number(s.score ?? SIGNAL_NAMES.filter((k) => s[k] === true).length);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a site is a library member, and why (owner, 2026-11-22): "gemini"
 * (Gemini said it is a portfolio: every member before this rule), "signals"
 * (a good capture with measured facts and at least STRONG_SIGNALS of the six
 * portfolio signals), "owner" (a good measured capture the owner decided to
 * keep), or null. Never a member: a site off the list or hidden (`listed`
 * false), or one graded "not a portfolio". A measured site with fewer signals
 * and no Gemini answer is not ranked yet: Gemini's "yes" or the owner's
 * verdict ranks it later. Pure.
 * @param {{ listed: boolean, grade?: any, goodCapture?: boolean, measured?: boolean, signals?: number | null, ownerKeeps?: boolean }} site
 * @returns {"gemini" | "signals" | "owner" | null}
 */
export function libraryMember({ listed, grade = null, goodCapture = false, measured = false, signals = null, ownerKeeps = false }) {
  if (!listed || saysNotPortfolio(grade) || freshGradeWaits(grade)) return null;
  if (geminiYes(grade)) return "gemini";
  if (!goodCapture || !measured) return null;
  if ((signals ?? 0) >= STRONG_SIGNALS) return "signals";
  return ownerKeeps ? "owner" : null;
}

/**
 * Whether a portfolios row (status, shot_key, captured_at, facts, and
 * page_text and gate_meta for a capture from before the capture checked its
 * screen) holds a good capture: stored live with its screenshot, and showing
 * the site (lib/reviews/stored-capture.mjs storedCaptureBlocked).
 */
export function goodCapture(row) {
  if (String(row?.status ?? "") !== "live" || row?.shot_key == null) return false;
  return !storedCaptureBlocked({ page_text: row.page_text ?? null, facts: row.facts, meta: row.gate_meta ?? null, captured_at: row.captured_at });
}

/**
 * SQL about the owner, for the row aliased `p`: `keeps`, he decided to keep the site (lib/reviews/keep.mjs);
 * `removed`, a verified owner removed it (portfolio_owner.removed_at), which counts at once, before the site
 * leaves the list. "0" for a table that does not exist yet.
 */
async function ownerSql(db) {
  const have = new Set((await rowsOf(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('status_reviews', 'portfolio_owner')")).map((r) => String(r.name)));
  return {
    keeps: have.has("status_reviews") ? `EXISTS (SELECT 1 FROM status_reviews k WHERE k.url = p.url AND ${KEEP_ROW_SQL("k")})` : "0",
    removed: have.has("portfolio_owner") ? "EXISTS (SELECT 1 FROM portfolio_owner o WHERE o.url = p.url AND o.removed_at IS NOT NULL)" : "0",
  };
}

/**
 * The portfolios columns libraryMember reads, for the row aliased `p`; the page text only where
 * storedCaptureBlocked needs it. `listed`: on the list, not down, and not removed by its owner.
 */
const MEMBER_COLS = (o) => {
  const gate = `(${CAPTURED_BEFORE_CHECK_SQL("p")} AND NOT ${GEMINI_YES_SQL("p")})`;
  return `p.url, p.ai_rubric, p.facts, p.signals, p.status, p.shot_key, p.captured_at,
    CASE WHEN ${gate} THEN p.page_text END AS page_text, CASE WHEN ${gate} THEN p.meta END AS gate_meta,
    (${LISTED_NOT_DOWN("p")} AND NOT ${o.removed}) AS listed, ${o.keeps} AS owner_keeps`;
};

/** A row read with MEMBER_COLS, as libraryMember's answer. */
function memberOfRow(r, grade) {
  const facts = parse(r.facts);
  return libraryMember({
    listed: Number(r.listed) === 1,
    grade,
    goodCapture: goodCapture(r),
    measured: Boolean(facts),
    signals: signalScore(facts, r.signals),
    ownerKeeps: Number(r.owner_keeps) === 1,
  });
}

/** Rows of a query, or none when its table doesn't exist yet. */
async function rowsOf(db, stmt) {
  try {
    return (await db.execute(stmt)).rows;
  } catch (e) {
    if (noTable(e)) return [];
    throw e;
  }
}

/**
 * Every face-off that counts, as comparisons (lib/tiers-rating.mjs): the
 * vote log (people's votes and the AI judge's, never practice votes) read
 * as it is, plus the AI comparisons the ranking job stored itself (the
 * comparisons table, without its mirror of the vote log).
 */
export async function loadFaceoffs(db) {
  const [votes, own] = await Promise.all([
    readVoteComparisons(db).catch((e) => {
      if (noTable(e)) return [];
      throw e;
    }),
    rowsOf(
      db,
      `SELECT id, created_at, rater_type, method, ranking, outcome, starred, experiment FROM comparisons
       WHERE (source IS NULL OR source NOT LIKE 'vote:%') AND experiment IS NULL AND outcome = 'ranked' AND method = 'one_on_one'`
    ),
  ]);
  return [
    ...(votes ?? []),
    ...own.map((r) => ({
      id: Number(r.id),
      created_at: String(r.created_at),
      rater_type: String(r.rater_type),
      method: String(r.method),
      ranking: r.ranking == null ? null : String(r.ranking),
      outcome: String(r.outcome),
      starred: Number(r.starred) ? 1 : 0,
      experiment: null,
    })),
  ];
}

/** When each site was first graded (the oldest grade in rubric_history), ms. */
async function firstGraded(db) {
  const out = new Map();
  for (const r of await rowsOf(db, "SELECT url, MIN(judged_at) AS at FROM rubric_history GROUP BY url")) {
    const at = Date.parse(String(r.at ?? ""));
    if (Number.isFinite(at)) out.set(String(r.url), at);
  }
  return out;
}

/**
 * The saved check data of every site, or of one (`only`): Lighthouse on
 * mobile and desktop and the polish fetch (cache rows), the capture's
 * diagnostics (portfolios.meta) and the newest measured facts
 * (portfolios.facts). url -> { psi, psiDesktop, inspect, meta, facts }.
 * With `urls`, only those sites (reads by key, in chunks).
 * @param {any} db
 * @param {{ only?: string | null, urls?: string[] | null }} [opts]
 * @returns {Promise<Map<string, { psi: any, psiDesktop: any, inspect: any, meta: any, facts: any }>>}
 */
export async function checkSources(db, { only = null, urls = null } = {}) {
  const out = new Map();
  const of = (url) => {
    if (!out.has(url)) out.set(url, { psi: null, psiDesktop: null, inspect: null, meta: null, facts: null });
    return out.get(url);
  };
  const captured = "(meta IS NOT NULL OR facts IS NOT NULL)";
  const kinds = ["psi", "psi-desktop", "inspect"];
  let cache;
  let metas;
  if (urls) {
    cache = [];
    metas = [];
    for (const part of chunk([...new Set(urls)], 100)) {
      const keys = part.flatMap((u) => kinds.map((k) => `${k}:${u}`));
      const marks = (n) => Array.from({ length: n }, () => "?").join(",");
      const [c, m] = await Promise.all([
        rowsOf(db, { sql: `SELECT k, v FROM cache WHERE k IN (${marks(keys.length)})`, args: keys }),
        rowsOf(db, { sql: `SELECT url, meta, facts FROM portfolios WHERE url IN (${marks(part.length)}) AND ${captured}`, args: part }),
      ]);
      cache.push(...c);
      metas.push(...m);
    }
  } else {
    const range = (p) => (only ? { sql: "k = ?", args: [`${p}:${only}`] } : { sql: "(k >= ? AND k < ?)", args: [`${p}:`, `${p};`] });
    const parts = kinds.map(range);
    [cache, metas] = await Promise.all([
      rowsOf(db, { sql: `SELECT k, v FROM cache WHERE ${parts.map((p) => p.sql).join(" OR ")}`, args: parts.flatMap((p) => p.args) }),
      rowsOf(db, only ? { sql: `SELECT url, meta, facts FROM portfolios WHERE url = ? AND ${captured}`, args: [only] } : `SELECT url, meta, facts FROM portfolios WHERE ${captured}`),
    ]);
  }
  for (const r of cache) {
    const k = String(r.k);
    const v = parse(r.v);
    if (k.startsWith("psi-desktop:")) of(k.slice(12)).psiDesktop = v;
    else if (k.startsWith("psi:")) of(k.slice(4)).psi = v;
    else if (k.startsWith("inspect:")) of(k.slice(8)).inspect = v;
  }
  for (const r of metas) {
    const s = of(String(r.url));
    s.meta = parse(r.meta);
    s.facts = parse(r.facts);
  }
  return out;
}

/**
 * A site's Code checks score, from its saved check data and what the checks
 * read (lib/fresh-facts.mjs checksReading: its Gemini grade with the newest
 * measured facts, or, ungraded, its measured facts alone). `grade` is the
 * stored grade as it is, or null; `sources.facts` the newest measured facts;
 * `medians` the library's (tier meta).
 * @param {any} grade
 * @param {any} [sources]
 * @param {any} [medians]
 * @param {Date} [now]
 */
export function pointsOf(grade, sources = {}, medians = null, now = new Date()) {
  const { facts, ...rest } = sources;
  const read = checksReading(grade, facts, { now }) ?? grade;
  return checkPoints(checkShares({ ...rest, grade: read, year: now.getUTCFullYear() }), medians ?? libraryMedians([]));
}

/**
 * When a site entered the library, ms: what equal points and equal ratings
 * are split by (earliest first). The oldest of its first grade (history and
 * the current one) and the date already stored with its rank; for a site
 * that has neither, the date of its capture (it is measured at capture time).
 */
function firstOf(url, grade, first, stored = new Map(), capturedAt = null) {
  const judged = Date.parse(String(grade?.judged_at ?? ""));
  const at = [first.get(url), Number.isFinite(judged) ? judged : null, stored.get(url)].filter((x) => typeof x === "number" && Number.isFinite(x));
  return at.length ? Math.min(...at) : storedMs(capturedAt);
}

/** The date each site entered the library, as stored with its rank (tier_ratings.first), ms. */
async function storedFirst(db) {
  const out = new Map();
  for (const r of await rowsOf(db, "SELECT url, first FROM tier_ratings WHERE first IS NOT NULL")) out.set(String(r.url), Number(r.first));
  return out;
}

/**
 * Every site with a grade or measured facts, with whether it is a library
 * member (libraryMember) and its entry in the order: { rows: [{ url, grade,
 * raw, member, why, entry, points }], ratings, medians }. Members get points
 * from automated checks and a starting rating from their place by points;
 * then every real face-off is replayed.
 */
export async function loadGrades(db, { now = new Date() } = {}) {
  const o = await ownerSql(db);
  const [res, faceoffs, first, stored, sources] = await Promise.all([
    db.execute(
      `SELECT ${MEMBER_COLS(o)} FROM portfolios p
       WHERE (p.ai_rubric IS NOT NULL AND json_valid(p.ai_rubric)) OR (p.facts IS NOT NULL AND json_valid(p.facts))`
    ),
    loadFaceoffs(db),
    firstGraded(db),
    storedFirst(db),
    checkSources(db),
  ]);
  const year = now.getUTCFullYear();
  const rows = res.rows.map((r) => {
    const raw = r.ai_rubric == null ? null : String(r.ai_rubric);
    const grade = parse(raw);
    const url = String(r.url);
    const why = memberOfRow(r, grade);
    const member = why != null;
    // The code items (resume, GitHub, contact, own domain, project links, footer year) from the newest measured facts.
    const { facts, ...src } = sources.get(url) ?? {};
    const read = member ? (checksReading(grade, facts ?? r.facts, { now }) ?? grade) : grade;
    const shares = member ? checkShares({ ...src, grade: read, year }) : null;
    return { url, grade, raw, member, why, shares, key: gradeKey(read), first: firstOf(url, grade, first, stored, r.captured_at) };
  });
  const members = rows.filter((r) => r.member);
  const medians = libraryMedians(members.map((r) => r.shares));
  for (const r of members) r.points = checkPoints(r.shares, medians);
  // Starting ratings by place in points order (ties: the date first measured, then the address; never Gemini).
  const seeds = new Map();
  if (SEED_FROM_CHECKS) {
    const bySeed = [...members].sort((a, b) => compareSeed({ ...a, points: a.points.total }, { ...b, points: b.points.total }));
    bySeed.forEach((r, i) => seeds.set(r.url, seedRating(i + 1, bySeed.length)));
  }
  const ratings = rateFaceoffs(faceoffs, { seeds });
  for (const r of rows) {
    const x = ratings.get(r.url);
    r.entry = entryOf({ url: r.url, mu: x?.mu, sigma: x?.sigma, faceoffs: x?.faceoffs, wins: x?.won ?? 0, votes: x ? x.wins + x.losses : 0, first: r.first, key: r.key, seeded: seeds.has(r.url), points: r.points?.total ?? null });
  }
  return { rows, ratings, medians, seeded: seeds };
}

/** The points of a newcomer among the members' points (meta.pointsHist: [[floor(points), n]] best first), as a starting rating. */
function seedFromPoints(points, meta) {
  const hist = meta?.pointsHist ?? [];
  const n = hist.reduce((s, [, c]) => s + c, 0);
  const b = Math.floor(points);
  let above = 0;
  let mine = 0;
  for (const [bucket, c] of hist) {
    if (bucket > b) above += c;
    else if (bucket === b) mine = c;
  }
  return seedRating(Math.round(above + mine / 2) + 1, n + 1);
}

/** Members per whole point, best first: what a newcomer's starting place is read from. */
const pointsHistOf = (members) => {
  const m = new Map();
  for (const r of members) {
    const b = Math.floor(r.points.total);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[0] - a[0]);
};

/**
 * A newcomer's row (a site measured or graded, not yet in the library, or a
 * visitor's site): a listed site's own row when it has a starting rank
 * already; otherwise a starting rank from its Code checks score (pointsOf:
 * its grade or, ungraded, its measured facts; the library's medians for what
 * is not measured), keeping any face-offs it has. The caller has decided it
 * may join (libraryMember, or a usable visitor grade).
 */
function newcomer(meta, row, grade, sources = {}, now = new Date()) {
  if (row?.seeded === 1 || !SEED_FROM_CHECKS) return { row, points: null };
  const points = pointsOf(grade, sources, meta?.medians, now);
  const seed = seedFromPoints(points.total, meta);
  const base = row ?? rowOf(null, "");
  // With face-offs already (a site voted on before it joined): its own rating, from a fresh start.
  const rated = base.votes > 0 ? { mu: base.mu, sigma: base.sigma } : seed;
  return { row: { ...base, ...rated, member: 1, seeded: 1, points: points.total, gkey: gradeKey(checksReading(grade, sources.facts, { now })), first: base.first ?? now.getTime() }, points };
}

/** The stored rank of a standing (lib/tiers-db.mjs standingOf), with the points breakdown when there is one. */
const rankFrom = (s, points) => ({ ...storedRank({ ...s, ranked: s.of }), ...(points ? { check: packCheck(points) } : {}) });

/**
 * A Gemini grade about to be written for `url`, with its rank (and the
 * site's row in tier_ratings): a few reads by primary key and the daily meta,
 * no scan. A site that already has a Starting rank (from the code checks, at
 * capture) keeps it: a grade never moves the order. A site without one gets
 * it now from its Code checks score; one taken out before comes back as it
 * was. Any grade that is not Gemini's "yes" ("not a portfolio", an error, a
 * marker waiting for a fresh grade) is returned without a rank and takes the
 * site out of the order, as before this rule; the daily run puts a site the
 * membership rule still accepts back with its rating (seedNewcomers), and
 * never one waiting for its fresh grade or graded "not a portfolio" (the
 * Removal rule decides the rest, lib/reviews/door.mjs).
 */
export async function rankForWrite(db, rubric, { url = "", now = Date.now() } = {}) {
  if (!rubric || typeof rubric !== "object") return rubric;
  const { rank: _old, ...grade } = rubric;
  void _old;
  await ensureTierSchema(db);
  if (!usable(grade)) {
    if (url) await db.execute({ sql: "UPDATE tier_ratings SET member = 0, dirty = 1 WHERE url = ? AND member = 1", args: [url] });
    return grade;
  }
  const [meta, current, sources] = await Promise.all([
    readTierMeta(db),
    url ? readSiteRow(db, url) : null,
    url ? checkSources(db, { only: url }).then((m) => m.get(url) ?? {}) : {},
  ]);
  const { row, points } = newcomer(meta, current?.fresh ? null : current, grade, sources, new Date(now));
  const me = row ?? current;
  // A member from now on: a site taken out before (its seeded row kept) comes back with its rating.
  if (url && me) await upsertMember(db, { ...me, url, member: 1 }, new Date(now).toISOString(), { dirty: points || me.member !== 1 ? 1 : 0 });
  return { ...grade, rank: rankFrom(standingOf({ ...me, url: url || me.url, member: 1 }, meta), points) };
}

/**
 * Writes a member's whole row (the rebuild, a new member); the rating's
 * bucket and the histogram follow. `dirty` marks a new member for the next
 * daily run, which writes its letter (lib/tiers-db.mjs dailyTiers).
 */
function memberStmt(r, at, { dirty = 0 } = {}) {
  const rating = cautious(r);
  return {
    sql: `INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, votes, wins, member, seeded, points, gkey, first, tier, dirty, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma, rating = excluded.rating, bucket = excluded.bucket,
            faceoffs = excluded.faceoffs, votes = excluded.votes, wins = excluded.wins, member = excluded.member, seeded = excluded.seeded,
            points = excluded.points, gkey = excluded.gkey, first = excluded.first, tier = excluded.tier, dirty = MAX(tier_ratings.dirty, excluded.dirty),
            updated_at = excluded.updated_at`,
    args: [r.url, r.mu, r.sigma, rating, bucketOf(rating), r.faceoffs ?? 0, r.votes ?? 0, r.wins ?? 0, r.member ? 1 : 0, r.seeded ? 1 : 0, r.points ?? null, r.gkey ?? null, r.first ?? null, r.tier ?? null, dirty ? 1 : 0, at],
  };
}
const upsertMember = (db, r, at, opts) => db.execute(memberStmt(r, at, opts));

/** Sites a daily run gives a Starting rank at most (the first run after this rule takes the backlog of about 160). */
export const NEWCOMERS_PER_RUN = 300;

/**
 * Listed sites that may be library members and are not: never ranked, or
 * ranked once and taken out since (delisted, down, a grade that was not an
 * answer). Not removed by their owner, not graded "not a portfolio", not
 * waiting for a fresh grade, and with a Gemini "yes", or a live capture with
 * facts and STRONG_SIGNALS or more signals or the owner's decision to keep
 * them. One indexed read for `only`; otherwise one pass over the list (the
 * daily run, never a visitor's request), at most `limit` rows.
 * libraryMember decides each one.
 */
async function joinable(db, { only = null, limit = NEWCOMERS_PER_RUN } = {}) {
  const o = await ownerSql(db);
  return rowsOf(db, {
    sql: `SELECT ${MEMBER_COLS(o)} FROM portfolios p
          WHERE ${LISTED_NOT_DOWN("p")} AND NOT ${NOT_PORTFOLIO("p")} AND NOT ${o.removed}
            AND NOT COALESCE(json_valid(p.ai_rubric) AND (json_extract(p.ai_rubric, '$.error') = 'fresh_grade_due' OR json_extract(p.ai_rubric, '$.fresh_grade') = 'due'), 0)
            AND NOT EXISTS (SELECT 1 FROM tier_ratings t WHERE t.url = p.url AND t.seeded = 1 AND t.member = 1)
            AND (${GEMINI_YES_SQL("p")}
              OR (p.status = 'live' AND p.shot_key IS NOT NULL AND p.facts IS NOT NULL AND json_valid(p.facts) AND (${SIGNALS_SQL("p")} >= ${STRONG_SIGNALS} OR ${o.keeps})))
            ${only ? "AND p.url = ?" : ""}
          ORDER BY p.url LIMIT ?`,
    args: only ? [only, limit] : [limit],
  });
}

/**
 * Gives each joinable row (joinable) that libraryMember accepts its place:
 * a site never ranked gets its Starting rank, its place among the members by
 * its Code checks score (the library's points histogram and medians from the
 * last rebuild, meta.pointsHist), as a new grade got it before; a site ranked
 * before comes back with the rating, votes, face-offs and starting points it
 * had. No other row's rating or votes move. Each row is marked for the daily
 * run (its letter). Returns the urls placed.
 */
async function seedRows(db, rows, meta, now) {
  if (!rows.length) return [];
  const at = new Date(now);
  const urls = rows.map((r) => String(r.url));
  const [sources, existing] = await Promise.all([
    checkSources(db, { urls }),
    (async () => {
      const m = new Map();
      for (const part of chunk(urls, 100)) {
        const res = await db.execute({ sql: `SELECT ${COLS} FROM tier_ratings WHERE url IN (${part.map(() => "?").join(",")})`, args: part });
        for (const r of res.rows) m.set(String(r.url), rowOf(r));
      }
      return m;
    })(),
  ]);
  const writes = [];
  const ranked = [];
  for (const r of rows) {
    const url = String(r.url);
    const grade = parse(r.ai_rubric);
    if (!memberOfRow(r, grade)) continue;
    const current = existing.get(url) ?? null;
    if (current?.seeded === 1) {
      // Back in the library, as it was: its rating, votes and starting points are kept.
      if (current.member === 1) continue;
      const back = { ...current, url, member: 1 };
      writes.push(memberStmt({ ...back, tier: standingOf(back, meta).tier }, at.toISOString(), { dirty: 1 }));
      ranked.push(url);
      continue;
    }
    const { row, points } = newcomer(meta, current, grade, sources.get(url) ?? { facts: r.facts }, at);
    if (!row || !points) continue;
    const s = standingOf({ ...row, url, member: 1 }, meta);
    writes.push(memberStmt({ ...row, url, tier: s.tier }, at.toISOString(), { dirty: 1 }));
    ranked.push(url);
  }
  for (const part of chunk(writes, 100)) await db.batch(part, "write");
  return ranked;
}

/**
 * A site's Starting rank as soon as it is measured (pipeline/capture.mjs,
 * after a stored capture with facts): when it may join the library
 * (libraryMember) and has none yet, its place by its Code checks score, no
 * Gemini grade needed. A few reads by key. Before the first rebuild (no
 * library yet) nothing is done: the rebuild places it. Returns true when the
 * site was ranked.
 */
export async function rankFromCode(db, url, { now = Date.now() } = {}) {
  if (!url) return false;
  await ensureTierSchema(db);
  const meta = await readTierMeta(db);
  if (!meta) return false;
  return (await seedRows(db, await joinable(db, { only: url, limit: 1 }), meta, now)).length > 0;
}

/**
 * The daily run's first step: every listed site measured since that may join
 * the library and has no Starting rank (the capture's own step can fail, and
 * sites measured before this rule have none) gets one, as rankFromCode
 * would. At most NEWCOMERS_PER_RUN a day. Returns the urls ranked.
 */
export async function seedNewcomers(db, { now = Date.now(), limit = NEWCOMERS_PER_RUN, log = () => {} } = {}) {
  await ensureTierSchema(db);
  const meta = await readTierMeta(db);
  if (!meta) return [];
  const ranked = await seedRows(db, await joinable(db, { limit }), meta, now);
  if (ranked.length) log(`tiers: ${ranked.length} measured site(s) given a Starting rank`);
  return ranked;
}

/**
 * The daily run (worker/tiers.ts, scripts/refresh-tiers.mjs --daily): newly
 * measured members get their Starting rank (seedNewcomers), then the cutoffs
 * and the letters that changed (lib/tiers-db.mjs dailyTiers), the newcomers'
 * included. Returns dailyTiers' counts and `joined`, how many were ranked.
 * @param {any} db
 * @param {{ now?: number, purge?: ((urls: string[]) => Promise<unknown>) | null, log?: (line: string) => void }} [options]
 */
export async function dailyRun(db, { now = Date.now(), purge = null, log = () => {} } = {}) {
  const joined = await seedNewcomers(db, { now, log });
  const r = await dailyTiers(db, { now, purge, log });
  return { ...r, joined: joined.length };
}

/**
 * The rank of a visitor's grade ("Grade my portfolio"): a listed site's own
 * row when it has one, otherwise a starting rank from the points its grade
 * shows; its letter from the daily cutoffs. `library` is { meta, row }.
 * Null for "not a portfolio" or an unusable grade.
 */
export function placeGrade(grade, library, { now = new Date() } = {}) {
  if (!usable(grade)) return null;
  const meta = library?.meta ?? null;
  const own = library?.row && !library.row.fresh ? library.row : null;
  const { row } = newcomer(meta, own, grade, {}, now);
  const me = row ?? own ?? rowOf(null, "");
  return { ...storedRank({ ...standingOf({ ...me, member: 1 }, meta), ranked: meta?.n ?? null }), v: LADDER_VERSION };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * The full rebuild (at deploy on staging, and by hand): points from
 * automated checks, starting ranks, a replay of every face-off, written into
 * tier_ratings (only rows that changed), then the cutoffs, then every
 * member's letter and each Gemini grade's copy of its rank where it changed.
 * Members graded by Gemini or measured by code alike (loadGrades). The daily
 * run (dailyRun) keeps it current after that. Returns { library, ranked, updated, cleared, jobs, distribution, rows }.
 */
export async function refreshTiers(db, { now = Date.now(), log = () => {} } = {}) {
  await ensureTierSchema(db);
  const at = new Date(now).toISOString();
  const loaded = await loadGrades(db, { now: new Date(now) });
  const members = loaded.rows.filter((r) => r.member);
  const memberSet = new Set(members.map((r) => r.url));
  // Every row as it should be: the members, and every other site with face-offs.
  const want = new Map();
  for (const r of members) {
    const e = r.entry;
    want.set(r.url, { url: r.url, mu: e.mu, sigma: e.sigma, faceoffs: e.faceoffs, votes: e.votes, wins: e.wins, member: 1, seeded: e.seeded ? 1 : 0, points: e.points, gkey: e.key, first: Number.isFinite(e.first) && e.first < Number.MAX_SAFE_INTEGER ? e.first : null });
  }
  for (const [url, x] of loaded.ratings) {
    if (memberSet.has(url)) continue;
    want.set(url, { url, mu: x.mu, sigma: x.sigma, faceoffs: x.faceoffs, votes: x.wins + x.losses, wins: x.won ?? 0, member: 0, seeded: 0, points: null, gkey: null, first: null });
  }
  const have = new Map((await db.execute("SELECT url, mu, sigma, faceoffs, votes, wins, member, seeded, points, gkey, first, tier FROM tier_ratings")).rows.map((r) => [String(r.url), rowOf(r)]));
  const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);
  const same = (a, b) => ["mu", "sigma", "faceoffs", "votes", "wins", "member", "seeded", "points", "gkey", "first"].every((k) => close(a[k], b[k]));
  const rowWrites = [];
  for (const [url, w] of want) {
    const h = have.get(url);
    if (!h || !same(w, h)) rowWrites.push(memberStmt({ ...w, tier: h?.tier ?? null }, at));
  }
  // Rows that no longer belong: out of the library, no face-offs.
  for (const [url, h] of have) if (!want.has(url) && (h.member || h.votes)) rowWrites.push({ sql: "UPDATE tier_ratings SET member = 0, votes = 0, faceoffs = 0, wins = 0, updated_at = ? WHERE url = ?", args: [at, url] });
  for (const part of chunk(rowWrites, 200)) await db.batch(part, "write");

  // The cutoffs, and the library facts a newcomer is placed with.
  const cut = await computeCutoffs(db);
  const meta = { ...cut, medians: loaded.medians, pointsHist: pointsHistOf(members), at };

  const writes = [];
  let updated = 0;
  let cleared = 0;
  const tiers = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const tierCol = [];
  for (const r of loaded.rows) {
    const standing = () => {
      const row = want.get(r.url) ?? { ...rowOf(null, r.url) };
      return standingOf({ ...row, member: r.member ? 1 : 0, seeded: row.seeded ?? 0 }, meta);
    };
    // Every member's letter in tier_ratings, graded by Gemini or not.
    if (r.member) {
      const s = standing();
      tiers[s.tier] = (tiers[s.tier] ?? 0) + 1;
      if ((have.get(r.url)?.tier ?? null) !== s.tier) tierCol.push({ sql: "UPDATE tier_ratings SET tier = ? WHERE url = ?", args: [s.tier, r.url] });
    }
    // The copy of the rank kept in a Gemini grade (portfolios.ai_rubric.rank), for the sites that have one.
    const g = r.grade;
    if (!g || g.error || r.raw == null) continue;
    let wantRank = null;
    if (usable(g)) {
      const s = standing();
      wantRank = { ...storedRank({ ...s, ranked: s.of }), ...(r.points ? { check: packCheck(r.points) } : {}) };
    }
    const haveRank = g.rank && typeof g.rank === "object" ? g.rank : null;
    if (sameRank(wantRank, haveRank)) continue;
    if (wantRank) updated++;
    else cleared++;
    writes.push(
      wantRank
        ? { sql: "UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.rank', json(?)) WHERE url = ? AND ai_rubric = ?", args: [JSON.stringify(wantRank), r.url, r.raw] }
        : { sql: "UPDATE portfolios SET ai_rubric = json_remove(ai_rubric, '$.rank') WHERE url = ? AND ai_rubric = ?", args: [r.url, r.raw] }
    );
  }
  for (const part of chunk([...writes, ...tierCol], 200)) await db.batch(part, "write");
  await db.execute("UPDATE tier_ratings SET dirty = 0 WHERE dirty = 1");
  await writeTierMeta(db, meta, now);
  const jobs = await rankOldReports(db, meta);
  log(`tiers rebuild: library ${meta.n}, ${rowWrites.length} rating row(s) written, ${updated} rank(s) written, ${cleared} cleared, ${jobs} report(s) placed; ${Object.entries(tiers).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  return { library: members.length, ranked: meta.n, updated, cleared, jobs, distribution: tiers, rows: rowWrites.length };
}

/**
 * Reports of "Grade my portfolio" placed on an older ladder (LADDER_VERSION),
 * or before tiers by ELO: each gets its rank as it is now (its site's row,
 * one read by key). Their "top N%" by grade (report.percentile) stays.
 */
async function rankOldReports(db, meta) {
  let rows;
  try {
    rows = (
      await db.execute({
        sql: `SELECT id, url, result, report FROM grade_jobs
              WHERE status = 'done' AND result IS NOT NULL AND json_valid(result) AND json_valid(report)
                AND COALESCE(json_extract(report, '$.rank.v'), 0) != ? AND COALESCE(json_extract(report, '$.unranked'), 0) != ?
              LIMIT ?`,
        args: [LADDER_VERSION, LADDER_VERSION, JOBS_PER_REFRESH],
      })
    ).rows;
  } catch (e) {
    if (noTable(e)) return 0;
    throw e;
  }
  const writes = [];
  for (const r of rows) {
    const row = await readSiteRow(db, String(r.url));
    const rank = placeGrade(parse(r.result), { meta, row });
    const report = parse(r.report) ?? {};
    // "Not a portfolio" and unusable grades are marked, so they are not read again.
    const next = rank ? { ...report, unranked: undefined, rank } : { ...report, rank: undefined, unranked: LADDER_VERSION };
    writes.push({ sql: "UPDATE grade_jobs SET report = ? WHERE id = ? AND report = ?", args: [JSON.stringify(next), String(r.id), String(r.report)] });
  }
  for (const part of chunk(writes, 100)) await db.batch(part, "write");
  return writes.length;
}
