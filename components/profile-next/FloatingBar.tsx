"use client";

import { useEffect, useRef } from "react";
import s from "./profile-next.module.css";

// The bar the hero folds into as the reader scrolls: pinned under the site
// header, with the site's picture, its tier and name, "role · address", and
// Like, Bookmark, Share and Visit. --p (0 to 1) runs from when a third of the
// hero has scrolled under the header to when it has nearly gone; the bar
// slides down from under the header as it grows, and the hero fades a little
// (profile-next.module.css). With reduced motion there is no in-between: the
// bar simply shows. While it is folded away it is hidden from screen readers
// and out of the tab order.

export function FloatingBar({ rootId, heroId, children }: { rootId: string; heroId: string; children: React.ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.getElementById(rootId);
    const hero = document.getElementById(heroId);
    if (!root || !hero) return;
    let raf = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      raf = 0;
      const head = parseFloat(getComputedStyle(root).getPropertyValue("--header-h")) || 64;
      const r = hero.getBoundingClientRect();
      const gone = head - r.top;
      let p = Math.min(1, Math.max(0, (gone - r.height * 0.3) / Math.max(1, r.height * 0.55)));
      if (reduce.matches) p = p >= 0.5 ? 1 : 0;
      root.style.setProperty("--p", p.toFixed(3));
      const state = p >= 0.5 ? "on" : p > 0 ? "vis" : "";
      if (root.dataset.bar !== state) {
        if (state) root.dataset.bar = state;
        else delete root.dataset.bar;
        const b = bar.current;
        if (b) {
          b.inert = state !== "on";
          b.setAttribute("aria-hidden", String(state !== "on"));
        }
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [rootId, heroId]);

  return (
    <div ref={bar} className={s.pbar} aria-hidden inert>
      {children}
    </div>
  );
}
