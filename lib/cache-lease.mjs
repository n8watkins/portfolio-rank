// The lease rows of the cache table (`lease:<key>`): only one worker measures
// a given key at a time, across the Worker's isolates and the daily prewarm
// job. A lease expires, so a crashed run cannot block the key for good.
// Plain JavaScript: lib/cache.ts and lib/psi-job.mjs share it.

/** How long a lease holds before another may take it (ms). */
export const LEASE_MS = 10 * 60 * 1000;

/** Takes the lease on `k` ("psi:<url>"); false when another holds it. */
export async function takeLease(db, k, now = Date.now()) {
  const res = await db.execute({
    sql: `INSERT INTO cache (k, v, at) VALUES (?, '', ?)
          ON CONFLICT(k) DO UPDATE SET at = excluded.at WHERE cache.at < ?`,
    args: [`lease:${k}`, now, now - LEASE_MS],
  });
  return res.rowsAffected > 0;
}

/** Gives the lease on `k` back. */
export async function releaseLease(db, k) {
  await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`lease:${k}`] });
}
