"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Vote } from "lucide-react";
import { PollBar } from "@/components/preview/PollResult";
import { SampleTag } from "@/components/preview/bits";

type Option = { label: string; votes: number; site?: { name: string; domain: string; shot: string } };
type Poll = { id: string; question: string; detail: string; kind: "hero" | "text"; opened: string; options: Option[] };

const KEY = "pr-poll-votes";

function readVotes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * The active poll. One vote per visitor, no sign-in: the preview remembers it
 * in this browser (the real thing would also key on a visitor cookie).
 * ?voted=1 shows the results state for screenshots.
 */
export function PollCard({ poll, showAll = true, forceVoted }: { poll: Poll; showAll?: boolean; forceVoted?: number }) {
  const [mine, setMine] = useState<number | null>(forceVoted ?? null);
  useEffect(() => {
    if (forceVoted !== undefined) return;
    const v = readVotes()[poll.id];
    if (typeof v === "number") setMine(v);
  }, [poll.id, forceVoted]);

  const vote = (i: number) => {
    setMine(i);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readVotes(), [poll.id]: i }));
    } catch {}
  };

  const options = poll.options.map((o, i) => ({ ...o, votes: o.votes + (mine === i ? 1 : 0) }));
  const total = options.reduce((n, o) => n + o.votes, 0);
  const max = Math.max(...options.map((o) => o.votes));
  const voted = mine !== null;

  return (
    <section aria-labelledby={`poll-${poll.id}`} className="card flex h-full flex-col p-5 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
          <Vote className="h-4 w-4" aria-hidden /> Poll of the week
        </p>
        <SampleTag what="Poll counts" />
      </div>
      <h2 id={`poll-${poll.id}`} className="mt-2 text-xl font-bold tracking-tight">
        {poll.question}
      </h2>
      <p className="mt-1 text-sm text-mute">{poll.detail}</p>

      {poll.kind === "hero" ? (
        <div className="mt-4 grid flex-1 grid-cols-2 gap-3">
          {options.map((o, i) => {
            const p = Math.round((o.votes / total) * 100);
            return (
              <button
                key={o.label}
                type="button"
                disabled={voted}
                onClick={() => vote(i)}
                aria-pressed={mine === i}
                aria-label={voted ? `${o.label}: ${p}%, ${o.votes} votes` : `Vote for ${o.label}, ${o.site?.domain}`}
                className={`group relative flex flex-col overflow-hidden rounded-xl border bg-raised text-left transition disabled:cursor-default ${
                  mine === i ? "border-accent ring-2 ring-accent" : voted ? "border-edge" : "card-hover border-edge hover:border-edge-strong"
                }`}
              >
                <span className="relative block min-h-32 flex-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${o.site!.shot}/hero.jpg`} alt={`Hero section of ${o.site!.domain}`} loading="lazy" className="absolute inset-0 h-full w-full object-cover object-top" />
                  {voted && (
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent p-3 pt-8 text-white">
                      {mine === i && (
                        <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11px] font-bold text-on-fill">
                          <Check className="h-3 w-3" aria-hidden /> Your vote
                        </span>
                      )}
                      <span className="block text-2xl font-bold tabular-nums">{p}%</span>
                      <span className="block text-xs text-white/80">{o.votes.toLocaleString()} votes</span>
                    </span>
                  )}
                </span>
                <span className="flex items-center justify-between gap-2 border-t border-edge bg-card px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{o.label}</span> <span className="text-mute">{o.site!.domain}</span>
                  </span>
                  {!voted && <span className="shrink-0 text-xs font-semibold text-accent">Vote</span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 grid flex-1 content-start gap-3">
          {options.map((o, i) =>
            voted ? (
              <PollBar key={o.label} label={o.label} votes={o.votes} pct={Math.round((o.votes / total) * 100)} lead={o.votes === max} mine={mine === i} />
            ) : (
              <button key={o.label} type="button" onClick={() => vote(i)} className="card-hover h-11 rounded-lg border border-edge bg-card px-4 text-left text-sm font-semibold">
                {o.label}
              </button>
            )
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-mute">
        <span role="status">
          {voted ? `Thanks. ${total.toLocaleString()} votes so far.` : "One vote per visitor, no sign-in."} Closes Sunday.
        </span>
        {showAll && (
          <a href="/polls" className="group inline-flex shrink-0 items-center gap-1 font-semibold text-accent">
            Past polls <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
          </a>
        )}
      </div>
    </section>
  );
}
