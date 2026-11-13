// Polls in the database: reading results, casting a vote, the rate limits
// and the results feed for the content engine. Plain JavaScript taking a
// libSQL client, shared by the API routes (app/api/polls) and the
// end-of-day run (pipeline/polls.mjs), and tested without a server.
//
// Privacy: nothing here returns who voted for what. Results are the totals
// in poll_options; poll_votes is read only to answer "did this visitor
// vote, and for which option" for that visitor.

/** Days per-person vote rows are kept after a poll closes (docs/COSTS.md section C, item 8). */
export const VOTE_ROWS_KEPT_DAYS = 30;
/** Past polls a public read returns by default, and at most. */
export const PAST_DEFAULT = 12;
export const PAST_MAX = 52;

const iso = (d) => new Date(d).toISOString();
const ph = (n) => Array.from({ length: n }, () => "?").join(",");

/** Whole percentages that add up to 100 (largest remainder), 0s when nobody voted. */
export function percents(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    out[i]++;
  }
  return out;
}

async function withOptions(db, rows, now) {
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  const opts = (
    await db.execute({
      sql: `SELECT poll_id, idx, label, portfolio_url, votes FROM poll_options WHERE poll_id IN (${ph(ids.length)}) ORDER BY poll_id, idx`,
      args: ids,
    })
  ).rows;
  const byPoll = new Map(ids.map((id) => [id, []]));
  for (const o of opts) byPoll.get(String(o.poll_id))?.push(o);
  return rows.map((r) => {
    const options = byPoll.get(String(r.id)) ?? [];
    const counts = options.map((o) => Number(o.votes));
    const pct = percents(counts);
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      id: String(r.id),
      kind: String(r.kind),
      question: String(r.question),
      detail: String(r.detail ?? ""),
      opensAt: String(r.opens_at),
      closesAt: String(r.closes_at),
      status: String(r.closes_at) <= iso(now) ? "closed" : "active",
      total,
      options: options.map((o, i) => ({
        index: Number(o.idx),
        label: String(o.label),
        votes: counts[i],
        percent: pct[i],
        ...(o.portfolio_url == null ? {} : { url: String(o.portfolio_url) }),
      })),
    };
  });
}

const COLS = "id, kind, question, detail, opens_at, closes_at";
const LIVE = "status = 'scheduled'";

/** Upcoming polls a public read lists, soonest first. */
export const UPCOMING_MAX = 4;

/**
 * What the public sees: { active: poll | null, upcoming, past: poll[] } with
 * each open or closed poll's totals and percentages. `past` is newest first.
 * `upcoming` (soonest first) carries only { id, kind, question, opensAt,
 * closesAt }: the options, and so a hero poll's sites, stay private until
 * the poll opens.
 */
export async function readPolls(db, { now = new Date(), past = PAST_DEFAULT, upcoming = UPCOMING_MAX } = {}) {
  const at = iso(now);
  const [activeRows, pastRows, upcomingRows] = await Promise.all([
    db.execute({ sql: `SELECT ${COLS} FROM polls WHERE ${LIVE} AND opens_at <= ? AND closes_at > ? ORDER BY opens_at DESC LIMIT 1`, args: [at, at] }),
    db.execute({ sql: `SELECT ${COLS} FROM polls WHERE ${LIVE} AND closes_at <= ? ORDER BY opens_at DESC LIMIT ?`, args: [at, past] }),
    db.execute({ sql: `SELECT ${COLS} FROM polls WHERE ${LIVE} AND opens_at > ? ORDER BY opens_at LIMIT ?`, args: [at, upcoming] }),
  ]);
  const polls = await withOptions(db, [...activeRows.rows, ...pastRows.rows], now);
  return {
    active: activeRows.rows.length ? polls[0] : null,
    upcoming: upcomingRows.rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      question: String(r.question),
      opensAt: String(r.opens_at),
      closesAt: String(r.closes_at),
    })),
    past: polls.slice(activeRows.rows.length),
  };
}

/**
 * Every poll from `since` on, any status, with its options and sites: the
 * owner's view of what is scheduled (app/admin/(tools)/polls). Never public.
 */
export async function readSchedule(db, { since, now = new Date() } = {}) {
  const rows = (
    await db.execute({
      sql: `SELECT ${COLS}, status AS state, topic, source FROM polls WHERE closes_at > ? ORDER BY opens_at`,
      args: [iso(since ?? now)],
    })
  ).rows;
  const polls = await withOptions(db, rows, now);
  return polls.map((p, i) => ({
    ...p,
    state: String(rows[i].state),
    topic: rows[i].topic == null ? null : String(rows[i].topic),
    source: String(rows[i].source),
    upcoming: p.opensAt > iso(now),
  }));
}

/** The last `limit` nightly poll generation attempts, newest first (owner view). */
export async function readGenerations(db, { limit = 10 } = {}) {
  const rows = (await db.execute({ sql: "SELECT night, at, model, requests, proposed, accepted, status, detail FROM poll_generations ORDER BY at DESC LIMIT ?", args: [limit] })).rows;
  return rows.map((r) => ({
    night: String(r.night),
    at: String(r.at),
    model: r.model == null ? null : String(r.model),
    requests: Number(r.requests),
    proposed: Number(r.proposed),
    accepted: Number(r.accepted),
    status: String(r.status),
    detail: r.detail == null ? null : String(r.detail),
  }));
}

