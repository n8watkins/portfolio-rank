import type { Metadata } from "next";
import { Swords, Target } from "lucide-react";
import { PlayGames } from "@/components/play/PlayGames";
import { db, ensureSchema } from "@/lib/db";
import { gamesEnabled } from "@/lib/games/server";
import { QUIZ_ID } from "@/lib/games/quiz.mjs";
import { heroOf, shotBases } from "@/lib/shots";

// Play: the face-off and, with GAMES_V2 on, Guess the percentile, behind one
// entry (/rank redirects here). With GAMES_V2 off the quiz and every link to
// it are hidden, and the page is the face-off that works today.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play - PortfolioRank",
  description: "Two developer portfolios side by side: pick the one you'd hire from. Or guess where five portfolios land among all of them.",
};

const MODES = [
  { key: "faceoff", href: "/play", label: "Face-off", hint: "Two portfolios side by side. Pick the one you'd hire from, then see how everyone leans.", Icon: Swords, icon: "icon-shake" },
  { key: "guess", href: "/play?mode=guess", label: "Guess the percentile", hint: "Five portfolios. Guess where each lands among all of them. A new Daily 5 every day.", Icon: Target, icon: "icon-twinkle" },
] as const;

/** Two of the best-rated sites' screenshots for the mode cards (two indexed reads). */
async function cardShots(): Promise<(string | null)[]> {
  try {
    await ensureSchema();
    const urls = (await db().execute("SELECT url FROM ratings ORDER BY elo DESC LIMIT 2")).rows.map((r) => String(r.url));
    const bases = await shotBases(urls);
    return [0, 1].map((k) => (bases.get(urls[k]) ? heroOf(bases.get(urls[k])!) : null));
  } catch {
    return [null, null];
  }
}

export default async function PlayPage({ searchParams }: { searchParams: Promise<{ mode?: string; quiz?: string }> }) {
  const sp = await searchParams;
  const games = gamesEnabled();
  const mode = games && sp.mode === "guess" ? "guess" : "faceoff";
  const quizId = typeof sp.quiz === "string" && QUIZ_ID.test(sp.quiz) ? sp.quiz : null;
  const shots = games ? await cardShots() : [];

  return (
    <div className="wrap py-4 sm:py-8">
      <h1 className="sr-only">{games ? "Play" : "Face-off"}</h1>
      {games && (
        <nav aria-label="Game mode" className="rise mb-5 grid grid-cols-2 gap-3 sm:mb-7 sm:gap-4">
          {MODES.map(({ key, href, label, hint, Icon, icon }, k) => (
            <a
              key={key}
              href={href}
              aria-current={mode === key ? "page" : undefined}
              className="card card-hover group relative flex items-stretch overflow-hidden aria-[current=page]:ring-2 aria-[current=page]:ring-accent"
            >
              {shots[k] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shots[k]!} alt="" className="hidden w-40 shrink-0 border-r border-edge bg-raised object-cover object-top md:block lg:w-56" />
              ) : (
                <span className="hidden w-40 shrink-0 border-r border-edge bg-raised md:block lg:w-56" aria-hidden />
              )}
              <span className="flex min-w-0 flex-1 items-start gap-3 p-3 sm:p-5">
                <span className="icon-tile hidden h-11 w-11 shrink-0 sm:grid">
                  <Icon className={`h-5 w-5 ${icon}`} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-base font-bold sm:text-lg">
                    <Icon className="h-4 w-4 shrink-0 text-accent sm:hidden" aria-hidden /> {label}
                  </span>
                  <span className="mt-0.5 block text-xs text-mute sm:text-sm">{hint}</span>
                </span>
              </span>
            </a>
          ))}
        </nav>
      )}
      <div className="rise" style={{ "--d": "80ms" } as React.CSSProperties}>
        <PlayGames mode={mode} games={games} quizId={mode === "guess" ? quizId : null} />
      </div>
    </div>
  );
}
