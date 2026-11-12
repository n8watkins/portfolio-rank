import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { SITE_URL } from "@/lib/site";

// What the newsletter's routes share (AUTOMATION.md "Newsletter").

/** NEWSLETTER_ENABLED: the sign-up, confirm and unsubscribe routes answer 404 and the cron does nothing while it is not "true". */
export const newsletterEnabled = () => /^true$/i.test(String(process.env.NEWSLETTER_ENABLED ?? ""));

/** This site's address, for links in emails. */
export const siteBase = () => (process.env.AUTH_URL || SITE_URL).replace(/\/$/, "");

export const nlSecret = () => String(process.env.AUTH_SECRET ?? "");

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
