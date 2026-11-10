import { Target, Swords } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { FaceOff } from "@/components/preview/FaceOff";
import { GuessRank } from "@/components/preview/GuessRank";
import { SampleTag } from "@/components/preview/bits";
import { faceoffPairs, guessRounds, leaderboard } from "@/lib/preview/data";
import type { Visitor } from "@/lib/preview/visitor";

const MODES = [
  { key: "faceoff", href: "/play", label: "Face-off", hint: "Which is better?", Icon: Swords },
  { key: "guess", href: "/play?mode=guess", label: "Guess the rank", hint: "Where does it land?", Icon: Target },
] as const;

/** Play: both game modes behind one entry. /rank opens the face-off. */
export function PlayPage({ v, mode, reveal }: { v: Visitor; mode: "faceoff" | "guess"; reveal?: boolean }) {
  const pairs = faceoffPairs(12).map(
    (p) => p.map(({ name, domain, shot, tagline, slug }) => ({ name, domain, shot, tagline, slug })) as [(typeof p)[0], (typeof p)[1]]
  );
  return (
    <AppShell visitor={v} current="rank">
      <div className="mx-auto max-w-6xl py-4 sm:py-8">
        <div className="rise mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
          <h1 className="sr-only">Play</h1>
          <nav aria-label="Game mode" className="grid w-full grid-cols-2 gap-1 rounded-xl border border-edge bg-raised p-1 sm:inline-grid sm:w-auto">
            {MODES.map(({ key, href, label, hint, Icon }) => (
              <a
                key={key}
                href={href}
                aria-current={mode === key ? "page" : undefined}
                className="group flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-mute transition hover:text-ink aria-[current=page]:bg-card aria-[current=page]:text-ink aria-[current=page]:shadow-[var(--card-hi),var(--card-drop)] sm:px-4"
              >
                <Icon className={`h-4 w-4 shrink-0 ${key === "faceoff" ? "icon-shake" : "icon-twinkle"}`} aria-hidden />
                <span>
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="hidden text-xs text-mute sm:block">{hint}</span>
                </span>
              </a>
            ))}
          </nav>
          <SampleTag what={mode === "guess" ? "Scores and People ranks" : "Vote shares"} className="max-sm:hidden" />
        </div>

        <div className="rise" style={{ "--d": "80ms" } as React.CSSProperties}>
          {mode === "guess" ? (
            <GuessRank rounds={guessRounds()} total={leaderboard("merged").length} reveal={reveal} />
          ) : (
            <>
              <h2 className="mb-3 text-xl font-bold tracking-tight sm:mb-5 sm:text-2xl">Which one would you hire from?</h2>
              <FaceOff pairs={pairs} voted={v.voted} />
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
