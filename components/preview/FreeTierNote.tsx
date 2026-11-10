import { Info, KeyRound } from "lucide-react";

/**
 * Shown wherever an action starts an AI grade (the grade boxes, /grade,
 * re-grade on /me). Calm and informative; nothing is disabled.
 */
export function FreeTierNote({ className = "", center = false }: { className?: string; center?: boolean }) {
  return (
    <p className={`flex items-start gap-1.5 text-xs leading-relaxed text-mute ${center ? "justify-center text-center lg:justify-start lg:text-left" : ""} ${className}`}>
      <Info className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Grades run on Google Gemini&apos;s free tier. Don&apos;t include private details; for heavier use you can add your own Gemini key.{" "}
        <a href="/settings#gemini-key" className="group inline-flex items-center gap-1 whitespace-nowrap font-semibold text-ink underline decoration-edge-strong underline-offset-4 hover:decoration-accent">
          <KeyRound className="h-3 w-3" aria-hidden /> Use your own key
        </a>
      </span>
    </p>
  );
}
