import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * The one page header every admin tool page uses (under the AdminNav that
 * app/admin/layout.tsx draws): an optional link back to the parent page, the
 * h1, a line or two saying what the page is, and actions on the right.
 */
export function AdminHeader({
  title,
  back,
  children,
  actions,
}: {
  title: string;
  /** A parent page, for pages one level down (guidelines, compare). */
  back?: { href: string; label: string };
  /** The description under the title. */
  children?: React.ReactNode;
  /** Links or buttons on the right (below the title on phones). */
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-6 pt-4" data-admin-header>
      <div className="min-w-0 max-w-3xl">
        {back && (
          <Link href={back.href} className="-ml-0.5 mb-1 inline-flex min-h-9 items-center gap-1.5 text-sm font-semibold text-mute hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden /> {back.label}
          </Link>
        )}
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {children && <div className="mt-1.5 text-sm text-mute text-pretty">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{actions}</div>}
    </header>
  );
}
