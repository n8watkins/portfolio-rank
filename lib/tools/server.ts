import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";
import { normalizeGradeUrl, siteKeyOf } from "@/lib/grader/url.mjs";
import { fail, readJsonBody, requester, sameOrigin } from "@/lib/grader/server";
import { reserveTool, toolCaps } from "./caps.mjs";
import { addPending } from "@/lib/discovery/sites.mjs";

// Request-side helpers for the free tools (app/api/tools/*, docs/TOOLS.md).
// Every tool request goes through gate(): the switch, same origin, a sane
// address, an hourly attempt limit, then Turnstile. A result is reused from
// the cache table for a day; only a fresh run reserves the daily caps.

/** The free tools answer only when TOOLS_ENABLED is "true" (staging first). */
export const toolsEnabled = () => /^true$/i.test(String(process.env.TOOLS_ENABLED ?? ""));

/** How long one result is reused for anyone who checks the same address. */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
/** Attempts (cached or not) per visitor and per network an hour, before Turnstile. */
const ATTEMPTS_PER_HOUR = { visitor: 40, network: 120 };

// Listed portfolios by site key, so "https://www.jane.dev/" finds "https://jane.dev".
const listed = new Map<string, string>();
for (const p of feed as { url: string }[]) {
  try {
    listed.set(siteKeyOf(p.url), p.url);
  } catch {
    // A malformed roster entry is simply not matched.
  }
}

/** The listed portfolio's own address for a checked one, or null when it isn't on the list. */
export function listedUrl(url: string): string | null {
  try {
    return listed.get(siteKeyOf(url)) ?? null;
  } catch {
    return null;
  }
}

export type Gate = Awaited<ReturnType<typeof requester>> & {
  /** The address as checked (normalized, https assumed). */
  url: string;
  siteKey: string;
  /** The listed portfolio's address when it is on the list: its saved results are the ones refreshed. */
  listed: string | null;
  body: Record<string, unknown>;
};

/** Checks a tool request; the Response is the refusal to send back. */
export async function gate(req: Request, action: string): Promise<Gate | Response> {
  if (!toolsEnabled()) return fail("not_found", 404);
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const body = await readJsonBody(req);
  if (!body) return fail("bad_request", 400);
  const target = normalizeGradeUrl(body.url);
  if (!target.ok) return fail(target.error, 400, { message: target.message.replace(/graded/g, "checked") });
  await ensureSchema();
  const who = await requester(req);
  const client = db();
  const now = Date.now();
  const limits = [rateLimit(client, `tools:v:${who.visitor}`, { limit: ATTEMPTS_PER_HOUR.visitor, windowMs: HOUR, now })];
  if (who.network) limits.push(rateLimit(client, `tools:n:${who.network}`, { limit: ATTEMPTS_PER_HOUR.network, windowMs: HOUR, now }));
  const over = (await Promise.all(limits)).find((h) => !h.ok);
  if (over) return fail("rate_limited", 429, { message: "That's a lot of checks in a short time. Try again in a little while." }, { "retry-after": String(over.retryAfterSec) });
  if ((await verifyTurnstile(body.turnstileToken, who.ip, { action })) === "failed") return fail("turnstile_failed", 403, { message: "We couldn't check that you're a person. Reload the page and try again." });
  const listedAs = listedUrl(target.url);
  return { ...who, url: listedAs ?? target.url, siteKey: target.siteKey, listed: listedAs, body };
}

/** Reserves one fresh run of `tool` for this visitor; a Response when a cap is reached. */
export async function reserve(g: Gate, tool: "speed" | "page"): Promise<Response | null> {
  const r = await reserveTool(db(), { tool, visitor: g.visitor, network: g.network, network48: g.network48, caps: toolCaps(process.env.TOOLS_CAPS) });
  if (r.ok) return null;
  const message =
    r.scope === "site"
      ? "Today's free checks are used up. They reset at midnight Pacific time."
      : "That's today's limit of checks from you. It resets at midnight Pacific time.";
  return fail("daily_limit", 429, { scope: r.scope, resetAt: r.resetAt, message });
}

/** A cached result younger than `ttlMs`, with when it was measured; null when missing or older. */
export async function readFresh<T>(key: string, ttlMs = RESULT_TTL_MS, now = Date.now()): Promise<(T & { measuredAt: string }) | null> {
  const row = (await db().execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [key] })).rows[0];
  if (!row || now - Number(row.at) >= ttlMs) return null;
  try {
    return { ...(JSON.parse(String(row.v)) as T), measuredAt: new Date(Number(row.at)).toISOString() };
  } catch {
    return null;
  }
}

/** True when the visitor asked to measure again now ("Check again" after a fix): the day's cached result is skipped, and the run counts against the caps. */
export const wantsFresh = (g: Gate) => g.body.fresh === true;

/**
 * Every site a tool checked and could load is added to PortfolioRank: a
 * listed one is refreshed in place, any other joins the discovery seen-set
 * as pending (private until graded; lib/discovery/sites.mjs). Owner
 * decision 2026-11-12: no opt-in box, said under the button and in the
 * privacy policy.
 */
export async function remember(g: Gate, loaded: boolean): Promise<{ status: string; added: boolean } | null> {
  if (g.listed || !loaded) return null;
  return addPending(db(), { url: g.url, source: "tools" });
}

/** The answer's common part: the address, whether it's listed, and the profile to see the saved results on. */
export const answerHead = (g: Gate) => ({ url: g.url, listed: Boolean(g.listed), ...(g.listed ? { profile: `/p/${encodeURIComponent(g.listed)}` } : {}) });

/** Saves a result under its cache key (the same keys the profile reads). */
export async function store(key: string, value: object, at = Date.now()): Promise<void> {
  await db().execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [key, JSON.stringify(value), at] });
}
