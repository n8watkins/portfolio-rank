import type { Metadata } from "next";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { INTRO_COOKIE } from "@/components/play/intro";
import { Swords, Target } from "lucide-react";
import { PlayGames } from "@/components/play/PlayGames";
import { gamesEnabled } from "@/lib/games/server";
import { QUIZ_ID } from "@/lib/games/quiz.mjs";

// Play: the face-off and, with GAMES_V2 on, Guess the percentile, behind one
// entry (/rank redirects here). With GAMES_V2 off the quiz and every link to
// it are hidden, and the page is the face-off that works today.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play - PortfolioRank",
  description: "Two developer portfolios side by side: pick the one you'd hire from. Or guess where five portfolios land among all of them.",
};

const MODES = [
  { key: "faceoff", href: "/play", label: "Face-off", short: "Face-off", hint: "Pick the portfolio you'd hire from, then see how everyone leans.", Icon: Swords },
  { key: "guess", href: "/play?mode=guess", label: "Guess the percentile", short: "Guess", hint: "Guess where five portfolios land among all of them.", Icon: Target },
] as const;

export default async function PlayPage({ searchParams }: { searchParams: Promise<{ mode?: string; quiz?: string }> }) {
  const sp = await searchParams;
  const games = gamesEnabled();
  const mode = games && sp.mode === "guess" ? "guess" : "faceoff";
  const quizId = typeof sp.quiz === "string" && QUIZ_ID.test(sp.quiz) ? sp.quiz : null;
  // The practice intro is drawn with the page, so it never pushes the cards down later.
  const intro = !(await auth())?.user && (await cookies()).get(INTRO_COOKIE)?.value !== "1";
  const current = MODES.find((m) => m.key === mode)!;

  return (
    <div className="wrap py-3 sm:py-5">
      <h1 className="sr-only">{games ? "Play" : "Face-off"}</h1>
      {games && (
        // A segmented control: the selected game is a raised tab, the other a quiet one.
        <div className="rise mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <nav aria-label="Game mode" className="inline-flex rounded-xl border border-edge bg-raised p-1 max-sm:w-full">
            {MODES.map(({ key, href, label, short, Icon }) => (
              <a
                key={key}
                href={href}
                aria-current={mode === key ? "page" : undefined}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-mute transition hover:text-ink aria-[current=page]:bg-card aria-[current=page]:text-ink aria-[current=page]:shadow-[var(--card-hi),var(--card-drop)] max-sm:flex-1"
              >
                <Icon className={`h-4 w-4 ${mode === key ? "text-accent" : ""}`} aria-hidden />
                <span className="sm:hidden">{short}</span>
                <span className="max-sm:hidden">{label}</span>
              </a>
            ))}
          </nav>
          <p className="text-sm text-mute max-sm:hidden">{current.hint}</p>
        </div>
      )}
      <div className="rise" style={{ "--d": "80ms" } as React.CSSProperties}>
        <PlayGames mode={mode} games={games} quizId={mode === "guess" ? quizId : null} intro={intro} />
      </div>
    </div>
  );
}
