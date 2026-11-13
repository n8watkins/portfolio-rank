"use client";

import { useEffect, useState } from "react";
import type { Inspection } from "@/app/api/inspect/route";
import type { PsiResult } from "@/app/api/psi/route";
import type { CacheMeta } from "@/lib/cache";
import { FRESHNESS_UI } from "@/lib/freshness-flag";
import { useClientSession } from "@/lib/session-client";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Check({ pass, label }: { pass: boolean | undefined; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className={pass ? "text-green-400" : "text-red-400"}>
        {pass ? "✓" : "✗"}
      </span>
      <span className={pass ? "" : "text-mute"}>{label}</span>
    </li>
  );
}

function scoreColor(s: number | null | undefined) {
  if (s == null) return "text-mute";
  if (s >= 90) return "text-green-400";
  if (s >= 50) return "text-accent";
  return "text-red-400";
}

/** "Nov 3", with the year when it isn't this year's. */
function shortDate(d: Date) {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * How fresh a result is (lib/freshness.mjs): "Measured Nov 11 · site
 * unchanged since" when a later check found the page the same, and
 * "Re-measuring, the site changed" while a due result runs again.
 */
function MeasuredOn({ meta }: { meta: CacheMeta }) {
  const { measuredAt, stale, staleReason, unchangedSince } = meta;
  if (!measuredAt) return null;
  const d = new Date(measuredAt);
  if (Number.isNaN(d.getTime())) return null;
  // Until FRESHNESS_ENABLED (lib/freshness-flag.ts): the line as it was.
  if (!FRESHNESS_UI) {
    return (
      <p className="mt-3 text-xs text-mute">
        Measured on{" "}
        <time dateTime={measuredAt}>{d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>
        {stale ? " · updating in the background" : ""}
      </p>
    );
  }
  const when = <time dateTime={measuredAt}>{shortDate(d)}</time>;
  if (stale) {
    return (
      <p className="mt-3 text-xs text-mute" role="status">
        {staleReason === "changed" ? "Re-measuring, the site changed" : "Re-measuring"} · last measured {when}
      </p>
    );
  }
  const checked = unchangedSince ? new Date(unchangedSince) : null;
  return (
    <p className="mt-3 text-xs text-mute">
      Measured {when}
      {checked && !Number.isNaN(checked.getTime()) && (
        <span title={`Checked again ${shortDate(checked)}: no changes`}> · site unchanged since</span>
      )}
    </p>
  );
}

const PSI_LABELS: Record<string, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

const FAILED = { ok: false, error: "failed" } as const;

/**
 * GETs a JSON endpoint; until the answer for this endpoint (and attempt)
 * arrives, `initial` (what the server had cached, so the first paint already
 * has the right shape) or null, so switching URLs never shows the previous
 * site's result.
 * retry() asks again. With `pollStaleMs`, a result that is being measured
 * again (`stale`) is asked for again after that long, a few times, so the
 * new result replaces "Re-measuring" without a reload.
 */
const STALE_POLLS = 4;
function useJson<T>(endpoint: string, { initial = null, pollStaleMs }: { initial?: T | null; pollStaleMs?: number } = {}): { data: T | null; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${endpoint}`;
  const [result, setResult] = useState<{ key: string; data: T; polls: number } | null>(null);
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(endpoint)
      .then((r) => r.json())
      .then((d) => live && setResult({ key, data: d, polls }))
      .catch(() => live && setResult({ key, data: FAILED as T, polls }));
    return () => {
      live = false;
    };
  }, [endpoint, key, polls]);
  const data = result?.key === key ? result.data : attempt === 0 ? initial : null;
  const stale = Boolean((data as CacheMeta | null)?.stale);
  useEffect(() => {
    if (!pollStaleMs || !stale || polls >= STALE_POLLS) return;
    const t = setTimeout(() => setPolls((p) => p + 1), pollStaleMs);
    return () => clearTimeout(t);
  }, [pollStaleMs, stale, polls, key]);
  return {
    data,
    retry: () => {
      setPolls(0);
      setAttempt((a) => a + 1);
    },
  };
}

export function useInspection(url: string, initial: Inspection | null = null) {
  return useJson<Inspection>(`/api/inspect?url=${encodeURIComponent(url)}`, { initial }).data;
}

/** Compact one-line chips for the face-off cards. */
export function InspectChips({ url }: { url: string }) {
  const data = useInspection(url);
  if (!data) {
    return <p className="text-xs text-mute">checking page…</p>;
  }
  if (!data.ok) {
    return <p className="text-xs text-red-400">site unreachable ✗</p>;
  }
  const chip = (pass: boolean | undefined, label: string) => (
    <span className={pass ? "text-green-400" : "text-mute line-through"}>
      {label}
    </span>
  );
  return (
    <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
      {chip(data.https, "https")}
      {chip(data.customDomain, "custom domain")}
      {chip(data.ogImageLoads, "share card")}
      {chip(data.favicon, "favicon")}
    </p>
  );
}

const GH_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";
const LI_PATH =
  "M13.6 13.6h-2.37V9.9c0-.88-.02-2.02-1.23-2.02-1.23 0-1.42.96-1.42 1.96v3.76H6.2V6h2.28v1.04h.03c.32-.6 1.1-1.23 2.26-1.23 2.4 0 2.85 1.58 2.85 3.64v4.15zM3.56 4.96a1.38 1.38 0 110-2.76 1.38 1.38 0 010 2.76zM4.75 13.6H2.37V6h2.38v7.6zM14.78 0H1.2C.54 0 0 .53 0 1.18v13.64C0 15.47.54 16 1.2 16h13.58c.66 0 1.22-.53 1.22-1.18V1.18C16 .53 15.44 0 14.78 0z";
const X_PATH =
  "M12.6 0h2.45l-5.36 6.12L16 16h-4.93l-3.86-5.05L2.7 16H.25l5.73-6.55L0 0h5.06l3.49 4.61L12.6 0zm-.86 14.54h1.36L4.32 1.39H2.86l8.88 13.15z";

function SocialIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
      <path d={path} />
    </svg>
  );
}

// Social profile buttons (GitHub / LinkedIn / X) scraped from the portfolio page
// - reach someone's profiles without opening their site. Renders nothing if none.
export function Socials({ url, initial = null }: { url: string; initial?: Inspection | null }) {
  const data = useInspection(url, initial);
  if (!data?.ok) return null;
  const links: { href: string; label: string; path: string }[] = [];
  if (data.githubUrl)
    links.push({
      href: data.githubUrl,
      label: data.githubUrl.replace(/^https?:\/\/github\.com\//, "@"),
      path: GH_PATH,
    });
  if (data.linkedinUrl)
    links.push({ href: data.linkedinUrl, label: "LinkedIn", path: LI_PATH });
  if (data.xUrl)
    links.push({
      href: data.xUrl,
      label: data.xUrl.replace(/^https?:\/\/x\.com\//, "@"),
      path: X_PATH,
    });
  if (!links.length) return null;
  return (
    <>
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm font-semibold transition hover:border-mute"
          title={l.href}
        >
          <SocialIcon path={l.path} />
          <span className="hidden sm:inline">{l.label}</span>
        </a>
      ))}
    </>
  );
}

/** What a PageSpeed failure means for the visitor, and whether trying again can help. */
function psiProblem(error: string | undefined): { text: string; retry: boolean } {
  if (error === "site_down") return { text: "This site is down or parked, so there's nothing to measure.", retry: false };
  if (error === "in_progress") return { text: "Lighthouse is already running for this site. Try again in a minute.", retry: true };
  if (error === "timeout") return { text: "Google's Lighthouse timed out on this site.", retry: true };
  if (/429|quota|rate/i.test(error ?? "")) return { text: "Google's Lighthouse quota is used up for now. Try again later.", retry: true };
  return { text: "Lighthouse couldn't analyze this site right now.", retry: true };
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 min-h-11 rounded-lg border border-edge px-4 text-sm font-semibold text-ink transition hover:border-mute"
    >
      Retry
    </button>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert">
      <p className="text-sm text-red-400">Couldn&apos;t reach the site.</p>
      <RetryButton onClick={onRetry} />
    </div>
  );
}

/** The share card preview; falls back to a note when the image won't load here. */
function ShareImage({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex aspect-[1.91/1] w-full items-center justify-center bg-edge px-4 text-center text-xs text-ink">
        The share image exists, but its host doesn&apos;t let it show here.
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Social share preview"
      loading="lazy"
      onError={() => setBroken(true)}
      className="aspect-[1.91/1] w-full bg-edge object-cover"
    />
  );
}

/**
 * Placeholders that take the space the loaded results will, so the profile
 * doesn't move when they arrive (mobile CLS). Hidden from screen readers;
 * each section says "Checking…" to them instead.
 */
const bar = "rounded bg-edge motion-safe:animate-pulse";
const POLISH_WIDTHS = ["w-32", "w-28", "w-36", "w-20", "w-32", "w-28", "w-36", "w-24", "w-20"];

function PolishSkeleton() {
  return (
    <>
      <p className="sr-only" role="status">
        Checking…
      </p>
      <ul aria-hidden className="space-y-1.5">
        {POLISH_WIDTHS.map((w, i) => (
          <li key={i} className="flex h-5 items-center gap-2">
            <span className={`h-3.5 w-3.5 ${bar}`} />
            <span className={`h-3.5 ${w} ${bar}`} />
          </li>
        ))}
      </ul>
      {/* The "Measured on" line. */}
      <p aria-hidden className="mt-3 text-xs">
        &nbsp;
      </p>
    </>
  );
}

function ShareSkeleton() {
  return (
    <>
      <p className="sr-only" role="status">
        Checking…
      </p>
      <div aria-hidden className="overflow-hidden rounded-lg border border-edge">
        <div className={`aspect-[1.91/1] w-full ${bar} rounded-none`} />
        <div className="space-y-1.5 border-t border-edge p-3">
          <div className={`h-4 w-3/4 ${bar}`} />
          <div className={`h-3 w-full ${bar}`} />
          <div className={`h-3 w-1/3 ${bar}`} />
        </div>
      </div>
    </>
  );
}

/** Full panel for the detail page. Order: Lighthouse → Polish → Share card. */
export function DetailDiagnostics({ url, initialInspection = null }: { url: string; initialInspection?: Inspection | null }) {
  // With FRESHNESS_ENABLED, a result being measured again is asked for again:
  // a PageSpeed run takes about 30 seconds, the polish check a few.
  const { data: inspect, retry: retryInspect } = useJson<Inspection>(`/api/inspect?url=${encodeURIComponent(url)}`, { initial: initialInspection, pollStaleMs: FRESHNESS_UI ? 8_000 : undefined });
  const { data: psi, retry: retryPsi } = useJson<PsiResult>(`/api/psi?url=${encodeURIComponent(url)}`, { pollStaleMs: FRESHNESS_UI ? 35_000 : undefined });
  const psiFailure = psi && !psi.ok ? psiProblem(psi.error) : null;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-edge bg-card p-5">
        <h2 className="mb-3 font-semibold">
          Lighthouse{" "}
          <span className="text-xs font-normal text-mute">
            via Google PageSpeed · mobile
          </span>
        </h2>
        {!psi ? (
          <>
            {/* The score grid's shape, so the page doesn't move when the scores arrive. */}
            <div aria-hidden className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(PSI_LABELS).map(([id, label]) => (
                <div key={id} className="rounded-lg border border-edge p-3 text-center">
                  <div className="flex h-8 items-center justify-center">
                    <span className={`h-6 w-10 ${bar}`} />
                  </div>
                  <p className="mt-1 text-xs text-mute">{label}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs text-mute" role="status">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-edge border-t-accent" />
              Running Lighthouse (about 30s)…
            </p>
            {/* The "Measured on" line. */}
            <p aria-hidden className="mt-3 text-xs">
              &nbsp;
            </p>
          </>
        ) : psiFailure ? (
          <div role="alert">
            <p className="text-sm text-red-400">{psiFailure.text}</p>
            {psiFailure.retry && <RetryButton onClick={retryPsi} />}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(PSI_LABELS).map(([id, label]) => (
                <div
                  key={id}
                  className="rounded-lg border border-edge p-3 text-center"
                >
                  <p
                    className={`text-2xl font-bold tabular-nums ${scoreColor(psi.scores?.[id])}`}
                  >
                    {psi.scores?.[id] ?? "-"}
                  </p>
                  <p className="mt-1 text-xs text-mute">{label}</p>
                </div>
              ))}
            </div>
            {psi.metrics && psi.metrics.length > 0 && (
              <p className="mt-3 text-xs text-mute">
                {psi.metrics.map((m) => `${m.label}: ${m.value}`).join(" · ")}
              </p>
            )}
            <MeasuredOn meta={psi} />
          </>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl border border-edge bg-card p-5">
          <h2 className="mb-3 font-semibold">Polish checklist</h2>
          {!inspect ? (
            <PolishSkeleton />
          ) : !inspect.ok ? (
            <Unreachable onRetry={retryInspect} />
          ) : (
            <ul className="space-y-1.5">
              <Check pass={inspect.https} label="Served over HTTPS" />
              <Check pass={inspect.customDomain} label="Custom domain" />
              <Check pass={inspect.ogImageLoads} label="Social share image" />
              <Check pass={inspect.favicon} label="Favicon" />
              <Check pass={!!inspect.description} label="Meta description" />
              {inspect.githubUrl ? (
                <li className="flex items-center gap-2 text-sm">
                  <span className="text-green-400">✓</span>
                  <a
                    href={inspect.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    GitHub:{" "}
                    {inspect.githubUrl.replace(/^https?:\/\/github\.com\//, "@")}
                  </a>
                </li>
              ) : (
                <Check pass={inspect.hasGithubLink} label="Links to GitHub" />
              )}
              <Check pass={inspect.hasResume} label="Resume / CV available" />
              <Check pass={inspect.hasContact} label="Contact path" />
              <Check
                pass={
                  inspect.copyrightYear == null ||
                  inspect.copyrightYear >= new Date().getFullYear() - 1
                }
                label={
                  inspect.copyrightYear
                    ? `Fresh (© ${inspect.copyrightYear})`
                    : "Fresh"
                }
              />
            </ul>
          )}
          {inspect?.ok && <MeasuredOn meta={inspect} />}
        </section>

        <section className="rounded-xl border border-edge bg-card p-5">
          <h2 className="mb-3 font-semibold">Share card</h2>
          {!inspect ? (
            <ShareSkeleton />
          ) : !inspect.ok ? (
            <p className="text-sm text-red-400">Couldn&apos;t reach the site.</p>
          ) : inspect.ogImage && inspect.ogImageLoads ? (
            <div className="overflow-hidden rounded-lg border border-edge">
              <ShareImage key={inspect.ogImage} src={new URL(inspect.ogImage, inspect.finalUrl).href} />
              <div className="border-t border-edge p-3">
                <p className="truncate text-sm font-semibold">
                  {inspect.ogTitle ?? inspect.title}
                </p>
                <p className="line-clamp-2 text-xs text-mute">
                  {inspect.ogDescription ?? inspect.description ?? ""}
                </p>
                <p className="mt-1 text-xs text-mute uppercase">
                  {domainOf(url)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-red-400">
              ✗ No working share card - this link looks bare when posted on
              social media.
            </p>
          )}
        </section>
      </div>
      <Remeasure
        url={url}
        onDone={() => {
          retryPsi();
          retryInspect();
        }}
      />
    </div>
  );
}

/**
 * The admin's "Re-measure" (app/api/admin/remeasure): every check of the
 * site runs again, Lighthouse and polish now, the screenshots and link
 * checks tonight. Shown only once the server confirms the admin; signed-out
 * visitors never ask.
 */
function Remeasure({ url, onDone }: { url: string; onDone: () => void }) {
  const session = useClientSession();
  const signedIn = session !== "loading" && session !== null;
  const endpoint = `/api/admin/remeasure?url=${encodeURIComponent(url)}`;
  const [state, setState] = useState<{ url: string; forcedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { forcedAt: string | null } | null) => live && d && setState({ url, forcedAt: d.forcedAt }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signedIn, endpoint, url]);
  if (!state || state.url !== url) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/remeasure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const d = (await r.json().catch(() => ({}))) as { forcedAt?: string; error?: string };
      if (!r.ok || !d.forcedAt) throw new Error(d.error ?? `http_${r.status}`);
      setState({ url, forcedAt: d.forcedAt });
      onDone();
    } catch (e) {
      setError(`Couldn't ask for it (${(e as Error).message}).`);
    } finally {
      setBusy(false);
    }
  };
  const asked = state.forcedAt ? new Date(state.forcedAt) : null;
  return (
    <section aria-label="Admin" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-edge p-4">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="min-h-11 rounded-lg border border-edge px-4 text-sm font-semibold text-ink transition hover:border-mute disabled:opacity-60"
      >
        {busy ? "Asking…" : "Re-measure"}
      </button>
      <p className="min-w-0 flex-1 text-xs text-mute">
        Admin: runs Lighthouse and the polish check again now; the screenshots and link checks tonight.
        {asked && !Number.isNaN(asked.getTime()) && (
          <>
            {" "}
            Last asked <time dateTime={state.forcedAt!}>{asked.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>.
          </>
        )}
      </p>
      {error && (
        <p role="alert" className="w-full text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
