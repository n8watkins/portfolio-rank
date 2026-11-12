"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Bookmark, Check, ChevronDown, ExternalLink, X } from "lucide-react";
import { AddToListButton } from "@/components/AddToListButton";
import { LikeButton } from "@/components/LikeButton";
import type { PlayDetails } from "@/lib/play/card";

// The pieces the games draw around a portfolio (face-off and Guess the
// percentile). The screenshot is the hero: above it only a slim line with
// the name and the site link, below it the action row (Details, Visit, Save,
// Like) and, when opened, "About this portfolio" in plain words. `reveal`
// false hides whatever gives a grade away (the AI grade, the face-off
// record, the share card and the full profile, which shows them): before a
// face-off vote, or before a guess is locked in.

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The slim line above a screenshot: the name and the site, which opens in a new tab. */
export function NameLine({ name, url, className = "" }: { name: string; url: string; className?: string }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-x-2 px-3 py-2 sm:px-4 ${className}`}>
      <h3 className="min-w-0 shrink truncate font-semibold">{name}</h3>
      <SiteLink url={url} className="min-w-0 shrink-[2]" />
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

export const actionBtn =
  "inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-sm font-semibold text-ink shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-[0.97] disabled:opacity-50";

/**
 * Details (opens "About this portfolio" below), Visit, Save (a list) and
 * Like (a personal bookmark on your profile, never a vote), each a full
 * 44 px target with its word.
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
  const btn = `${actionBtn} max-sm:gap-1 max-sm:px-1.5`;
  return (
    <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap">
      <button type="button" data-details onClick={onDetails} aria-expanded={open} aria-controls={detailsId} className={`${btn} ${open ? "border-accent/60 text-accent" : ""}`}>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        <span>Details</span>
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer" className={btn} aria-label={`Visit ${name} (opens in a new tab)`}>
        <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
        <span>Visit</span>
      </a>
      <div onClickCapture={onSaved} className="contents">
        <AddToListButton url={url} className="contents" buttonClassName={btn} ariaLabel={`Save ${name} to a list`}>
          <Bookmark className="h-4 w-4 shrink-0" aria-hidden />
          <span>Save</span>
        </AddToListButton>
      </div>
      <LikeButton url={url} name={name} variant="action" initialLiked={liked} className={btn} />
    </div>
  );
}

// "Hiring basics": the three questions in plain words, each answered by
// what the page check found (lib/grader/present.mjs FACT_GROUPS).
const BASICS: Record<string, string> = {
  reach: "Can a recruiter reach them?",
  work: "Can you see their work?",
  current: "Does it look current and their own?",
};
const NOUN: Record<string, string> = {
  contact: "a contact link",
  resume: "a resume",
  github: "a GitHub link",
  project_links: "working project links",
  own_domain: "their own domain",
  fresh_footer: "an up-to-date footer",
  original: "an original design",
};
const MISSING: Record<string, string> = {
  contact: "No contact link",
  resume: "No resume",
  github: "No GitHub link",
  project_links: "Some project links are broken",
  own_domain: "Not on their own domain",
  fresh_footer: "The footer year is old",
  original: "Looks like a template",
};
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function basicsLine(g: PlayDetails["groups"][number]) {
  const has = g.ok.map((f) => NOUN[f.id] ?? f.short.toLowerCase());
  const missing = g.missing.map((f) => `${MISSING[f.id] ?? `No ${f.short.toLowerCase()}`}.`);
  if (missing.length === 0) return `Yes: ${list(has)}.`;
  return [has.length ? `Has ${list(has)}.` : "", ...missing].filter(Boolean).join(" ");
}

// The AI grade's five scores in plain words (pipeline/rubric.mjs AI_CRITERIA ids).
const PLAIN_SCORE: Record<string, string> = {
  visual_design: "Looks",
  five_second_test: "Clear at a glance",
  storytelling: "Project stories",
  writing: "Writing",
  memorability: "Memorable",
};

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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h5 className="text-xs font-semibold tracking-wider text-mute uppercase">{title}</h5>
      {children}
    </section>
  );
}

/** "About this portfolio", loaded on first open; it sits below the card's actions. */
export function DetailsPanel({
  id,
  url,
  name,
  reveal,
  after = "you vote",
  className = "",
}: {
  id: string;
  url: string;
  name: string;
  reveal: boolean;
  /** When the hidden parts show: "you vote", "you lock in your guess". */
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

  const rate = d && d.votes > 0 ? Math.round((100 * d.wins) / d.votes) : null;
  const scores = d?.judgments.filter((j) => j.score != null) ?? [];

  return (
    <div id={id} className={`details-in border-t border-edge bg-bg/40 p-3 sm:p-4 ${className}`}>
      <h4 className="font-semibold">About this portfolio</h4>
      {d === undefined ? (
        <div role="status" aria-label="Loading" className="mt-3 grid gap-2">
          <div className="h-4 w-2/5 animate-pulse rounded bg-raised" />
          <div className="h-16 animate-pulse rounded-lg bg-raised" />
        </div>
      ) : d === null ? (
        <p role="alert" className="mt-2 text-sm text-mute">
          Couldn&apos;t load this. Try again in a moment.
        </p>
      ) : (
        <div className="mt-3 grid gap-4">
          <Group title="Hiring basics">
            {d.groups.length ? (
              <ul className="grid gap-1.5">
                {d.groups.map((g) => {
                  const ok = g.missing.length === 0;
                  return (
                    <li key={g.key} className="flex gap-2 text-sm">
                      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${ok ? "bg-up/15 text-up" : "bg-accent-soft text-accent"}`}>
                        {ok ? <Check className="h-3.5 w-3.5" aria-label="Yes" /> : <X className="h-3.5 w-3.5" aria-label="Not fully" />}
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium">{BASICS[g.key] ?? g.title}</span> <span className="text-mute">{basicsLine(g)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-mute">Not checked yet.</p>
            )}
          </Group>

          {!reveal ? (
            <p className="text-sm text-mute">The AI grade, this portfolio&apos;s record and its share card show after {after}.</p>
          ) : (
            <>
              <Group title="AI grade">
                {!d.graded ? (
                  <p className="text-sm text-mute">Not graded yet.</p>
                ) : (
                  <>
                    <p className="text-sm">
                      {d.tier ? (
                        <>
                          Tier <strong>{d.tier}</strong>
                          {d.topPct != null && (
                            <>
                              , in the top <strong>{d.topPct}%</strong> of graded portfolios
                            </>
                          )}
                          .
                        </>
                      ) : (
                        "Graded, below the top tiers (only S, A and B are shown)."
                      )}
                    </p>
                    {scores.length > 0 && (
                      <>
                        <p className="text-xs text-mute">An AI (Google Gemini) scored the page from 1 to 5 on five things a hiring manager notices.</p>
                        <ul className="grid gap-x-5 gap-y-1.5 sm:grid-cols-2">
                          {scores.map((j) => (
                            <li key={j.id} title={j.note}>
                              <span className="flex justify-between text-xs">
                                <span>{PLAIN_SCORE[j.id] ?? j.label}</span>
                                <span className="font-semibold tabular-nums">{j.score} of 5</span>
                              </span>
                              <span className="mt-1 block h-1.5 rounded-full bg-edge" aria-hidden>
                                <span className="block h-full rounded-full bg-accent" style={{ width: `${((j.score ?? 0) / 5) * 100}%` }} />
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </Group>
              <Group title="Record">
                <p className="text-sm">
                  {d.votes > 0 ? (
                    <>
                      In {d.votes} face-{d.votes === 1 ? "off" : "offs"}, people picked it <strong>{rate}%</strong> of the time.
                    </>
                  ) : (
                    "No face-offs yet."
                  )}
                </p>
              </Group>
              <Group title="Share card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={d.shareImage} alt={`Share card for ${name}`} loading="lazy" width={1200} height={630} className="aspect-[1200/630] w-full max-w-md rounded-lg border border-edge bg-raised object-cover" />
                <p className="text-xs text-mute">The picture people see when this portfolio is shared.</p>
              </Group>
              <a href={d.profile} target="_blank" rel="noopener" className="group inline-flex items-center gap-1 justify-self-start text-sm font-semibold text-accent">
                Full profile <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
