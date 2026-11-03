import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { auth } from "@/auth";
import { readAnonId, signAnonId } from "@/lib/matchup";

export const ANON_VOTE_LIMIT = 10; // free votes before the sign-in gate
export const DAILY_VOTE_LIMIT = 100; // per rater, signed-in or not
export const STAR_PER_VOTES = 5; // earn 1 Superstar per N votes
export const STAR_BANK_CAP = 5; // bank at most this many unspent stars
export const MAX_DRAWS_PER_HOUR = 120; // new matchups a signed-in rater may draw per hour
export const UNDO_WINDOW_MINUTES = 10; // only a recent vote can be undone

export type Rater = {
  type: "human" | "anon";
  id: string;
  login?: string;
};

export const ANON_COOKIE = "pr_anon";

/**
 * Identify the voter: signed-in users are canonical (`human`, raterId is
 * provider-prefixed: gh:<id> / g:<sub>), everyone else gets a sticky anon
 * session id whose votes are logged but never count toward official ELO.
 */
export async function getRater(): Promise<Rater> {
  const session = await auth();
  if (session?.raterId) {
    return { type: "human", id: session.raterId, login: session.login };
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
