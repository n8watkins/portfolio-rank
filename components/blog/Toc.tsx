"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown } from "lucide-react";

// A post's table of contents (owner, 2026-11-12 and 2026-11-13). On wide
// screens a sticky rail beside the article that highlights the section being
// read; on phones and tablets a slim bar that sticks under the site header,
// names the current section and opens the list. Links are plain anchors (the
// page scrolls smoothly, and not at all with reduced motion; globals.css);
// the only script is the scroll-spy, one rAF-throttled read of the headings.

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
  const list = useRef<HTMLOListElement>(null);
  // Keep the highlighted entry in view when the rail itself scrolls (long posts).
  useEffect(() => {
    const el = active ? list.current?.querySelector<HTMLElement>(`[data-toc="${CSS.escape(active)}"]`) : null;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <ol ref={list} className="toc-list grid gap-0.5 border-l border-edge">
      {items.map(({ id, text }) => (
        <li key={id}>
          <a
            href={`#${id}`}
            data-toc={id}
            onClick={onPick}
            aria-current={active === id ? "location" : undefined}
            className="toc-link -ml-px block rounded-r-md border-l-2 border-transparent py-1.5 pl-3 pr-2 text-[13px] leading-snug text-mute transition-colors hover:border-edge-strong hover:text-ink aria-[current=location]:border-accent aria-[current=location]:bg-raised aria-[current=location]:font-medium aria-[current=location]:text-ink"
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
    <nav aria-label="On this page" className="sticky top-24 flex max-h-[calc(100vh-8rem)] flex-col pb-6">
      <p className="mb-2.5 pl-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">On this page</p>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        <Links items={items} active={active} />
      </div>
      <a href="#top" className="mt-4 inline-flex items-center gap-1.5 pl-3.5 text-[13px] text-mute transition-colors hover:text-ink">
        <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Back to top
      </a>
    </nav>
  );
}

/**
 * The bar above the TL;DR on phones and tablets: it sticks under the site
 * header, shows the section being read, and opens the list; a pick, Escape or
 * a tap outside closes it.
 */
export function TocToggle({ items }: { items: TocItem[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const active = useActiveSection(items);
  const current = items.find((i) => i.id === active)?.text;
  useEffect(() => {
    const close = () => ref.current?.removeAttribute("open");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, []);
  return (
    <details ref={ref} className="toc-toggle group rounded-xl border border-edge bg-card/95 shadow-[var(--card-hi)] backdrop-blur">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 font-semibold">On this page</span>
        {current && (
          <span className="min-w-0 truncate text-mute">
            <span aria-hidden>· </span>
            {current}
          </span>
        )}
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-mute transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <nav aria-label="On this page" className="max-h-[60vh] overflow-y-auto overscroll-contain border-t border-edge px-3 py-3">
        <Links items={items} active={active} onPick={() => ref.current?.removeAttribute("open")} />
      </nav>
    </details>
  );
}
