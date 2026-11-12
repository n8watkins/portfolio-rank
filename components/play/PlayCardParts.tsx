"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PlayDiagnostics, SocialIcons } from "@/components/Diagnostics";
import { LikeButton } from "@/components/LikeButton";
import type { PlayDetails } from "@/lib/play/card";

// The pieces the games draw around a portfolio (face-off and Guess the
// percentile). The screenshot is the hero: above it a slim line with the
// name, the address (the visit link), socials and Save; with it,
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
 * The line above a screenshot: the name, the site's address (the visit
 * link), the person's GitHub, LinkedIn and X when the page links them, and
 * Save: a heart button, outlined in rose so it never reads as the gold Pick,
 * that keeps the portfolio on your profile (the saves behind the portfolio
 * page's "saved" count), never a vote.
 */
export function NameLine({ name, url, liked, onSaved, className = "" }: { name: string; url: string; liked?: boolean; onSaved?: () => void; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2 pr-2 pl-3 sm:flex-nowrap sm:pl-4 ${className}`}>
      <h3 className="min-w-0 shrink truncate font-semibold">{name}</h3>
      <SiteLink url={url} className="min-w-0 shrink-[2]" />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SocialIcons url={url} name={name} />
        <div onClickCapture={onSaved}>
          <LikeButton
            url={url}
            name={name}
            variant="action"
            verb="Save"
            initialLiked={liked}
            className="inline-flex h-11 min-w-24 items-center justify-center gap-2 rounded-lg border-2 border-rose-500/60 bg-card px-4 text-sm font-semibold text-ink transition hover:border-rose-500 hover:bg-rose-500/10 active:scale-[0.97] aria-pressed:bg-rose-500/10 [&_svg]:text-rose-500"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The site's address as the visit link (a new tab). The person's GitHub and
 * other profiles have one place, the icon row in the name line.
 */
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

function useCard(url: string) {
  const [d, setD] = useState<PlayDetails | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadDetails(url).then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, [url]);
  return d;
}

/** The face-off record: how often people picked it. Shown after the vote only, so it can't steer it. */
function RecordLine({ card }: { card: PlayDetails | null | undefined }) {
  if (!card) return null;
  const rate = card.votes > 0 ? Math.round((100 * card.wins) / card.votes) : null;
  return (
    <section className="details-in grid gap-1">
      <h5 className="text-xs font-semibold tracking-wider text-mute uppercase">Record</h5>
      <p className="text-sm">
        {rate != null ? (
          <>
            In {card.votes} face-{card.votes === 1 ? "off" : "offs"}, people picked it <strong>{rate}%</strong> of the time.
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
 * on the site (components/Diagnostics.tsx PlayDiagnostics: its own link
 * preview, Lighthouse, the polish checklist and the "Built with" list) and,
 * after a face-off vote, its record. None of it gives a Guess the percentile
 * answer away; the full profile (which shows the grade) is linked only where
 * `profile` is on.
 * - `part` "spec" is the "Built with" list alone (under the screenshot from
 *   1440 px up), "checks" the rest (beside it); "all" is both.
 * - `side` is the look beside the screenshot rather than below it.
 */
export function DetailsPanel({
  id,
  url,
  record,
  profile,
  part = "all",
  side = false,
  metrics,
  sections,
}: {
  id: string;
  url: string;
  record: boolean;
  profile: boolean;
  part?: "all" | "spec" | "checks";
  side?: boolean;
  /** The viewer's choice of Lighthouse scores and sections (lib/play/view-prefs.ts). */
  metrics?: string[];
  sections?: string[];
}) {
  const card = useCard(url);
  const rest = part !== "spec";
  return (
    <div id={id} className={`grid content-start gap-4 ${side ? "min-w-0 border-l border-edge p-4" : part === "spec" ? "border-t border-edge p-4" : "border-t border-edge bg-bg/40 p-3 sm:p-4"}`}>
      {rest && <h4 className="sr-only">About this portfolio</h4>}
      <PlayDiagnostics url={url} part={part} projects={card?.projects} metrics={metrics} sections={sections} />
      {rest && record && <RecordLine card={card} />}
      {rest && profile && (
        <a href={`/p/${encodeURIComponent(url)}`} target="_blank" rel="noopener" className="group inline-flex items-center gap-1 justify-self-start text-sm font-semibold text-accent">
          Full profile <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}
