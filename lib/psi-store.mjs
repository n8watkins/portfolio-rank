// Saving a Lighthouse result under its cache key, in one SQL statement (so the
// Worker and the daily prewarm job can write the same row at the same time
// without one undoing the other): a result of one run never replaces an
// average of two, however old, and a failure never replaces a good result (it is
// stored only where nothing good is, so a page can say why). The one exception
// is the daily job (runsAttempted of 2 or more): when its measure ends with
// only one good run (the other failed, or both calls were the same Lighthouse
// run) it may replace a stored result past the 90-day freshness limit, so a
// flaky site does not keep a months-old average for ever. Plain JavaScript: the
// Worker (lib/tools/server.ts) and the job (lib/psi-job.mjs) share it.

import { runCount } from "./psi-runs.mjs";
import { CHECK_KINDS } from "./freshness.mjs";

// SQL: whether the stored row `cache.v` is a good result.
const STORED_GOOD = "COALESCE(json_valid(cache.v) AND json_extract(cache.v, '$.ok') = 1, 0)";

/**
 * @param {{ execute: Function }} db
 * @param {string} key "psi:<url>" or "psi-desktop:<url>"
 * @param {any} value a PsiResult
 * @param {number} [at]
 * @returns {Promise<boolean>} whether the row was written
 */
export async function storeIfBetter(db, key, value, at = Date.now()) {
  const good = value?.ok === true;
  // A good result replaces: what is not good; a result of as many runs or more; or, when the job made it (it tried two
  // runs or more), a stored result past the freshness limit. A failure replaces only what is not good.
  const better = good
    ? `NOT ${STORED_GOOD} OR ? >= COALESCE(json_extract(cache.v, '$.runs'), 1) OR (? AND cache.at <= ?)`
    : `NOT ${STORED_GOOD}`;
  const r = await db.execute({
    sql: `INSERT INTO cache (k, v, at) VALUES (?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE ${better}`,
    args: [key, JSON.stringify(value), at, ...(good ? [runCount(value), Number(value.runsAttempted) >= 2 ? 1 : 0, at - CHECK_KINDS.lighthouse.maxAgeMs] : [])],
  });
  return r.rowsAffected > 0;
}

/** The cache key of a device's result: "psi:<url>" (phone) or "psi-desktop:<url>". */
export const psiCacheKey = (strategy, url) => (strategy === "mobile" ? `psi:${url}` : `psi-desktop:${url}`);
