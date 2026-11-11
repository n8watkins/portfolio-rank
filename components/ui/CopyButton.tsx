"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";

/** Copies text (a share link, a badge snippet) and says so for two seconds. */
export function CopyButton({
  text,
  label = "Copy",
  className = "",
  buttonClass,
  icon: Icon = Copy,
  onCopied,
}: {
  text: string;
  label?: string;
  className?: string;
  /** Replaces the default look (btnPrimary, say). */
  buttonClass?: string;
  icon?: LucideIcon;
  onCopied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
      onCopied?.();
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={`${buttonClass ?? "inline-flex h-11 items-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong sm:h-9"} ${className}`}
    >
      {state === "done" ? <Check className={`h-4 w-4 ${buttonClass ? "" : "text-up"}`} aria-hidden /> : <Icon className="h-4 w-4" aria-hidden />}
      <span>{state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
      <span role="status" className="sr-only">
        {state === "done" ? "Copied to the clipboard" : state === "failed" ? "Couldn't copy; select the text and copy it yourself" : ""}
      </span>
    </button>
  );
}
