import { LoaderCircle, Sparkles } from "lucide-react";
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
}: {
  current: NavKey;
  action: { href: string; label: string; done: boolean };
  signedIn: boolean;
  name: string;
}) {
  const ActionIcon = action.label === "Your report" ? LoaderCircle : Sparkles;
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Wordmark />
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
          <a
            href={action.href}
            aria-current={current === "grade" ? "page" : undefined}
            className={
              action.done
                ? "hidden h-9 items-center gap-2 rounded-lg border border-accent/50 px-3.5 text-sm font-semibold text-accent transition hover:border-accent lg:flex"
                : "hidden h-9 items-center gap-2 rounded-lg bg-fill px-3.5 text-sm font-semibold text-on-fill transition hover:opacity-90 lg:flex"
            }
          >
            <ActionIcon className="h-4 w-4" aria-hidden />
            {action.label}
          </a>
          <AccountMenu signedIn={signedIn} name={name} yourHref={action.href} yourLabel={action.done ? action.label : "Grade your portfolio"} />
        </div>
      </div>
    </header>
  );
}
