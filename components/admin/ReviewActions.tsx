"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, EyeOff, Send, X } from "lucide-react";
import { btnGhost, btnPrimary, btnSecondary } from "@/components/ui/styles";

// The owner's decision on one post (POST /api/admin/content/<id>): Publish
// or Reject a draft, Unpublish a published post. Reject and Unpublish take
// an optional note, kept on the post.

const ERRORS: Record<string, string> = {
  weekly_cap: "The weekly cap is full: 2 posts already go out within 7 days of this one. Publish it later, or unpublish another first.",
  wrong_status: "This post changed in the meantime. Reload to see where it is now.",
  not_found: "This post no longer exists.",
  signin_required: "Your session ended. Sign in again.",
  forbidden: "Only the admin can review posts.",
};

export function ReviewActions({ id, status, publishLabel }: { id: string; status: string; publishLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"reject" | "unpublish" | null>(null);
  const [note, setNote] = useState("");

  const act = async (action: "publish" | "reject" | "unpublish") => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/content/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(ERRORS[body.error ?? ""] ?? "That didn't work. Try again.");
      else {
        setAsking(null);
        setNote("");
        router.refresh();
      }
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (asking) {
    const label = asking === "reject" ? "Reject draft" : "Unpublish";
    return (
      <div className="grid w-full gap-2 sm:max-w-md">
        <label htmlFor="review-note" className="text-sm font-semibold">
          {asking === "reject" ? "Why not? (optional, kept on the draft)" : "Why? (optional, kept on the post)"}
        </label>
        <textarea
          id="review-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent/60"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnSecondary} disabled={busy !== null} onClick={() => act(asking)}>
            {asking === "reject" ? <X className="h-4 w-4 text-down" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />} {busy ? "Saving" : label}
          </button>
          <button type="button" className={btnGhost} onClick={() => setAsking(null)}>
            Cancel
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-down">{error}</p>}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "draft" && (
          <>
            <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => act("publish")}>
              {busy === "publish" ? <Check className="h-4 w-4" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} {busy === "publish" ? "Publishing" : publishLabel}
            </button>
            <button type="button" className={btnSecondary} disabled={busy !== null} onClick={() => setAsking("reject")}>
              <X className="h-4 w-4 text-down" aria-hidden /> Reject
            </button>
          </>
        )}
        {status === "published" && (
          <button type="button" className={btnSecondary} disabled={busy !== null} onClick={() => setAsking("unpublish")}>
            <EyeOff className="h-4 w-4" aria-hidden /> Unpublish
          </button>
        )}
      </div>
      {error && <p role="alert" className="max-w-md text-sm text-down">{error}</p>}
    </div>
  );
}
