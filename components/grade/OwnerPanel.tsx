"use client";

import { useState } from "react";
import { ArrowRight, ShieldCheck, Trash2 } from "lucide-react";
import { Regrade } from "@/components/me/Regrade";
import { btnSecondary, sectionTitle } from "@/components/ui/styles";

/**
 * What the report's owner can do (the browser that asked for it, or opened
 * its emailed link): re-grade, and delete the report with its screenshots.
 * For a portfolio on the list (GAMES_V2), anyone signed in with GitHub can
 * claim it to hide its grade, ask for a re-grade or remove it from the site.
 */
export function OwnerPanel({
  id,
  url,
  domain,
  mine,
  claimHref,
  gradedAt,
  regradeAfter,
  cooldownDays,
  now,
  afterDelete,
}: {
  id: string;
  url: string;
  domain: string;
  mine: boolean;
  claimHref: string | null;
  gradedAt: string;
  regradeAfter: string | null;
  cooldownDays: number;
  now: number;
  afterDelete: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/grade/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status === 204 || res.status === 404) return location.assign(afterDelete);
      setError(res.status === 403 ? "Only the browser that asked for this report can delete it." : "That didn't work. Try again in a moment.");
    } catch {
      setError("We couldn't reach PortfolioRank. Check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <section aria-labelledby="owner" className="card reveal mt-12 p-5 sm:p-6 print:hidden">
      <h2 id="owner" className={`${sectionTitle} flex items-center gap-2`}>
        <ShieldCheck className="h-4 w-4 text-mute" aria-hidden /> {mine ? "Your report" : `Is ${domain} yours?`}
      </h2>
      <p className="mt-1 text-sm text-mute">
        {mine ? "Only you see these. The report stays unlisted: only people with its link can open it." : "Claim it with GitHub to manage how it shows on PortfolioRank."}
      </p>
      <div className={`mt-4 grid grid-cols-1 gap-4 ${mine ? "md:grid-cols-2" : ""}`}>
        {mine && <Regrade url={url} gradedAt={gradedAt} regradeAfter={regradeAfter} cooldownDays={cooldownDays} now={now} follow />}
        <div className="flex flex-col gap-4">
          {claimHref && (
            <div className="rounded-xl border border-edge bg-bg/40 p-4">
              <p className="text-sm font-semibold">{mine ? `Claim ${domain} on the leaderboard` : `Claim ${domain}`}</p>
              <p className="mt-1 text-sm text-mute">Hide its grade, ask for a re-grade, or remove it from PortfolioRank.</p>
              <a href={claimHref} className={`${btnSecondary} mt-3`}>
                Claim your portfolio <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </a>
            </div>
          )}
          {mine && (
            <div className="rounded-xl border border-down/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Trash2 className="h-4 w-4 text-down" aria-hidden /> Delete this report
              </p>
              {!confirming ? (
                <>
                  <p className="mt-1 text-sm text-mute">The report and its screenshots go for good; its link stops working.</p>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="mt-3 inline-flex h-11 items-center rounded-lg border border-down/50 px-4 text-sm font-semibold text-down transition hover:bg-down/10"
                  >
                    Delete
                  </button>
                </>
              ) : (
                <div role="group" aria-label="Confirm deleting the report">
                  <p className="mt-1 text-sm">Delete the report on {domain}? This can&apos;t be undone.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={remove}
                      className="inline-flex h-11 items-center gap-2 rounded-lg bg-down px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden /> {busy ? "Deleting..." : "Delete the report"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={btnSecondary}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}
              {error && (
                <p role="alert" className="mt-2 text-sm text-down">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
