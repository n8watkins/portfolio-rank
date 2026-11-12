// The weekly change fingerprint of every listed site (lib/freshness.mjs,
// AUTOMATION.md "When checks re-run"), spread over the hourly Cron Trigger
// ("15 * * * *", worker/index.ts): each tick checks about a 168th of the
// list, so every site is checked once a week, and a site attempted in the
// last day is never fetched again. One ordinary page fetch per site, the
// same as the polish check's (lib/safefetch.ts: every redirect hop
// re-checked, 10-second timeout, body capped), and no other request.
import feed from "../data/feed.json";
import { db as database, ensureSchema } from "../lib/db";
import { readCapped, safeFetch } from "../lib/safefetch";
import { FINGERPRINT_MAX_BYTES, checkFingerprints, pageFingerprint, perTick } from "../lib/freshness.mjs";
import { ACTIVE } from "../pipeline/roster.mjs";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

/** One page fetch: its fingerprint, or why there is none. */
export async function fetchFingerprint(url: string, now = Date.now()): Promise<{ fp: ReturnType<typeof pageFingerprint> } | { error: string }> {
  const got = await safeFetch(url, { timeoutMs: 10_000 });
  if (!got) return { error: "unreachable" };
  const { res, finalUrl } = got;
  const type = res.headers.get("content-type") ?? "";
  if (res.status >= 400 || (type && !/text\/html|application\/xhtml/i.test(type))) {
    await res.body?.cancel().catch(() => {});
    return { error: res.status >= 400 ? `http_${res.status}` : "not_html" };
  }
  const html = await readCapped(res, FINGERPRINT_MAX_BYTES);
  return { fp: pageFingerprint({ html, finalUrl, headers: res.headers, now }) };
}

export async function freshnessTick(scheduledTime: number) {
  try {
    await ensureSchema();
    const out = await checkFingerprints(database(), {
      fetchPage: (url: string) => fetchFingerprint(url, scheduledTime),
      now: scheduledTime,
      limit: perTick((feed as unknown[]).length),
      active: ACTIVE,
    });
    log("freshness.tick", out);
    return out;
  } catch (e) {
    // Never fails the cron's other work; the next hour picks up where this left off.
    log("freshness.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
