import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import feed from "@/data/feed.json";
import { cached } from "@/lib/cache";
import { db, ensureSchema } from "@/lib/db";
import { currentVoter } from "@/lib/polls/server";
import { rateLimit } from "@/lib/polls/store.mjs";
import { heroOf, shotBases } from "@/lib/shots";
import { buildPool } from "@/lib/games/pool.mjs";
import { progress } from "@/lib/games/quiz.mjs";
import { HIT } from "@/lib/games/pool.mjs";
import { profilePath } from "@/lib/profile-url.mjs";

// Request-side helpers for the games, badges, claims, live stats and report
// APIs: the GAMES_V2 flag, who is playing, the cached quiz pool and the
// public shape of a quiz.

/**
 * Everything here is behind GAMES_V2 (wrangler.jsonc vars, "false") until the
 * redesign ships: off, every route answers 404 as if it didn't exist.
 */
export function gamesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GAMES_V2 === "true";
}

export const PRIVATE = { "cache-control": "private, no-store" };

export const fail = (error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: { ...PRIVATE, ...headers } });

export const off = () => fail("not_found", 404);

export type Pool = {
  source: "ratings" | "grades";
  totals: { merged: number; ai: number; people: number };
  sites: { u: string; m: number; a: number | null; p: number | null; t: string | null }[];
};

// The pool changes when the nightly recompute runs or a grade lands, so it is
// rebuilt at most every few hours (one read of the board, about 6,300 rows)
// and each isolate keeps it for a few minutes (docs/COSTS.md section C).
const POOL_TTL_MS = 3 * 60 * 60 * 1000;
// Kept in memory a few minutes; never in the end-to-end runs (SITE_ENV "test"),
// where one test's pool must not linger into the next test's seeded boards.
const POOL_MEMO_MS = process.env.SITE_ENV === "test" ? 0 : 5 * 60 * 1000;
let poolMemo: { at: number; pool: Promise<Pool> } | null = null;

export async function getPool(): Promise<Pool> {
  const now = Date.now();
  if (poolMemo && now - poolMemo.at < POOL_MEMO_MS) return poolMemo.pool;
  const pool = (async () => {
    await ensureSchema();
    const p = await cached<Pool>("games", "pool", { ttlMs: POOL_TTL_MS }, async () => (await buildPool(db())) as Pool);
    return { source: p.source, totals: p.totals, sites: p.sites };
  })();
  const entry = { at: now, pool };
  poolMemo = entry;
  pool.catch(() => {
    if (poolMemo === entry) poolMemo = null;
  });
  return pool;
}

/** Forgets this isolate's pool (tests, and after an owner hides or removes a site). */
export function forgetPool() {
  poolMemo = null;
}

export type Player = { id: string; browser: string; signedIn: boolean };

/**
 * Who is playing: the signed-in account, else the guest's signed practice
 * cookie (issued with `create`). Null when there is neither and `create` is false.
 */
export async function currentPlayer({ create }: { create: boolean }): Promise<Player | null> {
  const v = await currentVoter({ create });
  return v ? { id: v.voter, browser: v.browser, signedIn: v.signedIn } : null;
}

/** One hit on each rate-limit key; the first that is over, or null. */
export async function overLimit(hits: { key: string; limit: number; windowMs: number }[]) {
  const now = Date.now();
  const res = await Promise.all(hits.map((h) => rateLimit(db(), h.key, { limit: h.limit, windowMs: h.windowMs, now })));
  return res.find((r) => !r.ok) ?? null;
}

export const rateLimited = (over: { retryAfterSec: number }) => fail("rate_limited", 429, {}, { "retry-after": String(over.retryAfterSec) });

type FeedEntry = { url: string; name: string; tagline?: string };
const byUrl = new Map((feed as FeedEntry[]).map((p) => [p.url, p]));

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export const portfolioName = (url: string) => byUrl.get(url)?.name ?? domainOf(url);

/** A quiz as the player sees it: the five sites, never a percentile they haven't guessed. */
export async function publicQuiz(quiz: { id: string; kind: string; day: string | null; urls: string[] }, playerId: string | null) {
  const shots = await shotBases(quiz.urls);
  const mine = playerId ? await progress(db(), quiz.id, playerId) : { results: [], finished: false, score: 0, hits: 0 };
  return {
    id: quiz.id,
    kind: quiz.kind,
    day: quiz.day,
    challenge: `/play?mode=guess&quiz=${encodeURIComponent(quiz.id)}`,
    /** Points off that still count as a hit (lib/games/pool.mjs HIT). */
    hit: HIT,
    rounds: quiz.urls.map((url, index) => {
      const p = byUrl.get(url);
      const shot = shots.get(url) ?? null;
      return {
        index,
        url,
        name: p?.name ?? domainOf(url),
        tagline: p?.tagline ?? null,
        domain: domainOf(url),
        path: profilePath(url),
        shot,
        hero: shot ? heroOf(shot) : null,
      };
    }),
    progress: mine,
  };
}

/** A random quiz id: "r-" and 10 URL-safe characters (60 bits). */
export const newQuizId = () => `r-${randomBytes(8).toString("base64url").slice(0, 10)}`;

/** The Early supporter cut-off ("YYYY-MM-DD", Pacific), EARLY_SUPPORTER_UNTIL; none when unset. */
export const earlyUntil = () => (/^\d{4}-\d{2}-\d{2}$/.test(process.env.EARLY_SUPPORTER_UNTIL ?? "") ? process.env.EARLY_SUPPORTER_UNTIL! : null);

function key(purpose: string): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update(`portfolio-rank:${purpose}`).digest();
}

/** `<payload>.<signature>` signed for one purpose. */
export function sign(purpose: string, payload: string): string {
  return `${payload}.${createHmac("sha256", key(purpose)).update(payload).digest("base64url")}`;
}

/** The payload of a value `sign` made for this purpose, or null. */
export function unsign(purpose: string, value: string | undefined): string | null {
  const m = value?.match(/^(.+)\.([A-Za-z0-9_-]{43})$/);
  if (!m) return null;
  const want = Buffer.from(createHmac("sha256", key(purpose)).update(m[1]).digest("base64url"));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
