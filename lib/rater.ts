import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { auth } from "@/auth";

export const ANON_VOTE_LIMIT = 10; // free votes before the sign-in gate
export const DAILY_VOTE_LIMIT = 100; // per rater, signed-in or not

export type Rater = {
  type: "human" | "anon";
  id: string;
  login?: string;
};

const ANON_COOKIE = "pr_anon";

/**
 * Identify the voter: signed-in GitHub users are canonical (`human`),
 * everyone else gets a sticky anon session id whose votes are logged but
 * never count toward official ELO.
 */
export async function getRater(): Promise<Rater> {
  const session = await auth();
  if (session?.githubId) {
    return { type: "human", id: `gh:${session.githubId}`, login: session.login };
  }
  const jar = await cookies();
  let anonId = jar.get(ANON_COOKIE)?.value;
  if (!anonId || !/^[0-9a-f-]{36}$/.test(anonId)) {
    anonId = randomUUID();
    jar.set(ANON_COOKIE, anonId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return { type: "anon", id: `anon:${anonId}` };
}
