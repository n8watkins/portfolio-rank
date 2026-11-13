"use client";

import { useState } from "react";
import { CircleAlert, CircleCheck, ExternalLink, FlaskConical } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";

const WHY: Record<string, string> = {
  no_kit_key: "Kit isn't connected on this site (KIT_API_KEY).",
  no_post: "There is no post yet to put in the email.",
  signin_required: "Your session ended. Sign in again.",
  forbidden: "Only the admin can do this.",
};

/** "Create a test draft in Kit" (POST /api/admin/newsletter/test-draft), then a link to the draft in Kit. */
export function NewsletterTestDraft({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; url: string; subject: string } | { ok: false; text: string } | null>(null);

  const create = async () => {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/admin/newsletter/test-draft", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && b.url) setResult({ ok: true, url: String(b.url), subject: String(b.subject) });
    else setResult({ ok: false, text: WHY[String(b.error)] ?? (b.error === "kit_refused" ? `Kit refused it: ${b.reason ?? "unknown reason"}.` : "That didn't work. Try again in a moment.") });
    setBusy(false);
  };

  return (
    <div>
      <button type="button" onClick={create} disabled={disabled || busy} className={`${btnPrimary} w-full sm:w-auto`}>
        <FlaskConical className="h-4 w-4" aria-hidden /> {busy ? "Creating..." : "Create a test draft in Kit"}
      </button>
      <p className="mt-2 text-xs text-mute">A draft of the latest post, marked [test], sent to nobody. In Kit, use Send test email to see it in your inbox, then delete it.</p>
      {result && (
        <p role={result.ok ? "status" : "alert"} className={`mt-2 flex items-start gap-1.5 text-sm ${result.ok ? "text-up" : "text-down"}`}>
          {result.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          {result.ok ? (
            <span>
              Created &ldquo;{result.subject}&rdquo;.{" "}
              <a href={result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                Open it in Kit <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </span>
          ) : (
            result.text
          )}
        </p>
      )}
    </div>
  );
}
