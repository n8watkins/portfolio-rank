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

/** The reserve/release pair checkClaims takes, bound to a database and a cap. */
export function creditsFor(db, { cap, now = () => new Date() }) {
  return {
    reserve: (credits = SEARCH_CREDITS) => reserveCredits(db, { credits, cap, now: now() }),
    release: (credits = SEARCH_CREDITS) => releaseCredits(db, { credits, now: now() }),
  };
}
