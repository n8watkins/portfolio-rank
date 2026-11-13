// Tiers by ELO, kept incrementally (owner decision 2026-11-13: don't
// recompute everyone hourly):
//
//   applyFaceoff   a vote (a person's, the AI judge's, an AI comparison)
//                  updates only its two portfolios' ratings, at once, in
//                  tier_ratings, and marks them for the daily run
//   undoFaceoff    a person's Undo takes that back exactly when nothing
//                  else moved the two since (else as near as it can)
//   dailyTiers     once a day: the tier cutoffs (the rating at each band's
//                  last place) from a histogram kept by triggers plus a few
//                  indexed reads, then the stored letter rewritten only for
//                  the portfolios whose letter changed (the ones that got
//                  votes, and the ones between an old and a new cutoff)
//   readTierMeta   the cutoffs and histogram the daily run saved: any site's
//   siteStanding   letter, "top N%" and place are derived on read from its
//                  rating and those (lib/tiers.mjs tierForRating, placeForRating)
//
// The full rebuild (lib/tiers-store.mjs refreshTiers: points from automated
// checks, starting ranks, a replay of every face-off) fills these tables; it
// runs at deploy on staging and by hand. No AI request anywhere.
import { rateRanking } from "./ranking/engine.mjs";
import { MU, SIGMA_UNSURE, STARRED_WEIGHT } from "./ranking/config.mjs";
import { AI_VOTE_WEIGHT, MIN_FACEOFFS, STARTING_TIER, boundaryPlaces, cautious, eloOf, isRanked, placeForRating, tierForRating } from "./tiers.mjs";

/** Histogram buckets per rating point (a bucket is a quarter of a point). */
export const BUCKETS_PER_POINT = 4;
export const bucketOf = (rating) => Math.floor(rating * BUCKETS_PER_POINT);

const META_KEY = "cutoffs";

export const TIER_SCHEMA = [
  // One row per portfolio with a rating: library members (listed, graded, a portfolio) and any other site with face-offs.
  `CREATE TABLE IF NOT EXISTS tier_ratings (
    url TEXT PRIMARY KEY,
    mu REAL NOT NULL,
    sigma REAL NOT NULL,
    rating REAL NOT NULL,
    bucket INTEGER NOT NULL,
    faceoffs REAL NOT NULL DEFAULT 0,
    votes INTEGER NOT NULL DEFAULT 0,
    member INTEGER NOT NULL DEFAULT 0,
    seeded INTEGER NOT NULL DEFAULT 0,
    points REAL,
    gkey INTEGER,
    first REAL,
    tier TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`,
  // The board's order and the cutoffs' range reads.
  "CREATE INDEX IF NOT EXISTS tier_ratings_rank_idx ON tier_ratings (member, rating DESC)",
  // A cutoff's place inside its histogram bucket.
  "CREATE INDEX IF NOT EXISTS tier_ratings_bucket_idx ON tier_ratings (member, bucket, rating DESC)",
  // The portfolios that got votes since the last daily run.
  "CREATE INDEX IF NOT EXISTS tier_ratings_dirty_idx ON tier_ratings (dirty) WHERE dirty = 1",
  // Members per rating bucket, kept by the triggers below: the daily run reads this, never the whole table.
  "CREATE TABLE IF NOT EXISTS tier_hist (bucket INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
  `CREATE TRIGGER IF NOT EXISTS tier_hist_ins AFTER INSERT ON tier_ratings WHEN NEW.member = 1 BEGIN
     INSERT INTO tier_hist (bucket, n) VALUES (NEW.bucket, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_hist_del AFTER DELETE ON tier_ratings WHEN OLD.member = 1 BEGIN
     UPDATE tier_hist SET n = n - 1 WHERE bucket = OLD.bucket;
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_hist_out AFTER UPDATE OF bucket, member ON tier_ratings
     WHEN OLD.member = 1 AND (NEW.member != 1 OR NEW.bucket != OLD.bucket) BEGIN
     UPDATE tier_hist SET n = n - 1 WHERE bucket = OLD.bucket;
   END`,
  `CREATE TRIGGER IF NOT EXISTS tier_hist_in AFTER UPDATE OF bucket, member ON tier_ratings
     WHEN NEW.member = 1 AND (OLD.member != 1 OR NEW.bucket != OLD.bucket) BEGIN
     INSERT INTO tier_hist (bucket, n) VALUES (NEW.bucket, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1;
   END`,
  // The daily run's cutoffs and histogram, read by every page that shows a tier.
  "CREATE TABLE IF NOT EXISTS tier_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)",
  // What each person's vote changed, so Undo can take it back.
  "CREATE TABLE IF NOT EXISTS tier_undo (vote_id INTEGER PRIMARY KEY, w TEXT NOT NULL, l TEXT NOT NULL)",
];

