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

/** Full panel for the detail page. */
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
    <div className="grid gap-4 sm:grid-cols-2">
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
            <Check pass={inspect.hasGithubLink} label="Links to GitHub" />
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

      <section className="rounded-xl border border-edge bg-card p-5 sm:col-span-2">
        <h2 className="mb-3 font-semibold">
          Lighthouse{" "}
          <span className="text-xs font-normal text-mute">
            via Google PageSpeed · mobile
          </span>
        </h2>
        {!psi ? (
          <p className="text-sm text-mute">
            Running Lighthouse on Google&apos;s servers — first run takes
            ~30s…
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
    </div>
  );
}
