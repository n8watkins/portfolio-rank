import { Activity, ArrowRight, BookOpen, Bot, Code, Users, CalendarCheck, Check, ExternalLink, History, Sparkles, Sun, Swords, Target, X } from "lucide-react";
import { RankBadge, TierBadge } from "@/components/ui/badges";
import { sectionTitle } from "@/components/ui/styles";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { LiveStats } from "@/components/home/LiveStats";
import { PollBar } from "@/components/home/PollBar";
import { Thumb } from "@/components/home/Thumb";
import { ViewTabs } from "@/components/home/ViewTabs";
import { ROUTES } from "@/lib/nav";
import type { BoardItem, GradedItem, LiveStat, PortfolioOfTheDay as Potd, ShowItem, TopTen as TopTenData } from "@/lib/home";
import { topPct } from "@/lib/home";
import type { PublicPoll } from "@/lib/polls/server";

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
/** "today", "3 days ago", "5 months ago": as of when the page was rendered. */
function ago(iso: string, now: number) {
  const days = Math.round((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return RELATIVE.format(-days, "day");
  if (days < 365) return RELATIVE.format(-Math.round(days / 30.4), "month");
  return RELATIVE.format(-Math.round(days / 365), "year");
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function BoardRow({ r, tier }: { r: BoardItem; tier: boolean }) {
  return (
    <li>
      <a href={r.href} className="group flex items-center gap-3.5 rounded-xl px-2 py-3 transition hover:bg-raised">
        <span className="flex w-9 shrink-0 justify-end">
          <RankBadge rank={r.rank} tied={r.tied} />
        </span>
        <Thumb src={r.hero} domain={r.line} className="aspect-[16/10] w-[4.5rem] rounded-md transition group-hover:border-edge-strong max-sm:hidden" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{r.name}</span>
          <span className="block truncate text-xs text-mute">{r.line}</span>
        </span>
        <span className="flex w-12 shrink-0 justify-end text-sm font-semibold tabular-nums">{tier && r.score ? <TierBadge tier={r.score} /> : r.score}</span>
      </a>
    </li>
  );
}

function Board({ rows, scoreLabel }: { rows: BoardItem[]; scoreLabel: string }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-3.5 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-mute" aria-hidden>
        <span className="w-9 text-right">#</span>
        <span className="w-[4.5rem] max-sm:hidden" />
        <span className="flex-1">Portfolio</span>
        <span className="w-12 text-right">{scoreLabel}</span>
      </div>
      <ol className="flex flex-1 flex-col justify-between">
        {rows.map((r) => (
          <BoardRow key={r.url} r={r} tier={scoreLabel === "Tier"} />
        ))}
      </ol>
    </div>
  );
}

/** Top 10: Merged, AI and People with ranking v2; the people's board until then. */
export function TopTen({ top, className = "" }: { top: TopTenData; className?: string }) {
  const empty = top.kind === "ai" && top.rows.length === 0;
  return (
    <section aria-labelledby="top10" className={`card flex flex-col p-4 sm:p-6 ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-1">
        <h3 id="top10" className={sectionTitle}>
          Top 10
        </h3>
        {top.kind === "ai" && (
          <p className="flex items-center gap-1.5 text-xs text-mute">
            <Bot className="h-3.5 w-3.5" aria-hidden /> By AI grade
          </p>
        )}
      </div>
      {top.kind === "views" ? (
        <ViewTabs
          label="Leaderboard view"
          panels={{
            merged: <Board rows={top.views[0].rows} scoreLabel="Tier" />,
            ai: <Board rows={top.views[1].rows} scoreLabel="Tier" />,
            people: <Board rows={top.views[2].rows} scoreLabel="Tier" />,
          }}
        />
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-edge-strong px-6 py-12 text-center">
          <span className="icon-tile h-11 w-11">
            <Swords className="h-5 w-5" aria-hidden />
          </span>
          <p className="font-semibold">The board fills as portfolios are graded</p>
          <p className="max-w-sm text-sm text-mute">Gemini grades new portfolios every night. Meanwhile, every face-off vote moves two of them.</p>
          {ROUTES.faceoff && (
            <a href={ROUTES.faceoff} className="group mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
              Vote in a face-off <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </a>
          )}
        </div>
      ) : (
        <Board rows={top.rows} scoreLabel="Tier" />
      )}
    </section>
  );
}

/** The portfolios Gemini graded last, with their tier. */
export function RecentlyGraded({ items, now, className = "" }: { items: GradedItem[]; now: number; className?: string }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="recent" className={`card p-4 sm:p-5 ${className}`}>
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 id="recent" className={`${sectionTitle} flex items-center gap-2`}>
          <Sparkles className="h-4 w-4 text-mute" aria-hidden /> Recently graded
        </h3>
        <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute">Gemini</span>
      </div>
      <ol className="flex flex-1 flex-col justify-between">
        {items.map((r) => (
          <li key={r.url}>
            <a href={r.href} className="group flex items-center gap-3 rounded-xl px-1 py-2.5 transition hover:bg-raised">
              <Thumb src={r.hero} domain={r.domain} className="aspect-square w-10 rounded-lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{r.name}</span>
                <span className="flex min-w-0 gap-1 text-xs text-mute">
                  <span className="truncate">{r.domain}</span>
                  <span className="shrink-0">
                    · <time dateTime={r.at}>{ago(r.at, now)}</time>
                  </span>
                </span>
              </span>
              <TierBadge tier={r.tier} />
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Live numbers about the list, the votes and the grades. */
export function LiveCard({ stats, className = "" }: { stats: LiveStat[]; className?: string }) {
  return (
    <section aria-labelledby="stats" className={`card p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-center justify-between px-1">
        <h3 id="stats" className={`${sectionTitle} flex items-center gap-2`}>
          <Activity className="h-4 w-4 text-mute" aria-hidden /> Live
        </h3>
        <span className="flex items-center gap-2 text-xs text-mute">
          <span className="attn-dot" aria-hidden /> updating
        </span>
      </div>
      <LiveStats stats={stats} />
      {ROUTES.about && (
        <div className="mt-2 flex items-center justify-end border-t border-edge px-1 pt-1">
          <a href={ROUTES.about} className="group inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-ink hover:text-accent">
            <BookOpen className="h-3.5 w-3.5" aria-hidden /> How PortfolioRank works
            <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
          </a>
        </div>
      )}
    </section>
  );
}

type Mode = {
  href: string;
  Icon: typeof Swords;
  motion: string;
  title: string;
  line: string;
  steps: string[];
  media: React.ReactNode;
};

/**
 * The games, big and explained: Face-off (voting, live today) and Guess the
 * percentile (GAMES_V2, once its page has a route).
 */
export function PlayBand({ shots, guess }: { shots: ShowItem[]; guess: boolean }) {
  const [a, b, c] = shots;
  const modes: Mode[] = [];
  if (ROUTES.faceoff && a && b)
    modes.push({
      href: ROUTES.faceoff,
      Icon: Swords,
      motion: "icon-shake",
      title: "Face-off",
      line: "Two portfolios side by side. Pick the one you'd hire from, then see how everyone else voted.",
      steps: ["Look closer or visit both", "Pick one", "See the crowd's split"],
      media: (
        <span className="grid h-full grid-cols-2 gap-px bg-edge">
          {[a, b].map((e) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={e.url} src={e.hero} alt="" loading="lazy" decoding="async" className="aspect-[16/10] h-full w-full bg-raised object-cover object-top transition duration-500 group-hover:scale-[1.03]" />
          ))}
        </span>
      ),
    });
  if (guess && ROUTES.guess && c)
    modes.push({
      href: ROUTES.guess,
      Icon: Target,
      motion: "icon-twinkle",
      title: "Guess the percentile",
      line: "Five portfolios, the same for everyone today. Guess where each lands among every graded portfolio.",
      steps: ["See a portfolio", "Guess its top %", "Compare and share"],
      media: (
        <span className="relative block h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={c.hero} alt="" loading="lazy" decoding="async" className="aspect-[32/10] h-full w-full bg-raised object-cover object-top transition duration-500 group-hover:scale-[1.03]" />
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
            <CalendarCheck className="h-3.5 w-3.5" aria-hidden /> Today&apos;s Daily 5
          </span>
          <span className="absolute bottom-3 right-3 rounded-lg bg-black/65 px-3 py-1.5 text-lg font-bold text-white backdrop-blur">Top ?%</span>
        </span>
      ),
    });
  if (modes.length === 0) return null;
  const solo = modes.length === 1;
  return (
    <div className={`grid grid-cols-1 gap-5 ${solo ? "" : "md:grid-cols-2"}`}>
      {modes.map((m) => (
        <a
          key={m.title}
          href={m.href}
          className={`card card-hover card-featured group flex flex-col overflow-hidden ${solo ? "md:grid md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" : ""}`}
        >
          <span className={`relative block overflow-hidden ${solo ? "md:border-r md:border-edge" : ""}`}>{m.media}</span>
          <span className="flex flex-1 flex-col p-5 sm:p-6">
            <span className="flex items-center gap-3">
              <span className="icon-tile h-12 w-12 shrink-0">
                <m.Icon className={`${m.motion} h-6 w-6`} aria-hidden />
              </span>
              <span className="text-xl font-bold tracking-tight">{m.title}</span>
            </span>
            <span className="mt-3 block text-[15px] text-mute text-pretty">{m.line}</span>
            <span className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
              {m.steps.map((s, k) => (
                <span key={s} className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-raised text-[11px] font-bold text-ink ring-1 ring-edge">{k + 1}</span>
                  {s}
                </span>
              ))}
            </span>
            <span className="btn-sheen sheen-auto mt-5 inline-flex h-11 w-fit items-center gap-2 rounded-lg px-5 text-sm font-semibold">
              Play {m.title} <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}

/** One strong portfolio a day, the same for everyone. */
export function PortfolioOfTheDay({ p }: { p: Potd }) {
  return (
    <section aria-labelledby="potd" className="card card-featured grid grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <a href={p.href} tabIndex={-1} aria-hidden className="group block overflow-hidden border-edge max-md:border-b md:border-r">
        <ScreenshotFrame src={p.hero} alt="" domain={p.domain} className="h-full w-full transition duration-500 group-hover:scale-[1.02]" />
      </a>
      <div className="flex flex-col p-5 sm:p-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
          <Sun className="h-4 w-4" aria-hidden /> Portfolio of the day
        </p>
        <h2 id="potd" className="mt-2 text-2xl font-bold tracking-tight">
          {p.name}
        </h2>
        <p className="mt-0.5 text-sm text-mute">{p.line}</p>
        <div className="mt-4 flex items-center gap-3">
          <TierBadge tier={p.tier} size="lg" />
          <p className="text-sm">
            <span className="block font-semibold">
              Top {topPct(p.rank, p.total)}% · #{p.rank} by AI grade
            </span>
            <span className="block text-mute">of {p.total.toLocaleString("en-US")} graded portfolios</span>
          </p>
        </div>
        {p.best.length > 0 && (
          <ul className="mt-4 grid gap-1.5 text-sm">
            {p.best.map((b) => (
              <li key={b.label} className="flex gap-2">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                <span>
                  <span className="font-semibold">{b.label}:</span> <span className="text-mute">{b.note}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {p.facts.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Checks">
            {p.facts.map((f) => (
              <li key={f.id} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${f.pass ? "border-up/30" : "border-edge text-mute"}`}>
                {f.pass ? <Check className="h-3 w-3 text-up" aria-label="Passes:" /> : <X className="h-3 w-3" aria-label="Misses:" />}
                {f.label}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
          <a
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge px-3 text-sm font-semibold transition hover:border-edge-strong"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Visit<span className="sr-only"> {p.domain} (opens in a new tab)</span>
          </a>
          <a href={p.href} className="group ml-auto inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
            Full report<span className="sr-only"> for {p.name}</span> <ArrowRight className="nudge h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}

/** A small card on home pointing to how it all works. */
export function AboutCard({ total }: { total: number }) {
  if (!ROUTES.about) return null;
  return (
    <a href={ROUTES.about} className="card card-hover group flex h-full flex-col justify-center p-5 sm:p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/n8-icon.png" alt="" width={44} height={44} className="h-11 w-11 rounded-xl" />
      <h2 className="mt-4 text-lg font-bold tracking-tight">About PortfolioRank</h2>
      <p className="mt-1 text-sm text-mute">A project by n8builds: how {total.toLocaleString("en-US")} portfolios get a grade and a rank.</p>
      <ul className="mt-4 grid gap-2.5 text-sm">
        {[
          { Icon: Users, text: "Where the list comes from" },
          { Icon: Code, text: "What the code checks" },
          { Icon: Sparkles, text: "What Gemini judges" },
        ].map(({ Icon, text }) => (
          <li key={text} className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-raised text-mute ring-1 ring-edge">
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </span>
            {text}
          </li>
        ))}
      </ul>
      <span className="inline-flex items-center gap-1 pt-5 text-sm font-semibold text-accent">
        Read about it <ArrowRight className="nudge h-4 w-4" aria-hidden />
      </span>
    </a>
  );
}

function winner(p: PublicPoll) {
  return p.options.reduce((a, b) => (b.votes > a.votes ? b : a));
}

/** The last few poll results, compact. */
export function PastPolls({ past }: { past: PublicPoll[] }) {
  return (
    <section aria-labelledby="past-polls" className="card flex h-full flex-col p-5">
      <h3 id="past-polls" className={`${sectionTitle} flex items-center gap-2`}>
        <History className="h-4 w-4 text-mute" aria-hidden /> Past polls
      </h3>
      <ul className="mt-3 flex flex-1 flex-col justify-between gap-4">
        {past.slice(0, 3).map((p) => {
          const win = winner(p);
          return (
            <li key={p.id}>
              <p className="text-xs text-mute">
                {shortDate(p.opensAt)} · {p.total.toLocaleString("en-US")} votes
              </p>
              <p className="mt-0.5 text-sm font-semibold">{p.question}</p>
              <div className="mt-2">
                <PollBar label={win.site ? `${win.label}: ${win.site.domain}` : win.label} votes={win.votes} pct={win.percent} lead={p.total > 0} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