const ready = new WeakMap();
/** Creates the tables once per database client (idempotent, additive). */
export function ensureTierSchema(db) {
  if (!ready.has(db)) {
    const p = (async () => {
      for (const sql of TIER_SCHEMA) await db.execute(sql);
    })();
    p.catch(() => ready.delete(db));
    ready.set(db, p);
  }
  return ready.get(db);
}

const num = (v, d = 0) => (v == null ? d : Number(v));

/**
 * @typedef {{ url: string, mu: number, sigma: number, faceoffs: number, votes: number, member: number, seeded: number,
 *   points: number | null, gkey: number | null, first: number | null, tier: string | null, fresh: boolean }} TierRow
 * @typedef {{ tier: string | null, elo: number, faceoffs: number, votes: number, top: number | null, place: number | null,
 *   of: number | null, provisional: boolean, seeded: boolean, points: number | null }} Standing
 */

/**
 * A tier_ratings row as plain numbers; a fresh rating when there is none.
 * @param {any} r
 * @param {string} [url]
 * @returns {TierRow}
 */
export function rowOf(r, url = r?.url) {
  if (!r) return { url, mu: MU, sigma: SIGMA_UNSURE, faceoffs: 0, votes: 0, member: 0, seeded: 0, points: null, gkey: null, first: null, tier: null, fresh: true };
  return {
    url: String(r.url ?? url),
    mu: num(r.mu, MU),
    sigma: num(r.sigma, SIGMA_UNSURE),
    faceoffs: num(r.faceoffs),
    votes: num(r.votes),
    member: num(r.member),
    seeded: num(r.seeded),
    points: r.points == null ? null : Number(r.points),
    gkey: r.gkey == null ? null : Number(r.gkey),
    first: r.first == null ? null : Number(r.first),
    tier: r.tier == null ? null : String(r.tier),
    fresh: false,
  };
}

const COLS = "url, mu, sigma, faceoffs, votes, member, seeded, points, gkey, first, tier";

/** Writes a row's rating fields (an upsert), keeping its membership and starting rank. */
const upsertRating = (r, at) => ({
  sql: `INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, votes, dirty, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(url) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma, rating = excluded.rating,
          bucket = excluded.bucket, faceoffs = excluded.faceoffs, votes = excluded.votes, dirty = 1, updated_at = excluded.updated_at`,
  args: [r.url, r.mu, r.sigma, cautious(r), bucketOf(cautious(r)), r.faceoffs, r.votes, at],
});

/**
 * Applies one face-off to its two portfolios: reads their two rows, rates the
 * result (a person's vote fully, a Superstar vote twice, an AI one at
 * AI_VOTE_WEIGHT) and writes the two rows back. `exec` is a client or an open
 * transaction (the vote's own, so it all lands or nothing does); the tables
 * must exist (ensureTierSchema). With `voteId`, what it changed is kept for Undo.
 * @param {any} exec
 * @param {{ winner: string, loser: string, rater?: string, starred?: boolean, voteId?: number | null, at?: string, aiWeight?: number }} vote
 */
