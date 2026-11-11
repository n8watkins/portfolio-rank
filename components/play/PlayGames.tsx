"use client";

import { FaceOff } from "@/components/play/FaceOff";
import { GuessPercentile } from "@/components/play/GuessPercentile";
import { useBadgeToasts } from "@/components/play/BadgeToasts";
import { useClientSession } from "@/lib/session-client";

/** The game in play, with the "Badge earned" toast (GAMES_V2 only). */
export function PlayGames({ mode, games, quizId, intro }: { mode: "faceoff" | "guess"; games: boolean; quizId: string | null; intro: boolean }) {
  const session = useClientSession();
  const { check, toast } = useBadgeToasts(games, session === null);
  return (
    <>
      {mode === "guess" && games ? (
        <GuessPercentile quizId={quizId} guest={session === null} onBadgeCheck={check} />
      ) : (
        <>
          <h2 className="mb-3 text-xl font-bold tracking-tight sm:mb-5 sm:text-2xl">Which one would you hire from?</h2>
          <FaceOff games={games} intro={intro} onBadgeCheck={check} />
        </>
      )}
      {toast}
    </>
  );
}
