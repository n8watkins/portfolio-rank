"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";

/**
 * The one button on /newsletter/confirm and /newsletter/unsubscribe: mail
 * scanners open links but don't press buttons, so a link alone never
 * confirms or unsubscribes anyone. On success the button becomes `done`.
 */
export function NewsletterAction({
  endpoint,
  body,
  label,
  busyLabel,
  done,
  failed,
}: {
  endpoint: string;
  body?: Record<string, string>;
  label: string;
  busyLabel: string;
  done: React.ReactNode;
  failed: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  if (state === "done")
    return (
      <div role="status" className="pop-in mt-6 flex items-start gap-2 rounded-xl border border-up/40 bg-up/10 p-4 text-left text-sm font-medium">
        <CircleCheck className="mt-px h-5 w-5 shrink-0 text-up" aria-hidden />
        <div>{done}</div>
      </div>
    );
  return (
    <>
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
          }).catch(() => null);
          setState(res?.ok ? "done" : "failed");
        }}
        className={`${btnPrimary} mt-6 h-12 w-full text-[15px]`}
      >
        {state === "busy" ? busyLabel : label}
      </button>
      {state === "failed" && (
        <p role="alert" className="mt-3 text-sm text-down">
          {failed}
        </p>
      )}
    </>
  );
}
