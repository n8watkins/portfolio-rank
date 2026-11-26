"use client";

import s from "./profile-next.module.css";

// An overview tile: a link to its card that glides there (unless the visitor
// asks for less motion) and outlines the card for a moment. Without script it
// is a plain in-page link.

export function TileLink({ target, className, children }: { target: string; className: string; children: React.ReactNode }) {
  return (
    <a
      href={`#${target}`}
      className={className}
      onClick={(e) => {
        const el = document.getElementById(target);
        if (!el) return;
        e.preventDefault();
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        history.replaceState(null, "", `#${target}`);
        el.classList.add(s.highlight);
        window.setTimeout(() => el.classList.remove(s.highlight), 1600);
      }}
    >
      {children}
    </a>
  );
}
