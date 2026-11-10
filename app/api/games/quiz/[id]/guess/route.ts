import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { clientIp, ipKey, sameOrigin } from "@/lib/polls/server";
import { QUIZ_ID, getQuiz, recordGuess } from "@/lib/games/quiz.mjs";
import { checkBadges } from "@/lib/games/badges.mjs";
import { PRIVATE, currentPlayer, earlyUntil, fail, gamesEnabled, getPool, off, overLimit, rateLimited } from "@/lib/games/server";

// POST /api/games/quiz/<id>/guess { index: 0-4, guess: 1-100 ("top X%") }
//   200 { result, finished, badges }
//        result    { index, guess, merged, ai, people, points, hit }: the
//                  real percentiles, only now that the guess is in
//        finished  null, or { score, hits, perfect } when this was the fifth
//        badges    badge ids this answer earned (the "badge earned" toast)
//   409 { error: "already_guessed", result }: each round counts once
//   400 bad_request | bad_index, 403 bad_origin, 404 not_found, 429 rate_limited
// Scoring: a hit is within 10 points; points are 100 minus 4 per point off.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gamesEnabled()) return off();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const { id } = await params;
  if (!QUIZ_ID.test(id)) return fail("not_found", 404);
  let body: { index?: unknown; guess?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const { index, guess } = body ?? {};
  if (typeof index !== "number" || !Number.isInteger(index) || typeof guess !== "number" || !Number.isInteger(guess) || guess < 1 || guess > 100) {
    return fail("bad_request", 400);
  }
  await ensureSchema();
  const player = (await currentPlayer({ create: true }))!;
  const ip = clientIp(req);
  const over = await overLimit([
    { key: `quiz-guess:b:${player.browser || player.id}`, limit: 300, windowMs: HOUR },
    ...(ip ? [{ key: `quiz-guess:ip:${ipKey(ip)}`, limit: 1200, windowMs: HOUR }] : []),
  ]);
  if (over) return rateLimited(over);
  const quiz = await getQuiz(db(), id);
  if (!quiz) return fail("not_found", 404);
  const pool = await getPool();
  const now = new Date();
  const out = await recordGuess(db(), { quiz, player: player.id, index, guess, pool, now });
  if (!out.ok) {
    if (out.error === "already_guessed") return fail("already_guessed", 409, { result: out.result });
    return fail(out.error ?? "bad_request", 400);
  }
  const badges = out.finished
    ? (await checkBadges(db(), player.id, { pool, now, force: true, signedIn: player.signedIn, earlyUntil: earlyUntil() })).awarded
    : [];
  return NextResponse.json({ result: out.result, finished: out.finished, badges }, { headers: PRIVATE });
}
