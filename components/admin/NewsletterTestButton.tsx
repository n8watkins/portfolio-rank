"use client";

import { useState } from "react";
import { CircleAlert, CircleCheck, Send } from "lucide-react";
import { btnSecondary } from "@/components/ui/styles";

const WHY: Record<string, string> = {
  no_owner_email: "OWNER_EMAIL isn't set on this Worker, so there is no address to send to.",
  no_post: "There is no post yet to put in the email.",
  "cap:day": "Today's email cap is used up. It resets at midnight Pacific.",
  "cap:kind": "Today's newsletter emails are used up. They reset at midnight Pacific.",
  "cap:recipient": "That's enough newsletter emails to your address today.",
  no_transport: "This Worker has no newsletter mailroom binding (MAILROOM_NEWS).",
};

/** "Send test to me": POST /api/admin/newsletter/test, then says what happened. */
export function NewsletterTestButton({ disabled, to }: { disabled: boolean; to: string | null }) {
  const [state, setState] = useState<"idle" | "busy" | { ok: true; text: string } | { ok: false; text: string }>("idle");
  return (
    <div>
      <button
        type="button"
        disabled={disabled || state === "busy"}
        onClick={async () => {
          setState("busy");
          const res = await fetch("/api/admin/newsletter/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
          const b = res ? await res.json().catch(() => ({})) : {};
          if (res?.ok) setState({ ok: true, text: `Sent to ${b.to}: "${b.post}". It can take a minute to arrive.` });
          else {
            const reason = String(b.error ?? "");
            const mailroom = /mailroom refused: (\w+)/.exec(reason)?.[1];
            setState({
              ok: false,
              text:
                WHY[reason] ??
                (mailroom === "unknown_app"
                  ? "Mailroom doesn't know the newsletter's app yet: deploy the mailroom change first (portfoliorank-news)."
                  : mailroom
                    ? `Mailroom refused it (${mailroom}).`
                    : "That didn't work. Try again in a moment."),
            });
          }
        }}
        className={`${btnSecondary} w-full sm:w-auto`}
      >
        <Send className="h-4 w-4 text-accent" aria-hidden /> {state === "busy" ? "Sending..." : "Send test to me"}
      </button>
      <p className="mt-2 text-xs text-mute">{to ? <>Goes to {to} (OWNER_EMAIL), with the latest post, through the same caps as the real emails.</> : WHY.no_owner_email}</p>
      {typeof state === "object" && (
        <p role={state.ok ? "status" : "alert"} className={`mt-2 flex items-start gap-1.5 text-sm ${state.ok ? "text-up" : "text-down"}`}>
          {state.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          {state.text}
        </p>
      )}
    </div>
  );
}
