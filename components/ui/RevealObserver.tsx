"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Marks every `.reveal` block revealed as it scrolls into view (once).
 * Mounted once by the shell; it re-scans on every route change and whenever
 * new `.reveal` blocks are added (streamed or client-rendered content).
 * Without JavaScript the layout's <noscript> style shows them at once.
 */
export function RevealObserver() {
  const pathname = usePathname();
  useEffect(() => {
    const reveal = (el: Element) => ((el as HTMLElement).dataset.revealed = "");
    if (!("IntersectionObserver" in window)) {
      document.querySelectorAll(".reveal:not([data-revealed])").forEach(reveal);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          reveal(e.target);
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    const scan = () => document.querySelectorAll(".reveal:not([data-revealed])").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [pathname]);
  return null;
}
