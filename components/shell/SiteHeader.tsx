import { Ban, Clock, Sparkles, UserRound } from "lucide-react";
import { AccountMenu } from "@/components/shell/AccountMenu";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { NAV, type NavKey } from "@/components/shell/nav";

export function Wordmark() {
  return (
    <a href="/" className="flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/pr-logo.svg" alt="" className="h-7 w-7" />
      <span>
        Portfolio<span className="text-accent">Rank</span>
      </span>
    </a>
  );
}

export function SiteHeader({
  current,
  action,
  signedIn,
  name,
  blocked = false,
}: {
  current: NavKey;
  action: { href: string; label: string; done: boolean };
  signedIn: boolean;
  name: string;
  blocked?: boolean;
}) {
  const ActionIcon = action.label === "Your report" ? Clock : action.done ? UserRound : Sparkles;
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Wordmark />
          <a
            href="https://n8builds.dev"
            target="_blank"
            rel="noopener"
            className="hidden items-center gap-1.5 border-l border-edge pl-3 text-xs font-medium text-mute transition hover:text-ink xl:flex"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/n8-logo.png" alt="" className="h-4 w-4 rounded" />
            by n8builds
          </a>
        </div>
        <nav aria-label="Main" className="hidden flex-1 items-center gap-1 lg:flex">
          {NAV.map((n) => (
            <a
              key={n.key}
              href={n.href}
              aria-current={current === n.key ? "page" : undefined}
              className="relative rounded-lg px-3 py-2 text-sm font-medium text-mute transition hover:text-ink aria-[current=page]:text-ink aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-3 aria-[current=page]:after:-bottom-[11px] aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-accent"
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {blocked && !action.done ? (
            <span
              title="AI grading is off in the UK, the EU/EEA and Switzerland."
              className="hidden h-9 cursor-not-allowed items-center gap-2 rounded-lg border border-dashed border-edge-strong px-3.5 text-sm font-semibold text-mute lg:flex"
            >
              <Ban className="h-4 w-4" aria-hidden /> Grading off here
            </span>
          ) : (
          <a
            href={action.href}
            aria-current={current === "grade" ? "page" : undefined}
            className={
              action.done
                ? "group hidden h-9 items-center gap-2 rounded-lg border border-edge-strong bg-card px-3.5 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-accent/60 lg:flex"
                : "group btn-sheen hidden h-9 items-center gap-2 rounded-lg bg-fill px-3.5 text-sm font-semibold text-on-fill transition lg:flex"
            }
          >
            <ActionIcon className={action.done ? "h-4 w-4" : "icon-twinkle h-4 w-4"} aria-hidden />
            {action.label}
          </a>
          )}
          <AccountMenu signedIn={signedIn} name={name} yourHref={action.href} yourLabel={action.done ? action.label : "Grade your portfolio"} />
        </div>
      </div>
    </header>
  );
}
