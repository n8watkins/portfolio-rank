"use client";

import { useEffect, useState } from "react";
import type { Inspection } from "@/app/api/inspect/route";
import type { PsiResult } from "@/app/api/psi/route";
import type { CacheMeta } from "@/lib/cache";
import { useClientSession } from "@/lib/session-client";
import { GH_PATH, LI_PATH, SocialIcon, X_PATH } from "@/components/ui/social-icons";

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

/**
 * When a result was measured (lib/freshness.mjs), and "updating in the
 * background" while a due result runs again.
 */
function MeasuredOn({ meta }: { meta: CacheMeta }) {
  const { measuredAt, stale } = meta;
  if (!measuredAt) return null;
  const d = new Date(measuredAt);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <p className="mt-3 text-xs text-mute">
      Measured on{" "}
      <time dateTime={measuredAt}>{d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>
      {stale ? " · updating in the background" : ""}
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
 * retry() asks again.
 */
function useJson<T>(endpoint: string, { initial = null }: { initial?: T | null } = {}): { data: T | null; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${endpoint}`;
  const [result, setResult] = useState<{ key: string; data: T } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(endpoint)
      .then((r) => r.json())
      .then((d) => live && setResult({ key, data: d }))
      .catch(() => live && setResult({ key, data: FAILED as T }));
    return () => {
      live = false;
    };
  }, [endpoint, key]);
  const data = result?.key === key ? result.data : attempt === 0 ? initial : null;
  return { data, retry: () => setAttempt((a) => a + 1) };
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
  const { data: inspect, retry: retryInspect } = useJson<Inspection>(`/api/inspect?url=${encodeURIComponent(url)}`, { initial: initialInspection });
  const { data: psi, retry: retryPsi } = useJson<PsiResult>(`/api/psi?url=${encodeURIComponent(url)}`);
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
