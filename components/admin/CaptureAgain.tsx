"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { btnSecondary } from "@/components/ui/styles";

// "Capture again" on a row of the Capture problems page
// (app/admin/(tools)/capture-problems): the admin's existing Re-measure
// (app/api/admin/remeasure, the same request the portfolio page's Re-measure
// sends). Every check of the site is due again: the screenshots are taken
// again in tonight's capture, past any refresh backoff, the link checks run
// in tonight's free checks, and Lighthouse and the polish check run on the
// site's next page view. The grade and the listing do not change.
export function CaptureAgain({ url, domain }: { url: string; domain: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setState("busy");
    setError(null);
    try {
      const r = await fetch("/api/admin/remeasure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      const d = (await r.json().catch(() => ({}))) as { forcedAt?: string; error?: string };
      if (!r.ok || !d.forcedAt) throw new Error(d.error ?? `http_${r.status}`);
      setState("done");
    } catch (e) {
      setState("idle");
      setError(`Couldn't ask for it (${(e as Error).message}).`);
    }
  };
  if (state === "done")
    return (
      <p className="text-sm font-semibold" role="status" data-capture-again-done>
        Asked: it is captured again tonight.
      </p>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" className={btnSecondary} onClick={run} disabled={state === "busy"} aria-label={`Capture again: ${domain}`} data-capture-again>
        <RotateCcw className="h-4 w-4" aria-hidden />
        {state === "busy" ? "Asking..." : "Capture again"}
      </button>
      {error && (
        <span className="text-sm text-down" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
