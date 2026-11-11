// Guess the percentile: quizzes of five portfolios, checked on the server.
// A quiz is stored once (its five URLs in order), so the Daily 5 is the same
// for everyone that Pacific day and a challenge link replays the same five.
// A round's real percentile is only ever returned with the answer to that
// round's guess (lib/games/server.ts publicQuiz never includes it).
//
// Plain JavaScript taking a libSQL client, shared by the API routes
// (app/api/games) and the tests.
import { createRng } from "../ranking/prng.mjs";
import { quotaDay } from "../../pipeline/quota-day.mjs";
import { HIT, ROUNDS, percentilesOf, pickFive, points } from "./pool.mjs";

/** The Daily 5's id for a Pacific day ("YYYY-MM-DD"). */
export const dailyId = (day) => `daily-${day}`;
/** A quiz id: the Daily 5 of a day, or a random quiz ("r-" and 10 URL-safe characters). */
export const QUIZ_ID = /^(daily-\d{4}-\d{2}-\d{2}|r-[A-Za-z0-9_-]{10})$/;

const iso = (d) => new Date(d).toISOString();

/** A stored quiz: { id, kind, day, urls, createdAt }, or null. */
export async function getQuiz(db, id) {
  const r = (await db.execute({ sql: "SELECT id, kind, day, urls, created_at FROM quizzes WHERE id = ?", args: [id] })).rows[0];
  if (!r) return null;
  return { id: String(r.id), kind: String(r.kind), day: r.day == null ? null : String(r.day), urls: JSON.parse(String(r.urls)), createdAt: String(r.created_at) };
}

/**
 * Today's Daily 5 (Pacific day), stored the first time anyone asks for it:
 * drawn from the pool by the date alone, so it is deterministic, and kept,
 * so a recompute later that day doesn't change it. Null when the pool is
 * empty.
 */
export async function dailyQuiz(db, pool, { now = new Date() } = {}) {
  const { day } = quotaDay(now);
  const id = dailyId(day);
  const have = await getQuiz(db, id);
  if (have) return have;
  if (!pool.sites.length) return null;
  const urls = pickFive(pool, createRng(`daily:${day}`));
  await db.execute({
    sql: "INSERT OR IGNORE INTO quizzes (id, kind, day, urls, created_at) VALUES (?, 'daily', ?, ?, ?)",
    args: [id, day, JSON.stringify(urls), iso(now)],
  });
  return getQuiz(db, id);
}

/** A new random quiz under `id` (the caller makes it unguessable). Null when the pool is empty. */
/**
 * @param {any} db
 * @param {{ sites: any[] }} pool
 * @param {{ id: string, now?: Date, rng?: () => number }} opts
 */
export async function randomQuiz(db, pool, { id, now = new Date(), rng = Math.random }) {
  if (!QUIZ_ID.test(id) || !id.startsWith("r-")) throw new Error(`bad random quiz id ${id}`);
  if (!pool.sites.length) return null;
  const urls = pickFive(pool, rng);
  await db.execute({
    sql: "INSERT INTO quizzes (id, kind, day, urls, created_at) VALUES (?, 'random', NULL, ?, ?)",
    args: [id, JSON.stringify(urls), iso(now)],
  });
  return getQuiz(db, id);
}

const resultOf = (r) => {
  const merged = r.merged == null ? null : Number(r.merged);
  return {
    index: Number(r.idx),
    guess: Number(r.guess),
    merged,
    ai: r.ai == null ? null : Number(r.ai),
    people: r.people == null ? null : Number(r.people),
    points: Number(r.points),
    hit: merged != null && Math.abs(Number(r.guess) - merged) <= HIT,
  };
};

/** A player's answers so far in a quiz: { results, finished, score, hits }. */
export async function progress(db, quizId, player) {
  const [g, p] = await db.batch(
    [
      { sql: "SELECT idx, guess, merged, ai, people, points FROM quiz_guesses WHERE quiz_id = ? AND player = ? ORDER BY idx", args: [quizId, player] },
      { sql: "SELECT finished_at, score, hits FROM quiz_plays WHERE quiz_id = ? AND player = ?", args: [quizId, player] },
    ],
    "read"
  );
  const play = p.rows[0];
  return {
    results: g.rows.map(resultOf),
    finished: Boolean(play?.finished_at),
    score: play?.finished_at ? Number(play.score) : g.rows.reduce((n, r) => n + Number(r.points), 0),
    hits: play?.finished_at ? Number(play.hits) : g.rows.map(resultOf).filter((r) => r.hit).length,
  };
}

/**
 * Records one guess (1 to 100, "top X%") for round `index` of a quiz, scored
 * against the pool now. Each round is answered once: the first guess stands
 * (the primary key decides, so concurrent requests can't both count). A
 * round whose site has left the pool since (removed by its owner, say)
 * scores nothing and is not a hit. The fifth answer finishes the play.
 * Returns { ok: true, result, finished } or { ok: false, error, result? }
 * with error "already_guessed" or "bad_index". `finished` is null until
 * this guess finished the quiz, then { score, hits, perfect }.
 */
export async function recordGuess(db, { quiz, player, index, guess, pool, now = new Date() }) {
  if (!Number.isInteger(index) || index < 0 || index >= quiz.urls.length) return { ok: false, error: "bad_index" };
  const url = quiz.urls[index];
  const pct = percentilesOf(pool, url);
  const at = iso(now);
  const pts = pct ? points(guess, pct.merged) : 0;
  const [, ins, fin] = await db.batch(
    [
      { sql: "INSERT OR IGNORE INTO quiz_plays (quiz_id, player, started_at) VALUES (?, ?, ?)", args: [quiz.id, player, at] },
      {
        sql: `INSERT OR IGNORE INTO quiz_guesses (quiz_id, player, idx, url, guess, merged, ai, people, points, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [quiz.id, player, index, url, guess, pct?.merged ?? null, pct?.ai ?? null, pct?.people ?? null, pts, at],
      },
      {
        sql: `UPDATE quiz_plays SET finished_at = ?3,
                score = (SELECT COALESCE(SUM(points), 0) FROM quiz_guesses WHERE quiz_id = ?1 AND player = ?2),
                hits = (SELECT COUNT(*) FROM quiz_guesses WHERE quiz_id = ?1 AND player = ?2 AND merged IS NOT NULL AND ABS(guess - merged) <= ${HIT})
              WHERE quiz_id = ?1 AND player = ?2 AND finished_at IS NULL
                AND (SELECT COUNT(*) FROM quiz_guesses WHERE quiz_id = ?1 AND player = ?2) >= ?4
              RETURNING score, hits`,
        args: [quiz.id, player, at, Math.min(ROUNDS, quiz.urls.length)],
      },
    ],
    "write"
  );
  if (ins.rowsAffected === 0) {
    const stored = (await progress(db, quiz.id, player)).results.find((r) => r.index === index);
    return { ok: false, error: "already_guessed", result: stored };
  }
  const result = resultOf({ idx: index, guess, merged: pct?.merged, ai: pct?.ai, people: pct?.people, points: pts });
  let finished = null;
  if (fin.rows.length) {
    const hits = Number(fin.rows[0].hits);
    finished = { score: Number(fin.rows[0].score), hits, perfect: hits === quiz.urls.length && quiz.urls.length === ROUNDS };
    await db.execute("INSERT INTO game_totals (k, n) VALUES ('quizzes', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
  }
  return { ok: true, result, finished };
}