export async function applyFaceoff(exec, { winner, loser, rater = "human", starred = false, voteId = null, at = new Date().toISOString(), aiWeight = AI_VOTE_WEIGHT }) {
  if (!winner || !loser || winner === loser) return null;
  const human = rater === "human";
  const weight = human ? (starred ? STARRED_WEIGHT : 1) : aiWeight;
  if (!(weight > 0)) return null;
  const count = human ? 1 : aiWeight;
  const res = await exec.execute({ sql: `SELECT ${COLS} FROM tier_ratings WHERE url IN (?, ?)`, args: [winner, loser] });
  const rows = new Map(res.rows.map((r) => [String(r.url), rowOf(r)]));
  const before = { [winner]: rows.get(winner) ?? rowOf(null, winner), [loser]: rows.get(loser) ?? rowOf(null, loser) };
  const out = rateRanking((u) => before[u], [[winner], [loser]], weight);
  if (!out) return null;
  const after = {};
  for (const [url, r] of out) after[url] = { ...before[url], mu: r.mu, sigma: r.sigma, faceoffs: before[url].faceoffs + count, votes: before[url].votes + 1 };
  const stmts = [upsertRating(after[winner], at), upsertRating(after[loser], at)];
  if (voteId != null) {
    const pack = (b, a) => JSON.stringify({ mu: [b.mu, a.mu], sigma: [b.sigma, a.sigma], faceoffs: count });
    stmts.push({ sql: "INSERT OR REPLACE INTO tier_undo (vote_id, w, l) VALUES (?, ?, ?)", args: [voteId, pack(before[winner], after[winner]), pack(before[loser], after[loser])] });
  }
  for (const s of stmts) await exec.execute(s);
  return after;
}

/**
 * Takes back a person's vote (Undo): each portfolio gets back its rating from
 * before the vote when nothing moved it since; otherwise the vote's move is
 * subtracted from its mean and the uncertainty it removed is added back.
 * Returns true when there was something to undo.
 * @param {any} exec
 * @param {{ voteId: number, winner: string, loser: string, at?: string }} vote
 */
export async function undoFaceoff(exec, { voteId, winner, loser, at = new Date().toISOString() }) {
  const u = (await exec.execute({ sql: "SELECT w, l FROM tier_undo WHERE vote_id = ?", args: [voteId] })).rows[0];
  if (!u) return false;
  const res = await exec.execute({ sql: `SELECT ${COLS} FROM tier_ratings WHERE url IN (?, ?)`, args: [winner, loser] });
  const rows = new Map(res.rows.map((r) => [String(r.url), rowOf(r)]));
  for (const [url, raw] of [[winner, u.w], [loser, u.l]]) {
    const cur = rows.get(url);
    if (!cur) continue;
    const d = JSON.parse(String(raw));
    const untouched = Math.abs(cur.mu - d.mu[1]) < 1e-9 && Math.abs(cur.sigma - d.sigma[1]) < 1e-9;
    const mu = untouched ? d.mu[0] : cur.mu - (d.mu[1] - d.mu[0]);
    const sigma = untouched ? d.sigma[0] : Math.sqrt(Math.max(1e-6, cur.sigma ** 2 + (d.sigma[0] ** 2 - d.sigma[1] ** 2)));
    await exec.execute(upsertRating({ ...cur, mu, sigma, faceoffs: Math.max(0, cur.faceoffs - d.faceoffs), votes: Math.max(0, cur.votes - 1) }, at));
  }
  await exec.execute({ sql: "DELETE FROM tier_undo WHERE vote_id = ?", args: [voteId] });
  return true;
}

/** The daily run's cutoffs, histogram and library facts, or null before the first run (one row). */
export async function readTierMeta(db) {
  await ensureTierSchema(db);
  const r = (await db.execute({ sql: "SELECT v FROM tier_meta WHERE k = ?", args: [META_KEY] })).rows[0];
  if (!r) return null;
  try {
    return JSON.parse(String(r.v));
  } catch {
    return null;
  }
}

export async function writeTierMeta(db, meta, now = Date.now()) {
  await db.execute({ sql: "INSERT OR REPLACE INTO tier_meta (k, v, at) VALUES (?, ?, ?)", args: [META_KEY, JSON.stringify(meta), now] });
}

