"use client";

import { ThemeChooser } from "@/components/shell/ThemeChooser";
import { useStoredFlag } from "@/lib/client-state";

// Settings saved on this device: the theme (also in the header's menu) and
// how voting behaves. Motion follows the device's own "reduce motion"
// setting everywhere, so there is no switch for it here.
export default function SettingsPage() {
  const [autoOpen, setAutoOpen] = useStoredFlag("pr_autoopen");

  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
      <div className="py-6">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-mute">Saved on this device.</p>
      </div>

      <section aria-labelledby="appearance" className="mb-8">
        <h2 id="appearance" className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-mute">
          Appearance
        </h2>
        <div className="rounded-xl border border-edge bg-card p-5">
          <p id="theme-label" className="font-semibold">
            Theme
          </p>
          <p id="theme-desc" className="mt-1 text-sm text-mute">
            System follows your device&apos;s light or dark mode. Animations follow its reduce motion setting.
          </p>
          <div className="mt-4 sm:max-w-sm">
            <ThemeChooser labelledBy="theme-label" describedBy="theme-desc" />
          </div>
        </div>
      </section>

      <section aria-labelledby="voting">
        <h2 id="voting" className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-mute">
          Voting
        </h2>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-edge bg-card p-5">
          <div className="min-w-0">
            <p id="autoopen-label" className="font-semibold">
              Auto-open both sites when voting
            </p>
            <p id="autoopen-desc" className="mt-1 text-sm text-mute">
              Opens each new pair&apos;s two sites in new tabs so you can review the real pages before picking. You may need to allow pop-ups for this site.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoOpen}
            aria-labelledby="autoopen-label"
            aria-describedby="autoopen-desc"
            onClick={() => setAutoOpen(!autoOpen)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition after:absolute after:-inset-y-2.5 after:inset-x-0 ${autoOpen ? "bg-fill" : "bg-mute"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-sm transition-all ${autoOpen ? "left-[1.375rem]" : "left-0.5"}`} />
          </button>
        </div>
      </section>
    </div>
  );
}
