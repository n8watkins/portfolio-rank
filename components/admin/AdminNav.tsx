"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The admin pages, in one place, so every admin page links to the others the same way. */
export const ADMIN_PAGES = [
  { href: "/admin/usage", label: "Usage" },
  { href: "/admin/images", label: "Images" },
  { href: "/admin/blog", label: "Blog drafts" },
  { href: "/admin/polls", label: "Polls" },
] as const;

/**
 * The admin pages' links, drawn once by app/admin/layout.tsx above every
 * admin page. The page you are on, or the section it belongs to (a draft,
 * the guidelines and compare pages sit under Blog drafts), is marked
 * aria-current.
 */
export function AdminNav() {
  const path = usePathname() ?? "";
  return (
    <nav aria-label="Admin" className="-mx-1 flex items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] sm:gap-1">
      <span className="mr-1 shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-accent">Admin</span>
      {ADMIN_PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={path === p.href ? "page" : path.startsWith(`${p.href}/`) ? "true" : undefined}
          className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-2.5 text-sm sm:px-3 font-semibold text-mute hover:bg-raised hover:text-ink [&[aria-current]]:bg-raised [&[aria-current]]:text-ink"
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
