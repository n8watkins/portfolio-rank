import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { QUIZ_ID, getQuiz } from "@/lib/games/quiz.mjs";
import { PRIVATE, currentPlayer, fail, gamesEnabled, off, publicQuiz } from "@/lib/games/server";

// GET /api/games/quiz/<id> -> { quiz } with the visitor's progress: a
// challenge link (or a past Daily 5) replays the same five. 404 not_found.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gamesEnabled()) return off();
  const { id } = await params;
  if (!QUIZ_ID.test(id)) return fail("not_found", 404);
  await ensureSchema();
  const quiz = await getQuiz(db(), id);
  if (!quiz) return fail("not_found", 404);
  const player = await currentPlayer({ create: false });
  return NextResponse.json({ quiz: await publicQuiz(quiz, player?.id ?? null) }, { headers: PRIVATE });
}
