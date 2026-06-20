"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [autoOpen, setAutoOpen] = useState(false);

  useEffect(() => {
    setAutoOpen(localStorage.getItem("pr_autoopen") === "1");
  }, []);

  const toggleAutoOpen = () =>
    setAutoOpen((v) => {
      const nv = !v;
      localStorage.setItem("pr_autoopen", nv ? "1" : "0");
      return nv;
    });

  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <a
          href="/rank"
          className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent transition hover:border-accent"
        >
          ⚔️ Rank
        </a>
      </header>

      <div className="py-6">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-mute">Saved on this device.</p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl border border-edge bg-card p-5">
        <div className="min-w-0">
          <p className="font-semibold">Auto-open both sites when voting</p>
          <p className="mt-1 text-sm text-mute">
            Opens each new pair&apos;s two sites in new tabs so you can review the
            real pages before picking. You may need to allow pop-ups for this
            site.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={autoOpen}
          onClick={toggleAutoOpen}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
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
    </div>
  );
}