/**
 * One site's rating row (one read by primary key), or a fresh one.
 * @returns {Promise<TierRow>}
 */
export async function readSiteRow(db, url) {
  await ensureTierSchema(db);
  const r = (await db.execute({ sql: `SELECT ${COLS} FROM tier_ratings WHERE url = ?`, args: [url] })).rows[0];
  return rowOf(r ?? null, url);
}

/**
 * A site's standing, derived on read from its row and the daily cutoffs:
 * { tier, elo, faceoffs, votes, top, place, of, provisional, seeded, points }.
 * A member gets its letter from the cutoffs; anyone else has no letter
 * unless it has MIN_FACEOFFS face-offs (then the starting tier).
 * @param {Pick<TierRow, "mu" | "sigma" | "faceoffs" | "votes" | "member" | "seeded" | "points"> & { tier?: string | null }} row
 * @param {any} meta
 * @returns {Standing}
 */
export function standingOf(row, meta) {
  const r = { mu: row.mu, sigma: row.sigma };
  const rating = cautious(r);
  const ranked = row.member === 1 && isRanked({ seeded: row.seeded === 1, faceoffs: row.faceoffs });
  const tier = ranked ? (tierForRating(rating, meta?.cutoffs) ?? row.tier ?? STARTING_TIER) : row.member === 1 ? STARTING_TIER : null;
  const place = ranked ? placeForRating(rating, meta) : null;
  return {
    tier,
    elo: eloOf(r),
    faceoffs: Math.round(row.faceoffs * 100) / 100,
    votes: row.votes,
    top: place?.top ?? null,
    place: place?.place ?? null,
    of: ranked ? (meta?.n ?? null) : null,
    provisional: !ranked,
    seeded: row.seeded === 1,
    points: row.points,
  };
}

/**
 * The best-rated members, best first (an index range read of `limit` rows).
 * @returns {Promise<TierRow[]>}
 */
export async function topRows(db, limit = 100) {
  await ensureTierSchema(db);
  const res = await db.execute({ sql: `SELECT ${COLS} FROM tier_ratings WHERE member = 1 ORDER BY rating DESC, url LIMIT ?`, args: [limit] });
  return res.rows.map((r) => rowOf(r));
}

/** The members per rating bucket, best first: [[bucket, n]] (the histogram, a few hundred rows at most). */
async function readHist(db) {
  const res = await db.execute("SELECT bucket, n FROM tier_hist WHERE n > 0 ORDER BY bucket DESC");
  return res.rows.map((r) => [Number(r.bucket), Number(r.n)]);
}

/** The rating at a place (1 = best) among the members: its bucket from the histogram, then one indexed read inside it. */
async function ratingAt(db, hist, place) {
  let before = 0;
  for (const [bucket, n] of hist) {
    if (before + n >= place) {
      const r = await db.execute({
        sql: "SELECT rating FROM tier_ratings WHERE member = 1 AND bucket = ? ORDER BY rating DESC LIMIT 1 OFFSET ?",
        args: [bucket, place - before - 1],
      });
      return { rating: Number(r.rows[0]?.rating), skipped: place - before - 1 };
    }
    before += n;
  }
  return { rating: null, skipped: 0 };
}

/**
 * The cutoffs for the members as they are now: [{ tier, min }] best first,
 * `min` the rating at the tier's last place (null for the last tier).
 */
export async function computeCutoffs(db, { hist = null } = {}) {
  const h = hist ?? (await readHist(db));
  const n = h.reduce((s, [, c]) => s + c, 0);
  const cutoffs = [];
  for (const b of boundaryPlaces(n)) cutoffs.push({ tier: b.tier, min: b.last >= n ? null : (await ratingAt(db, h, b.last)).rating });
  return { n, cutoffs, hist: h, perPoint: BUCKETS_PER_POINT };
}

const chunk = (arr, k) => Array.from({ length: Math.ceil(arr.length / k) }, (_, i) => arr.slice(i * k, i * k + k));

