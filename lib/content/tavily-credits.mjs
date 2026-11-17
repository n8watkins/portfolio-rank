// The monthly Tavily credit cap (docs/COSTS.md, "Tavily"). PortfolioRank and
// Wren share one free Tavily account: 1,000 credits a month and 100 requests
// a minute across both keys. PortfolioRank may use 200 (TAVILY_MONTHLY_CREDITS),
// Wren 750, which leaves 50 spare.
//
// Each search reserves its credits here before the call, in one statement that
// only succeeds while the month's total stays within the cap, so two searches
// running at once can't both take the last credit. Tavily resets on the 1st
// of the calendar month (UTC); a new month is a new row. Plain JavaScript:
// the content engine, the admin API and the tests all import it.

/** The default monthly cap when TAVILY_MONTHLY_CREDITS is missing or not a whole number. */
export const DEFAULT_MONTHLY_CREDITS = 200;
/** A basic search (what claims.mjs runs, with no page text) is 1 credit; an advanced one would be 2. */
export const SEARCH_CREDITS = 1;

/** The UTC calendar month a moment falls in, as YYYY-MM. */
export function creditMonth(now = new Date()) {
  return new Date(now).toISOString().slice(0, 7);
}

/** The cap from the variable: a whole number of 0 or more, else the default. */
export function monthlyCap(value) {
  const n = Number(String(value ?? "").trim() || NaN);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MONTHLY_CREDITS;
}

/** Takes `credits` for the month if the total stays within `cap`; returns whether it did. */
export async function reserveCredits(db, { credits = SEARCH_CREDITS, cap, now = new Date() }) {
  const month = creditMonth(now);
  await db.execute({ sql: "INSERT OR IGNORE INTO tavily_credits (month, used) VALUES (?, 0)", args: [month] });
  const r = await db.execute({
    sql: "UPDATE tavily_credits SET used = used + ? WHERE month = ? AND used + ? <= ?",
    args: [credits, month, credits, cap],
  });
  return r.rowsAffected === 1;
}

/** Gives back credits for a search Tavily did not answer (it charges only for answered searches). */
export async function releaseCredits(db, { credits = SEARCH_CREDITS, now = new Date() }) {
  await db.execute({ sql: "UPDATE tavily_credits SET used = MAX(used - ?, 0) WHERE month = ?", args: [credits, creditMonth(now)] });
}

/** This month's usage against the cap, for the admin quota data. */
export async function creditUsage(db, { cap, now = new Date() }) {
  const month = creditMonth(now);
  const r = await db.execute({ sql: "SELECT used FROM tavily_credits WHERE month = ?", args: [month] });
  return { month, used: Number(r.rows[0]?.used ?? 0), cap };
}

// The weekly cap: one row per search, reserved before the call in one
// statement that only succeeds while the last 7 days hold fewer than the cap
// (searches already recorded on content_runs count too), so a draft that
// fails after searching still counts its searches.
const WEEK_MS = 7 * 86400000;
export const WEEK_TABLES = [
  `CREATE TABLE IF NOT EXISTS tavily_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS tavily_searches_at_idx ON tavily_searches (at)",
];

/** Takes one search of the week's cap; returns the row id, or null at the cap. */
export async function reserveWeekly(db, { cap, now = new Date() }) {
  const at = new Date(now).toISOString();
  const since = new Date(new Date(now).getTime() - WEEK_MS).toISOString();
  const r = await db.execute({
    sql: `INSERT INTO tavily_searches (at) SELECT ? WHERE (SELECT COUNT(*) FROM tavily_searches WHERE at > ?) < ?
            AND (SELECT COALESCE(SUM(tavily), 0) FROM content_runs WHERE at > ?) < ?`,
    args: [at, since, cap, since, cap],
  });
  return r.rowsAffected === 1 ? Number(r.lastInsertRowid) : null;
}

/** Gives back a weekly search that Tavily did not answer. */
export async function releaseWeekly(db, id) {
  await db.execute({ sql: "DELETE FROM tavily_searches WHERE id = ?", args: [id] });
}

/**
 * The reserve/release pair checkClaims takes, bound to a database and the
 * caps: a search is reserved against the week (when weekCap is given) and the
 * month before the call, and both are given back when it is not answered.
 */
export function creditsFor(db, { cap, weekCap = null, now = () => new Date() }) {
  const held = [];
  return {
    reserve: async (credits = SEARCH_CREDITS) => {
      let weekId = null;
      if (weekCap != null) {
        weekId = await reserveWeekly(db, { cap: weekCap, now: now() });
        if (weekId == null) return false;
      }
      if (!(await reserveCredits(db, { credits, cap, now: now() }))) {
        if (weekId != null) await releaseWeekly(db, weekId);
        return false;
      }
      held.push(weekId);
      return true;
    },
    release: async (credits = SEARCH_CREDITS) => {
      const weekId = held.pop();
      if (weekId != null) await releaseWeekly(db, weekId);
      await releaseCredits(db, { credits, now: now() });
    },
  };
}
