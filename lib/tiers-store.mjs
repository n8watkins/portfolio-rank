// The full rebuild of tiers by ELO (lib/tiers.mjs), and placing one grade:
//
//   refreshTiers   the whole library, from scratch: points from automated
//                  checks (lib/check-points.mjs, saved data only), a starting
//                  rating from each graded portfolio's place by points, every
//                  real face-off replayed on top (lib/tiers-rating.mjs), all
//                  written into tier_ratings (lib/tiers-db.mjs), then the
//                  cutoffs and each grade's `rank` = { tier, elo, faceoffs,
//                  votes, top, place, of, provisional, seeded, points, check }.
//                  At each deploy on staging and by hand
//                  (scripts/refresh-tiers.mjs); day to day, votes and the daily
//                  run (lib/tiers-db.mjs) keep it current without it.
//   rankForWrite   one new grade, as it is written (the nightly grader, the
//                  judge script): its site's row and rank, from a few reads by key.
//   placeGrade     a visitor's report: its rank from its site's row or its points.
//
// No AI request anywhere.
import { ACTIVE, NOT_PORTFOLIO } from "../pipeline/roster.mjs";
import { readVoteComparisons } from "./ranking/store.mjs";
import { LADDER_VERSION, SEED_FROM_CHECKS, TIERS, cautious, compareSeed, entryOf, seedRating, storedRank } from "./tiers.mjs";
import { bucketOf, computeCutoffs, ensureTierSchema, readSiteRow, readTierMeta, rowOf, standingOf, writeTierMeta } from "./tiers-db.mjs";
import { rateFaceoffs } from "./tiers-rating.mjs";
import { gradeKey } from "./grade-score.mjs";
import { checkPoints, checkShares, libraryMedians } from "./check-points.mjs";

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
 * A newcomer's row (a grade not yet in the library, or a visitor's site): a
 * listed site's own row when it has a starting rank already; otherwise a
 * starting rank from the points its data shows (the library's medians for
 * the rest), keeping any face-offs it has.
 */
function newcomer(meta, row, grade, sources = {}, now = new Date()) {
  if (row?.seeded === 1 || !SEED_FROM_CHECKS || !usable(grade)) return { row, points: null };
  const medians = meta?.medians ?? libraryMedians([]);
  const points = checkPoints(checkShares({ ...sources, grade, year: now.getUTCFullYear() }), medians);
  const seed = seedFromPoints(points.total, meta);
  const base = row ?? rowOf(null, "");
  // With face-offs already (a site voted on before it was graded): its own rating, from a fresh start.
  const rated = base.votes > 0 ? { mu: base.mu, sigma: base.sigma } : seed;
  return { row: { ...base, ...rated, member: 1, seeded: 1, points: points.total, gkey: gradeKey(grade), first: base.first ?? now.getTime() }, points };
}

/** The stored rank of a standing (lib/tiers-db.mjs standingOf), with the points breakdown when there is one. */
const rankFrom = (s, points) => ({ ...storedRank({ ...s, ranked: s.of }), ...(points ? { check: packCheck(points) } : {}) });

/**
 * A grade about to be written for `url`, with its rank (and the site's row
 * in tier_ratings, as a member with its starting rank): a few reads by
 * primary key and the daily meta, no scan. A grade that can't be ranked ("not
 * a portfolio", no answer) is returned without one, and the site leaves the
 * library.
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
  if (url && me) await upsertMember(db, { ...me, url }, new Date(now).toISOString());
  return { ...grade, rank: rankFrom(standingOf({ ...me, member: 1 }, meta), points) };
}

/** Writes a member's whole row (the rebuild, a new grade); the rating's bucket and the histogram follow. */
function memberStmt(r, at) {
  const rating = cautious(r);
  return {
    sql: `INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, votes, member, seeded, points, gkey, first, tier, dirty, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(url) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma, rating = excluded.rating, bucket = excluded.bucket,
            faceoffs = excluded.faceoffs, votes = excluded.votes, member = excluded.member, seeded = excluded.seeded,
            points = excluded.points, gkey = excluded.gkey, first = excluded.first, tier = excluded.tier, updated_at = excluded.updated_at`,
    args: [r.url, r.mu, r.sigma, rating, bucketOf(rating), r.faceoffs ?? 0, r.votes ?? 0, r.member ? 1 : 0, r.seeded ? 1 : 0, r.points ?? null, r.gkey ?? null, r.first ?? null, r.tier ?? null, at],
  };
}
const upsertMember = (db, r, at) => db.execute(memberStmt(r, at));

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
 * tier_ratings (only rows that changed), then the cutoffs, then each grade's
 * rank where it changed. The daily run (lib/tiers-db.mjs dailyTiers) keeps it
 * current after that. Returns { library, ranked, updated, cleared, jobs, distribution, rows }.
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
    want.set(r.url, { url: r.url, mu: e.mu, sigma: e.sigma, faceoffs: e.faceoffs, votes: e.votes, member: 1, seeded: e.seeded ? 1 : 0, points: e.points, gkey: e.key, first: Number.isFinite(e.first) && e.first < Number.MAX_SAFE_INTEGER ? e.first : null });
  }
  for (const [url, x] of loaded.ratings) {
    if (memberSet.has(url)) continue;
    want.set(url, { url, mu: x.mu, sigma: x.sigma, faceoffs: x.faceoffs, votes: x.wins + x.losses, member: 0, seeded: 0, points: null, gkey: null, first: null });
  }
  const have = new Map((await db.execute("SELECT url, mu, sigma, faceoffs, votes, member, seeded, points, gkey, first, tier FROM tier_ratings")).rows.map((r) => [String(r.url), rowOf(r)]));
  const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);
  const same = (a, b) => ["mu", "sigma", "faceoffs", "votes", "member", "seeded", "points", "gkey", "first"].every((k) => close(a[k], b[k]));
  const rowWrites = [];
  for (const [url, w] of want) {
    const h = have.get(url);
    if (!h || !same(w, h)) rowWrites.push(memberStmt({ ...w, tier: h?.tier ?? null }, at));
  }
  // Rows that no longer belong: out of the library, no face-offs.
  for (const [url, h] of have) if (!want.has(url) && (h.member || h.votes)) rowWrites.push({ sql: "UPDATE tier_ratings SET member = 0, votes = 0, faceoffs = 0, updated_at = ? WHERE url = ?", args: [at, url] });
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
    const g = r.grade;
    if (!g || g.error) continue;
    let wantRank = null;
    if (usable(g)) {
      const row = want.get(r.url) ?? { ...rowOf(null, r.url) };
      const s = standingOf({ ...row, member: r.member ? 1 : 0, seeded: row.seeded ?? 0 }, meta);
      wantRank = { ...storedRank({ ...s, ranked: s.of }), ...(r.points ? { check: packCheck(r.points) } : {}) };
      if (r.member) {
        tiers[s.tier] = (tiers[s.tier] ?? 0) + 1;
        if ((have.get(r.url)?.tier ?? null) !== s.tier) tierCol.push({ sql: "UPDATE tier_ratings SET tier = ? WHERE url = ?", args: [s.tier, r.url] });
      }
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
