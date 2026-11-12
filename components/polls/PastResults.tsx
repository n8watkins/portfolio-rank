"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { PollBar } from "@/components/home/PollBar";
import { voteCount, weekRange } from "@/lib/polls/format";
import type { PublicPoll } from "@/lib/polls/server";

/**
 * Closed polls with their results. The list is the same for everyone (the
 * page is cached); which ones this browser voted in comes from
 * GET /api/polls/mine after it loads.
 */
export function PastResults({ past }: { past: PublicPoll[] }) {
  const [mine, setMine] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!past.length) return;
    const ids = past.map((p) => p.id).join(",");
    fetch(`/api/polls/mine?ids=${ids}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { votes?: Record<string, number> } | null) => b?.votes && setMine(b.votes))
      .catch(() => {});
  }, [past]);

  return (
    <ul className="grid grid-cols-1 gap-5 md:grid-cols-2">
      {past.map((p) => {
        const max = Math.max(...p.options.map((o) => o.votes));
        const voted = mine[p.id];
        return (
          <li key={p.id} className="card flex flex-col p-5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
              <span>{weekRange(p.opensAt, p.closesAt)}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{voteCount(p.total)}</span>
              {voted !== undefined && (
                <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11px] font-bold text-on-fill">
                  <Check className="h-3 w-3" aria-hidden /> You voted
                </span>
              )}
            </p>
            <h3 className="mt-1.5 text-base font-bold tracking-tight text-balance">{p.question}</h3>
            <div className="mt-4 grid grid-cols-1 gap-3.5">
              {p.options.map((o) => {
                const bar = (
                  <PollBar
                    label={o.site ? o.site.name : o.label}
                    votes={o.votes}
                    pct={o.percent}
                    lead={o.votes === max && max > 0}
                    mine={voted === o.index}
                  />
                );
                if (!o.site) return <div key={o.index}>{bar}</div>;
                return (
                  <a key={o.index} href={o.site.path} className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-1 transition hover:bg-raised">
                    <span className="relative block aspect-[16/10] w-12 shrink-0 sm:w-16 overflow-hidden rounded-md border border-edge bg-raised">
                      {o.site.hero && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={o.site.hero} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover object-top" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">{bar}</span>
                  </a>
                );
              })}
            </div>
            {p.total === 0 && <p className="mt-3 text-xs text-mute">Nobody voted in this one.</p>}
          </li>
        );
      })}
    </ul>
  );
}
