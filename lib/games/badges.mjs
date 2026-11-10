// Badges: about twenty simple achievements, each one rule over a counter
// (owner decision 2026-11-10). The counters are read from what the site
// already stores (votes, quiz plays, lists, likes, poll votes), plus a few
// kept only for badges (grades requested, shares, portfolios visited).
// Awarding is idempotent: a badge is a (player, badge) row inserted once,
// and an earned badge stays earned even if its counter later drops (an
// undone vote, a deleted list).
//
// Every read is bounded (LIMIT, primary keys, small per-player sets), and a
// check's result is kept a short while in badge_checks, so listing badges
// again within that time reads one row (docs/COSTS.md section C).
//
// "Your eye" comes from the same reads: how often a player's face-off votes
// and quiz guesses agree with the crowd (the People board) and with the AI
// (the AI board).
import { pacificParts, pad, quotaDay } from "../../pipeline/quota-day.mjs";
import { pollWeek } from "../polls/week.mjs";
import { HIT, poolIndex, topPct } from "./pool.mjs";

export const BADGES = [
  { id: "vote", name: "First vote", how: "Vote in a face-off.", hue: 42, counter: "votes", target: 1 },
  { id: "votes10", name: "Warming up", how: "Cast 10 votes.", hue: 32, counter: "votes", target: 10 },
  { id: "votes100", name: "Regular", how: "Cast 100 votes.", hue: 22, counter: "votes", target: 100 },
  { id: "votes1000", name: "Judge", how: "Cast 1,000 votes.", hue: 8, counter: "votes", target: 1000 },
  { id: "quiz", name: "First quiz", how: "Finish a Guess the percentile quiz.", hue: 200, counter: "quizzes", target: 1 },
  { id: "perfect", name: "Sharp eye", how: "Get all 5 within 10 points.", hue: 265, counter: "perfectQuizzes", target: 1 },
  { id: "daily3", name: "Daily habit", how: "Play the Daily 5 three days running.", hue: 215, counter: "dailyStreak", target: 3 },
  { id: "streak7", name: "Week streak", how: "Play 7 days in a row.", hue: 350, counter: "dayStreak", target: 7 },
  { id: "grade", name: "First grade", how: "Grade a portfolio.", hue: 150, counter: "grades", target: 1 },
  { id: "grade10", name: "Reviewer", how: "Grade 10 portfolios.", hue: 165, counter: "grades", target: 10 },
  { id: "list", name: "Collector", how: "Make your first list.", hue: 185, counter: "lists", target: 1 },
  { id: "list10", name: "Curator", how: "Put 10 sites in one list.", hue: 175, counter: "biggestList", target: 10 },
  { id: "share", name: "Show-off", how: "Share a result or a report.", hue: 300, counter: "shares", target: 1 },
  { id: "crowd10", name: "In tune", how: "Agree with the crowd 10 times.", hue: 120, counter: "crowdAgreed", target: 10 },
  { id: "poll", name: "Voice", how: "Vote in a poll.", hue: 230, counter: "polls", target: 1 },
  { id: "pollstreak", name: "Pollster", how: "Vote in 4 polls in a row.", hue: 245, counter: "pollStreak", target: 4 },
  { id: "gem", name: "Hidden gem", how: "Save a site that later reaches the top 10%.", hue: 280, counter: "gems", target: 1 },
  { id: "owl", name: "Night owl", how: "Vote between midnight and 5 a.m. (Pacific).", hue: 255, counter: "lateVotes", target: 1 },
  { id: "visit50", name: "Explorer", how: "Visit 50 portfolios.", hue: 135, counter: "visits", target: 50 },
  { id: "early", name: "Early supporter", how: "Play before the early-supporter window closes.", hue: 45, counter: "early", target: 1 },
];

export const COUNTER_KEYS = [...new Set(BADGES.map((b) => b.counter))];

/** How long a badge check is reused before the counters are read again. */
export const CHECK_REUSE_MS = 15_000;
/** Votes, plays and guesses a check reads at most (enough for every target). */
export const READ_CAP = 1000;
/** Visits recorded per player: no more than the Explorer badge needs. */
export const VISIT_CAP = 50;
/** Shares and grades counted per player (only the first few matter). */
export const COUNTER_CAP = 1000;
/** A saved site counts as a gem when it reaches this "top X%". */
export const GEM_PCT = 10;
/** Poll weeks a check looks back over (poll vote rows are kept 30 days after a poll closes). */
const POLL_WEEKS = 4;

