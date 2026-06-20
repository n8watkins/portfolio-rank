"use client";

import { useMemo, useState } from "react";
import type { Portfolio } from "@/app/page";
import { SITE } from "@/lib/site";

const PAGE_SIZE = 24;
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

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function PortfolioGrid({ portfolios }: { portfolios: Portfolio[] }) {
  const [query, setQuery] = useState("");
  const [letter, setLetter] = useState("All");
  const [role, setRole] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);

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
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Browse</h2>
          <a
            href={SITE.submit}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-edge px-2.5 py-1 text-xs font-semibold text-mute transition hover:border-mute hover:text-ink"
          >
            + Submit yours
          </a>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisible(PAGE_SIZE);
          }}
          placeholder="Search by name, role, or domain…"
          className="w-full rounded-lg border border-edge bg-card px-4 py-2 text-sm outline-none transition placeholder:text-mute focus:border-mute sm:w-80"
        />
      </div>

      <div className="mb-3 flex flex-wrap justify-center gap-1.5">
        {ROLES.map((r) => (
          <button
            key={r.label}
            onClick={() => {
              setRole(role === r.label ? null : r.label);
              setVisible(PAGE_SIZE);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              role === r.label
                ? "border-accent bg-accent text-bg"
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
            onClick={() => {
              setLetter(l);
              setVisible(PAGE_SIZE);
            }}
            className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
              letter === l
                ? "bg-accent text-bg"
                : "text-mute hover:bg-edge hover:text-ink"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p, i) => (
          <a
            key={p.url}
            href={`/p/${encodeURIComponent(p.url)}`}
            className="fade-up group rounded-xl border border-edge bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:border-mute"
            style={{ animationDelay: `${Math.min((i % PAGE_SIZE) * 15, 450)}ms` }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://www.google.com/s2/favicons?domain=${domainOf(p.url)}&sz=64`}
                  alt=""
                  loading="lazy"
                  className="h-7 w-7 shrink-0 rounded-md bg-edge"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="truncate text-xs text-mute">
                    {p.tagline ?? domainOf(p.url)}
                  </p>
                </div>
              </div>
              {/* Opens the real site; preventDefault keeps the card's own link
                  (to the detail page) from firing. */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  window.open(p.url, "_blank", "noopener");
                }}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-mute opacity-0 transition hover:text-ink group-hover:opacity-100"
                title="Visit site"
                aria-label={`Visit ${domainOf(p.url)}`}
              >
                ↗
              </button>
            </div>
          </a>
        ))}
      </div>

      {shown.length === 0 && (
        <p className="py-16 text-center text-sm text-mute">
          No portfolios match “{query}”.
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
