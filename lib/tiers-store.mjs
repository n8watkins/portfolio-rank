// The database side of tiers by ELO (lib/tiers.mjs): each graded portfolio
// gets points from automated checks (lib/check-points.mjs, saved data only)
// and a starting rating from its place by points; every real face-off is
// replayed on top (lib/tiers-rating.mjs, no AI request), the library is put
// in order by rating, and each graded portfolio's rank is written into its
// grade as `rank` = { tier, elo, faceoffs, votes, top, place, of,
// provisional, seeded, points, check } (`check`: the points breakdown, as
// [item, points, measured] rows):
//
//   refreshTiers   the whole library: hourly on the Worker's Cron Trigger
//                  (worker/tiers.ts), at each deploy, and by hand with
//                  scripts/refresh-tiers.mjs. Writes only the grades whose
//                  rank changed, and places reports of "Grade my portfolio"
//                  made on an older ladder.
//   rankForWrite   one new grade, as it is written (the nightly grader, the
//                  judge script), placed against the last refresh's library
//                  so it shows its tier at once.
//
// The last refresh's library (each member's rating, face-offs and date first
// graded, plus the rating of every other site with face-offs) is kept in the
// cache table under LIBRARY_KEY, so placing a grade or drawing the ranked
// leaderboard reads one row.
import { ACTIVE, NOT_PORTFOLIO } from "../pipeline/roster.mjs";
import { readVoteComparisons } from "./ranking/store.mjs";
import { LADDER_VERSION, SEED_FROM_CHECKS, compareSeed, distribution, entryOf, orderLibrary, placeNew, rankLibrary, rankedCount, seedRating, storedRank } from "./tiers.mjs";
import { rateFaceoffs } from "./tiers-rating.mjs";
import { gradeKey } from "./grade-score.mjs";
import { checkPoints, checkShares, libraryMedians } from "./check-points.mjs";

// v5: starting ranks from automated checks, then face-offs.
export const LIBRARY_KEY = "tiers:library:v5";
/** A cached library older than this is rebuilt before a grade is placed in it. */
export const LIBRARY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
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

/** Whether a grade can be a library member: a usable grade (Gemini answered) that is a portfolio. */
const usable = (g) => Boolean(g && typeof g === "object" && !g.error && typeof g.tier === "string" && g.tier && g.is_portfolio !== false);

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
 * mobile and desktop and the polish fetch (cache rows), and the capture's
 * diagnostics (portfolios.meta). url -> { psi, psiDesktop, inspect, meta }.
 */
async function checkSources(db, { only = null } = {}) {
  const out = new Map();
  const of = (url) => {
    if (!out.has(url)) out.set(url, { psi: null, psiDesktop: null, inspect: null, meta: null });
    return out.get(url);
  };
  const range = (p) => (only ? { sql: "k = ?", args: [`${p}:${only}`] } : { sql: "(k >= ? AND k < ?)", args: [`${p}:`, `${p};`] });
  const parts = ["psi", "psi-desktop", "inspect"].map(range);
  const [cache, metas] = await Promise.all([
    rowsOf(db, { sql: `SELECT k, v FROM cache WHERE ${parts.map((p) => p.sql).join(" OR ")}`, args: parts.flatMap((p) => p.args) }),
    rowsOf(db, only ? { sql: "SELECT url, meta FROM portfolios WHERE url = ? AND meta IS NOT NULL", args: [only] } : "SELECT url, meta FROM portfolios WHERE meta IS NOT NULL"),
  ]);
  for (const r of cache) {
    const k = String(r.k);
    const v = parse(r.v);
    if (k.startsWith("psi-desktop:")) of(k.slice(12)).psiDesktop = v;
    else if (k.startsWith("psi:")) of(k.slice(4)).psi = v;
    else if (k.startsWith("inspect:")) of(k.slice(8)).inspect = v;
  }
  for (const r of metas) of(String(r.url)).meta = parse(r.meta);
  return out;
}

