"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Bookmark, Check, ChevronDown, ExternalLink, FolderGit2, Mail, ShieldCheck, Swords, Wrench } from "lucide-react";
import { AddToListButton } from "@/components/AddToListButton";
import { LikeButton } from "@/components/LikeButton";
import type { PlayCard, PlayDetails } from "@/lib/play/card";

// The pieces the games draw around a portfolio (face-off and Guess the
// percentile): the facts beside a smaller screenshot, the action row
// (Details, Visit, Save, Like) and the inline Details panel that opens right
// below the card. `reveal` false hides whatever gives a grade away (tier,
// "top N%", the AI's scores, the share card and the full profile, which
// shows them): before a guess is locked in, or before a face-off vote
// unless "Show scores before voting" is on.

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const CHECK_ICON = { reach: Mail, work: FolderGit2, current: ShieldCheck } as const;
const CHECK_SHORT = { reach: "Reach", work: "Work", current: "Current" } as const;

/** Tier letter and "top N%", or the reason there is none. */
export function GradeLine({ card, reveal, hint = "Grade shows after you pick" }: { card: PlayCard | null; reveal: boolean; hint?: string }) {
  if (!card?.graded) return <span className="text-xs text-mute">Not graded yet</span>;
  if (!reveal)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-mute">
        <span className="grid h-6 w-6 place-items-center rounded-md border border-dashed border-edge-strong text-[11px] font-bold" aria-hidden>
          ?
        </span>
        {hint}
      </span>
    );
  if (!card.tier)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-mute">
        <span className="grid h-6 min-w-6 place-items-center rounded-md bg-edge px-1 text-[11px] font-bold text-ink" aria-hidden>
          AI
        </span>
        Graded, below the top tiers
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={`grid h-7 w-7 place-items-center rounded-md text-sm font-extrabold ${card.tier === "S" ? "bg-fill text-on-fill" : "bg-accent-soft text-accent ring-1 ring-accent/40"}`}>
        {card.tier}
        <span className="sr-only"> tier</span>
      </span>
      {card.topPct != null && (
        <span>
          Top <strong className="tabular-nums">{card.topPct}%</strong> <span className="text-mute max-sm:hidden">of graded</span>
        </span>
      )}
    </span>
  );
}

