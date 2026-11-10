import { Shot } from "@/components/preview/Shot";
import { Movement } from "@/components/preview/bits";
import type { Ranked, View } from "@/lib/preview/data";

export function fmtScore(view: View, score: number) {
  return view === "merged" ? score.toFixed(1) : String(score);
}

export function rankLabel(r: { rank: number; tied: boolean }) {
  return r.tied ? `=${r.rank}` : `${r.rank}`;
}

/** One compact row: rank, thumbnail, name, movement, score. */
export function RankRow({ r, view }: { r: Ranked; view: View }) {
  return (
    <li>
      <a href={`/grade/${r.slug}`} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-raised">
        <span className={`w-9 shrink-0 text-right text-sm font-bold tabular-nums ${r.rank === 1 ? "text-accent" : "text-mute"}`}>{rankLabel(r)}</span>
        <Shot base={r.shot} alt="" domain={r.domain} className="aspect-[16/10] w-16 shrink-0 rounded-md border border-edge transition group-hover:border-edge-strong" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{r.name}</span>
          <span className="block truncate text-xs text-mute">{r.tagline ?? r.domain}</span>
        </span>
        {view !== "ai" && <Movement move={r.move} className="nudge-up w-8 justify-end" />}
        <span className="w-11 shrink-0 text-right text-sm font-semibold tabular-nums">{fmtScore(view, r.score)}</span>
      </a>
    </li>
  );
}
