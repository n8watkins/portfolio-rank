import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** What goes here, in one line, and the one thing to do about it. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className = "",
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  /** One button or link (btnPrimary or btnSecondary). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card flex flex-col items-center px-6 py-10 text-center ${className}`}>
      <span className="icon-tile h-11 w-11">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-4 font-semibold">{title}</p>
      {children && <p className="mt-1.5 max-w-sm text-sm text-mute text-pretty">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