/** When a site was first graded: the oldest of its history and its current grade, ms. */
function firstOf(url, grade, first) {
  const judged = Date.parse(String(grade?.judged_at ?? ""));
  const at = [first.get(url), Number.isFinite(judged) ? judged : null].filter((x) => typeof x === "number");
  return at.length ? Math.min(...at) : null;
}

/**
 * Every stored grade with whether it is a library member and its entry in
 * the order: { rows: [{ url, grade, raw, member, entry, points }], ratings,
 * medians }. Members get points from automated checks and a starting rating
 * from their place by points; then every real face-off is replayed.
 */
export async function loadGrades(db, { now = new Date() } = {}) {
  const [res, faceoffs, first, sources] = await Promise.all([
    db.execute(
      `SELECT url, ai_rubric, (${ACTIVE()} AND NOT ${NOT_PORTFOLIO()}) AS active FROM portfolios
       WHERE ai_rubric IS NOT NULL AND json_valid(ai_rubric)`
    ),
    loadFaceoffs(db),
    firstGraded(db),
    checkSources(db),
  ]);
  const year = now.getUTCFullYear();
  const rows = res.rows.map((r) => {
    const grade = parse(r.ai_rubric);
    const url = String(r.url);
    const member = Number(r.active) === 1 && usable(grade);
    const shares = member ? checkShares({ ...(sources.get(url) ?? {}), grade, year }) : null;
    return { url, grade, raw: String(r.ai_rubric), member, shares, key: gradeKey(grade), first: firstOf(url, grade, first) };
  });
  const members = rows.filter((r) => r.member);
  const medians = libraryMedians(members.map((r) => r.shares));
  for (const r of members) r.points = checkPoints(r.shares, medians);
  // Starting ratings by place in points order (ties: the Gemini score, the date first graded, the address).
  const seeds = new Map();
  if (SEED_FROM_CHECKS) {
    const bySeed = [...members].sort((a, b) => compareSeed({ ...a, points: a.points.total }, { ...b, points: b.points.total }));
    bySeed.forEach((r, i) => seeds.set(r.url, seedRating(i + 1, bySeed.length)));
  }
  const ratings = rateFaceoffs(faceoffs, { seeds });
  for (const r of rows) {
    const x = ratings.get(r.url);
    r.entry = entryOf({ url: r.url, mu: x?.mu, sigma: x?.sigma, faceoffs: x?.faceoffs, votes: x ? x.wins + x.losses : 0, first: r.first, key: r.key, seeded: seeds.has(r.url), points: r.points?.total ?? null });
  }
  return { rows, ratings, medians, seeded: seeds };
}

/** The library in its full order (lib/tiers.mjs orderLibrary), from loadGrades. */
export const libraryOrder = ({ rows }) => orderLibrary(rows.filter((r) => r.member).map((r) => r.entry));

const FIELDS = ["url", "mu", "sigma", "faceoffs", "first", "key", "seeded", "points", "votes"];
const pack = (e) => FIELDS.map((f) => (typeof e[f] === "number" ? Math.round(e[f] * 1e4) / 1e4 : typeof e[f] === "boolean" ? (e[f] ? 1 : 0) : e[f]));

/** Sites with face-offs that are not library members (ungraded, delisted...), so their ELO can be shown and placed. */
const othersOf = (ratings, order, seeded = new Map()) => {
  const members = new Set(order.map((e) => e.url));
  return [...ratings]
    .filter(([url]) => !members.has(url) && !seeded.has(url))
    .map(([url, r]) => entryOf({ url, mu: r.mu, sigma: r.sigma, faceoffs: r.faceoffs, votes: r.wins + r.losses }));
};

