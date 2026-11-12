// The database side of tiers by rank (lib/tiers.mjs): every graded
// portfolio's rank is recomputed from the stored grades (no AI request) and
// written into its grade as `rank` = { tier, score, top }:
//
//   refreshTiers   the whole library: hourly on the Worker's Cron Trigger
//                  (worker/tiers.ts), and by hand with
//                  scripts/refresh-tiers.mjs. Writes only the grades whose
//                  rank changed, and finishes reports of "Grade my
//                  portfolio" made before tiers by rank (their report gets
//                  a rank against today's library).
//   rankForWrite   one new grade, as it is written (the nightly grader, the
//                  judge script), placed against the last refresh's library
//                  so it shows its tier at once.
//
// The last refresh's library (its keys, best first) is kept in the cache
// table under LIBRARY_KEY, so placing a grade reads one row.
import { ACTIVE, NOT_PORTFOLIO } from "../pipeline/roster.mjs";
import { distribution, placeKey, rankKey, rankOf, rankScore, sortedKeys } from "./tiers.mjs";

export const LIBRARY_KEY = "tiers:library";
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

const sameRank = (a, b) => (a == null && b == null) || (a != null && b != null && a.tier === b.tier && a.score === b.score && a.top === b.top);

/** Whether a grade can be a library member: a usable grade with Gemini's letter (the leaderboard's seed) and a score. */
const usable = (g) => Boolean(g && !g.error && typeof g.tier === "string" && g.tier && rankKey(g) != null);

/**
 * Every stored grade with whether it is a library member: [{ url, grade,
 * member }]. One read of the portfolios table.
 */
export async function loadGrades(db) {
  const rows = (
    await db.execute(
      `SELECT url, ai_rubric, (${ACTIVE()} AND NOT ${NOT_PORTFOLIO()}) AS active FROM portfolios
       WHERE ai_rubric IS NOT NULL AND json_valid(ai_rubric)`
    )
  ).rows;
  return rows.map((r) => {
    const grade = parse(r.ai_rubric);
    return { url: String(r.url), grade, raw: String(r.ai_rubric), member: Number(r.active) === 1 && usable(grade) };
  });
}

/** The library's keys, best first, from loadGrades rows. */
export const libraryKeys = (rows) => sortedKeys(rows.filter((r) => r.member).map((r) => rankKey(r.grade)));

const noTable = (e) => /no such table/i.test(String(e?.message ?? e));

async function saveLibrary(db, keys, now) {
  try {
    await db.execute({
      sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
      args: [LIBRARY_KEY, JSON.stringify({ keys, at: new Date(now).toISOString() }), now],
    });
  } catch (e) {
    // A pipeline-only database without the app's cache table: nothing to keep.
    if (!noTable(e)) throw e;
  }
}

/**
 * The last refresh's library keys (best first); rebuilt from the grades
 * (without writing any rank) when there is none or it is older than
 * LIBRARY_MAX_AGE_MS.
 */
export async function cachedLibraryKeys(db, { now = Date.now() } = {}) {
  const hit = (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [LIBRARY_KEY] }).catch((e) => (noTable(e) ? { rows: [] } : Promise.reject(e)))).rows[0];
  const v = hit ? parse(hit.v) : null;
  if (v && Array.isArray(v.keys) && now - Number(hit.at) < LIBRARY_MAX_AGE_MS) return v.keys;
  const keys = libraryKeys(await loadGrades(db));
  await saveLibrary(db, keys, now);
  return keys;
}

/**
 * A grade about to be written for `url`, with its rank against the cached
 * library (as a newcomer: the hourly refresh then places it exactly). A
 * grade that can't be ranked ("not a portfolio", no scores) is returned
 * without one.
 */
export async function rankForWrite(db, rubric, { now = Date.now() } = {}) {
  if (!rubric || typeof rubric !== "object") return rubric;
  const { rank: _old, ...grade } = rubric;
  void _old;
  if (!usable(grade) || grade.is_portfolio === false) return grade;
  const keys = await cachedLibraryKeys(db, { now });
  const rank = rankOf(grade, keys);
  return rank ? { ...grade, rank } : grade;
}

/**
 * The rank and "top N%" of a visitor's grade against a library (the grade
 * report): { rank: { tier, score, top }, percentile: { rank, total, topPct,
 * ahead } } or null when the grade can't be ranked.
 */
export function placeGrade(grade, keysDesc) {
  const key = rankKey(grade);
  const place = placeKey(keysDesc, key);
  if (!place) return null;
  return {
    rank: { tier: place.tier, score: rankScore(grade), top: place.top },
    percentile: {
      rank: place.rank,
      total: place.total,
      topPct: place.top,
      ahead: Math.round((100 * (place.total - place.position)) / place.total),
    },
  };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Recomputes every grade's rank and writes the ones that changed. A grade
 * replaced while this ran is left alone (the write checks it is still the
 * grade that was read). Returns { library, updated, cleared, jobs,
 * distribution }.
 */
export async function refreshTiers(db, { now = Date.now(), log = () => {} } = {}) {
  const rows = await loadGrades(db);
  const keys = libraryKeys(rows);
  const writes = [];
  let updated = 0;
  let cleared = 0;
  for (const r of rows) {
    const g = r.grade;
    if (!g || g.error) continue;
    const want = usable(g) && g.is_portfolio !== false ? rankOf(g, keys, { member: r.member }) : null;
    const have = g.rank && typeof g.rank === "object" ? { tier: g.rank.tier, score: g.rank.score, top: g.rank.top } : null;
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
  await saveLibrary(db, keys, now);
  const jobs = await rankOldReports(db, keys);
  const dist = distribution(keys);
  log(`tiers: library ${keys.length}, ${updated} rank(s) written, ${cleared} cleared, ${jobs} report(s) ranked; ${Object.entries(dist).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  return { library: keys.length, updated, cleared, jobs, distribution: dist };
}

/**
 * Reports of "Grade my portfolio" finished before tiers by rank: each gets
 * its rank and "top N%" against the library as it is now.
 */
async function rankOldReports(db, keys) {
  let rows;
  try {
    rows = (
      await db.execute({
        sql: `SELECT id, result, report FROM grade_jobs
              WHERE status = 'done' AND result IS NOT NULL AND json_valid(result) AND json_valid(report)
                AND json_extract(report, '$.rank') IS NULL AND json_extract(report, '$.unranked') IS NULL
              LIMIT ?`,
        args: [JOBS_PER_REFRESH],
      })
    ).rows;
  } catch (e) {
    if (noTable(e)) return 0;
    throw e;
  }
  const writes = [];
  for (const r of rows) {
    const placed = placeGrade(parse(r.result), keys);
    const report = parse(r.report) ?? {};
    // "Not a portfolio" and unscored grades are marked, so they are not read again.
    const next = placed ? { ...report, rank: placed.rank, percentile: { ...(report.percentile ?? {}), ...placed.percentile } } : { ...report, unranked: true };
    writes.push({ sql: "UPDATE grade_jobs SET report = ? WHERE id = ? AND report = ?", args: [JSON.stringify(next), String(r.id), String(r.report)] });
  }
  for (const part of chunk(writes, 100)) await db.batch(part, "write");
  return writes.length;
}
