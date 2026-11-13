"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleAlert, Power } from "lucide-react";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";

type Change = { on: boolean; at: string; by: string | null };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/**
 * "Turn newsletter on/off" (POST /api/admin/newsletter/switch): the owner's
 * stored switch. Off hides every sign-up form and stops new broadcasts; on
 * shows and runs them, as long as NEWSLETTER_ENABLED is on for this deploy.
 */
export function NewsletterSwitch({ initial, deployOn, log: initialLog }: { initial: boolean; deployOn: boolean; log: Change[] }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [log, setLog] = useState(initialLog);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/newsletter/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: !on }) }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok) {
      setOn(Boolean(b.on));
      setLog(Array.isArray(b.log) ? b.log : log);
      router.refresh();
    } else setError("That didn't work. Try again in a moment.");
    setBusy(false);
  };

  return (
    <div data-newsletter-switch={on ? "on" : "off"}>
      <p className="text-sm">
        The newsletter is <span className={`font-semibold ${on && deployOn ? "text-up" : "text-ink"}`}>{on ? (deployOn ? "on" : "on, but off for this deploy") : "off"}</span>.{" "}
        <span className="text-mute">{on ? "Sign-up forms show on the blog and in the footer, and new posts go to Kit." : "No sign-up forms anywhere, and no broadcasts."}</span>
      </p>
      <button type="button" onClick={flip} disabled={busy} aria-pressed={on} className={`${on ? btnSecondary : btnPrimary} mt-4 w-full sm:w-auto`}>
        <Power className="h-4 w-4" aria-hidden /> {busy ? "Saving..." : on ? "Turn newsletter off" : "Turn newsletter on"}
      </button>
      {!deployOn && <p className="mt-2 text-xs text-mute">NEWSLETTER_ENABLED is off for this deploy, so the newsletter stays hidden whatever this switch says.</p>}
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-down">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      {log.length > 0 && (
        <ul className="mt-4 grid gap-1 text-xs text-mute" aria-label="Recent changes">
          {log.map((c, i) => (
            <li key={`${c.at}-${i}`}>
              Turned {c.on ? "on" : "off"} {when(c.at)}
              {c.by ? ` by ${c.by}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
