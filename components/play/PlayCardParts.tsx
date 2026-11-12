"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PlayDiagnostics } from "@/components/Diagnostics";
import { LikeButton } from "@/components/LikeButton";
import { GitHubMark } from "@/components/ui/GitHubMark";
import type { PlayDetails } from "@/lib/play/card";

// The pieces the games draw around a portfolio (face-off and Guess the
// percentile). The screenshot is the hero: above it a slim line with the
// name, the site's address (the visit link) and a small Save; with it,
// always shown, "About this portfolio" (what our tools measured), below the screenshot
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

/** The face-off record: how often people picked it. Shown after the vote only, so it can't steer it. */
function RecordLine({ url }: { url: string }) {
  const [d, setD] = useState<PlayDetails | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadDetails(url).then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, [url]);
  if (!d) return null;
  const rate = d.votes > 0 ? Math.round((100 * d.wins) / d.votes) : null;
  return (
    <section className="grid gap-1">
      <h5 className="text-xs font-semibold tracking-wider text-mute uppercase">Record</h5>
      <p className="text-sm">
        {rate != null ? (
          <>
            In {d.votes} face-{d.votes === 1 ? "off" : "offs"}, people picked it <strong>{rate}%</strong> of the time.
          </>
        ) : (
          "No face-offs yet."
        )}
      </p>
    </section>
  );
}

/**
 * "About this portfolio", always shown with the card: what our tools measured
 * on the site (its own link preview, the Lighthouse scores, the polish
 * checklist; components/Diagnostics.tsx PlayDiagnostics) and, after a face-off
 * vote, its record. None of it gives a Guess the percentile answer away; the
 * full profile (which shows the grade) is linked only where `profile` is on.
 * `side` is the look beside the screenshot (1440 px up) rather than below it.
 */
export function DetailsPanel({ id, url, record, profile, side = false }: { id: string; url: string; record: boolean; profile: boolean; side?: boolean }) {
  return (
    <div id={id} className={`grid content-start gap-4 ${side ? "min-w-0 border-l border-edge p-4" : "border-t border-edge bg-bg/40 p-3 sm:p-4"}`}>
      <h4 className="sr-only">About this portfolio</h4>
      <PlayDiagnostics url={url} />
      {record && <RecordLine url={url} />}
      {profile && (
        <a href={`/p/${encodeURIComponent(url)}`} target="_blank" rel="noopener" className="group inline-flex items-center gap-1 justify-self-start text-sm font-semibold text-accent">
          Full profile <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}