/** The hiring manager's three questions as one chip each: covered or what to fix. */
export function ChecksSummary({ card, dense = false }: { card: PlayCard | null; dense?: boolean }) {
  if (!card?.checks.length) return null;
  return (
    <ul className={`flex flex-wrap ${dense ? "gap-1" : "gap-1.5"}`} aria-label="Hiring manager checks">
      {card.checks.map((c) => {
        const Icon = CHECK_ICON[c.key as keyof typeof CHECK_ICON] ?? ShieldCheck;
        const ok = c.state === "ok";
        return (
          <li
            key={c.key}
            title={ok ? `${c.title} Yes.` : c.toFix.length ? `${c.title} Missing: ${c.toFix.join(", ")}.` : `${c.title} Not measured.`}
            className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold ${
              ok ? "border-up/30 text-up" : c.state === "fix" ? "border-accent/35 text-accent" : "border-dashed border-edge-strong text-mute"
            }`}
          >
            <Icon className="h-3 w-3" aria-hidden />
            <span className={dense ? "max-sm:sr-only" : ""}>{CHECK_SHORT[c.key as keyof typeof CHECK_SHORT] ?? c.title}</span>
            {ok ? (
              <Check className="h-3 w-3" aria-label="covered" />
            ) : c.state === "fix" ? (
              <span className="tabular-nums">
                {c.toFix.length}
                <span className={dense ? "max-sm:sr-only" : ""}> to fix</span>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Face-off record: votes and how often it wins. */
export function Record({ card, reveal }: { card: PlayCard | null; reveal: boolean }) {
  if (!card) return null;
  const rate = card.votes > 0 ? Math.round((100 * card.wins) / card.votes) : null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-mute">
      <Swords className="h-3.5 w-3.5" aria-hidden />
      <span className="tabular-nums">
        {card.votes} {card.votes === 1 ? "face-off" : "face-offs"}
        {reveal && rate != null && (
          <>
            , wins <strong className="text-ink">{rate}%</strong>
          </>
        )}
      </span>
    </span>
  );
}

export const actionBtn =
  "inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-sm font-semibold text-ink shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-[0.97] disabled:opacity-50";

/**
 * Details (opens the panel below), Visit, Save (a list) and Like (a personal
 * bookmark on your profile, never a vote). On a phone they sit two by two,
 * each a full 44 px target with its word.
 */
export function PlayActions({
  url,
  name,
  liked,
  detailsId,
  open,
  onDetails,
  onSaved,
}: {
  url: string;
  name: string;
  liked?: boolean;
  detailsId: string;
  open: boolean;
  onDetails: () => void;
  onSaved?: () => void;
}) {
  const btn = `${actionBtn} max-sm:gap-1 max-sm:px-1.5 max-sm:text-xs`;
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
      <button type="button" data-details onClick={onDetails} aria-expanded={open} aria-controls={detailsId} className={`${btn} ${open ? "border-accent/60 text-accent" : ""}`}>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        <span className="label">Details</span>
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer" className={btn} aria-label={`Visit ${name} (opens in a new tab)`}>
        <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
        <span className="label">Visit</span>
      </a>
      <div onClickCapture={onSaved} className="contents">
        <AddToListButton url={url} className="contents" buttonClassName={btn} ariaLabel={`Save ${name} to a list`}>
          <Bookmark className="h-4 w-4 shrink-0" aria-hidden />
          <span className="label">Save</span>
        </AddToListButton>
      </div>
      <LikeButton url={url} name={name} variant="action" initialLiked={liked} className={btn} />
    </div>
  );
}

/** The site's address as a readable link that opens it in a new tab. */
export function SiteLink({ url, className = "" }: { url: string; className?: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`group inline-flex min-w-0 items-center gap-1 text-sm text-mute underline-offset-4 hover:text-ink hover:underline ${className}`}>
      <span className="truncate">{domainOf(url)}</span>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

const cache = new Map<string, Promise<PlayDetails | null>>();
function loadDetails(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = fetch(`/api/play/card?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? (r.json() as Promise<PlayDetails>) : null))
      .catch(() => null);
    p.then((d) => d ?? cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/** The inline Details panel, loaded on first open. */
export function DetailsPanel({
  id,
  url,
  name,
  reveal,
  after = "you pick",
  className = "",
}: {
  id: string;
  url: string;
  name: string;
  reveal: boolean;
  /** When the hidden parts show: "you pick", "you lock in your guess". */
  after?: string;
  className?: string;
}) {
  const [d, setD] = useState<PlayDetails | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadDetails(url).then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, [url]);

  return (
    <section id={id} aria-label={`Details for ${name}`} className={`card details-in p-4 sm:p-5 ${className}`}>
      {d === undefined ? (
        <div role="status" className="grid gap-3" aria-label="Loading details">
          <div className="h-5 w-1/3 animate-pulse rounded bg-raised" />
          <div className="h-20 animate-pulse rounded-lg bg-raised" />
          <div className="aspect-[1200/630] animate-pulse rounded-lg bg-raised" />
        </div>
      ) : d === null ? (
        <p role="alert" className="text-sm text-mute">
          Couldn&apos;t load the details. <a className="font-semibold text-accent underline underline-offset-2" href={`/p/${encodeURIComponent(url)}`}>Open the full profile</a> instead.
        </p>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{name}</h3>
            <GradeLine card={d} reveal={reveal} hint={`Grade shows after ${after}`} />
          </div>

          {d.groups.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold tracking-wider text-mute uppercase">What a hiring manager checks</h4>
              <ul className="mt-2 grid gap-2">
                {d.groups.map((g) => (
                  <li key={g.key} className="rounded-lg border border-edge bg-bg/40 p-2.5">
                    <p className="flex items-center justify-between gap-2 text-sm font-medium">
                      {g.title}
                      {g.missing.length === 0 ? (
                        <span className="rounded-full bg-up/10 px-2 py-0.5 text-[11px] font-semibold text-up">Covered</span>
                      ) : (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">{g.missing.length} to fix</span>
                      )}
                    </p>
                    <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                      {g.ok.map((f) => (
                        <span key={f.id} className="inline-flex items-center gap-1 rounded-full border border-up/30 px-2 py-0.5" title={f.detail}>
                          <Check className="h-3 w-3 text-up" aria-hidden /> {f.short}
                        </span>
                      ))}
                      {g.missing.map((f) => (
                        <span key={f.id} className="inline-flex items-center gap-1 rounded-full border border-accent/30 px-2 py-0.5" title={f.missing}>
                          <Wrench className="h-3 w-3 text-accent" aria-hidden /> {f.short}: <span className="text-mute">{f.detail}</span>
                        </span>
                      ))}
                      {g.unknown.map((f) => (
                        <span key={f.id} className="rounded-full border border-dashed border-edge-strong px-2 py-0.5 text-mute">
                          {f.short}: not measured
                        </span>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reveal && d.judgments.some((j) => j.score != null) && (
            <div>
              <h4 className="text-xs font-semibold tracking-wider text-mute uppercase">The AI&apos;s read{d.model ? ` (Gemini)` : ""}</h4>
              <ul className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
                {d.judgments.map((j) => (
                  <li key={j.id} title={j.note}>
                    <span className="flex items-center justify-between text-xs">
                      <span>{j.label}</span>
                      <span className="font-semibold tabular-nums">{j.score ?? "-"}/5</span>
                    </span>
                    <span className="mt-1 block h-1.5 rounded-full bg-edge" aria-hidden>
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${((j.score ?? 0) / 5) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reveal ? (
            <div>
              <h4 className="text-xs font-semibold tracking-wider text-mute uppercase">Share card</h4>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={d.shareImage} alt={`Share card for ${name}`} loading="lazy" width={1200} height={630} className="mt-2 aspect-[1200/630] w-full rounded-lg border border-edge bg-raised object-cover" />
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-edge-strong p-3 text-xs text-mute">The grade, the AI&apos;s scores, the share card and the full profile show once {after}.</p>
          )}

          {reveal && (
            <a href={d.profile} target="_blank" rel="noopener" className="group inline-flex items-center gap-1 justify-self-start text-sm font-semibold text-accent">
              Full profile <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      )}
    </section>
  );
}
