import { createHmac, randomUUID } from "crypto";
import { verifyTurnstile as verifyTurnstileFor } from "@/lib/turnstile";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import feed from "@/data/feed.json";
import { readAnonId, signAnonId } from "@/lib/matchup";
import { ANON_COOKIE } from "@/lib/rater";
import { heroOf, shotBases } from "@/lib/shots";
import { SITE_URL } from "@/lib/site";

// Request-side helpers for the polls API (app/api/polls): who is voting,
// the Origin check, Turnstile, and the public shape of a poll.

/** A poll id: the Monday that starts its week (lib/polls/week.mjs). */
export const POLL_ID = /^\d{4}-\d{2}-\d{2}$/;

/** Poll options as the database layer returns them (lib/polls/store.mjs). */
type StoredOption = { index: number; label: string; votes: number; percent: number; url?: string };
export type StoredPoll = {
  id: string;
  kind: string;
  question: string;
  detail: string;
  opensAt: string;
  closesAt: string;
  status: "active" | "closed";
  total: number;
  options: StoredOption[];
};

export type PollSite = {
  url: string;
  name: string;
  domain: string;
  /** The site's page on PortfolioRank. */
  path: string;
  /** Capture base for frameOf (lib/shot-url), or null when there is no capture to show. */
  shot: string | null;
  /** The hero screenshot's URL, or null. */
  hero: string | null;
};
export type PublicPoll = Omit<StoredPoll, "options"> & {
  kind: "hero" | "text";
  options: (Omit<StoredOption, "url"> & { site?: PollSite })[];
};

const names = new Map((feed as { url: string; name: string }[]).map((p) => [p.url, p.name]));
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Adds each screenshot option's site (name, domain, page, screenshot). */
export async function publicPolls(polls: StoredPoll[]): Promise<PublicPoll[]> {
  const urls = [...new Set(polls.flatMap((p) => p.options.flatMap((o) => (o.url ? [o.url] : []))))];
  const shots = await shotBases(urls);
  return polls.map((p) => ({
    ...p,
    kind: p.kind === "hero" ? "hero" : "text",
    options: p.options.map(({ url, ...o }) => {
      if (!url) return o;
      const shot = shots.get(url) ?? null;
      return {
        ...o,
        site: { url, name: names.get(url) ?? domainOf(url), domain: domainOf(url), path: `/p/${encodeURIComponent(url)}`, shot, hero: shot ? heroOf(shot) : null },
      };
    }),
  }));
}

export type Voter = {
  /** One vote per this: the signed-in account (gh:<id>), else the practice id (anon:<uuid>). */
  voter: string;
  /** And one vote per browser: the signed practice cookie's id. */
  browser: string;
  signedIn: boolean;
};

/**
 * Who is voting. The browser always carries the signed practice cookie
 * (pr_anon, lib/rater.ts); with `create`, one is issued when it is missing
 * or forged. Returns null when there is none and `create` is false.
 */
export async function currentVoter({ create }: { create: boolean }): Promise<Voter | null> {
  const jar = await cookies();
  let anonId = readAnonId(jar.get(ANON_COOKIE)?.value);
  const session = await auth();
  if (!anonId) {
    if (!create) return session?.raterId ? { voter: session.raterId, browser: "", signedIn: true } : null;
    anonId = randomUUID();
    jar.set(ANON_COOKIE, signAnonId(anonId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  const browser = `anon:${anonId}`;
  return session?.raterId ? { voter: session.raterId, browser, signedIn: true } : { voter: browser, browser, signedIn: false };
}

/**
 * A vote must come from a page of this site: the Origin header must be the
 * site's own (or this request's, for previews and local runs). Browsers send
 * Origin on every cross-site and every POST fetch.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(SITE_URL).origin, new URL(req.url).origin]);
  if (process.env.AUTH_URL) {
    try {
      allowed.add(new URL(process.env.AUTH_URL).origin);
    } catch {
      /* not a URL */
    }
  }
  return allowed.has(origin);
}

/** The client's IP as Cloudflare reports it, or "" outside Cloudflare. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "";
}

/** A keyed hash of the IP for the rate limits: the database never stores an address. */
export function ipKey(ip: string): string {
  const secret = process.env.AUTH_SECRET ?? "";
  return createHmac("sha256", secret).update(`poll-ip\n${ip}`).digest("base64url").slice(0, 22);
}

/**
 * Cloudflare Turnstile for a poll vote (lib/turnstile.ts, action
 * "poll-vote"). The deployed Workers refuse without a usable secret; only
 * local runs skip it. "ok", "skipped" or "failed".
 */
export async function verifyTurnstile(token: unknown, ip: string): Promise<"ok" | "skipped" | "failed"> {
  return verifyTurnstileFor(token, ip, { action: "poll-vote" });
}

export { turnstileRequired } from "@/lib/turnstile";