/**
 * The daily run. Reads: the meta row, the histogram, one indexed read per
 * cutoff, the portfolios that got votes (dirty), and the members whose rating
 * lies between a cutoff's old and new value. Writes: the letter (in
 * tier_ratings and in the stored grade's rank) only where it changed, the
 * ELO and votes of the ones that got votes, and the meta row. `purge(urls)`
 * is told which profiles changed. Returns the counts.
 */
export async function dailyTiers(db, { now = Date.now(), purge = null, log = () => {} } = {}) {
  await ensureTierSchema(db);
  const prev = await readTierMeta(db);
  const fresh = await computeCutoffs(db);
  const meta = { ...(prev ?? {}), ...fresh, at: new Date(now).toISOString() };
  const select = `SELECT ${COLS}, rating, dirty FROM tier_ratings`;
  const candidates = new Map();
  const add = (rows) => rows.forEach((r) => candidates.set(String(r.url), r));
  add((await db.execute(`${select} WHERE dirty = 1`)).rows);
  if (!prev?.cutoffs) {
    // The first run: every member.
    add((await db.execute(`${select} WHERE member = 1`)).rows);
  } else {
    const old = new Map(prev.cutoffs.map((c) => [c.tier, c.min]));
    const seen = new Set();
    for (const c of fresh.cutoffs) {
      const a = old.get(c.tier);
      if (c.min == null || a == null || a === c.min) continue;
      const lo = Math.min(a, c.min);
      const hi = Math.max(a, c.min);
      const key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add((await db.execute({ sql: `${select} WHERE member = 1 AND rating >= ? AND rating <= ?`, args: [lo, hi] })).rows);
    }
    // A ladder that changed shape (a tier gained or lost room): the members of the affected tiers.
    const shape = (cs) => cs.map((c) => c.tier).join(",");
    if (shape(prev.cutoffs) !== shape(fresh.cutoffs)) add((await db.execute(`${select} WHERE member = 1`)).rows);
  }
  const at = new Date(now).toISOString();
  const tierWrites = [];
  const gradeWrites = [];
  const changed = [];
  for (const raw of candidates.values()) {
    const row = rowOf(raw);
    const s = standingOf(row, meta);
    const tierChanged = (s.tier ?? null) !== (row.tier ?? null);
    if (tierChanged) {
      tierWrites.push({ sql: "UPDATE tier_ratings SET tier = ?, updated_at = ? WHERE url = ?", args: [s.tier, at, row.url] });
      changed.push(row.url);
    }
    if (row.member === 1 && (tierChanged || Number(raw.dirty) === 1)) {
      gradeWrites.push({
        sql: `UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.rank.tier', ?, '$.rank.elo', ?, '$.rank.votes', ?, '$.rank.faceoffs', ?,
                '$.rank.top', ?, '$.rank.place', ?, '$.rank.of', ?, '$.rank.provisional', json(?))
              WHERE url = ? AND json_valid(ai_rubric) AND json_type(ai_rubric, '$.rank') = 'object'`,
        args: [s.tier, s.elo, s.votes, s.faceoffs, s.top, s.place, s.of, s.provisional ? "true" : "false", row.url],
      });
    }
  }
  for (const part of chunk([...tierWrites, ...gradeWrites], 200)) await db.batch(part, "write");
  const cleared = (await db.execute("UPDATE tier_ratings SET dirty = 0 WHERE dirty = 1")).rowsAffected;
  await writeTierMeta(db, meta, now);
  if (purge && changed.length) await purge(changed);
  const out = { n: fresh.n, candidates: candidates.size, changed: changed.length, voted: cleared, written: tierWrites.length + gradeWrites.length };
  log(`tiers daily: ${out.n} ranked, ${out.candidates} looked at, ${out.changed} letter(s) changed, ${out.voted} with new votes`);
  return out;
}

/** True when the daily run is due: no run yet, or the last one is about a day old. */
export const dailyDue = (meta, now = Date.now()) => !meta?.at || now - Date.parse(meta.at) >= 23 * 60 * 60 * 1000;

export { MIN_FACEOFFS };
