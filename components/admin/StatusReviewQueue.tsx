"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck, ChevronDown, CircleAlert, ClipboardCheck, ExternalLink, X } from "lucide-react";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChipButton, tag } from "@/components/ui/Chip";
import { btnGhost, btnPrimary, btnSecondary } from "@/components/ui/styles";
import { frameOf } from "@/lib/shot-url";
import { ShotViewer, type ViewerFrame } from "@/components/admin/ShotViewer";

// The owner's review queue (app/admin/(tools)/review/page.tsx): one card per
// proposed status change, with a tick box. Rows where the graders agree come
// ticked; a disagreement is flagged and starts unticked. "Confirm all where
// everyone agrees" (or "Confirm N ticked" once the ticks change) applies the
// ticked rows after a second click; each row also has Confirm and Reject.
// Either thumbnail opens the large viewer (./ShotViewer.tsx) with the whole
// capture and the same Confirm and Reject. Decisions go to POST
// /api/admin/review.

type Verdict = { is_portfolio: boolean; reason?: string; scores?: { visual_design?: number; project_presentation?: number; writing?: number } } | null;
type Grader = { batch?: Verdict; solo?: Verdict };
export type Review = {
  id: number;
  batch: string;
  url: string;
  group: string;
  current: string;
  /** review: the capture was blocked, so no grader saw the site; a person looks and nothing is applied. */
  proposed: "relist" | "remove" | "review";
  agreed: boolean;
  reason: string | null;
  offList: boolean;
  shotKey: string | null;
  /** prompt: the grading prompt's version (absent on rows written before it was recorded). */
  verdicts: { gemini31?: Grader; haiku?: Grader; prompt?: string };
  signals: { score?: number; names?: string[]; junk_rule?: string | null; capture?: { action?: string | null; blocked?: string | null; failed?: string | null } } | null;
  status: string;
  decidedAt: string | null;
  decidedBy: string | null;
  applied: { grade?: string; visibility?: string[]; feed?: string | null; error?: string; rejected?: boolean; action?: "none" } | null;
  createdAt: string;
};

const GROUPS: Record<string, string> = {
  not_portfolio: "Graded not a portfolio",
  delisted_graded: "Delisted after grading",
  delisted_ungraded: "Delisted before grading",
  broken: "Broken or dead, never graded",
  live_ungraded: "Live, not graded yet",
};
const CURRENT: Record<string, string> = { ranked: "Listed and ranked", listed: "Listed, not ranked", hidden: "Hidden", delisted: "Off the list" };
const PROPOSED = { relist: "List and rank it", remove: "Take it off the list", review: "A person checks it" } as const;
const TONE = { relist: "text-up", remove: "text-down", review: "text-ink" } as const;
const GRADERS = [
  ["gemini31", "Gemini 3.1"],
  ["haiku", "Haiku 5.5"],
] as const;
const SIGNALS = 6;
const CHUNK = 200;
// The static tag in a colour (its own text colour replaces the tag's muted one, which would win otherwise).
const tagDown = `${tag.replace("text-mute", "")} text-down ring-down/40`;
const tagUp = `${tag.replace("text-mute", "")} text-up`;
// A thumbnail that opens the large viewer.
const thumb =
  "block cursor-zoom-in overflow-hidden rounded-lg ring-1 ring-edge transition hover:ring-edge-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const ERRORS: Record<string, string> = {
  signin_required: "Your session ended. Sign in again.",
  forbidden: "Only the admin can decide reviews.",
  bad_origin: "That request came from another site.",
  bad_request: "That request wasn't understood. Reload and try again.",
  wrong_status: "Someone decided this row in the meantime.",
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

