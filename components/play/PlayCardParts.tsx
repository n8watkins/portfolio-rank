"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, X } from "lucide-react";
import { LikeButton } from "@/components/LikeButton";
import { GitHubMark } from "@/components/ui/GitHubMark";
import type { PlayDetails } from "@/lib/play/card";

// The pieces the games draw around a portfolio (face-off and Guess the
// percentile). The screenshot is the hero: above it a slim line with the
// name, the site's address (the visit link) and a small Save; with it,
// always shown, "About this portfolio" in plain words, below the screenshot
// or (from 1440 px up in the face-off) beside it.

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * The slim line above a screenshot: the name, the site's address (the visit
 * link) and a small Save: a heart that keeps the portfolio on your profile
 * (the saves behind the portfolio page's "saved" count), never a vote.
 */
export function NameLine({ name, url, liked, onSaved, className = "" }: { name: string; url: string; liked?: boolean; onSaved?: () => void; className?: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-x-2 py-1.5 pr-1.5 pl-3 sm:pl-4 ${className}`}>
      <h3 className="min-w-0 shrink truncate font-semibold">{name}</h3>
      <SiteLink url={url} className="min-w-0 shrink-[2]" />
      <div onClickCapture={onSaved} className="ml-auto shrink-0">
        <LikeButton
          url={url}
          name={name}
          variant="action"
          verb="Save"
          initialLiked={liked}
          className="inline-flex h-9 min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-mute transition hover:bg-raised hover:text-ink"
        />
      </div>
    </div>
  );
}

const onGitHubPages = (url: string) => /(^|\.)github\.io$/i.test(domainOf(url));

/**
 * The site's address as the visit link (a new tab). A site hosted on GitHub
 * Pages (github.io) gets GitHub's mark on the right, "hosted on GitHub".
 */
export function SiteLink({ url, className = "" }: { url: string; className?: string }) {
  const gh = onGitHubPages(url);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`group inline-flex min-w-0 items-center gap-1 text-sm text-mute underline-offset-4 hover:text-ink hover:underline ${className}`}>
      <span className="truncate">{domainOf(url)}</span>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
      <span className="sr-only"> (opens in a new tab{gh ? ", hosted on GitHub" : ""})</span>
      {gh && (
        <span title="Hosted on GitHub" className="ml-1 inline-grid shrink-0 place-items-center">
          <GitHubMark className="h-3.5 w-3.5" />
        </span>
      )}
    </a>
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
  if (missing.length === 0 && has.length === 0) return "Not checked on this page yet.";
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

/**
 * "About this portfolio", always shown with the card: the share card, the
 * hiring basics, the AI grade and (after a vote) the face-off record.
 * - `grade` false (Guess the percentile before Lock in) hides the AI grade
 *   and the full profile and shows the share card with the tier and the
 *   result masked, since they give the answer away.
 * - `record` false hides the win rate, so it can't steer a face-off vote.
 * - `part` splits it for the widest face-off layout: "share" (the share card,
 *   under the screenshot) and "facts" (everything else, beside it).
 * - `side` is the look beside the screenshot rather than below it.
 * Below the screenshot ("all"), the share card and the facts sit side by side
 * when the card is wide enough (a container query), else stacked.
 */
export function DetailsPanel({
  id,
  url,
  name,
  grade,
  record,
  part = "all",
  maskedNote = "The tier and result are hidden until you lock in your guess.",
  side = false,
  className = "",
}: {
  id: string;
  url: string;
  name: string;
  grade: boolean;
  record: boolean;
  part?: "all" | "share" | "facts";
  maskedNote?: string;
  side?: boolean;
  className?: string;
}) {
  const showShare = part !== "facts";
  const showFacts = part !== "share";
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
    <div id={id} className={`@container ${side ? "min-w-0 border-l border-edge p-4" : part === "share" ? "border-t border-edge p-3 sm:p-4" : "border-t border-edge bg-bg/40 p-3 sm:p-4"} ${className}`}>
      {showFacts && <h4 className="sr-only">About this portfolio</h4>}
      {d === undefined ? (
        <div role="status" aria-label="Loading details" className="grid gap-3">
          {showShare && <div className="aspect-[1200/630] w-full max-w-sm animate-pulse rounded-lg bg-raised" />}
          {showFacts && <div className="h-16 animate-pulse rounded-lg bg-raised" />}
        </div>
      ) : d === null ? (
        <p role="alert" className="text-sm text-mute">
          Couldn&apos;t load the details. Try again in a moment.
        </p>
      ) : (
        <div className={`grid gap-4 ${part === "all" ? "@lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] @lg:items-start" : ""}`}>
          {showShare && (
            <Group title="Share card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={grade ? d.shareImage : `${d.shareImage}?masked=1`}
                alt={`Share card for ${name}`}
                loading="lazy"
                width={1200}
                height={630}
                className="aspect-[1200/630] w-full max-w-sm rounded-lg border border-edge bg-raised object-cover"
              />
              <p className="text-xs text-mute">{grade ? "The picture people see when this portfolio is shared." : maskedNote}</p>
            </Group>
          )}

          {showFacts && (
            <div className="grid gap-4">
              <Group title="Hiring basics">
                {d.groups.length ? (
                  <ul className="grid gap-1.5">
                    {d.groups.map((g) => {
                      // Older grades have no measured checks: a neutral mark, not a tick.
                      const unknown = g.missing.length === 0 && g.ok.length === 0;
                      const ok = !unknown && g.missing.length === 0;
                      return (
                        <li key={g.key} className="flex gap-2 text-sm">
                          <span
                            className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                              unknown ? "border border-dashed border-edge-strong text-mute" : ok ? "bg-up/15 text-up" : "bg-accent-soft text-accent"
                            }`}
                          >
                            {unknown ? <span aria-label="Not checked">?</span> : ok ? <Check className="h-3.5 w-3.5" aria-label="Yes" /> : <X className="h-3.5 w-3.5" aria-label="Not fully" />}
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

              {grade && (
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
                          <ul className={`grid gap-x-5 gap-y-1.5 ${side ? "" : "sm:grid-cols-2"}`}>
                            {scores.map((j) => (
                              <li key={j.id} title={j.note}>
                                <span className="flex justify-between text-xs">
                                  <span>{PLAIN_SCORE[j.id] ?? j.label}</span>
                                  <span className="font-semibold tabular-nums">{j.score} of 5</span>
                                </span>
                                <span className="mt-1 block h-1.5 rounded-full bg-edge" aria-hidden>
                                  <span
                                    className="block h-full rounded-full bg-accent"
                                    style={{
                                      width: `${((j.score ?? 0) / 5) * 100}%`,
                                    }}
                                  />
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </Group>
              )}

              {record && (
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
              )}

              {grade && (
                <a href={d.profile} target="_blank" rel="noopener" className="group inline-flex items-center gap-1 justify-self-start text-sm font-semibold text-accent">
                  Full profile <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
