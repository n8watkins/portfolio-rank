import { CircleAlert, CircleCheck } from "lucide-react";
import { TARGET_WORDS } from "@/pipeline/content/scorecard.mjs";

// The code-only quality scorecard of a draft (pipeline/content/scorecard.mjs),
// on the review page and in the side-by-side compare.

export type Card = {
  words: number;
  readingGrade: number | null;
  examples: string[];
  sources: string[];
  claimsCut: number;
  images: { total: number; withAlt: number };
  repeated: { phrase: string; n: number }[];
  devMeta: { match: string; why: string }[];
  payoff: { ok: boolean; sentence: string | null };
  flags: string[];
};

function Row({ label, value, ok }: { label: string; value: React.ReactNode; ok: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-edge py-1.5 first:border-t-0">
      <dt className="flex items-center gap-1.5 text-mute">
        {ok ? <CircleCheck className="h-3.5 w-3.5 shrink-0 text-up" aria-label="fine" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0 text-down" aria-label="look at this" />}
        {label}
      </dt>
      <dd className="text-right font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function Scorecard({ card, compact = false }: { card: Card; compact?: boolean }) {
  return (
    <div className={`card mt-3 p-4 text-sm ${compact ? "" : ""}`} data-scorecard>
      {/* "3 things to look at", not "· 3": the owner read the old "Scorecard · 3" as a score of minus 3 (2026-11-12). */}
      <p className="font-semibold">
        Scorecard:{" "}
        {card.flags.length ? (
          <span className="text-down">
            {card.flags.length} {card.flags.length === 1 ? "thing" : "things"} to look at
          </span>
        ) : (
          <span className="text-up">nothing flagged</span>
        )}
      </p>
      {!compact && <p className="mt-1 text-mute">Counted by code, not AI. Not a grade: each flag is something a reader might notice, for you to judge.</p>}
      {card.flags.length > 0 && (
        <ul className="mt-2 grid gap-1 text-down">
          {card.flags.map((f) => (
            <li key={f} className="flex gap-2">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {f}
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-2">
        <Row label="Words" value={`${card.words} (${TARGET_WORDS.min} to ${TARGET_WORDS.max})`} ok={card.words >= TARGET_WORDS.min && card.words <= TARGET_WORDS.max} />
        <Row label="Takeaway in the first 150 words" value={card.payoff.ok ? "yes" : "no"} ok={card.payoff.ok} />
        <Row label="About portfolios, not our build" value={card.devMeta.length ? `${card.devMeta.length} hit(s)` : "yes"} ok={!card.devMeta.length} />
        <Row label="Reading level" value={card.readingGrade == null ? "n/a" : `grade ${card.readingGrade}`} ok={card.readingGrade == null || card.readingGrade <= 11} />
        <Row label="Real portfolio examples" value={card.examples.length} ok={card.examples.length > 0} />
        <Row label="Sources cited" value={card.sources.length} ok />
        <Row label="Claims cut" value={card.claimsCut} ok />
        <Row label="Images with alt text" value={`${card.images.withAlt} of ${card.images.total}`} ok={card.images.withAlt === card.images.total} />
        <Row label="Repeated phrases" value={card.repeated.length} ok={card.repeated.length < 3} />
      </dl>
      {card.payoff.sentence && !compact && <p className="mt-2 text-mute">Takeaway: &ldquo;{card.payoff.sentence}&rdquo;</p>}
      {card.devMeta.length > 0 && <p className="mt-2 text-down">Dev meta: {[...new Set(card.devMeta.map((d) => d.match))].join(", ")}</p>}
      {card.repeated.length > 0 && !compact && <p className="mt-2 text-mute">Repeated: {card.repeated.map((r) => `"${r.phrase}" x${r.n}`).join(", ")}</p>}
    </div>
  );
}
