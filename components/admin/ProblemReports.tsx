"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Flag, RotateCcw } from "lucide-react";
import { tag } from "@/components/ui/Chip";
import { btnGhost, btnSecondary } from "@/components/ui/styles";

// Visitors' "Report a problem" notes on the owner's review page
// (app/admin/(tools)/review/page.tsx), grouped by site: how many, which
// reasons, every note (plain text), when, and links to the site and its
// profile. "Mark handled" closes all of a site's open reports and records
// who and when; handled sites stay listed below with Reopen. POST
// /api/admin/problem-reports (lib/problem-reports/store.mjs). A report
// changes nothing about the site: fixing what it points at is the owner's
// own step (a re-capture, a review row, a removal).

type Report = { id: number; url: string; reason: string; note: string | null; createdAt: string; updatedAt: string };
export type ReportedSite = {
  /** The group: the site for open reports; the site and the moment they were handled for handled ones. */
  key: string;
  url: string;
  count: number;
  reasons: { key: string; label: string; count: number }[];
  reports: Report[];
  first: string;
  last: string;
  handledAt: string | null;
  handledBy: string | null;
};

const ERRORS: Record<string, string> = {
  signin_required: "Your session ended. Sign in again.",
  forbidden: "Only the admin can do this.",
  bad_origin: "That request came from another site.",
  bad_request: "That request wasn't understood. Reload and try again.",
};

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "";
const profileOf = (url: string) => `/p/${encodeURIComponent(url)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const linkCls = "inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-accent underline-offset-4 hover:underline";

function SiteLinks({ url }: { url: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-4">
      <a href={url} target="_blank" rel="noopener noreferrer" className={linkCls} data-problem-site-link>
        Open the site <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
      <a href={profileOf(url)} target="_blank" rel="noopener" className={linkCls} data-problem-profile-link>
        Its profile <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    </span>
  );
}

export function ProblemReports({ open, handled }: { open: ReportedSite[]; handled: ReportedSite[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Sites acted on since the page loaded, until the refreshed lists arrive.
  const [gone, setGone] = useState<Set<string>>(new Set());
  // Fresh lists from the server replace the guess.
  const [lists, setLists] = useState({ open, handled });
  if (lists.open !== open || lists.handled !== handled) {
    setLists({ open, handled });
    setGone(new Set());
  }

  async function act(site: ReportedSite, action: "handle" | "reopen") {
    const key = `${action}:${site.key}`;
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const res = await fetch("/api/admin/problem-reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Handle sends each report as the page shows it: one a visitor resent since stays open.
        body: JSON.stringify(
          action === "handle" ? { action, reports: site.reports.map((r) => ({ id: r.id, updatedAt: r.updatedAt })) } : { action, ids: site.reports.map((r) => r.id) }
        ),
      });
      const b = (await res.json().catch(() => ({}))) as { error?: string; stale?: number[] };
      if (!res.ok) {
        setErrors((e) => ({ ...e, [key]: ERRORS[b.error ?? ""] ?? "That didn't work. Try again." }));
        return;
      }
      if (b.stale?.length) {
        // A visitor changed a report after this page loaded: show the fresh list, with that report still open.
        setErrors((e) => ({
          ...e,
          [`handle:${site.url}`]: `${plural(b.stale!.length, "report")} changed since this page loaded and ${b.stale!.length === 1 ? "stays" : "stay"} open. Read ${b.stale!.length === 1 ? "it" : "them"}, then mark handled again.`,
        }));
      } else {
        setGone((g) => new Set(g).add(key));
      }
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [key]: "We couldn't reach the server. Try again." }));
    } finally {
      setBusy(null);
    }
  }

  const openShown = open.filter((s) => !gone.has(`handle:${s.key}`));
  const handledShown = handled.filter((s) => !gone.has(`reopen:${s.key}`));
  const total = openShown.reduce((n, s) => n + s.count, 0);

  return (
    <section className="mb-8" aria-labelledby="problem-reports-heading" data-problem-reports>
      <h2 id="problem-reports-heading" className="flex items-center gap-2 text-lg font-bold tracking-tight">
        <Flag className="h-4 w-4 text-accent" aria-hidden />
        Visitor reports
        {openShown.length > 0 && (
          <span className="text-base font-semibold text-mute">
            ({plural(total, "report")} on {plural(openShown.length, "site")})
          </span>
        )}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-mute text-pretty">
        Sent from &ldquo;Report a problem&rdquo; under a profile&rsquo;s screenshot. A report changes nothing about the site&rsquo;s rank, tier, score or listing; it
        tells you where to look.
      </p>

      {openShown.length === 0 ? (
        <p className="mt-3 text-sm text-mute" data-problem-empty>
          No open reports.
        </p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {openShown.map((s) => {
            const domain = domainOf(s.url);
            const key = `handle:${s.key}`;
            const notes = s.reports.filter((r) => r.note);
            return (
              <li key={s.url} className="card p-4 sm:p-5" data-problem-site={s.url}>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-base font-bold break-all">{domain}</span>
                  <span className={tag} data-problem-count>
                    {plural(s.count, "report")}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-mute">{s.count === 1 ? `Sent ${when(s.last)}` : `First ${when(s.first)} · latest ${when(s.last)}`}</p>
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Reasons">
                  {s.reasons.map((r) => (
                    <li key={r.key} className={`${tag} h-auto min-h-6 py-0.5 text-ink`} data-problem-reason={r.key}>
                      {r.label}
                      {r.count > 1 && <span className="tabular-nums text-mute">&times;{r.count}</span>}
                    </li>
                  ))}
                </ul>
                {notes.length > 0 && (
                  <ul className="mt-3 grid gap-2" aria-label="Notes">
                    {notes.map((r) => (
                      <li key={r.id} className="rounded-lg bg-raised px-3 py-2 text-sm" data-problem-note>
                        {/* Plain text: React escapes it, and line breaks are kept with whitespace-pre-line. */}
                        <p className="whitespace-pre-line break-words text-pretty">{r.note}</p>
                        <p className="mt-1 text-xs text-mute">
                          {s.reasons.find((x) => x.key === r.reason)?.label ?? r.reason} · <span className="whitespace-nowrap">{when(r.updatedAt)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-edge pt-3">
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy !== null}
                    onClick={() => act(s, "handle")}
                    aria-label={`Mark the reports on ${domain} handled`}
                    data-problem-handle
                  >
                    <Check className="h-4 w-4" aria-hidden />
                    {busy === key ? "Saving..." : "Mark handled"}
                  </button>
                  <SiteLinks url={s.url} />
                  {errors[key] && (
                    <p className="text-sm text-down" role="alert">
                      {errors[key]}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {handledShown.length > 0 && (
        <details className="group/handled mt-4" data-problem-handled>
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-mute hover:text-ink [&::-webkit-details-marker]:hidden">
            Handled recently ({handledShown.length.toLocaleString("en-US")})
          </summary>
          <ul className="card mt-2 divide-y divide-edge">
            {handledShown.map((s) => {
              const domain = domainOf(s.url);
              const key = `reopen:${s.key}`;
              return (
                <li key={s.key}className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm" data-problem-handled-site={s.url}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="font-semibold break-all">{domain}</p>
                    <p className="text-xs text-mute text-pretty">
                      {plural(s.count, "report")}: {s.reasons.map((r) => r.label).join(", ")} · handled {when(s.handledAt)}
                      {s.handledBy ? ` by ${s.handledBy.replace(/^admin:/, "")}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {errors[key] && (
                      <p className="text-sm text-down" role="alert">
                        {errors[key]}
                      </p>
                    )}
                    <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => act(s, "reopen")} aria-label={`Reopen the reports on ${domain}`} data-problem-reopen>
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      {busy === key ? "Saving..." : "Reopen"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
