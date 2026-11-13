"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Link2, Loader2, Plus } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";
import { useToolRequest } from "@/components/tools/useToolRequest";

const LOOKS_LIKE_URL = /^(https?:\/\/)?[^\s./]+\.[^\s]{2,}$/;

const STEPS = [
  "Loading your site",
  "Checking resume, GitHub, contact and project links",
  "Reading your link preview",
  "Running Lighthouse on a phone and a desktop",
  "Saving your profile",
];

/** The wait, told honestly: every check runs at once, Lighthouse takes about a minute. */
function Running({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  // The fast checks finish in seconds; Lighthouse holds the last steps.
  const at = secs < 3 ? 0 : secs < 6 ? 1 : secs < 9 ? 2 : secs < 55 ? 3 : 4;
  return (
    <div role="status" aria-live="polite" className="card mt-6 p-5 text-left sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden /> Adding your portfolio
        </p>
        <span className="text-sm tabular-nums text-mute">{secs}s</span>
      </div>
      <ol className="mt-4 space-y-2.5">
        {STEPS.map((s, i) => (
          <li key={s} className={`flex items-center gap-2.5 text-sm transition ${i <= at ? "text-ink" : "text-mute/70"}`}>
            {i < at ? <CircleCheck className="h-4 w-4 text-up" aria-hidden /> : <span className={`mx-1 h-2 w-2 rounded-full ${i === at ? "attn-dot bg-accent" : "bg-edge-strong"}`} aria-hidden />}
            {s}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-mute">Lighthouse loads your whole site twice, so this takes about a minute. Your profile opens when it&apos;s done.</p>
    </div>
  );
}

/**
 * "Add your portfolio": one address, every check at once (POST /api/add),
 * then the portfolio's profile, where the AI report card fills in once it's
 * graded.
 */
export function AddForm({ initialUrl = "" }: { initialUrl?: string }) {
  const id = useId();
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState("");
  const [since, setSince] = useState<number | null>(null);
  const { arm, post, turnstile, needsTick } = useToolRequest("add");
  const busy = since !== null;

  return (
    <form
      noValidate
      onFocus={arm}
      onPointerEnter={arm}
      onSubmit={async (e) => {
        e.preventDefault();
        const v = url.trim();
        if (!LOOKS_LIKE_URL.test(v)) {
          setError("Paste your portfolio's address, like yourname.dev.");
          return;
        }
        setError("");
        setSince(Date.now());
        const r = await post<{ path: string }>("/api/add", { url: v });
        if (r.ok) return router.push(r.data.path);
        setSince(null);
        setError(r.message);
      }}
      aria-busy={busy}
      className="w-full text-left"
    >
      <label htmlFor={`${id}-url`} className="sr-only">
        Your portfolio address
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
          <input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="yourname.dev"
            value={url}
            disabled={busy}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
            aria-invalid={!!error}
            aria-describedby={`${id}-note${error ? ` ${id}-error` : ""}`}
            className="h-12 w-full rounded-lg border border-edge bg-card pl-10 pr-3 text-[15px] outline-none transition placeholder:text-mute/80 focus:border-accent disabled:opacity-70"
          />
        </div>
        <button type="submit" disabled={busy} className={`${btnPrimary} h-12 px-6 text-[15px]`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          {busy ? "Adding" : "Add my portfolio"}
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-down">
          {error}
        </p>
      )}
      <p id={`${id}-note`} className="mt-2.5 text-xs text-mute">
        Free, no account. Your site is added to PortfolioRank and stays private until it&apos;s graded.
      </p>
      {turnstile}
      {needsTick && (
        <p role="status" className="mt-2 text-sm font-medium">
          Cloudflare wants a quick check first: tick the box{busy ? " and the checks start" : ""}.
        </p>
      )}
      {busy && since !== null && !needsTick && <Running since={since} />}
    </form>
  );
}
