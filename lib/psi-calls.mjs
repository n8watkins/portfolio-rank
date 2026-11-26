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
  // The daily job's tries per site and device ("mobile" or "desktop") that did not end in a new stored result:
  // when the last one was (ms) and how many failed in a row. It sorts the job's queue (untried sites first) and
  // spaces the tries out (lib/psi-pacing.mjs backoffMs). A new stored result deletes the row.
  `CREATE TABLE IF NOT EXISTS psi_attempts (
    url TEXT NOT NULL,
    device TEXT NOT NULL,
    at INTEGER NOT NULL,
    fails INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (url, device)
  )`,
];

/** Notes that a measure of `device` ended without a new stored result (one more failure in a row). */
export async function recordFailedAttempt(db, url, device, now = Date.now()) {
  await db.execute({
    sql: `INSERT INTO psi_attempts (url, device, at, fails) VALUES (?, ?, ?, 1)
          ON CONFLICT(url, device) DO UPDATE SET at = excluded.at, fails = psi_attempts.fails + 1`,
    args: [url, device, now],
  });
}

/** A new result was stored for `device`: the count of failures in a row starts over. */
export async function clearAttempts(db, url, device) {
  await db.execute({ sql: "DELETE FROM psi_attempts WHERE url = ? AND device = ?", args: [url, device] });
}

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
