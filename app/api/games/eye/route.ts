import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { checkBadges } from "@/lib/games/badges.mjs";
import { PRIVATE, currentPlayer, earlyUntil, gamesEnabled, getPool, off } from "@/lib/games/server";

// GET /api/games/eye -> { eye } for the visitor ("your eye"):
//   crowd   { agree, of, pct }: face-off votes that match the People board
//           (the winner ranks higher there) plus quiz guesses within 10
//           points of the People percentile
//   ai      the same against the AI board
//   votes, guesses   the two parts separately
// pct is null until there is something to compare. Computed from stored
// votes and guesses (lib/games/badges.mjs gather), with the badge check.
export const dynamic = "force-dynamic";

export async function GET() {
  if (!gamesEnabled()) return off();
  await ensureSchema();
  const player = await currentPlayer({ create: false });
  if (!player) {
    const none = { agree: 0, of: 0, pct: null };
    return NextResponse.json({ eye: { crowd: none, ai: none, votes: { crowd: none, ai: none }, guesses: { crowd: none, ai: none } } }, { headers: PRIVATE });
  }
  const { eye } = await checkBadges(db(), player.id, { pool: await getPool(), signedIn: player.signedIn, earlyUntil: earlyUntil() });
  return NextResponse.json({ eye }, { headers: PRIVATE });
}
