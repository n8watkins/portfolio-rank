"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { btnSecondary } from "@/components/ui/styles";

/**
 * "Re-check my site": shown only to the portfolio's verified owner
 * (GET /api/recheck says so), at most once an hour. Runs every check again
 * (about a minute) and reloads the profile with the new results.
 */
export function RecheckButton({ url }: { url: string }) {
  const [state, setState] = useState<{ owner: boolean; nextAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`/api/recheck?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => alive && setState(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  if (!state?.owner) return null;
  // nextAt is only set while the hour hasn't passed (GET /api/recheck).
  const wait = state.nextAt ? new Date(state.nextAt) : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy || Boolean(wait)}
        onClick={async () => {
          setBusy(true);
          setError("");
          const r = await fetch("/api/recheck", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => null);
          const b = (await r?.json().catch(() => ({}))) as { message?: string; nextAt?: string };
          if (r?.ok) return window.location.reload();
          setBusy(false);
          setError(b?.message ?? "Couldn't re-check. Try again later.");
          if (b?.nextAt) setState({ owner: true, nextAt: b.nextAt });
        }}
        className={btnSecondary}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="h-4 w-4" aria-hidden />}
        {busy ? "Re-checking, about a minute" : "Re-check my site"}
      </button>
      {wait && !busy && (
        <span className="text-xs text-mute">Again at {wait.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
      )}
      {error && (
        <span role="alert" className="text-xs text-down">
          {error}
        </span>
      )}
    </div>
  );
}
