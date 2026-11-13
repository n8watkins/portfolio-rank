"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";

// "Send test alert" (POST /api/admin/alerts/test): one email through the
// normal owner-alert path, and the outcome inline, with the exact reason
// when it couldn't be sent.

const MESSAGES: Record<string, string> = {
  signin_required: "Your session ended. Sign in again.",
  forbidden: "Only the admin can send a test alert.",
  bad_origin: "The request didn't come from this site.",
};

type Result = { ok: boolean; text: string };

export function TestAlert({ to }: { to: string | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/alerts/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as { sent?: boolean; error?: string; missing?: string[]; reason?: string };
      if (res.ok && body.sent) setResult({ ok: true, text: `Sent${to ? ` to ${to}` : ""}. It should arrive within a minute; check spam if it doesn't.` });
      else if (body.error === "no_sender") setResult({ ok: false, text: `Not sent: owner alerts are off on this site. Missing: ${(body.missing ?? []).join(", ") || "unknown"}.` });
      else if (body.error === "not_sent") setResult({ ok: false, text: `Not sent: ${body.reason ?? "unknown reason"}.` });
      else setResult({ ok: false, text: MESSAGES[body.error ?? ""] ?? `Not sent (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}).` });
    } catch {
      setResult({ ok: false, text: "Not sent: the request didn't reach the site. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={send} disabled={busy} className={btnPrimary}>
        <Send aria-hidden className="size-4" />
        {busy ? "Sending..." : "Send test alert"}
      </button>
      <p role="status" aria-live="polite" className={`text-sm ${result ? (result.ok ? "text-up" : "text-down") : "text-mute"}`}>
        {result?.text ?? ""}
      </p>
    </div>
  );
}
