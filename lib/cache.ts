import { db, ensureSchema } from "./db";
import { runInBackground } from "./background";
import { decide, type CheckKind } from "./freshness.mjs";

/** Why a stored result is being measured again (lib/freshness.mjs decide). */
export type StaleReason = "changed" | "forced" | "max_age" | "failed";

/** What every cached lookup returns on top of its own fields. */
export type CacheMeta = {
  /** When this result was measured (ISO 8601). */
  measuredAt?: string;
  /** True when the result is due again and a refresh is under way. */
  stale?: boolean;
  /** With `stale`, why: the site changed, the admin asked, or it is past its maximum age. */
  staleReason?: StaleReason;
  /** When a later check found the site unchanged since this was measured (ISO 8601). */
  unchangedSince?: string;
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
  /**
   * The site's change rule instead of a fixed TTL (lib/freshness.mjs): the
   * result is reused while the page is unchanged, and due again when its
   * fingerprint changed, the admin pressed "Re-measure", or it is older
   * than the kind's maximum age; a failure keeps its short retry window.
   */
  freshness?: { kind: CheckKind; url: string };
};

type Entry<T> = { data: T; at: number; due: { run: boolean; reason: StaleReason | "missing" | null; unchangedSince: number | null } };

/**
 * The stored result for `k` and whether it is due again: by the site's
 * change rule when `freshness` is given (one query reads the result and the
 * site's fingerprint row together), else by age against `ttlOf`.
 */
export async function readEntry<T>(k: string, ttlOf: (data: T) => number, isFailure: (data: T) => boolean, freshness?: { kind: CheckKind; url: string }): Promise<Entry<T> | null> {
  const row = freshness
    ? (
        await db().execute({
          sql: `SELECT c.v, c.at, f.checked_at, f.changed_at, f.forced_at
                FROM (SELECT ? AS k, ? AS u) q
                LEFT JOIN cache c ON c.k = q.k
                LEFT JOIN site_freshness f ON f.url = q.u`,
          args: [k, freshness.url],
        })
      ).rows[0]
    : (await db().execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })).rows[0];
  if (!row || row.v == null || row.v === "") return null;
  const at = Number(row.at);
  const data = JSON.parse(String(row.v)) as T;
  if (freshness) {
    const due = decide(freshness.kind, { result: { at, failed: isFailure(data) }, page: row });
    return { data, at, due: due as Entry<T>["due"] };
  }
  const old = Date.now() - at >= ttlOf(data);
  return { data, at, due: { run: old, reason: old ? (isFailure(data) ? "failed" : "max_age") : null, unchangedSince: null } };
}

/** The CacheMeta for a stored entry. */
export function metaOf<T>(entry: Entry<T>): CacheMeta {
  const meta: CacheMeta = { measuredAt: new Date(entry.at).toISOString() };
  if (entry.due.run) {
    meta.stale = true;
    if (entry.due.reason && entry.due.reason !== "missing") meta.staleReason = entry.due.reason;
  } else if (entry.due.unchangedSince != null) {
    meta.unchangedSince = new Date(entry.due.unchangedSince).toISOString();
  }
  return meta;
}

/**
 * Read-through cache in the `cache` table (`<namespace>:<key>` → JSON, `at` =
 * when it was measured).
 *
 * - Fresh hit: returned as is (with `unchangedSince` when a fingerprint check
 *   since found the site unchanged).
 * - Due hit (older than its TTL, or by the site's change rule with
 *   `freshness`): returned at once with `stale: true` and `staleReason`, and
 *   a refresh runs in the background (Workers `ctx.waitUntil`), at most one
 *   per key across isolates. A failed refresh keeps the old good result and
 *   is retried after the lease expires.
 * - Miss: computed while the caller waits (concurrent misses in an isolate
 *   share one call; with `leaseOnMiss`, across isolates too).
 */
export async function cached<T extends object>(
  namespace: string,
  key: string,
  options: CacheOptions<T>,
  compute: () => Promise<T>
): Promise<T & CacheMeta> {
  const { ttlMs, isFailure = () => false, failureTtlMs = ttlMs, leaseOnMiss, freshness } = options;
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

  const entry = await readEntry<T>(k, ttlOf, isFailure, freshness);
  if (!entry) return once(k, fill);
  const meta = metaOf(entry);
  if (!entry.due.run) return { ...entry.data, ...meta };

  if (!inflight.has(k)) runInBackground(once(k, () => refresh(isFailure(entry.data))));
  return { ...entry.data, ...meta };
}
