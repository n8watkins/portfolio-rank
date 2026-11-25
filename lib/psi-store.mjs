// Saving a Lighthouse result under its cache key, in one SQL statement (so the
// Worker and the daily prewarm job can write the same row at the same time
// without one undoing the other): a result of one run never replaces an
// average of two (unless the average is older than STALE_MS: then it is due
// anyway), and a failure never replaces a good result (it is stored only where
// nothing good is, so a page can say why). Plain JavaScript: the
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
  // A good result replaces: nothing good, or as many runs or more, or a good result that is past the age Lighthouse is measured again at.
  const better = good ? `NOT ${STORED_GOOD} OR ? >= COALESCE(json_extract(cache.v, '$.runs'), 1) OR cache.at <= ?` : `NOT ${STORED_GOOD}`;
  const r = await db.execute({
    sql: `INSERT INTO cache (k, v, at) VALUES (?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE ${better}`,
    args: [key, JSON.stringify(value), at, ...(good ? [runCount(value), at - CHECK_KINDS.lighthouse.maxAgeMs] : [])],
  });
  return r.rowsAffected > 0;
}

/** The cache key of a device's result: "psi:<url>" (phone) or "psi-desktop:<url>". */
export const psiCacheKey = (strategy, url) => (strategy === "mobile" ? `psi:${url}` : `psi-desktop:${url}`);
