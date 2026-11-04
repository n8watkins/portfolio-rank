import type { ReactNode } from "react";

/** The frame for the not-found and error pages: logo, a label, a heading, one
 *  sentence and the ways out. */
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
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <a href="/" className="flex items-center gap-2 text-base font-bold tracking-tight">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pr-logo.svg" alt="" className="h-8 w-8" />
        <span>
          Portfolio<span className="text-accent">Rank</span>
        </span>
      </a>
      <p className="mt-10 text-xs font-semibold uppercase tracking-widest text-accent">{label}</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-mute text-pretty">{children}</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{actions}</div>
    </main>
  );
}

export const primaryButton =
  "rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const secondaryButton =
  "rounded-lg border border-edge px-5 py-2.5 text-sm font-semibold text-ink transition hover:border-mute focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
