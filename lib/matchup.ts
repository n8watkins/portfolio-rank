import { createHmac, timingSafeEqual } from "crypto";
import { pairKey } from "@/lib/elo";

// Server-issued proof that a rater was shown a pair. A vote must carry the
// token for exactly the pair it names, so nobody can vote "my site beats X"
// for an X of their choosing. Signed with a key derived from AUTH_SECRET.
export const MATCHUP_TTL_MS = 30 * 60 * 1000;

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update("portfolio-rank:v1").digest();
}

function mac(purpose: string, data: string): string {
  return createHmac("sha256", key()).update(`${purpose}\n${data}`).digest("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `<expiry ms>.<signature>` over the rater and the (unordered) pair. */
export function issueMatchupToken(raterId: string, a: string, b: string): string {
  const exp = Date.now() + MATCHUP_TTL_MS;
  return `${exp}.${mac("matchup", `${raterId}\n${pairKey(a, b)}\n${exp}`)}`;
}

export function verifyMatchupToken(
  token: unknown,
  raterId: string,
  a: string,
  b: string
): boolean {
  if (typeof token !== "string") return false;
  const m = token.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < Date.now() || exp > Date.now() + MATCHUP_TTL_MS) return false;
  return same(m[2], mac("matchup", `${raterId}\n${pairKey(a, b)}\n${exp}`));
}

/** Signed value for the practice-vote cookie: `<uuid>.<signature>`. */
export function signAnonId(id: string): string {
  return `${id}.${mac("anon", id)}`;
}

/** The uuid inside a practice-vote cookie, or null if the server didn't sign it. */
export function readAnonId(cookie: string | undefined): string | null {
  const m = cookie?.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return null;
  return same(m[2], mac("anon", m[1])) ? m[1] : null;
}
