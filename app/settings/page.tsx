"use client";

import Link from "next/link";
import { useStoredFlag } from "@/lib/client-state";

export default function SettingsPage() {
  const [autoOpen, setAutoOpen] = useStoredFlag("pr_autoopen");
  const toggleAutoOpen = () => setAutoOpen(!autoOpen);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <Link href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </Link>
        <a
          href="/rank"
          className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent transition hover:border-accent"
        >
          ⚔️ Rank
        </a>
      </header>

      <main id="main" tabIndex={-1}>
        <div className="py-6">
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="mt-2 text-sm text-mute">Saved on this device.</p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-edge bg-card p-5">
          <div className="min-w-0">
            <p id="autoopen-label" className="font-semibold">Auto-open both sites when voting</p>
            <p id="autoopen-desc" className="mt-1 text-sm text-mute">
              Opens each new pair&apos;s two sites in new tabs so you can review the
              real pages before picking. You may need to allow pop-ups for this
              site.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoOpen}
            aria-labelledby="autoopen-label"
            aria-describedby="autoopen-desc"
            onClick={toggleAutoOpen}
            className={`relative h-6 w-11 shrink-0 rounded-full transition after:absolute after:-inset-y-2.5 after:inset-x-0 ${
              autoOpen ? "bg-accent" : "bg-edge"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-bg transition-all ${
                autoOpen ? "left-[1.375rem]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </main>
    </div>
  );
}
