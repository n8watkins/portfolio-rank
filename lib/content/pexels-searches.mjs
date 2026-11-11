// Pexels searches per calendar month (UTC), counted for the admin quota data
// (docs/COSTS.md, "Pexels"). Pexels is free (200 requests an hour, 20,000 a
// month); the content engine makes at most 1 search per image slot and 2 per
// post, so expected use is about 16 a month. The monthly cap here
// (PEXELS_MONTHLY_SEARCHES, 500 by default) only stops a runaway: each search
// takes its place in one statement that succeeds while the month stays
// within the cap, like the Tavily counter.

export const DEFAULT_MONTHLY_SEARCHES = 500;
/** Searches one post may make (one per slot). */
export const PEXELS_PER_POST = 2;

export const PEXELS_TABLES = [
  `CREATE TABLE IF NOT EXISTS pexels_searches (
    month TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0
  )`,
];

export const searchMonth = (now = new Date()) => new Date(now).toISOString().slice(0, 7);

/** The cap from the variable: a whole number of 0 or more, else the default. */
export function pexelsCap(value) {
  const n = Number(String(value ?? "").trim() || NaN);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MONTHLY_SEARCHES;
}

/** Counts one search if the month stays within `cap`; returns whether it did. */
export async function reserveSearch(db, { cap, now = new Date() }) {
  const month = searchMonth(now);
  const r = await db.execute({
    sql: `INSERT INTO pexels_searches (month, used) SELECT ?, 1 WHERE 1 <= ?
          ON CONFLICT(month) DO UPDATE SET used = used + 1 WHERE pexels_searches.used + 1 <= ?`,
    args: [month, cap, cap],
  });
  return r.rowsAffected === 1;
}

/** This month's searches against the cap, for the admin quota data. */
export async function searchUsage(db, { cap, now = new Date() }) {
  const month = searchMonth(now);
  const r = await db.execute({ sql: "SELECT used FROM pexels_searches WHERE month = ?", args: [month] });
  return { month, used: Number(r.rows[0]?.used ?? 0), cap };
}
