import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { SITE_URL } from "@/lib/site";
import { kitClient } from "./kit.mjs";
import { readSwitch } from "./switch.mjs";

// What the newsletter's routes and admin pages share (AUTOMATION.md "Newsletter").

/** NEWSLETTER_ENABLED: the sign-up route answers 404 and the cron does nothing while it is not "true". */
export const newsletterEnabled = () => /^true$/i.test(String(process.env.NEWSLETTER_ENABLED ?? ""));

/**
 * Whether the newsletter is live: NEWSLETTER_ENABLED (the deploy-level kill
 * switch) and the owner's stored switch (lib/newsletter/switch.mjs) both on.
 */
export async function newsletterLive(): Promise<boolean> {
  if (!newsletterEnabled()) return false;
  await ensureSchema();
  return (await readSwitch(db())).on;
}

/** This site's address, for links in emails. */
export const siteBase = () => (process.env.SITE_URL || SITE_URL).replace(/\/$/, "");

const nlSecret = () => String(process.env.AUTH_SECRET ?? "");

/** KIT_TEST_API: a local stand-in for Kit in the end-to-end tests, ignored on the deployed Workers. */
const kitTestApi = () => (["production", "staging"].includes(String(process.env.SITE_ENV ?? "")) ? undefined : process.env.KIT_TEST_API || undefined);

/** The Kit client (KIT_API_KEY, a Worker secret), or null without the key. */
export const kit = () => kitClient({ apiKey: process.env.KIT_API_KEY, base: kitTestApi() });

/**
 * The Kit form people sign up through, whose double opt-in sends the confirm
 * email: KIT_FORM_ID, else the account's only active form (asked once a
 * day). Null when neither says.
 */
export async function kitFormId(): Promise<string | null> {
  const set = String(process.env.KIT_FORM_ID ?? "").trim();
  if (/^\d+$/.test(set)) return set;
  const client = kit();
  if (!client) return null;
  const r = await cached<{ id: string | null }>("kit", "form", { ttlMs: DAY, isFailure: (d) => d.id == null, failureTtlMs: DAY / 24 }, async () => {
    try {
      return { id: await client.onlyForm() };
    } catch {
      return { id: null };
    }
  });
  return r.id;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export const fail = (error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => json({ error, ...extra }, status, headers);

/** A keyed hash, so rate-limit keys never hold an address or an IP. */
export const keyed = (kind: string, value: string) => createHmac("sha256", nlSecret()).update(`${kind}\n${value}`).digest("base64url").slice(0, 22);

/** The first limit that is used up, or null. */
export async function limited(hits: { key: string; limit: number; windowMs: number }[]) {
  const now = Date.now();
  for (const h of hits) {
    const r = await rateLimit(db(), h.key, { limit: h.limit, windowMs: h.windowMs, now });
    if (!r.ok) return r;
  }
  return null;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Kit's confirmed subscribers, cached for a day (one Kit call a day however
 * often the admin pages and the owner goals look): { count } or, when Kit
 * isn't set up or didn't answer, { count: null, error } (kept an hour).
 * `fresh` skips the cache (the admin's Newsletter page).
 */
export async function subscriberCount({ fresh = false } = {}): Promise<{ count: number | null; error?: string; measuredAt?: string }> {
  const client = kit();
  if (!client) return { count: null, error: "no_kit_key" };
  const compute = async () => {
    try {
      return { count: await client.confirmedCount() };
    } catch (e) {
      return { count: null, error: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  };
  if (fresh) {
    const r = await compute();
    // A good fresh count also refreshes the cached one the other pages read.
    if (r.count != null) await db().execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES ('kit:confirmed', ?, ?)", args: [JSON.stringify(r), Date.now()] });
    return { ...r, measuredAt: new Date().toISOString() };
  }
  return cached<{ count: number | null; error?: string }>("kit", "confirmed", { ttlMs: DAY, isFailure: (d) => d.count == null, failureTtlMs: DAY / 24 }, compute);
}
