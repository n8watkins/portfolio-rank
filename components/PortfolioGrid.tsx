"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Portfolio } from "@/app/page";
import { SITE } from "@/lib/site";
import { LikeButton } from "@/components/LikeButton";
import { faviconOf } from "@/lib/shot-url";

const PAGE_SIZE = 18; // 6 rows on desktop (3-col); "Show more" reveals the rest
const LETTERS = ["All", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

const ROLES: { label: string; pattern: RegExp }[] = [
  { label: "Full Stack", pattern: /full.?stack/i },
  { label: "Frontend", pattern: /front.?end|web dev/i },
  { label: "Backend", pattern: /back.?end/i },
  { label: "Software Engineer", pattern: /software (engineer|developer)/i },
  { label: "AI / ML", pattern: /\bai\b|machine learning|\bml\b|data scien|deep learning|llm/i },
  { label: "Mobile", pattern: /mobile|android|ios|flutter|react native/i },
  { label: "DevOps / Cloud", pattern: /devops|cloud|sre|platform engineer|infrastructure/i },
  { label: "Design / UX", pattern: /design|ux|\bui\b/i },
];

// Search and filters live in the address (?q=, ?role=, ?letter=), so a
// filtered view can be shared and survives Back. Updates replace the history
// entry instead of adding one per keystroke.
const FILTERS_CHANGED = "portfoliorank:filters";

function subscribeToAddress(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(FILTERS_CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(FILTERS_CHANGED, onChange);
  };
}

function useFilters() {
  // The server (and hydration) render unfiltered; the address applies right after.
  const search = useSyncExternalStore(
    subscribeToAddress,
    () => window.location.search,
    () => ""
  );
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const roleParam = params.get("role");
  const letterParam = params.get("letter")?.toUpperCase() ?? "";
  const filters = {
    query: params.get("q") ?? "",
    role: ROLES.some((r) => r.label === roleParam) ? roleParam : null,
    letter: LETTERS.includes(letterParam) ? letterParam : "All",
  };
  const set = useCallback((next: { query?: string; role?: string | null; letter?: string }) => {
    const url = new URL(window.location.href);
    const put = (k: string, v: string | null | undefined, empty: string | null = null) =>
      v === undefined ? undefined : !v || v === empty ? url.searchParams.delete(k) : url.searchParams.set(k, v);
    put("q", next.query);
    put("role", next.role);
    put("letter", next.letter, "All");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new Event(FILTERS_CHANGED));
  }, []);
  return [filters, set] as const;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function PortfolioGrid({ portfolios }: { portfolios: Portfolio[] }) {
  const [{ query, letter, role }, setFilters] = useFilters();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const filtering = Boolean(query.trim()) || letter !== "All" || role !== null;
  // Hydrate the signed-in rater's liked set once so cards show a filled ♥.
  // Returns [] for anon, so the heart simply stays hollow.
  const [likedSet, setLikedSet] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch("/api/likes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.liked && setLikedSet(new Set<string>(d.liked)))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rolePattern = ROLES.find((r) => r.label === role)?.pattern;
    return portfolios.filter((p) => {
      if (letter !== "All" && !p.name.toUpperCase().startsWith(letter)) {
        return false;
      }
      if (rolePattern && !(p.tagline && rolePattern.test(p.tagline))) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.tagline?.toLowerCase().includes(q) ||
        domainOf(p.url).toLowerCase().includes(q)
      );
    });
  }, [query, letter, role, portfolios]);

  const shown = filtered.slice(0, visible);

  return (
    <section id="browse" className="scroll-mt-16">
      <div className="mb-6 flex flex-col items-center justify-between gap-3 sm:flex-row">
        <label htmlFor="browse-search" className="sr-only">
          Search portfolios
        </label>
        <input
          id="browse-search"
          type="search"
          value={query}
          onChange={(e) => {
            setFilters({ query: e.target.value });
            setVisible(PAGE_SIZE);
          }}
          placeholder="Search by name, role, or domain…"
          className="w-full rounded-lg border border-edge bg-card px-4 py-2 text-base outline-none transition placeholder:text-mute focus:border-mute sm:w-80 sm:text-sm"
        />
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Browse</h2>
          <a
            href={SITE.submit}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-fill px-4 py-2 text-sm font-semibold text-on-fill transition hover:opacity-85"
          >
            + Submit yours
          </a>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap justify-center gap-1.5">
        {ROLES.map((r) => (
          <button
            key={r.label}
            aria-pressed={role === r.label}
            onClick={() => {
              setFilters({ role: role === r.label ? null : r.label });
              setVisible(PAGE_SIZE);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              role === r.label
                ? "border-accent bg-fill text-on-fill"
                : "border-edge text-mute hover:border-mute hover:text-ink"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap justify-center gap-1">
        {LETTERS.map((l) => (
          <button
            key={l}
            aria-pressed={letter === l}
            aria-label={l === "All" ? "All letters" : `Names starting with ${l}`}
            onClick={() => {
              setFilters({ letter: l });
              setVisible(PAGE_SIZE);
            }}
            className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
              letter === l
                ? "bg-fill text-on-fill"
                : "text-mute hover:bg-edge hover:text-ink"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* How many match, read out as filters change; a way back to everything. */}
      <div className="mb-3 flex min-h-11 items-center justify-center gap-3 text-sm text-mute">
        <p role="status" aria-live="polite">
          {filtering
            ? `${filtered.length.toLocaleString()} of ${portfolios.length.toLocaleString()} portfolios`
            : `${portfolios.length.toLocaleString()} portfolios`}
        </p>
        {filtering && (
          <button
            type="button"
            onClick={() => {
              setFilters({ query: "", role: null, letter: "All" });
              setVisible(PAGE_SIZE);
            }}
            className="min-h-11 px-2 font-semibold text-accent underline underline-offset-2"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p, i) => (
          // The name is the card's link and stretches over the whole card
          // (::after); Like and Visit sit above it as siblings, never nested
          // inside the link.
          <div
            key={p.url}
            className="fade-up group relative rounded-xl border border-edge bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:border-mute"
            style={{ animationDelay: `${Math.min((i % PAGE_SIZE) * 15, 450)}ms` }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={faviconOf(domainOf(p.url))}
                  alt=""
                  loading="lazy"
                  className="h-7 w-7 shrink-0 rounded-md bg-edge"
                />
                <div className="min-w-0">
                  <a
                    href={`/p/${encodeURIComponent(p.url)}`}
                    className="block truncate text-sm font-semibold after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
                  >
                    {p.name}
                  </a>
                  <p className="truncate text-xs text-mute">
                    {p.tagline ?? domainOf(p.url)}
                  </p>
                </div>
              </div>
              <div className="relative z-10 flex shrink-0 items-center gap-0.5">
                <LikeButton
                  url={p.url}
                  name={p.name}
                  initialLiked={likedSet.has(p.url)}
                  variant="icon"
                />
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative rounded-md px-1.5 py-0.5 text-mute opacity-0 transition after:absolute after:-inset-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  title="Visit site"
                  aria-label={`Visit ${domainOf(p.url)} (opens in a new tab)`}
                >
                  <span aria-hidden>↗</span>
                </a>
              </div>
            </div>
          </div>
        ))}
      </div>

      {shown.length === 0 && (
        <p className="py-16 text-center text-sm text-mute">
          No portfolios match {query.trim() ? `“${query.trim()}”` : "these filters"}.
        </p>
      )}

      {visible < filtered.length && (
        <div className="mt-8 text-center">
          <button
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="rounded-lg border border-edge px-5 py-2.5 text-sm font-semibold transition hover:border-mute"
          >
            Show more ({(filtered.length - visible).toLocaleString()} left)
          </button>
        </div>
      )}
    </section>
  );
}