function VerdictCell({ v }: { v: Verdict | undefined }) {
  if (!v) return <span className="text-mute">not run</span>;
  const s = v.scores ?? {};
  const scores = [s.visual_design, s.project_presentation, s.writing];
  const hasScores = scores.some((x) => typeof x === "number");
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className={`inline-flex items-center gap-1 font-semibold ${v.is_portfolio ? "text-up" : "text-down"}`}>
        {v.is_portfolio ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <X className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        {v.is_portfolio ? "Portfolio" : "Not a portfolio"}
      </span>
      {hasScores && (
        <span className="text-xs tabular-nums text-mute" title="Visual design, project presentation and writing, 1 to 5">
          {scores.map((x) => (typeof x === "number" ? x : "-")).join(" · ")}
        </span>
      )}
    </span>
  );
}

function Verdicts({ r }: { r: Review }) {
  const reasons = GRADERS.flatMap(([key, label]) =>
    (["batch", "solo"] as const).flatMap((mode) => {
      const v = r.verdicts[key]?.[mode];
      return v?.reason ? [{ who: `${label}, ${mode === "batch" ? "batched" : "one at a time"}`, v }] : [];
    })
  );
  return (
    <div className="min-w-0">
      <table className="w-full max-w-[34rem] text-left text-sm">
        <caption className="sr-only">Each grader&rsquo;s verdict, batched and one at a time</caption>
        <thead>
          <tr className="text-xs text-mute">
            <th scope="col" className="w-[6.5rem] pb-1 font-medium">
              Grader
            </th>
            <th scope="col" className="pb-1 font-medium">
              Batched
            </th>
            <th scope="col" className="pb-1 font-medium">
              One at a time
            </th>
          </tr>
        </thead>
        <tbody>
          {GRADERS.map(([key, label]) => (
            <tr key={key} className="border-t border-edge align-baseline">
              <th scope="row" className="py-1.5 pr-2 font-semibold whitespace-nowrap">
                {label}
              </th>
              <td className="py-1.5 pr-2">
                <VerdictCell v={r.verdicts[key]?.batch} />
              </td>
              <td className="py-1.5">
                <VerdictCell v={r.verdicts[key]?.solo} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.verdicts.prompt && (
        <p className="mt-1 text-xs text-mute" data-review-prompt>
          Graded with prompt <span className="font-mono text-ink">{r.verdicts.prompt}</span>
        </p>
      )}
      {reasons.length > 0 && (
        <details className="group/why mt-1">
          <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-mute hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-4 w-4 transition group-open/why:rotate-180" aria-hidden /> Why each grader decided
          </summary>
          <ul className="mt-1 grid gap-1.5 text-sm">
            {reasons.map(({ who, v }) => (
              <li key={who}>
                <span className="font-semibold">{who}:</span> <span className="text-mute">{v!.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Signals({ s }: { s: Review["signals"] }) {
  if (!s) return null;
  const failed = s.capture?.failed;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      {typeof s.score === "number" && (
        <p>
          <span className="font-semibold">
            Code signals {s.score} of {SIGNALS}
          </span>
          {s.names && s.names.length > 0 && <span className="text-mute">: {s.names.join(", ")}</span>}
        </p>
      )}
      {s.junk_rule && <span className={tagDown}>Junk rule: {s.junk_rule}</span>}
      {failed && <span className={tagDown}>Capture failed: {failed}</span>}
    </div>
  );
}

function Row({
  r,
  shotsBase,
  ticked,
  onTick,
  busy,
  error,
  onDecide,
  onView,
}: {
  r: Review;
  shotsBase: string | null;
  ticked: boolean;
  onTick: (on: boolean) => void;
  busy: boolean;
  error: string | null;
  onDecide: (action: "confirm" | "reject") => void;
  onView: (frame: ViewerFrame, from: HTMLElement) => void;
}) {
  const domain = domainOf(r.url);
  const base = shotsBase && r.shotKey ? `${shotsBase.replace(/\/+$/, "")}/${r.shotKey}` : null;
  const box = `review-${r.id}`;
  const action = r.signals?.capture?.action ?? null;
  const blocked = r.signals?.capture?.blocked ?? null;
  return (
    <li className={`card p-4 sm:p-5 ${r.agreed ? "" : "ring-1 ring-inset ring-down/35"}`} data-review-row={r.id} data-agreed={r.agreed ? "true" : "false"}>
      <div className="flex items-start gap-3">
        <label htmlFor={box} className="-m-2.5 grid h-11 w-11 shrink-0 cursor-pointer place-items-center">
          <input id={box} type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} className="h-5 w-5 cursor-pointer accent-[var(--color-fill)]" />
          <span className="sr-only">Include {domain}</span>
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-base font-bold break-all hover:text-accent">
              {domain}
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-mute" aria-hidden />
            </a>
            {blocked ? (
              <span className={`${tagDown} font-semibold`}>
                <CircleAlert className="h-3.5 w-3.5" aria-hidden /> Capture blocked
              </span>
            ) : r.agreed ? (
              <span className={tagUp}>
                <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Graders agree
              </span>
            ) : (
              <span className={`${tagDown} font-semibold`}>
                <CircleAlert className="h-3.5 w-3.5" aria-hidden /> Graders disagree
              </span>
            )}
            <span className={tag}>{GROUPS[r.group] ?? r.group}</span>
            {r.offList && <span className={tag}>No longer on the community list</span>}
          </div>
          <p className="mt-1.5 text-sm">
            <span className="text-mute">Now:</span> {CURRENT[r.current] ?? r.current} <span className="text-mute">→ Proposed:</span>{" "}
            <span className={`font-semibold ${TONE[r.proposed]}`}>{PROPOSED[r.proposed]}</span>{" "}
            <span className="text-mute">· pending</span>
          </p>

          <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <figure className="min-w-0">
              <div className="relative flex items-end gap-2.5">
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`View the whole desktop screenshot of ${domain}`}
                  onClick={(e) => onView("desktop", e.currentTarget)}
                  className={`${thumb} min-w-0 flex-1`}
                  data-review-thumb="desktop"
                >
                  <ScreenshotFrame src={base ? frameOf(base, "hero.jpg") : null} alt="" domain={domain} />
                </button>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`View the whole phone screenshot of ${domain}`}
                  onClick={(e) => onView("phone", e.currentTarget)}
                  className={`${thumb} w-[22%] max-w-[5.25rem] shrink-0`}
                  data-review-thumb="phone"
                >
                  <ScreenshotFrame src={base ? frameOf(base, "mobile.jpg") : null} alt="" domain={domain} kind="mobile" />
                </button>
                {blocked && (
                  <p className="pointer-events-none absolute inset-x-2 top-2 rounded-md bg-card/95 px-2.5 py-1.5 text-xs font-semibold text-down shadow-[var(--card-drop)] ring-1 ring-down/40" data-review-blocked>
                    Capture blocked: {blocked}
                  </p>
                )}
              </div>
              {action && (
                <figcaption className="mt-2 text-xs text-mute text-pretty" data-review-action>
                  Before the screenshot: <span className="text-ink">{action}</span>
                </figcaption>
              )}
            </figure>
            <div className="grid min-w-0 content-start gap-3">
              {r.reason && <p className="text-sm text-pretty">{r.reason}</p>}
              {blocked ? <p className="text-sm text-mute">Not graded: no grader saw the site, since the capture never got past the gate.</p> : <Verdicts r={r} />}
              <Signals s={r.signals} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
            <button type="button" className={btnSecondary} disabled={busy} onClick={() => onDecide("confirm")} data-review-confirm>
              <Check className="h-4 w-4" aria-hidden /> {r.proposed === "review" ? "Mark checked" : "Confirm"}
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => onDecide("reject")} data-review-reject>
              <X className="h-4 w-4" aria-hidden /> Reject
            </button>
            {r.applied?.error && !error && <p className="text-sm text-down">The last try failed: {r.applied.error}</p>}
            {error && (
              <p className="text-sm text-down" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function Decided({ rows }: { rows: Review[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="group/decided mt-8" data-review-decided>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-lg font-bold tracking-tight [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-5 w-5 text-mute transition group-open/decided:rotate-180" aria-hidden /> Decided ({rows.length.toLocaleString("en-US")})
      </summary>
      <ul className="card mt-3 divide-y divide-edge">
        {rows.map((r) => (
          <li key={r.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:gap-4" data-review-decided-row={r.id}>
            <div className="min-w-0">
              <p className="font-semibold break-all">{domainOf(r.url)}</p>
              <p className="text-xs text-mute">
                <span className={r.status === "confirmed" ? "font-semibold text-up" : "font-semibold"}>{r.status === "rejected" ? "Rejected" : r.proposed === "review" ? "Checked" : "Confirmed"}</span>
                {" · "}
                {PROPOSED[r.proposed]}
                {r.decidedBy && ` · ${r.decidedBy.replace(/^admin:/, "")}`}
                {r.decidedAt && `, ${when(r.decidedAt)}`}
              </p>
            </div>
            <p className="text-mute text-pretty">
              {r.status === "rejected"
                ? "Nothing changed."
                : r.applied && "action" in r.applied
                  ? "Marked checked; nothing to apply."
                  : r.applied?.visibility?.length
                    ? r.applied.visibility.join("; ") + "."
                    : "Recorded; the grade already matched."}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

type Filter = "all" | "agreed" | "flagged";

export function StatusReviewQueue({ pending, decided, shotsBase }: { pending: Review[]; decided: Review[]; shotsBase: string | null }) {
  const router = useRouter();
  const agreedIds = useMemo(() => pending.filter((r) => r.agreed).map((r) => r.id), [pending]);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(agreedIds));
  const [filter, setFilter] = useState<Filter>("all");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<Record<number, "confirm" | "reject">>({});
  // The large viewer: the row (kept as it was, so a decided row stays on screen until closed), the view and its thumbnail.
  const [viewing, setViewing] = useState<{ review: Review; frame: ViewerFrame; from: HTMLElement } | null>(null);

  const live = pending.filter((r) => ticked.has(r.id));
  const onlyAgreed = live.length === agreedIds.length && live.every((r) => r.agreed);
  const shown = pending.filter((r) => (filter === "agreed" ? r.agreed : filter === "flagged" ? !r.agreed : true));
  const flagged = pending.length - agreedIds.length;

  async function decide(ids: number[], action: "confirm" | "reject") {
    setBusy((b) => new Set([...b, ...ids]));
    setNotice(null);
    const failed: Record<number, string> = {};
    const okIds: number[] = [];
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        const res = await fetch("/api/admin/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: part, action }) });
        const body = (await res.json().catch(() => ({}))) as { error?: string; results?: { id: number; ok: boolean; error?: string }[] };
        if (!res.ok) {
          for (const id of part) failed[id] = ERRORS[body.error ?? ""] ?? "That didn't work. Try again.";
          continue;
        }
        for (const r of body.results ?? []) {
          if (r.ok) okIds.push(r.id);
          else failed[r.id] = ERRORS[r.error ?? ""] ?? `It didn't apply: ${r.error}`;
        }
      }
    } catch {
      for (const id of ids) failed[id] ??= "The connection failed. Try again.";
    }
    setErrors((e) => {
      const next = { ...e };
      for (const id of ids) delete next[id];
      return { ...next, ...failed };
    });
    setTicked((t) => new Set([...t].filter((id) => !ids.includes(id) || failed[id])));
    setBusy((b) => new Set([...b].filter((id) => !ids.includes(id))));
    setDone((d) => ({ ...d, ...Object.fromEntries(okIds.map((id) => [id, action])) }));
    setAsking(false);
    if (ids.length > 1) setNotice(`${okIds.length.toLocaleString("en-US")} ${action === "confirm" ? "confirmed" : "rejected"}${Object.keys(failed).length ? `, ${Object.keys(failed).length} failed (marked below)` : ""}.`);
    router.refresh();
  }

  // Kept open over the empty state too, so deciding the last row in the viewer shows its done state.
  const viewer = viewing && (
    <ShotViewer
      key={`${viewing.review.id}-${viewing.frame}`}
      domain={domainOf(viewing.review.url)}
      url={viewing.review.url}
      base={shotsBase && viewing.review.shotKey ? `${shotsBase.replace(/\/+$/, "")}/${viewing.review.shotKey}` : null}
      frame={viewing.frame}
      proposed={viewing.review.proposed}
      busy={busy.has(viewing.review.id)}
      error={errors[viewing.review.id] ?? null}
      done={done[viewing.review.id] ?? null}
      onDecide={(action) => decide([viewing.review.id], action)}
      onClose={() => setViewing(null)}
      returnFocus={viewing.from}
      prompt={viewing.review.verdicts.prompt ?? null}
    />
  );

  if (pending.length === 0)
    return (
      <>
        <EmptyState icon={ClipboardCheck} title="Nothing to review">
          When a re-check proposes status changes, they wait here for you.
        </EmptyState>
        <Decided rows={decided} />
        {viewer}
      </>
    );

  return (
    <>
      <div className="card flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-3 sm:p-4" data-review-toolbar>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          <ChipButton pressed={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="tabular-nums text-mute">{pending.length}</span>
          </ChipButton>
          <ChipButton pressed={filter === "agreed"} onClick={() => setFilter("agreed")}>
            Graders agree <span className="tabular-nums text-mute">{agreedIds.length}</span>
          </ChipButton>
          <ChipButton pressed={filter === "flagged"} onClick={() => setFilter("flagged")}>
            Disagreements <span className="tabular-nums text-mute">{flagged}</span>
          </ChipButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {asking ? (
            <>
              <button type="button" className={btnPrimary} onClick={() => decide(live.map((r) => r.id), "confirm")} disabled={busy.size > 0} data-review-bulk-yes>
                <CheckCheck className="h-4 w-4" aria-hidden /> Yes, apply {live.length.toLocaleString("en-US")} {live.length === 1 ? "change" : "changes"}
              </button>
              <button type="button" className={btnGhost} onClick={() => setAsking(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {!onlyAgreed && agreedIds.length > 0 && (
                <button type="button" className={btnGhost} onClick={() => setTicked(new Set(agreedIds))}>
                  Tick where graders agree
                </button>
              )}
              <button type="button" className={btnPrimary} disabled={live.length === 0 || busy.size > 0} onClick={() => setAsking(true)} data-review-bulk>
                <CheckCheck className="h-4 w-4" aria-hidden />
                {onlyAgreed ? (
                  <>
                    {/* The long label on one line from the small breakpoint up; the short one on a phone. */}
                    <span className="hidden sm:inline">Confirm all where everyone agrees ({live.length.toLocaleString("en-US")})</span>
                    <span className="sm:hidden">Confirm all agreed ({live.length.toLocaleString("en-US")})</span>
                  </>
                ) : (
                  `Confirm ${live.length.toLocaleString("en-US")} ticked`
                )}
              </button>
            </>
          )}
        </div>
      </div>
      {notice && (
        <p className="mt-3 text-sm" role="status">
          {notice}
        </p>
      )}
      <ul className="mt-4 grid gap-4" data-review-list>
        {shown.map((r) => (
          <Row
            key={r.id}
            r={r}
            shotsBase={shotsBase}
            ticked={ticked.has(r.id)}
            onTick={(on) =>
              setTicked((t) => {
                const next = new Set(t);
                if (on) next.add(r.id);
                else next.delete(r.id);
                return next;
              })
            }
            busy={busy.has(r.id)}
            error={errors[r.id] ?? null}
            onDecide={(action) => decide([r.id], action)}
            onView={(frame, from) => setViewing({ review: r, frame, from })}
          />
        ))}
      </ul>
      <Decided rows={decided} />
      {viewer}
    </>
  );
}
