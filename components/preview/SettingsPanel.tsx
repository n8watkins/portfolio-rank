"use client";

import { useEffect, useState } from "react";
import { CircleCheck, Eye, EyeOff, KeyRound, Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { useTheme, type Theme } from "@/components/shell/ThemeToggle";

const KEY = "pr-gemini-key";

function Section({ id, title, line, children }: { id: string; title: string; line: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-t`} className="card rise scroll-mt-24 p-5 sm:p-6">
      <h2 id={`${id}-t`} className="text-lg font-bold tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-sm text-mute">{line}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Settings, all stored in this browser only. */
export function SettingsPanel() {
  const [theme, setTheme] = useTheme();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "removed" | "invalid">("");
  const [autoOpen, setAutoOpen] = useState(false);

  useEffect(() => {
    try {
      const k = localStorage.getItem(KEY);
      setSaved(k);
      setAutoOpen(localStorage.getItem("pr_autoopen") === "1");
    } catch {}
  }, []);

  const masked = saved ? `${saved.slice(0, 4)}${"•".repeat(8)}${saved.slice(-4)}` : null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <Section id="display" title="Display" line="Follows your system until you pick one.">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-lg border border-edge bg-raised p-1 sm:w-fit">
          {(
            [
              ["system", "System", Monitor],
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
            ] as [Theme, string, typeof Sun][]
          ).map(([t, label, Icon]) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              onClick={() => setTheme(t)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium text-mute aria-checked:bg-card aria-checked:text-ink aria-checked:shadow-[var(--card-hi),var(--card-drop)]"
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
      </Section>

      <Section id="gemini-key" title="Your own Gemini key" line="Grades run on Google Gemini's free tier. For heavier use, add your own key: your grades then run on it instead.">
        <form
          className="grid grid-cols-1 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const k = key.trim();
            if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) {
              setStatus("invalid");
              return;
            }
            try {
              localStorage.setItem(KEY, k);
            } catch {}
            setSaved(k);
            setKey("");
            setStatus("saved");
          }}
        >
          {masked && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4 text-mute" aria-hidden /> Key in use: <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[13px]">{masked}</code>
              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.removeItem(KEY);
                  } catch {}
                  setSaved(null);
                  setStatus("removed");
                }}
                className="inline-flex items-center gap-1 text-sm font-semibold text-down hover:underline"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
              </button>
            </p>
          )}
          <label htmlFor="gk" className="text-sm font-medium">
            {masked ? "Replace the key" : "Gemini API key"}
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                id="gk"
                type={show ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setStatus("");
                }}
                placeholder="AIza..."
                aria-invalid={status === "invalid"}
                aria-describedby="gk-help"
                className="h-11 w-full rounded-lg border border-edge bg-card pl-3 pr-11 font-mono text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? "Hide key" : "Show key"}
                className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-md text-mute hover:text-ink"
              >
                {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
            <button type="submit" className="btn-sheen h-11 shrink-0 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill">
              Save key
            </button>
          </div>
          <p id="gk-help" className="text-sm text-mute" role="status">
            {status === "invalid"
              ? "That doesn't look like a Gemini key. They start with AIza."
              : status === "saved"
                ? "Saved in this browser only."
                : status === "removed"
                  ? "Removed. Grades use the free tier again."
                  : "Stored only in this browser, never on our servers. Get one free at aistudio.google.com."}
            {status === "saved" && <CircleCheck className="ml-1 inline h-4 w-4 text-up" aria-hidden />}
          </p>
        </form>
      </Section>

      <Section id="voting" title="Voting" line="How face-offs behave on this device.">
        <div className="flex items-center justify-between gap-4">
          <p id="autoopen-label" className="text-sm">
            <span className="block font-semibold">Open both sites when a new pair appears</span>
            <span className="block text-mute">Review the real pages before you pick. You may need to allow pop-ups.</span>
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={autoOpen}
            aria-labelledby="autoopen-label"
            onClick={() =>
              setAutoOpen((v) => {
                try {
                  localStorage.setItem("pr_autoopen", v ? "0" : "1");
                } catch {}
                return !v;
              })
            }
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${autoOpen ? "bg-fill" : "bg-edge-strong"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-all ${autoOpen ? "left-[1.375rem]" : "left-0.5"}`} />
          </button>
        </div>
      </Section>
    </div>
  );
}
