import { Target, Swords } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { FaceOff, type Entry } from "@/components/preview/FaceOff";
import { GuessPercentile } from "@/components/preview/GuessPercentile";
import { SampleTag } from "@/components/preview/bits";
import { faceoffPairs, quizSet, scorecard } from "@/lib/preview/data";
import type { Visitor } from "@/lib/preview/visitor";

const MODES = [
  { key: "faceoff", href: "/play", label: "Face-off", hint: "Which is better?", Icon: Swords },
  { key: "guess", href: "/play?mode=guess", label: "Guess the percentile", hint: "Five a day, or random", Icon: Target },
] as const;

/** Play: both game modes behind one entry. /rank opens the face-off. */
export function PlayPage({
  v,
  mode,
  quiz,
  preset,
  details,
  withSlug,
}: {
  v: Visitor;
  mode: "faceoff" | "guess";
  /** Quiz seed from ?quiz= (a challenge or random quiz); none means today's Daily 5. */
  quiz?: string;
  preset?: "reveal" | "end";
  details?: "simple" | "advanced";
  /** From a portfolio page: put this site in the first pair or first quiz round. */
  withSlug?: string;
}) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const seed = quiz && /^[\w-]{3,32}$/.test(quiz) ? quiz : `daily-${today}`;
  const daily = seed.startsWith("daily-");
  const dayLabel = new Date(daily ? seed.slice(6) : today).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const nextSeed = Math.random().toString(36).slice(2, 8);
  const pairs = faceoffPairs(12, withSlug).map(
    (p) => p.map(({ name, domain, url, shot, tagline, slug }) => ({ name, domain, url, shot, tagline, slug, card: scorecard(url) })) as [Entry, Entry]
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
            <>
              <nav aria-label="Quiz" className="mb-4 flex flex-wrap items-center gap-2">
                <a
                  href="/play?mode=guess"
                  aria-current={daily ? "page" : undefined}
                  className="inline-flex h-8 items-center rounded-full border border-edge bg-card px-3 text-sm font-medium transition hover:border-edge-strong aria-[current=page]:border-accent/60 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent"
                >
                  Daily 5
                </a>
                <a
                  href={`/play?mode=guess&quiz=${daily ? nextSeed : seed}`}
                  aria-current={!daily ? "page" : undefined}
                  className="inline-flex h-8 items-center rounded-full border border-edge bg-card px-3 text-sm font-medium transition hover:border-edge-strong aria-[current=page]:border-accent/60 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent"
                >
                  Random quiz
                </a>
                <span className="text-xs text-mute">{daily ? "Same five for everyone today." : "Share the link and a friend gets the same five."}</span>
              </nav>
              <GuessPercentile rounds={quizSet(seed, withSlug)} seed={seed} details={details} daily={daily} dayLabel={dayLabel} nextSeed={nextSeed} guest={!v.signedIn} preset={preset} />
            </>
          ) : (
            <>
              <h2 className="mb-3 text-xl font-bold tracking-tight sm:mb-5 sm:text-2xl">Which one would you hire from?</h2>
              <FaceOff pairs={pairs} voted={v.voted} details={details} />
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
