import { EloTierBadge } from "@/components/ui/badges";
import { ROUTES } from "@/lib/nav";
import { BELOW_TOP_TIERS, familyOf, tierLabel } from "@/lib/tiers.mjs";
import type { ProfileTier as Data } from "@/lib/tiers-view";

// A profile's tier by ELO (RANKING_V2 only, lib/tiers-view.ts): the letter,
// its place, "Starting rank from automated checks" and the real votes, the
// points behind the start item by item, and the quickest points to gain.

export function ProfileTier({ t }: { t: Data }) {
  const strong = familyOf(t.shown) === "A" || familyOf(t.shown) === "S";
  const votes = `${t.votes.toLocaleString("en-US")} real vote${t.votes === 1 ? "" : "s"}`;
  return (
    <section
      aria-labelledby="tier"
      className={`mb-4 rounded-xl border bg-card p-5 ${strong ? "border-accent/50 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_25%,transparent),0_12px_32px_-18px_var(--color-accent)]" : "border-edge"}`}
    >
      <div className="flex items-center gap-4">
        {t.shown ? (
          <a href="/grading#tiers" aria-label={`Tier ${tierLabel(t.shown)}: how tiers work`} className="rounded-2xl">
            <EloTierBadge tier={t.shown} size="lg" />
          </a>
        ) : (
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-raised text-sm font-semibold text-mute ring-1 ring-inset ring-edge" aria-hidden>
            {t.hasTier ? "-" : "?"}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 id="tier" className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">
            Tier
          </h2>
          {t.hasTier ? (
            <>
              <p className={`mt-0.5 font-semibold ${strong ? "text-accent" : ""}`}>
                {t.shown ? (t.top != null ? `Top ${t.top}%` : `Tier ${tierLabel(t.shown)}`) : BELOW_TOP_TIERS}
                {t.shown && t.of != null && <span className="font-normal text-mute"> of {t.of.toLocaleString("en-US")} ranked portfolios</span>}
              </p>
              <p className="text-sm text-mute">
                {t.seeded ? `Starting rank from automated checks · ${votes}. Votes move it from here.` : `ELO from ${votes}. It moves as people vote.`}
              </p>
            </>
          ) : (
            <p className="mt-0.5 text-sm text-mute">Not graded yet, so no tier. ELO from {votes}.</p>
          )}
        </div>
        {ROUTES.faceoff && (
          <a href={ROUTES.faceoff} className="hidden shrink-0 rounded-lg border border-edge-strong px-3 py-2 text-sm font-semibold transition hover:border-accent sm:block">
            Vote in a face-off
          </a>
        )}
      </div>
      {t.check && (
        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-edge pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
          <div>
            <h3 className="text-sm font-semibold">
              Automated checks: <span className="tabular-nums">{t.check.total}</span> of 100 points
            </h3>
            <ul className="mt-2 grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
              {t.check.items.map((i) => (
                <li key={i.id} className="flex items-baseline justify-between gap-3 border-b border-edge py-1.5">
                  <span className={i.measured ? "" : "text-mute"}>
                    {i.name}
                    {!i.measured && <span className="block text-[11px]">Not measured yet: library median</span>}
                  </span>
                  <span className={`shrink-0 tabular-nums ${i.id === "template" && i.points < 0 ? "text-down" : i.measured && i.points >= i.max ? "text-up" : "text-mute"}`}>
                    {i.id === "template" ? (i.points < 0 ? i.points : "0") : `${i.points}/${i.max}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Quickest points</h3>
            {t.fixes.length ? (
              <ul className="mt-2 grid gap-2 text-sm">
                {t.fixes.map((f) => (
                  <li key={f.id} className="flex items-start gap-2">
                    <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-xs font-bold leading-5 text-accent tabular-nums">+{Math.round(f.gain)}</span>
                    <span>{f.text.slice(f.text.indexOf(" if you ") + 1)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-mute">Every measured check is full. Votes decide the rest.</p>
            )}
            <a href="/grading#points" className="mt-3 inline-block text-xs font-medium text-accent hover:underline">
              How the points work
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
