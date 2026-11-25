// PageSpeed calls made per Pacific day (Google's daily quota resets at
// midnight Pacific, the same day as pipeline/quota-day.mjs), counted when each
// call starts: the admin limits page's "PageSpeed runs" reads this, so a run
// whose result was never stored (a failed or cancelled measure) still counts.

import { quotaDay } from "../pipeline/quota-day.mjs";

export const PSI_CALL_TABLES = [
  `CREATE TABLE IF NOT EXISTS psi_calls (
    day TEXT PRIMARY KEY,
    n INTEGER NOT NULL DEFAULT 0
  )`,
];

/** Counts one PageSpeed call for today. Never throws: counting must not stop a measure. */
export async function countPsiCall(db, now = new Date()) {
  try {
    await db.execute({
      sql: "INSERT INTO psi_calls (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1",
      args: [quotaDay(now).day],
    });
  } catch {
    // The table may not exist yet on a database that has not been migrated.
  }
}
