import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { sameOrigin, clientIp, ipKey } from "@/lib/polls/server";
import { dailyQuiz, randomQuiz } from "@/lib/games/quiz.mjs";
import { PRIVATE, currentPlayer, fail, gamesEnabled, getPool, newQuizId, off, overLimit, publicQuiz, rateLimited } from "@/lib/games/server";

// Guess the percentile (GAMES_V2).
// GET  /api/games/quiz  -> today's Daily 5 (Pacific day), the same five for
//                          everyone: { quiz } with the visitor's progress
// POST /api/games/quiz  -> a new random quiz: { quiz }; its `challenge`
//                          link replays the same five for anyone
// A quiz never carries a percentile the visitor hasn't guessed yet; guesses
// go to /api/games/quiz/<id>/guess. 503 no_portfolios while nothing is graded.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

export async function GET() {
  if (!gamesEnabled()) return off();
  await ensureSchema();
  const quiz = await dailyQuiz(db(), await getPool(), { now: new Date() });
  if (!quiz) return fail("no_portfolios", 503);
  const player = await currentPlayer({ create: false });
  return NextResponse.json({ quiz: await publicQuiz(quiz, player?.id ?? null) }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  if (!gamesEnabled()) return off();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  await ensureSchema();
  const player = (await currentPlayer({ create: true }))!;
  const ip = clientIp(req);
  // Each quiz is a stored row: new ones are capped per browser and per network.
  const over = await overLimit([
    { key: `quiz-new:b:${player.browser || player.id}`, limit: 30, windowMs: HOUR },
    ...(ip ? [{ key: `quiz-new:ip:${ipKey(ip)}`, limit: 120, windowMs: HOUR }] : []),
  ]);
  if (over) return rateLimited(over);
  const quiz = await randomQuiz(db(), await getPool(), { id: newQuizId(), now: new Date() });
  if (!quiz) return fail("no_portfolios", 503);
  return NextResponse.json({ quiz: await publicQuiz(quiz, player.id) }, { status: 201, headers: PRIVATE });
}