const iso = (d) => new Date(d).toISOString();
/** "2026-11-10 13:00:00" (SQLite datetime) or ISO -> Date. */
const toDate = (s) => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(String(s)) ? `${String(s).replace(" ", "T")}Z` : String(s));
const pacificDay = (at) => {
  const p = pacificParts(at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};
const dayNumber = (day) => Date.UTC(...day.split("-").map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 86400000;

/** @typedef {{ pool: { totals: { merged: number, ai: number, people: number }, sites: any[] }, now?: Date, force?: boolean, signedIn?: boolean, earlyUntil?: string | null }} CheckOptions */

/** The longest run of consecutive days in a set of "YYYY-MM-DD" days. */
export function longestRun(days) {
  const nums = [...new Set([...days].map(dayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < nums.length; i++) {
    run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Agreement as { agree, of, pct } (pct null when nothing to compare). */
const share = (agree, of) => ({ agree, of, pct: of ? Math.round((agree / of) * 100) : null });

/**
 * Reads a player's counters and eye stats. `signedIn` decides whether lists
 * and likes count (guests can't keep either). `earlyUntil` ("YYYY-MM-DD",
 * Pacific) is the last day the Early supporter badge is given.
 * @param {any} db
 * @param {string} player
 * @param {CheckOptions} opts
 */
export async function gather(db, player, { pool, now = new Date(), signedIn = player.startsWith("gh:"), earlyUntil = null }) {
  const weeks = [];
  let w = pollWeek(now);
  for (let i = 0; i < POLL_WEEKS + 1; i++) {
    weeks.push(w.id);
    w = pollWeek(new Date(w.opensAt.getTime() - 3600000));
  }
  const stmts = [
    { sql: "SELECT winner, loser, created_at FROM votes WHERE rater_id = ? ORDER BY created_at DESC LIMIT ?", args: [player, READ_CAP] },
    { sql: "SELECT quiz_id, finished_at, hits FROM quiz_plays WHERE player = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT ?", args: [player, READ_CAP] },
    { sql: "SELECT guess, merged, ai, people FROM quiz_guesses WHERE player = ? ORDER BY created_at DESC LIMIT ?", args: [player, READ_CAP] },
    { sql: "SELECT k, n FROM player_counters WHERE player = ?", args: [player] },
    { sql: "SELECT COUNT(*) AS n FROM (SELECT 1 FROM player_visits WHERE player = ? LIMIT ?)", args: [player, VISIT_CAP] },
    { sql: `SELECT poll_id FROM poll_votes WHERE voter = ? AND poll_id IN (${weeks.map(() => "?").join(",")})`, args: [player, ...weeks] },
    { sql: "SELECT url, pct FROM gem_watch WHERE player = ?", args: [player] },
  ];
  if (signedIn) {
    stmts.push(
      {
        sql: `SELECT l.id, (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS n
              FROM lists l WHERE l.owner = ? AND l.deleted_at IS NULL LIMIT 100`,
        args: [player],
      },
      {
        sql: `SELECT url FROM (SELECT url FROM likes WHERE rater_id = ?1 ORDER BY created_at DESC LIMIT 500)
              UNION SELECT li.url FROM list_items li JOIN lists l ON l.id = li.list_id
              WHERE l.owner = ?1 AND l.deleted_at IS NULL LIMIT 1000`,
        args: [player],
      }
    );
  }
  const [votes, plays, guesses, counters, visits, polls, watch, lists, saved] = await db.batch(stmts, "read");

  const idx = poolIndex(pool);
  const days = new Set();
  let lateVotes = 0;
  let crowdAgreed = 0;
  let crowdOf = 0;
  let aiAgreed = 0;
  let aiOf = 0;
  for (const v of votes.rows) {
    const at = toDate(v.created_at);
    if (!Number.isNaN(at.getTime())) {
      days.add(pacificDay(at));
      if (pacificParts(at).hour < 5) lateVotes++;
    }
    const a = idx.get(String(v.winner));
    const b = idx.get(String(v.loser));
    if (a?.p != null && b?.p != null && a.p !== b.p) {
      crowdOf++;
      if (a.p < b.p) crowdAgreed++;
    }
    if (a?.a != null && b?.a != null && a.a !== b.a) {
      aiOf++;
      if (a.a < b.a) aiAgreed++;
    }
  }
  const dailyDays = [];
  let perfect = 0;
  for (const p of plays.rows) {
    days.add(pacificDay(toDate(p.finished_at)));
    if (Number(p.hits) >= 5) perfect++;
    const m = String(p.quiz_id).match(/^daily-(\d{4}-\d{2}-\d{2})$/);
    if (m) dailyDays.push(m[1]);
  }
  let guessCrowd = 0;
  let guessCrowdOf = 0;
  let guessAi = 0;
  let guessAiOf = 0;
  for (const g of guesses.rows) {
    if (g.people != null) {
      guessCrowdOf++;
      if (Math.abs(Number(g.guess) - Number(g.people)) <= HIT) guessCrowd++;
    }
    if (g.ai != null) {
      guessAiOf++;
      if (Math.abs(Number(g.guess) - Number(g.ai)) <= HIT) guessAi++;
    }
  }
  const stored = Object.fromEntries(counters.rows.map((r) => [String(r.k), Number(r.n)]));

  // Poll weeks voted in, newest first: weeks[0] is this week.
  const voted = new Set(polls.rows.map((r) => String(r.poll_id)));
  let pollStreak = 0;
  let run = 0;
  for (const id of [...weeks].reverse()) {
    run = voted.has(id) ? run + 1 : 0;
    pollStreak = Math.max(pollStreak, run);
  }

  // Hidden gem: a saved site's percentile the first time a check saw it
  // saved, against its percentile now.
  const watched = new Map(watch.rows.map((r) => [String(r.url), r.pct == null ? null : Number(r.pct)]));
  const newWatch = [];
  let gems = 0;
  const pctNow = (u) => {
    const s = idx.get(u);
    return s ? topPct(s.m, pool.totals.merged) : null;
  };
  for (const r of saved?.rows ?? []) {
    const u = String(r.url);
    const now_ = pctNow(u);
    if (!watched.has(u)) {
      newWatch.push({ url: u, pct: now_ });
      continue;
    }
    const then = watched.get(u);
    if (now_ != null && now_ <= GEM_PCT && (then == null || then > GEM_PCT)) gems++;
  }

  const listCounts = (lists?.rows ?? []).map((r) => Number(r.n));
  const active = votes.rows.length > 0 || plays.rows.length > 0 || voted.size > 0 || listCounts.length > 0;
  const today = quotaDay(now).day;
  const out = {
    votes: votes.rows.length,
    quizzes: plays.rows.length,
    perfectQuizzes: perfect,
    dailyStreak: longestRun(dailyDays),
    dayStreak: longestRun(days),
    grades: stored.grades ?? 0,
    lists: listCounts.length,
    biggestList: listCounts.length ? Math.max(...listCounts) : 0,
    shares: stored.shares ?? 0,
    crowdAgreed,
    polls: voted.size,
    pollStreak,
    gems,
    lateVotes,
    visits: Number(visits.rows[0]?.n ?? 0),
    early: active && earlyUntil && today <= earlyUntil ? 1 : 0,
  };
  const eye = {
    crowd: share(crowdAgreed + guessCrowd, crowdOf + guessCrowdOf),
    ai: share(aiAgreed + guessAi, aiOf + guessAiOf),
    votes: { crowd: share(crowdAgreed, crowdOf), ai: share(aiAgreed, aiOf) },
    guesses: { crowd: share(guessCrowd, guessCrowdOf), ai: share(guessAi, guessAiOf) },
  };
  return { counters: out, eye, newWatch };
}

/**
 * Checks a player's badges: reads the counters (or reuses a check from the
 * last CHECK_REUSE_MS unless `force`), records newly saved sites for Hidden
 * gem and awards every badge whose counter reached its target. Returns
 * { counters, eye, awarded: [badge ids earned by this check] }.
 * @param {any} db
 * @param {string} player
 * @param {CheckOptions} opts
 */
export async function checkBadges(db, player, { pool, now = new Date(), force = false, signedIn, earlyUntil }) {
  const t = new Date(now).getTime();
  if (!force) {
    const r = (await db.execute({ sql: "SELECT at, counters, eye FROM badge_checks WHERE player = ?", args: [player] })).rows[0];
    if (r && t - Number(r.at) < CHECK_REUSE_MS) return { counters: JSON.parse(String(r.counters)), eye: JSON.parse(String(r.eye)), awarded: [] };
  }
  const { counters, eye, newWatch } = await gather(db, player, { pool, now, signedIn, earlyUntil });
  const due = BADGES.filter((b) => counters[b.counter] >= b.target).map((b) => b.id);
  const stmts = [
    ...newWatch.map((w) => ({ sql: "INSERT OR IGNORE INTO gem_watch (player, url, pct) VALUES (?, ?, ?)", args: [player, w.url, w.pct] })),
    ...due.map((id) => ({ sql: "INSERT OR IGNORE INTO badges (player, badge, earned_at) VALUES (?, ?, ?)", args: [player, id, iso(now)] })),
    {
      sql: `INSERT INTO badge_checks (player, at, counters, eye) VALUES (?, ?, ?, ?)
            ON CONFLICT(player) DO UPDATE SET at = excluded.at, counters = excluded.counters, eye = excluded.eye`,
      args: [player, t, JSON.stringify(counters), JSON.stringify(eye)],
    },
  ];
  const res = await db.batch(stmts, "write");
  const awarded = due.filter((_, i) => res[newWatch.length + i].rowsAffected === 1);
  return { counters, eye, awarded };
}

/**
 * Every badge with the player's progress: { badges: [{ id, name, how, hue,
 * counter, target, progress, earned, earnedAt, new }], counters, eye }.
 * `new` is true once, the first time an earned badge is listed (the UI's
 * "badge earned" toast); listing marks it told.
 * @param {any} db
 * @param {string} player
 * @param {CheckOptions} opts
 */
export async function listBadges(db, player, opts) {
  const { counters, eye } = await checkBadges(db, player, opts);
  const rows = (await db.execute({ sql: "SELECT badge, earned_at, notified FROM badges WHERE player = ?", args: [player] })).rows;
  const earned = new Map(rows.map((r) => [String(r.badge), { at: String(r.earned_at), told: Number(r.notified) === 1 }]));
  const untold = [...earned].filter(([, e]) => !e.told).map(([id]) => id);
  if (untold.length) {
    await db.execute({
      sql: `UPDATE badges SET notified = 1 WHERE player = ? AND badge IN (${untold.map(() => "?").join(",")})`,
      args: [player, ...untold],
    });
  }
  return {
    badges: BADGES.map((b) => {
      const e = earned.get(b.id);
      return {
        ...b,
        progress: Math.min(counters[b.counter] ?? 0, b.target),
        earned: Boolean(e),
        earnedAt: e?.at ?? null,
        new: Boolean(e && !e.told),
      };
    }),
    counters,
    eye,
  };
}

/**
 * Records something only a badge needs to know:
 *   "share"  the player shared a result or a report (counted)
 *   "grade"  the player asked for a grade (the grade service calls this)
 *   "visit"  the player opened a portfolio (`url`, distinct, up to VISIT_CAP)
 * Returns true when it changed anything.
 * @param {any} db
 * @param {string} player
 * @param {string} kind
 * @param {{ url?: string }} [opts]
 */
export async function recordEvent(db, player, kind, { url } = {}) {
  if (kind === "visit") {
    if (!url) return false;
    const res = await db.execute({
      sql: `INSERT OR IGNORE INTO player_visits (player, url)
            SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM player_visits WHERE player = ?1 LIMIT ?3)) < ?3`,
      args: [player, url, VISIT_CAP],
    });
    return res.rowsAffected > 0;
  }
  if (kind === "share" || kind === "grade") {
    const k = kind === "share" ? "shares" : "grades";
    const res = await db.execute({
      sql: `INSERT INTO player_counters (player, k, n) VALUES (?, ?, 1)
            ON CONFLICT(player, k) DO UPDATE SET n = n + 1 WHERE n < ?`,
      args: [player, k, COUNTER_CAP],
    });
    return res.rowsAffected > 0;
  }
  throw new Error(`unknown badge event ${kind}`);
}
