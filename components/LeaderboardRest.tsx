"use client";

import { useState } from "react";

type Row = {
  rank: number;
  url: string;
  name: string;
  tagline?: string;
  elo: number;
  votes: number;
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const PAGE = 15;

// The #6+ tail of the leaderboard, revealed a page at a time so /top isn't an
// endless scroll. Data is already fetched server-side; this only gates display.
export function LeaderboardRest({ entries }: { entries: Row[] }) {
  const [visible, setVisible] = useState(PAGE);
  const shown = entries.slice(0, visible);

  return (
    <div className="pb-16">
      <h2 className="mb-2 mt-8 text-sm font-semibold text-mute">The rest</h2>
      <ol className="space-y-2">
        {shown.map((e) => (
          <li
            key={e.url}
            className="flex items-center gap-3 rounded-xl border border-edge bg-card px-4 py-2.5"
          >
            <span className="w-7 text-right text-sm font-bold tabular-nums text-mute">
              {e.rank}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://www.google.com/s2/favicons?domain=${domainOf(e.url)}&sz=64`}
              alt=""
              loading="lazy"
              className="h-7 w-7 rounded-md bg-edge"
            />
            <div className="min-w-0 flex-1">
              <a
                href={`/p/${encodeURIComponent(e.url)}`}
                className="block truncate text-sm font-semibold hover:underline underline-offset-4"
              >
                {e.name}
              </a>
              <p className="truncate text-xs text-mute">
                {e.tagline ?? domainOf(e.url)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-bold tabular-nums">{e.elo}</p>
              <p className="text-xs text-mute">{e.votes}v</p>
            </div>
          </li>
        ))}
      </ol>
      {visible < entries.length && (
        <div className="mt-4 text-center">
          <button
            onClick={() => setVisible((v) => v + PAGE)}
            className="rounded-lg border border-edge px-5 py-2 text-sm font-semibold transition hover:border-mute"
          >
            Show more ({entries.length - visible} left)
          </button>
        </div>
      )}
    </div>
  );
}
