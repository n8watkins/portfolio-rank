import { db, ensureSchema } from "./db";
import { runInBackground } from "./background";

/** What every cached lookup returns on top of its own fields. */
export type CacheMeta = {
  /** When this result was measured (ISO 8601). */
  measuredAt?: string;
  /** True when the result is older than its TTL and a refresh is under way. */
  stale?: boolean;
};

// Only one isolate refreshes a given key at a time: it takes a lease row in the
// same table (`lease:<key>`), and the lease expires so a crashed refresh can't
// block the key for good. Within an isolate, concurrent refreshes and first
// fills of the same key share one promise.
const LEASE_MS = 10 * 60 * 1000;
const inflight = new Map<string, Promise<unknown>>();

async function takeLease(k: string): Promise<boolean> {
  const now = Date.now();
  const res = await db().execute({
    sql: `INSERT INTO cache (k, v, at) VALUES (?, '', ?)
          ON CONFLICT(k) DO UPDATE SET at = excluded.at WHERE cache.at < ?`,
    args: [`lease:${k}`, now, now - LEASE_MS],
  });
  return res.rowsAffected > 0;
}

async function releaseLease(k: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`lease:${k}`] });
}

function once<T>(k: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(k) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export type CacheOptions<T> = {
  /** How long a result stays fresh. */
  ttlMs: number;
  /**
   * Marks a result as a failure. A failure is stored too, but stays fresh only
   * `failureTtlMs`, and a failed refresh never replaces a good result.
   */
  isFailure?: (data: T) => boolean;
  failureTtlMs?: number;
  /**
   * Take the cross-isolate lease before filling a miss, so an expensive
   * lookup runs once however many isolates miss at the same moment; the
   * others get `busy()` at once.
   */
  leaseOnMiss?: { busy: () => T };
};

/**
 * A cached result as stored, with when it was measured, or null. Never
 * computes or refreshes: for a page's first paint (the profile's checks and
 * social links), which the client then asks for as usual.
 */
export async function peekCached<T extends object>(namespace: string, key: string): Promise<(T & CacheMeta) | null> {
  await ensureSchema();
  const row = (await db().execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [`${namespace}:${key}`] })).rows[0];
  if (!row?.v) return null;
  try {
    return { ...(JSON.parse(String(row.v)) as T), measuredAt: new Date(Number(row.at)).toISOString() };
  } catch {
    return null;
  }
}

/**
 * Read-through cache in the `cache` table (`<namespace>:<key>` → JSON, `at` =
 * when it was measured).
 *
 * - Fresh hit: returned as is.
 * - Stale hit (older than its TTL): returned at once with `stale: true`, and a
 *   refresh runs in the background (Workers `ctx.waitUntil`), at most one per
 *   key across isolates. A failed refresh keeps the old good result and is
 *   retried after the lease expires.
 * - Miss: computed while the caller waits (concurrent misses in an isolate
 *   share one call; with `leaseOnMiss`, across isolates too).
 */
export async function cached<T extends object>(
  namespace: string,
  key: string,
  options: CacheOptions<T>,
  compute: () => Promise<T>
): Promise<T & CacheMeta> {
  const { ttlMs, isFailure = () => false, failureTtlMs = ttlMs, leaseOnMiss } = options;
  const ttlOf = (data: T) => (isFailure(data) ? failureTtlMs : ttlMs);
  await ensureSchema();
  const k = `${namespace}:${key}`;

  const store = async (data: T): Promise<number> => {
    const at = Date.now();
    await db().execute({
      sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
      args: [k, JSON.stringify(data), at],
    });
    return at;
  };

  const fill = async (): Promise<T & CacheMeta> => {
    if (leaseOnMiss && !(await takeLease(k))) return leaseOnMiss.busy();
    try {
      const data = await compute();
      const at = await store(data);
      return { ...data, measuredAt: new Date(at).toISOString() };
    } finally {
      if (leaseOnMiss) await releaseLease(k).catch(() => {});
    }
  };

  // A refresh that fails keeps a good old result and holds the lease until it
  // expires, so a failing lookup is retried at most once per LEASE_MS instead
  // of on every request. A stored failure is simply replaced.
  const refresh = async (hadFailure: boolean): Promise<void> => {
    if (!(await takeLease(k))) return;
    const data = await compute();
    if (isFailure(data) && !hadFailure) return;
    await store(data);
    await releaseLease(k);
  };

  const row = (
    await db().execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })
  ).rows[0];
  if (!row) return once(k, fill);

  const at = Number(row.at);
  const data = JSON.parse(String(row.v)) as T;
  const measuredAt = new Date(at).toISOString();
  if (Date.now() - at < ttlOf(data)) return { ...data, measuredAt };

  if (!inflight.has(k)) runInBackground(once(k, () => refresh(isFailure(data))));
  return { ...data, measuredAt, stale: true };
}
