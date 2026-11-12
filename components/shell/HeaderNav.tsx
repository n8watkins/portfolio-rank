"use client";

import { usePathname } from "next/navigation";
import { Gamepad2 } from "lucide-react";
import { NAV, navKeyFor } from "@/lib/nav";
import { useBlogLive } from "@/components/shell/useBlogLive";

/** The desktop header's destinations; the current one is underlined in amber. */
export function HeaderNav() {
  const current = navKeyFor(usePathname() ?? "/");
  // Blog is last, so it appears without moving the others.
  const blogLive = useBlogLive();
  return (
    <nav aria-label="Main" className="hidden shrink-0 items-center gap-1 lg:flex">
      {NAV.filter((n) => n.key !== "blog" || blogLive).map((n) => (
        <a
          key={n.key}
          href={n.href}
          aria-current={current === n.key ? "page" : undefined}
          className={`group relative inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[15px] font-medium transition hover:bg-raised hover:text-ink aria-[current=page]:text-ink aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-3.5 aria-[current=page]:after:-bottom-[15px] aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-accent ${
            n.key === "play" ? "text-ink" : "text-mute"
          }`}
        >
          {n.key === "play" && <Gamepad2 className="icon-shake h-4 w-4 text-accent" aria-hidden />}
          {n.label}
        </a>
      ))}
    </nav>
  );
}
