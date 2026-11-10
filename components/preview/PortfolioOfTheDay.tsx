import { ArrowRight, Check, Sparkles, Sun, X } from "lucide-react";
import { Shot } from "@/components/preview/Shot";
import { Details } from "@/components/preview/Details";
import { SiteActions } from "@/components/preview/SiteActions";
import { TierBadge } from "@/components/preview/bits";
import { leaderboard, scorecard, topPct } from "@/lib/preview/data";

/** One top-100 portfolio a day, the same for everyone. */
export function PortfolioOfTheDay() {
  const board = leaderboard("merged");
  const day = Math.floor(Date.now() / 86_400_000);
  const r = board[(day * 37) % 100];
  const card = scorecard(r.url);
  const best = [...card.subs].sort((a, b) => b.value - a.value).slice(0, 2);
  return (
    <section aria-labelledby="potd" className="card card-featured grid grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <a href={`/grade/${r.slug}`} className="group block overflow-hidden border-edge max-md:border-b md:border-r">
        <Shot base={r.shot} alt={`Screenshot of ${r.domain}`} domain={r.domain} className="aspect-[16/10] h-full w-full !object-left-top transition duration-500 group-hover:scale-[1.02]" />
      </a>
      <div className="flex flex-col p-5 sm:p-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
          <Sun className="h-4 w-4" aria-hidden /> Portfolio of the day
        </p>
        <h2 id="potd" className="mt-2 text-2xl font-bold tracking-tight">
          {r.name}
        </h2>
        <p className="mt-0.5 text-sm text-mute">{r.tagline ?? r.domain}</p>
        <div className="mt-4 flex items-center gap-3">
          <TierBadge tier={r.grade!.tier} size="lg" />
          <p className="text-sm">
            <span className="block font-semibold">
              Top {topPct(r.rank, board.length)}% · #{r.rank} merged
            </span>
            <span className="block text-mute">{card.verdict}</span>
          </p>
        </div>
        <ul className="mt-4 grid gap-1.5 text-sm">
          {best.map((b) => (
            <li key={b.label} className="flex gap-2">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
              <span>
                <span className="font-semibold">{b.label}:</span> <span className="text-mute">{b.note}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.facts.slice(0, 6).map((f) => (
            <span key={f.label} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${f.pass ? "border-up/30" : "border-edge text-mute"}`}>
              {f.pass ? <Check className="h-3 w-3 text-up" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {f.label}
            </span>
          ))}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
          <Details name={r.name} domain={r.domain} url={r.url} shot={r.shot} card={card} />
          <SiteActions url={r.url} name={r.name} />
          <a href={`/grade/${r.slug}`} className="group ml-auto inline-flex items-center gap-1 text-sm font-semibold text-accent">
            Full report <ArrowRight className="nudge h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}

/** A small card on home pointing to the About page. */
export function AboutCard() {
  return (
    <a href="/about" className="card card-hover group flex h-full flex-col p-5 sm:p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/n8-icon.png" alt="" className="h-11 w-11 rounded-xl" />
      <h2 className="mt-4 text-lg font-bold tracking-tight">About PortfolioRank</h2>
      <p className="mt-1 text-sm text-mute">A project by n8builds. Where the 2,103 portfolios come from, what code checks, what Gemini judges, and how votes become a rank.</p>
      <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-semibold text-accent">
        Read about it <ArrowRight className="nudge h-4 w-4" aria-hidden />
      </span>
    </a>
  );
}
