import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { auth } from "@/auth";
import { readAnonId, signAnonId } from "@/lib/matchup";

export const ANON_VOTE_LIMIT = 10; // free votes before the sign-in gate
export const DAILY_VOTE_LIMIT = 100; // per rater, signed-in or not
export const STAR_PER_VOTES = 5; // earn 1 Superstar per N votes
export const STAR_BANK_CAP = 5; // bank at most this many unspent stars
export const MAX_DRAWS_PER_HOUR = 120; // new matchups a signed-in rater may draw per hour
// A practice visitor needs about 10 pairs for their 10 votes, plus skips. A low
// daily cap means nobody can fish (skip and redraw) for a chosen site to vote
// for and then claim those votes at sign-in.
export const ANON_MAX_DRAWS_PER_DAY = 60;
export const UNDO_WINDOW_MINUTES = 10; // only a recent vote can be undone

/**
 * Owner-tunable guards, off when unset (0). Set as Worker vars in
 * wrangler.jsonc, read per request:
 * - HUMAN_MAX_DRAWS_PER_DAY: matchups a signed-in rater may draw per day,
 *   on top of the hourly MAX_DRAWS_PER_HOUR.
 * - MIN_GITHUB_ACCOUNT_AGE_DAYS (30 in wrangler.jsonc): GitHub accounts
 *   younger than this can sign in, like and keep lists, but their votes (and
 *   claimed practice votes) don't count, a claim they prove waits for the
 *   site owner's review, and they can't act as a portfolio's owner. Sessions
 *   from before the account date was recorded are treated as too new until
 *   they sign in again.
 */
export function guardConfig() {
  const num = (name: string) => {
    const n = Number(process.env[name] ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    humanMaxDrawsPerDay: num("HUMAN_MAX_DRAWS_PER_DAY"),
    minAccountAgeDays: num("MIN_GITHUB_ACCOUNT_AGE_DAYS"),
  };
}

/**
 * True when MIN_GITHUB_ACCOUNT_AGE_DAYS is set and this signed-in rater's
 * GitHub account is younger. Email accounts (em:) are never too new: their
 * votes count fully (owner decision 2026-11-12: deal with fake accounts only
 * if it actually happens).
 */
export function accountTooNew(rater: Pick<Rater, "type" | "accountCreatedAt"> & { id?: string }): boolean {
  const { minAccountAgeDays } = guardConfig();
  if (rater.type !== "human" || !minAccountAgeDays) return false;
  if (rater.id?.startsWith("em:")) return false;
  const created = Date.parse(rater.accountCreatedAt ?? "");
  if (!Number.isFinite(created)) return true;
  return Date.now() - created < minAccountAgeDays * 24 * 60 * 60 * 1000;
}

export type Rater = {
  type: "human" | "anon";
  id: string;
  login?: string;
  accountCreatedAt?: string;
};

export const ANON_COOKIE = "pr_anon";

/**
 * Identify the voter: signed-in users are canonical (`human`, raterId is
 * provider-prefixed: gh:<GitHub id> / em:<email account id>), everyone else gets a sticky anon
 * session id whose votes are logged but never count toward official ELO.
 */
export async function getRater(): Promise<Rater> {
  const session = await auth();
  if (session?.raterId) {
    return {
      type: "human",
      id: session.raterId,
      login: session.login,
      accountCreatedAt: session.accountCreatedAt,
    };
  }
  const jar = await cookies();
  // The cookie is `<uuid>.<signature>`: a value the server didn't sign (an
  // old unsigned cookie or a forged one) is replaced with a fresh identity.
  let anonId = readAnonId(jar.get(ANON_COOKIE)?.value);
  if (!anonId) {
    anonId = randomUUID();
    jar.set(ANON_COOKIE, signAnonId(anonId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return { type: "anon", id: `anon:${anonId}` };
}
