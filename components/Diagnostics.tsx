"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Cloud, FolderGit2, Gauge, Layers, Moon, Newspaper, Smartphone, Weight, type LucideIcon } from "lucide-react";
import { GitHubMark } from "@/components/ui/GitHubMark";
import type { Inspection } from "@/app/api/inspect/route";
import type { PsiResult } from "@/app/api/psi/route";

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

/** "Measured on Nov 3, 2026", plus "· updating" while a stale result refreshes. */
function MeasuredOn({ at, stale }: { at?: string; stale?: boolean }) {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <p className="mt-3 text-xs text-mute">
      Measured on{" "}
      <time dateTime={at}>
        {d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
      </time>
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
 * GETs a JSON endpoint; null until the answer for this endpoint (and attempt)
 * arrives, so switching URLs never shows the previous site's result.
 * retry() asks again.
 */
// First loads are shared by every component on the page that asks for the
// same endpoint (the games draw one site's data in two places); a retry
// always asks again.
const firstLoads = new Map<string, Promise<unknown>>();
function getJson(endpoint: string, attempt: number): Promise<unknown> {
  if (attempt > 0) return fetch(endpoint).then((r) => r.json());
  let p = firstLoads.get(endpoint);
  if (!p) {
    p = fetch(endpoint).then((r) => r.json());
    p.catch(() => firstLoads.delete(endpoint));
    firstLoads.set(endpoint, p);
  }
  return p;
}

function useJson<T>(endpoint: string): { data: T | null; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${endpoint}`;
  const [result, setResult] = useState<{ key: string; data: T } | null>(null);
  useEffect(() => {
    let live = true;
    getJson(endpoint, attempt)
      .then((d) => d as T)
      .then((d) => live && setResult({ key, data: d }))
      .catch(() => live && setResult({ key, data: FAILED as T }));
    return () => {
      live = false;
    };
  }, [endpoint, key, attempt]);
  return {
    data: result?.key === key ? result.data : null,
    retry: () => setAttempt((a) => a + 1),
  };
}

export function useInspection(url: string) {
  return useJson<Inspection>(`/api/inspect?url=${encodeURIComponent(url)}`).data;
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
export function Socials({ url }: { url: string }) {
  const data = useInspection(url);
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

/**
 * The person's GitHub, LinkedIn and X as small icon links (the games' name
 * line): the profiles the polish fetch found on the page or its /about page
 * (/api/inspect), nothing looked up elsewhere. Nothing while loading or when
 * none were found.
 */
export function SocialIcons({ url, name }: { url: string; name: string }) {
  const data = useInspection(url);
  if (!data?.ok) return null;
  const links = [
    data.githubUrl && { href: data.githubUrl, label: `${name} on GitHub (${data.githubUrl.replace(/^https?:\/\/github\.com\//, "@")})`, path: GH_PATH },
    data.linkedinUrl && { href: data.linkedinUrl, label: `${name} on LinkedIn`, path: LI_PATH },
    data.xUrl && { href: data.xUrl, label: `${name} on X (${data.xUrl.replace(/^https?:\/\/x\.com\//, "@")})`, path: X_PATH },
  ].filter(Boolean) as { href: string; label: string; path: string }[];
  if (!links.length) return null;
  return (
    <span className="details-in inline-flex items-center gap-0.5">
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          title={l.label}
          aria-label={`${l.label} (opens in a new tab)`}
          className="grid h-9 w-9 place-items-center rounded-lg text-mute transition hover:bg-raised hover:text-ink"
        >
          <SocialIcon path={l.path} />
        </a>
      ))}
    </span>
  );
}

/** What a PageSpeed failure means for the visitor, and whether trying again can help. */
function psiProblem(error: string | undefined): { text: string; retry: boolean } {
  if (error === "site_down") return { text: "This site is down or parked, so there's nothing to measure.", retry: false };
  if (error === "in_progress") return { text: "Lighthouse is already running for this site. Try again in a minute.", retry: true };
  if (error === "timeout") return { text: "Google's Lighthouse timed out on this site.", retry: true };
  if (/429|quota|rate/i.test(error ?? "")) return { text: "Google's Lighthouse quota is used up for now. Try again later.", retry: true };
  if (/capacity|unavailable|503/i.test(error ?? "")) return { text: "Google's Lighthouse is busy right now. Try again in a little while.", retry: true };
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
function ShareImage({ src, compact = false }: { src: string; compact?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className={`flex aspect-[1.91/1] w-full items-center justify-center bg-edge text-center text-ink ${compact ? "px-1 text-[10px]" : "px-4 text-xs"}`}>
        {compact ? "Its host blocks showing it here." : "The share image exists, but its host doesn't let it show here."}
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

/** Full panel for the detail page. Order: Lighthouse → Polish → Share card. */
export function DetailDiagnostics({ url }: { url: string }) {
  const { data: inspect, retry: retryInspect } = useJson<Inspection>(`/api/inspect?url=${encodeURIComponent(url)}`);
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
          <p className="flex items-center gap-2 text-sm text-mute">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-accent" />
            Running Lighthouse on Google&apos;s servers - first run takes ~30s…
          </p>
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
            <MeasuredOn at={psi.measuredAt} stale={psi.stale} />
          </>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl border border-edge bg-card p-5">
          <h2 className="mb-3 font-semibold">Polish checklist</h2>
          {!inspect ? (
            <p className="text-sm text-mute">Checking…</p>
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
          {inspect?.ok && <MeasuredOn at={inspect.measuredAt} stale={inspect.stale} />}
        </section>

        <section className="rounded-xl border border-edge bg-card p-5">
          <h2 className="mb-3 font-semibold">Share card</h2>
          {!inspect ? (
            <p className="text-sm text-mute">Checking…</p>
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
    </div>
  );
}

/** The polish checklist's lines (shared by the portfolio page and the games). */
function polishLines(inspect: Inspection & { ok: true }): { label: string; pass: boolean | undefined }[] {
  const year = new Date().getFullYear();
  return [
    { label: "HTTPS", pass: inspect.https },
    { label: "Custom domain", pass: inspect.customDomain },
    { label: "Share image", pass: inspect.ogImageLoads },
    { label: "Favicon", pass: inspect.favicon },
    { label: "Meta description", pass: !!inspect.description },
    { label: "Links to GitHub", pass: !!inspect.githubUrl || inspect.hasGithubLink },
    { label: "Resume / CV", pass: inspect.hasResume },
    { label: "Contact path", pass: inspect.hasContact },
    { label: inspect.copyrightYear ? `Fresh (© ${inspect.copyrightYear})` : "Fresh", pass: inspect.copyrightYear == null || inspect.copyrightYear >= year - 1 },
  ];
}

const PLAY_PSI: [string, string][] = [
  ["performance", "Perf."],
  ["accessibility", "Access."],
  ["best-practices", "Best pr."],
  ["seo", "SEO"],
];

function PlayLabel({ children }: { children: React.ReactNode }) {
  return <h5 className="text-xs font-semibold tracking-wider text-mute uppercase">{children}</h5>;
}

/** A placeholder in the shape of what loads; it shimmers only when motion is welcome. */
function Placeholder({ className }: { className: string }) {
  return <div aria-hidden className={`rounded-lg bg-raised motion-safe:animate-pulse ${className}`} />;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const metricOf = (psi: PsiResult | null, id: string) => (psi?.ok ? psi.metrics?.find((m) => m.id === id)?.value : undefined);

type SpecRow = { icon: LucideIcon | "github"; label: string; value: React.ReactNode };

/**
 * "Built with": a compact spec list of what the tools found, each line shown
 * only when known (never "unknown"). From the polish fetch (framework, host,
 * HTML size, viewport, dark mode, blog, Last-Modified, footer year, GitHub),
 * the cached Lighthouse run (page weight, requests, LCP, CLS) and the grade
 * (`projects`, project links on the page).
 */
function SpecList({ inspect, psi, projects }: { inspect: Inspection | null; psi: PsiResult | null; projects: number | null | undefined }) {
  if (!inspect) return <Placeholder className="h-28" />;
  const s = inspect.ok ? inspect.spec : undefined;
  const rows: SpecRow[] = [];
  if (s?.framework) rows.push({ icon: Layers, label: "Framework", value: s.framework });
  if (s?.host) rows.push({ icon: Cloud, label: "Hosted on", value: s.host });
  const w = psi?.ok ? psi.weight : undefined;
  if (w?.bytes) rows.push({ icon: Weight, label: "Page weight", value: `${kb(w.bytes)}${w.requests ? `, ${w.requests} requests` : ""}` });
  else if (s?.htmlBytes) rows.push({ icon: Weight, label: "HTML size", value: kb(s.htmlBytes) });
  const lcp = metricOf(psi, "largest-contentful-paint");
  const cls = metricOf(psi, "cumulative-layout-shift");
  if (lcp || cls) rows.push({ icon: Gauge, label: "Core Web Vitals", value: [lcp && `LCP ${lcp}`, cls && `CLS ${cls}`].filter(Boolean).join(", ") });
  if (s?.viewport !== undefined) rows.push({ icon: Smartphone, label: "Mobile-friendly", value: s.viewport ? "Yes" : "No viewport tag" });
  if (s?.darkMode) rows.push({ icon: Moon, label: "Dark mode", value: "Yes" });
  if (s?.blog) rows.push({ icon: Newspaper, label: "Blog", value: "Yes" });
  if (projects) rows.push({ icon: FolderGit2, label: "Projects linked", value: projects });
  if (inspect.ok && inspect.githubUrl)
    rows.push({
      icon: "github",
      label: "GitHub",
      value: (
        <a href={inspect.githubUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-4 hover:underline">
          {inspect.githubUrl.replace(/^https?:\/\/github\.com\//, "@")}
        </a>
      ),
    });
  // Last-Modified only when it is clearly older than the fetch (many hosts stamp every response with "now"); else the footer year.
  const lm = s?.lastModified ? Date.parse(s.lastModified) : NaN;
  const fetchedAt = inspect.measuredAt ? Date.parse(inspect.measuredAt) : NaN;
  const realLm = Number.isFinite(lm) && Number.isFinite(fetchedAt) && fetchedAt - lm > 2 * 86_400_000;
  const updated = realLm ? new Date(lm).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : inspect.ok && inspect.copyrightYear ? `© ${inspect.copyrightYear}` : null;
  if (updated) rows.push({ icon: CalendarClock, label: "Last updated", value: updated });
  if (!rows.length) return null;
  return (
    <section className="details-in grid gap-2">
      <PlayLabel>Built with</PlayLabel>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 @md:grid-cols-2">
        {rows.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex min-w-0 items-center gap-2 text-xs">
            {Icon === "github" ? <GitHubMark className="h-3.5 w-3.5 shrink-0 text-mute" /> : <Icon className="h-3.5 w-3.5 shrink-0 text-mute" aria-hidden />}
            <dt className="shrink-0 text-mute">{label}</dt>
            <dd className="min-w-0 truncate font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type Strategy = "mobile" | "desktop";
type PsiState = { phase: "loading" | "measuring" | "done"; data: PsiResult | null; retry: () => void };

// One measurement per site and strategy on the page, however many cards ask.
const measuring = new Map<string, Promise<PsiResult>>();
const POLL_MS = 5_000;
const POLL_FOR_MS = 150_000;

const psiEndpoint = (url: string, strategy: Strategy, cachedOnly: boolean) =>
  `/api/psi?url=${encodeURIComponent(url)}${strategy === "desktop" ? "&strategy=desktop" : ""}${cachedOnly ? "&cached=1" : ""}`;

/**
 * Measures when missing (owner, 2026-11-12): a site with no stored
 * Lighthouse result (and no stored failure) is measured as soon as Play shows
 * it, through the normal /api/psi, whose per-site lease lets every viewer
 * share one PageSpeed run. While another viewer's run is going ("in_progress"),
 * this polls the stored result until it lands.
 */
function usePsi(url: string, strategy: Strategy): PsiState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; phase: PsiState["phase"]; data: PsiResult | null } | null>(null);
  const key = `${strategy}:${url}:${attempt}`;
  useEffect(() => {
    let live = true;
    const set = (phase: PsiState["phase"], data: PsiResult | null) => live && setState({ key, phase, data });
    const peek = () => fetch(psiEndpoint(url, strategy, true)).then((r) => r.json() as Promise<PsiResult>);
    const measure = () => {
      const k = `${strategy}:${url}`;
      let p = attempt === 0 ? measuring.get(k) : undefined;
      if (!p) {
        p = fetch(psiEndpoint(url, strategy, false)).then((r) => r.json() as Promise<PsiResult>);
        measuring.set(k, p);
        p.finally(() => measuring.get(k) === p && measuring.delete(k));
      }
      return p;
    };
    const run = async () => {
      try {
        const stored = attempt === 0 ? await peek() : null;
        if (stored && !(stored.ok === false && stored.error === "not_measured")) return set("done", stored);
        set("measuring", null);
        let result = await measure();
        const until = Date.now() + POLL_FOR_MS;
        while (live && !result.ok && result.error === "in_progress" && Date.now() < until) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          const p = await peek();
          if (!(p.ok === false && p.error === "not_measured")) result = p;
        }
        set("done", !result.ok && result.error === "in_progress" ? { ok: false, error: "still_measuring" } : result);
      } catch {
        set("done", { ok: false, error: "fetch_error" });
      }
    };
    run();
    return () => {
      live = false;
    };
  }, [url, strategy, attempt, key]);
  const current = state?.key === key ? state : null;
  return { phase: current?.phase ?? "loading", data: current?.data ?? null, retry: () => setAttempt((a) => a + 1) };
}

/** One strategy's Lighthouse scores: a placeholder, "Measuring…", the four scores, or the reason with Retry. */
function PsiRow({ label, state, metrics }: { label: string; state: PsiState; metrics: string[] }) {
  const { phase, data } = state;
  const cols = PLAY_PSI.filter(([id]) => metrics.includes(id));
  return (
    <div className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-xs text-mute">{label}</span>
      {phase === "loading" ? (
        <Placeholder className="h-11" />
      ) : phase === "measuring" ? (
        <div role="status" className="relative h-11 overflow-hidden rounded-lg border border-edge bg-raised">
          <span className="absolute inset-y-0 left-0 w-1/3 rounded-lg bg-accent/15 motion-safe:animate-[measuring_1.6s_ease-in-out_infinite]" aria-hidden />
          <span className="relative flex h-full items-center px-3 text-xs text-mute">Measuring with Google Lighthouse… (about 30 s)</span>
        </div>
      ) : data?.ok ? (
        <div className="details-in grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, minmax(0, ${cols.length === 1 ? "6rem" : "1fr"}))` }}>
          {cols.map(([id, short]) => (
            <div key={id} className="rounded-lg border border-edge px-1 py-1 text-center" title={PSI_LABELS[id]}>
              <p className={`text-base leading-tight font-bold tabular-nums ${scoreColor(data.scores?.[id])}`}>{data.scores?.[id] ?? "-"}</p>
              <p className="text-[10px] text-mute">{short}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="details-in flex flex-wrap items-center gap-x-2 text-xs text-mute">
          <span>{data?.error === "still_measuring" ? "Still measuring. Try again in a minute." : psiProblem(data?.error).text}</span>
          {(data?.error === "still_measuring" || psiProblem(data?.error).retry) && (
            <button type="button" onClick={state.retry} className="min-h-9 font-semibold text-accent underline-offset-4 hover:underline">
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The games' view of what the tools measured on a site (Play's "About this
 * portfolio"), in two parts so the widest layout can balance them:
 * - "spec": the "Built with" list (SpecList);
 * - "checks": its own link preview (og:image, title, description), the
 *   Lighthouse scores and the polish checklist;
 * - "all": both, one after the other.
 * Lighthouse (mobile and desktop) is measured when missing (usePsi); the
 * polish fetch is the portfolio page's own (/api/inspect). Each part fades in when
 * its data arrives, over a placeholder of its shape.
 */
export function PlayDiagnostics({
  url,
  part = "all",
  projects,
  metrics = PLAY_PSI.map(([id]) => id),
  sections = ["preview", "polish", "built"],
}: {
  url: string;
  part?: "all" | "spec" | "checks";
  projects?: number | null;
  /** Which Lighthouse scores to show (lib/play/view-prefs.ts); none hides Lighthouse. */
  metrics?: string[];
  /** Which other parts to show: "preview", "polish", "built". */
  sections?: string[];
}) {
  const { data: inspect } = useJson<Inspection>(`/api/inspect?url=${encodeURIComponent(url)}`);
  const mobile = usePsi(url, "mobile");
  const desktop = usePsi(url, "desktop");
  const psi = mobile.data;
  const spec = part !== "checks" && sections.includes("built");
  const checks = part !== "spec";
  const preview = checks && sections.includes("preview");
  const polish = checks && sections.includes("polish");
  const lighthouse = checks && metrics.length > 0;

  return (
    <div className="@container grid gap-4">
      {preview && (
        <section className="grid gap-2">
          <PlayLabel>Link preview</PlayLabel>
          {!inspect ? (
            <Placeholder className="h-16 max-w-md" />
          ) : !inspect.ok ? (
            <p className="details-in text-sm text-mute">Couldn&apos;t reach the site to read its preview.</p>
          ) : inspect.ogImage && inspect.ogImageLoads ? (
            <div className="details-in flex max-w-md overflow-hidden rounded-lg border border-edge bg-card">
              <div className="w-28 shrink-0 border-r border-edge sm:w-32">
                <ShareImage key={inspect.ogImage} compact src={new URL(inspect.ogImage, inspect.finalUrl).href} />
              </div>
              <div className="min-w-0 p-2">
                <p className="truncate text-xs font-semibold">{inspect.ogTitle ?? inspect.title}</p>
                <p className="line-clamp-2 text-[11px] text-mute">{inspect.ogDescription ?? inspect.description ?? ""}</p>
                <p className="mt-0.5 truncate text-[11px] text-mute uppercase">{domainOf(url)}</p>
              </div>
            </div>
          ) : (
            <p className="details-in flex items-start gap-2 text-sm">
              <span className="font-bold text-red-500" aria-hidden>
                ✗
              </span>
              <span>
                <strong>No share image:</strong> <span className="text-mute">links to this site show up bare.</span>
              </span>
            </p>
          )}
        </section>
      )}

      {lighthouse && (
        <section className="grid gap-2">
          <PlayLabel>{metrics.length === 1 ? `Lighthouse ${(PSI_LABELS[metrics[0]] ?? "").toLowerCase()}` : "Lighthouse"}</PlayLabel>
          <PsiRow label="Mobile" state={mobile} metrics={metrics} />
          <PsiRow label="Desktop" state={desktop} metrics={metrics} />
        </section>
      )}

      {polish && (
        <section className="grid gap-2">
          <PlayLabel>Polish checklist</PlayLabel>
          {!inspect ? (
            <Placeholder className="h-20" />
          ) : !inspect.ok ? (
            <p className="details-in text-sm text-mute">Couldn&apos;t reach the site.</p>
          ) : (
            <ul className="details-in grid grid-cols-2 gap-x-3 gap-y-1">
              {polishLines(inspect as Inspection & { ok: true }).map((l) => (
                <li key={l.label} className="flex items-center gap-1.5 text-xs">
                  <span className={`font-bold ${l.pass ? "text-up" : "text-red-500"}`} aria-hidden>
                    {l.pass ? "✓" : "✗"}
                  </span>
                  <span className={l.pass ? "" : "text-mute"}>
                    {l.label}
                    <span className="sr-only">{l.pass ? ": yes" : ": no"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {spec && <SpecList inspect={inspect} psi={psi} projects={projects} />}
    </div>
  );
}
