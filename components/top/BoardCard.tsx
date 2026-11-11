"use client";

import { useRef, useState } from "react";
import { btnSecondary } from "@/components/ui/styles";

/**
 * The board's card: the first rows, then the rest rendered on the server but
 * kept hidden (so their screenshots don't load) until "Show more". Focus
 * moves to the first new row so keyboard and screen reader users carry on
 * from there.
 */
export function BoardCard({ head, first, rest, restCount }: { head: React.ReactNode; first: React.ReactNode; rest: React.ReactNode; restCount: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLOListElement>(null);
  return (
    <>
      <div className="card rise mt-4 overflow-hidden" style={{ "--d": "120ms" } as React.CSSProperties}>
        {head}
        <ol>{first}</ol>
        {restCount > 0 && (
          <ol ref={ref} hidden={!open} className="border-t border-edge">
            {rest}
          </ol>
        )}
      </div>
      {restCount > 0 && !open && (
        <div className="mt-5 text-center">
          <button
            type="button"
            className={`${btnSecondary} h-10`}
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => ref.current?.querySelector("a")?.focus());
            }}
          >
            Show {restCount} more
          </button>
        </div>
      )}
    </>
  );
}