/** One poll that has opened (active or closed), or null. Upcoming and withdrawn polls are not public. */
export async function readPoll(db, id, { now = new Date() } = {}) {
  const rows = (await db.execute({ sql: `SELECT ${COLS} FROM polls WHERE id = ? AND ${LIVE} AND opens_at <= ?`, args: [id, iso(now)] })).rows;
  return (await withOptions(db, rows, now))[0] ?? null;
}

/** The option index this visitor voted for in `pollId`, or null. */
export async function myVote(db, { pollId, voter, browser }) {
  const row = (
    await db.execute({
      sql: "SELECT option_idx FROM poll_votes WHERE poll_id = ? AND (voter = ? OR browser = ?) LIMIT 1",
      args: [pollId, voter, browser],
    })
  ).rows[0];
  return row ? Number(row.option_idx) : null;
}

/**
 * This visitor's votes in `pollIds`: { [pollId]: option index }, only for
 * the polls they voted in. Vote rows are kept 30 days after a poll closes,
 * so older polls never show one.
 */
export async function myVotes(db, { pollIds, voter, browser }) {
  if (!pollIds.length) return {};
  const rows = (
    await db.execute({
      sql: `SELECT poll_id, option_idx FROM poll_votes WHERE poll_id IN (${ph(pollIds.length)}) AND (voter = ? OR browser = ?)`,
      args: [...pollIds, voter, browser],
    })
  ).rows;
  return Object.fromEntries(rows.map((r) => [String(r.poll_id), Number(r.option_idx)]));
}

/**
 * Casts one vote. The insert itself checks that the poll is open and the
 * option exists, and the unique indexes enforce one vote per voter and per
 * browser, so concurrent requests can't slip past a check. The trigger adds
 * it to the option's total in the same transaction.
 * Returns { ok: true, mine } or { ok: false, error, mine? } where error is
 * "already_voted", "closed", "not_found" or "bad_option".
 */
export async function castVote(db, { pollId, option, voter, browser, now = new Date() }) {
  const at = iso(now);
  const res = await db.execute({
    sql: `INSERT OR IGNORE INTO poll_votes (poll_id, voter, browser, option_idx, created_at)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM polls p JOIN poll_options o ON o.poll_id = p.id
            WHERE p.id = ? AND o.idx = ? AND p.${LIVE} AND p.opens_at <= ? AND p.closes_at > ?)`,
    args: [pollId, voter, browser, option, at, pollId, option, at, at],
  });
  if (res.rowsAffected === 1) return { ok: true, mine: option };
  const mine = await myVote(db, { pollId, voter, browser });
  if (mine != null) return { ok: false, error: "already_voted", mine };
  const poll = (await db.execute({ sql: `SELECT opens_at, closes_at FROM polls WHERE id = ? AND ${LIVE}`, args: [pollId] })).rows[0];
  if (!poll || String(poll.opens_at) > at) return { ok: false, error: "not_found" };
  if (String(poll.closes_at) <= at) return { ok: false, error: "closed" };
  return { ok: false, error: "bad_option" };
}

/**
 * One hit on a fixed-window counter in rate_limits, in a single statement
 * (no read-then-write race). Returns { ok, n, retryAfterSec }.
 */
export async function rateLimit(db, key, { limit, windowMs, now = Date.now() }) {
  const t = Number(now);
  const res = await db.execute({
    sql: `INSERT INTO rate_limits (k, window_start, n) VALUES (?, ?, 1)
          ON CONFLICT(k) DO UPDATE SET
            n = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.n + 1 END,
            window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
          RETURNING n, window_start`,
    args: [key, t, t - windowMs, t - windowMs],
  });
  const n = Number(res.rows[0]?.n ?? 1);
  const start = Number(res.rows[0]?.window_start ?? t);
  return { ok: n <= limit, n, retryAfterSec: Math.max(1, Math.ceil((start + windowMs - t) / 1000)) };
}

/**
 * The results feed for the content engine and the AI vs people comparisons:
 * closed polls (newest first) that closed at or after `since`, with totals,
 * the winning option and its margin in points. A tie has no winner.
 */
export async function pollResults(db, { since = "1970-01-01T00:00:00.000Z", limit = 52, now = new Date() } = {}) {
  const rows = (
    await db.execute({
      sql: `SELECT ${COLS} FROM polls WHERE ${LIVE} AND closes_at <= ? AND closes_at >= ? ORDER BY opens_at DESC LIMIT ?`,
      args: [iso(now), iso(since), limit],
    })
  ).rows;
  return (await withOptions(db, rows, now)).map((p) => {
    const sorted = [...p.options].sort((a, b) => b.votes - a.votes);
    const tie = sorted.length < 2 || sorted[0].votes === sorted[1].votes;
    return { ...p, winner: tie ? null : sorted[0].index, margin: sorted.length < 2 ? 0 : sorted[0].percent - sorted[1].percent };
  });
}

/**
 * Housekeeping (the end-of-day run): drops per-person vote rows of polls
 * closed more than VOTE_ROWS_KEPT_DAYS ago (the totals stay), and rate
 * limit windows older than a day. Returns the rows deleted.
 */
export async function prunePolls(db, { now = new Date() } = {}) {
  const cutoff = iso(new Date(now).getTime() - VOTE_ROWS_KEPT_DAYS * 86400000);
  const [votes, limits] = await db.batch(
    [
      { sql: "DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE closes_at < ?)", args: [cutoff] },
      { sql: "DELETE FROM rate_limits WHERE window_start < ?", args: [new Date(now).getTime() - 86400000] },
    ],
    "write"
  );
  return { votes: votes.rowsAffected, rateLimits: limits.rowsAffected };
}
