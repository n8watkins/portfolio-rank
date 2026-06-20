"use client";

import { useEffect, useState } from "react";
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

const PSI_LABELS: Record<string, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

export function useInspection(url: string) {
  const [data, setData] = useState<Inspection | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    fetch(`/api/inspect?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d) => live && setData(d))
      .catch(() => live && setData({ ok: false, error: "failed" }));
    return () => {
      live = false;
    };
  }, [url]);
  return data;
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

// A GitHub-profile button, scraped from the portfolio page — so you can reach
// someone's GitHub without opening their site. Renders nothing if none found.
export function GithubLink({ url }: { url: string }) {
  const data = useInspection(url);
  if (!data?.ok || !data.githubUrl) return null;
  const handle = data.githubUrl.replace(/^https?:\/\/github\.com\//, "@");
  return (
    <a
      href={data.githubUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm font-semibold transition hover:border-mute"
      title="Their GitHub profile (scraped from the site)"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      {handle}
    </a>
  );
}

/** Full panel for the detail page. Order: Lighthouse → Polish → Share card. */
export function DetailDiagnostics({ url }: { url: string }) {
  const inspect = useInspection(url);
  const [psi, setPsi] = useState<PsiResult | null>(null);

  useEffect(() => {
    let live = true;
    setPsi(null);
    fetch(`/api/psi?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d) => live && setPsi(d))
      .catch(() => live && setPsi({ ok: false, error: "failed" }));
    return () => {
      live = false;
    };
  }, [url]);

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
            Running Lighthouse on Google&apos;s servers — first run takes ~30s…
          </p>
        ) : !psi.ok ? (
          <p className="text-sm text-red-400">
            Couldn&apos;t analyze: {psi.error}
          </p>
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
                    {psi.scores?.[id] ?? "—"}
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
          </>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl border border-edge bg-card p-5">
          <h2 className="mb-3 font-semibold">Polish checklist</h2>
          {!inspect ? (
            <p className="text-sm text-mute">Checking…</p>
          ) : !inspect.ok ? (
            <p className="text-sm text-red-400">Couldn&apos;t reach the site.</p>
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
        </section>

        <section className="rounded-xl border border-edge bg-card p-5">
          <h2 className="mb-3 font-semibold">Share card</h2>
          {!inspect ? (
            <p className="text-sm text-mute">Checking…</p>
          ) : !inspect.ok ? (
            <p className="text-sm text-red-400">Couldn&apos;t reach the site.</p>
          ) : inspect.ogImage && inspect.ogImageLoads ? (
            <div className="overflow-hidden rounded-lg border border-edge">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={new URL(inspect.ogImage, inspect.finalUrl).href}
                alt="Social share preview"
                className="aspect-[1.91/1] w-full bg-edge object-cover"
              />
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
              ✗ No working share card — this link looks bare when posted on
              social media.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