async function saveLibrary(db, order, others, now, medians = null) {
  try {
    await db.execute({
      sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
      args: [LIBRARY_KEY, JSON.stringify({ fields: FIELDS, order: order.map(pack), others: others.map(pack), medians, at: new Date(now).toISOString() }), now],
    });
  } catch (e) {
    // A pipeline-only database without the app's cache table: nothing to keep.
    if (!noTable(e)) throw e;
  }
}

/**
 * The last refresh's library: { order (members, best first), others (every
 * other site with face-offs), medians (the checks' library medians), at }. Rebuilt from the grades and face-offs
 * (without writing any rank) when there is none or it is older than
 * LIBRARY_MAX_AGE_MS.
 */
export async function cachedLibraryState(db, { now = Date.now() } = {}) {
  let hit;
  try {
    hit = (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [LIBRARY_KEY] })).rows[0];
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  const v = hit ? parse(hit.v) : null;
  if (v && Array.isArray(v.order) && Array.isArray(v.fields) && now - Number(hit.at) < LIBRARY_MAX_AGE_MS) {
    const unpack = (row) => entryOf(Object.fromEntries(v.fields.map((f, i) => [f, row[i]])));
    return { order: v.order.map(unpack), others: (v.others ?? []).map(unpack), medians: v.medians ?? null, at: String(v.at ?? "") };
  }
  const loaded = await loadGrades(db, { now: new Date(now) });
  const order = libraryOrder(loaded);
  const others = othersOf(loaded.ratings, order, loaded.seeded);
  await saveLibrary(db, order, others, now, loaded.medians);
  return { order, others, medians: loaded.medians, at: new Date(now).toISOString() };
}

/** The last refresh's library in its full order (cachedLibraryState().order). */
export const cachedLibrary = async (db, opts) => (await cachedLibraryState(db, opts)).order;

/** A site's entry in a cached library state (member or not), or a fresh one without face-offs. */
export const entryIn = (state, url) => state.order.find((e) => e.url === url) ?? state.others.find((e) => e.url === url) ?? entryOf({ url });

/**
 * A newcomer's entry (a grade not yet in the library: a new member before the
 * next refresh, a visitor's site): its own face-offs if it has any, and, when
 * it is graded, a starting rank from its points placed among the members'
 * points. `sources` is its saved check data (checkSources), if any.
 */
function newcomer(state, url, grade, sources = {}, now = new Date()) {
  const known = url ? (state.order.find((e) => e.url === url) ?? state.others.find((e) => e.url === url)) : null;
  if (known?.seeded) return { entry: known, points: null };
  const base = known ?? entryOf({ url });
  if (!SEED_FROM_CHECKS || !usable(grade) || !state.medians) return { entry: base, points: null };
  const points = checkPoints(checkShares({ ...sources, grade, year: now.getUTCFullYear() }), state.medians);
  const me = { url: url || "\uffff", points: points.total, key: gradeKey(grade), first: now.getTime() };
  const members = state.order.filter((e) => e.seeded && e.url !== url);
  const place = 1 + members.filter((e) => compareSeed(e, me) < 0).length;
  // No face-offs yet: the starting rating of its place. With face-offs: its own replayed rating (fresh start).
  const seed = seedRating(place, members.length + 1);
  const entry = known ? entryOf({ ...known, seeded: true, points: points.total }) : entryOf({ url: me.url, mu: seed.mu, sigma: seed.sigma, seeded: true, points: points.total, key: me.key, first: me.first });
  return { entry, points };
}

/**
 * A grade about to be written for `url`, with its rank against the cached
 * library (as a newcomer: the hourly refresh then places it exactly). A
 * grade that can't be ranked ("not a portfolio", no answer) is returned
 * without one.
 */
