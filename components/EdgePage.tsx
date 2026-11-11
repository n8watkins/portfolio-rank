import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import type { ReactNode } from "react";

/** The body of the not-found and error pages, inside the shell: a label, a
 *  heading, one sentence and the ways out. */
export function EdgePage({
  label,
  title,
  children,
  actions,
}: {
  label: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-widest text-accent">{label}</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-mute text-pretty">{children}</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{actions}</div>
    </div>
  );
}

// The shared button styles (components/ui/styles.ts).
export const primaryButton = btnPrimary;
export const secondaryButton = btnSecondary;
