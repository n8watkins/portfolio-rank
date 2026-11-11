"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong"
    >
      {done ? <Check className="h-4 w-4 text-up" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      <span role="status">{done ? "Copied" : label}</span>
    </button>
  );
}