export async function rankForWrite(db, rubric, { url = "", now = Date.now() } = {}) {
  if (!rubric || typeof rubric !== "object") return rubric;
  const { rank: _old, ...grade } = rubric;
  void _old;
  if (!usable(grade)) return grade;
  const state = await cachedLibraryState(db, { now });
  const sources = url ? ((await checkSources(db, { only: url })).get(url) ?? {}) : {};
  const { entry, points } = newcomer(state, url, grade, sources, new Date(now));
  const placed = placeNew(state.order.filter((e) => e.url !== url), { ...entry, url: url || "\uffff" });
  return { ...grade, rank: { ...storedRank(placed), ...(points ? { check: packCheck(points) } : {}) } };
}

/**
 * The rank of a visitor's grade ("Grade my portfolio") against a library
 * state: a listed site keeps its own rank; any other site gets a starting
 * rank from the points its grade alone can show (the library's medians for
 * the rest). Null for "not a portfolio" or an unusable grade.
 */
export function placeGrade(grade, state, { url = "", now = new Date() } = {}) {
  if (!usable(grade)) return null;
  const { entry } = newcomer(state, url, grade, {}, now);
  return { ...storedRank(placeNew(state.order.filter((e) => e.url !== url), { ...entry, url: url || "\uffff" })), v: LADDER_VERSION };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Recomputes every grade's rank and writes the ones that changed. A grade
 * replaced while this ran is left alone (the write checks it is still the
 * grade that was read). Returns { library, ranked, updated, cleared, jobs,
 * distribution }.
 */
export async function refreshTiers(db, { now = Date.now(), log = () => {} } = {}) {
  const loaded = await loadGrades(db, { now: new Date(now) });
  const order = libraryOrder(loaded);
  const others = othersOf(loaded.ratings, order, loaded.seeded);
  const ranks = rankLibrary(order);
  const writes = [];
  let updated = 0;
  let cleared = 0;
  for (const r of loaded.rows) {
    const g = r.grade;
    if (!g || g.error) continue;
    let want = null;
    if (usable(g)) {
      want = storedRank((r.member ? ranks.get(r.url) : null) ?? placeNew(order, r.entry));
      if (r.points) want.check = packCheck(r.points);
    }
    const have = g.rank && typeof g.rank === "object" ? g.rank : null;
    if (sameRank(want, have)) continue;
    if (want) updated++;
    else cleared++;
    writes.push(
      want
        ? { sql: "UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.rank', json(?)) WHERE url = ? AND ai_rubric = ?", args: [JSON.stringify(want), r.url, r.raw] }
        : { sql: "UPDATE portfolios SET ai_rubric = json_remove(ai_rubric, '$.rank') WHERE url = ? AND ai_rubric = ?", args: [r.url, r.raw] }
    );
  }
  for (const part of chunk(writes, 200)) await db.batch(part, "write");
  await saveLibrary(db, order, others, now, loaded.medians);
  const jobs = await rankOldReports(db, { order, others, medians: loaded.medians });
  const dist = distribution(order);
  const ranked = rankedCount(order);
  log(`tiers: library ${order.length}, ${ranked} ranked, ${updated} rank(s) written, ${cleared} cleared, ${jobs} report(s) placed; ${Object.entries(dist).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  return { library: order.length, ranked, updated, cleared, jobs, distribution: dist };
}

/**
 * Reports of "Grade my portfolio" placed on an older ladder (LADDER_VERSION),
 * or before tiers by ELO: each gets its rank against the library as it is
 * now. Their "top N%" by grade (report.percentile) stays as it was.
 */
async function rankOldReports(db, state) {
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
    const rank = placeGrade(parse(r.result), state, { url: String(r.url) });
    const report = parse(r.report) ?? {};
    // "Not a portfolio" and unusable grades are marked, so they are not read again.
    const next = rank ? { ...report, unranked: undefined, rank } : { ...report, rank: undefined, unranked: LADDER_VERSION };
    writes.push({ sql: "UPDATE grade_jobs SET report = ? WHERE id = ? AND report = ?", args: [JSON.stringify(next), String(r.id), String(r.report)] });
  }
  for (const part of chunk(writes, 100)) await db.batch(part, "write");
  return writes.length;
}
