import Link from "next/link";

/** The admin pages, in one place, so every admin page links to the others the same way. */
export const ADMIN_PAGES = [
  { href: "/admin/usage", label: "Usage" },
  { href: "/admin/images", label: "Images" },
  { href: "/admin/blog", label: "Blog drafts" },
  { href: "/admin/polls", label: "Polls" },
] as const;

/** The admin pages' links; `current` is the page it sits on (marked aria-current). */
export function AdminNav({ current }: { current: (typeof ADMIN_PAGES)[number]["href"] }) {
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-1">
      {ADMIN_PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? "page" : undefined}
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-mute hover:bg-raised hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:text-ink"
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
