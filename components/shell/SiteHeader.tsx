import { Clock, Sparkles, UserRound } from "lucide-react";
import { AccountMenu } from "@/components/shell/AccountMenu";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { NAV, type NavKey } from "@/components/shell/nav";

export function Wordmark() {
  return (
    <a href="/" className="flex shrink-0 items-center gap-2.5 text-[17px] font-bold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/pr-logo.svg" alt="" className="h-8 w-8" />
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
}: {
  current: NavKey;
  action: { href: string; label: string; done: boolean };
  signedIn: boolean;
  name: string;
}) {
  const ActionIcon = action.label === "Your report" ? Clock : action.done ? UserRound : Sparkles;
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-bg/85 backdrop-blur">
      <div className="wrap flex h-16 items-center gap-8">
        <div className="flex items-center gap-3">
          <Wordmark />
          <a
            href="https://n8builds.dev"
            target="_blank"
            rel="noopener"
            className="hidden items-center gap-1.5 border-l border-edge pl-3 text-xs font-medium text-mute transition hover:text-ink xl:flex"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/n8-icon.png" alt="" className="h-4 w-4 rounded" />
            by n8builds
          </a>
        </div>
        <nav aria-label="Main" className="hidden flex-1 items-center gap-1 lg:flex">
          {NAV.map((n) => (
            <a
              key={n.key}
              href={n.href}
              aria-current={current === n.key ? "page" : undefined}
              className="relative rounded-lg px-3.5 py-2 text-[15px] font-medium text-mute transition hover:bg-raised hover:text-ink aria-[current=page]:text-ink aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-3.5 aria-[current=page]:after:-bottom-[15px] aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-accent"
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <a
            href={action.href}
            aria-current={current === "grade" ? "page" : undefined}
            className={
              action.done
                ? "group hidden h-10 items-center gap-2 rounded-lg border border-edge-strong bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-accent/60 lg:flex"
                : "group btn-sheen hidden h-10 items-center gap-2 rounded-lg bg-fill px-4 text-sm font-semibold text-on-fill transition lg:flex"
            }
          >
            <ActionIcon className={action.done ? "h-4 w-4" : "icon-twinkle h-4 w-4"} aria-hidden />
            {action.label}
          </a>
          <AccountMenu signedIn={signedIn} name={name} yourHref={action.href} yourLabel={action.done ? action.label : "Grade your portfolio"} />
        </div>
      </div>
    </header>
  );
}
