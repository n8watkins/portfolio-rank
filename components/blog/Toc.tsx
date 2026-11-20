"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

// A post's table of contents (owner, 2026-11-12, after the Appturnity blog,
// toned down): on wide screens a sticky rail beside the article that marks
// the section being read; on phones and tablets a small "On this page"
// toggle above the TL;DR. Links are plain anchors (the page already scrolls
// smoothly, and not at all with reduced motion; globals.css); the only
// script is the scroll-spy, one rAF-throttled read of the headings' tops.

export type TocItem = { id: string; text: string };

/** The id of the section being read: the last heading above a line 30% down the screen. */
function useActiveSection(items: TocItem[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let current: string | null = null;
      for (const { id } of items) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      // At the very end of the page the last section is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = items.at(-1)?.id ?? current;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items]);
  return active;
}

function Links({ items, active, onPick }: { items: TocItem[]; active: string | null; onPick?: () => void }) {
  return (
    <ol className="toc-list grid border-l border-edge">
      {items.map(({ id, text }) => (
        <li key={id}>
          <a
            href={`#${id}`}
            onClick={onPick}
            aria-current={active === id ? "location" : undefined}
            className="toc-link -ml-px block border-l-2 border-transparent py-1.5 pl-3.5 pr-2 text-[13.5px] leading-snug text-mute transition-colors hover:border-edge-strong hover:text-ink aria-[current=location]:border-accent aria-[current=location]:font-medium aria-[current=location]:text-ink"
          >
            {text}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The sticky rail beside the article (wide screens). */
export function TocRail({ items }: { items: TocItem[] }) {
  const active = useActiveSection(items);
  return (
    <nav aria-label="On this page" className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pb-6">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-mute">On this page</p>
      <Links items={items} active={active} />
    </nav>
  );
}

/** The "On this page" toggle above the TL;DR (phones and tablets); closes after a pick. */
export function TocToggle({ items }: { items: TocItem[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={ref} className="toc-toggle group card mb-6 overflow-hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        On this page
        <ChevronDown className="h-4 w-4 text-mute transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <nav aria-label="On this page" className="border-t border-edge px-4 py-3">
        <Links items={items} active={null} onPick={() => ref.current?.removeAttribute("open")} />
      </nav>
    </details>
  );
}
