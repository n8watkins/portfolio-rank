import { Target, Swords } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { FaceOff, type Entry } from "@/components/preview/FaceOff";
import { GuessPercentile } from "@/components/preview/GuessPercentile";
import { faceoffPairs, quizSet, scorecard } from "@/lib/preview/data";
import type { Visitor } from "@/lib/preview/visitor";

const MODES = [
  { key: "faceoff", href: "/play", label: "Face-off", hint: "Two portfolios side by side. Pick the one you'd hire from, then see how everyone voted.", Icon: Swords },
  { key: "guess", href: "/play?mode=guess", label: "Guess the percentile", hint: "Five portfolios. Guess where each lands among all of them. A new Daily 5 every day.", Icon: Target },
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
      <div className="py-4 sm:py-8">
        <h1 className="sr-only">Play</h1>
        <nav aria-label="Game mode" className="rise mb-3 grid grid-cols-2 gap-3 sm:gap-4">
          {MODES.map(({ key, href, label, hint, Icon }) => {
            const img = key === "faceoff" ? pairs[0][0].shot : quizSet(seed, withSlug)[0].shot;
            return (
              <a
                key={key}
                href={href}
                aria-current={mode === key ? "page" : undefined}
                className="card card-hover group relative flex items-stretch overflow-hidden aria-[current=page]:ring-2 aria-[current=page]:ring-accent"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${img}/hero.jpg`} alt="" className="hidden w-40 shrink-0 border-r border-edge object-cover object-top md:block lg:w-56" />
                <span className="flex min-w-0 flex-1 items-start gap-3 p-3 sm:p-5">
                  <span className="icon-tile hidden h-11 w-11 shrink-0 sm:grid">
                    <Icon className={`h-5 w-5 ${key === "faceoff" ? "icon-shake" : "icon-twinkle"}`} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-base font-bold sm:text-lg">
                      <Icon className="h-4 w-4 shrink-0 text-accent sm:hidden" aria-hidden /> {label}
                    </span>
                    <span className="mt-0.5 block text-xs text-mute sm:text-sm">{hint}</span>
                  </span>
                </span>
              </a>
            );
          })}
        </nav>
        <p className="rise mb-5 text-xs text-mute sm:mb-7">Preview data: vote shares, scores and People ranks are made up until the real ones exist.</p>

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
