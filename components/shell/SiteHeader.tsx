import { Clock, Sparkles, UserRound } from "lucide-react";
import { SITE } from "@/lib/site";
import type { PrimaryAction } from "@/lib/nav";
import { AccountMenu } from "@/components/shell/AccountMenu";
import { HeaderNav } from "@/components/shell/HeaderNav";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Wordmark } from "@/components/shell/Wordmark";

/**
 * The maker's mark beside the logo: the n8 icon and "n8builds.dev". When the
 * header is too narrow for the name, it wraps onto a second line that the
 * fixed height clips, so only the icon shows; no breakpoint guesses.
 */
function MakerLink() {
  return (
    <a
      href={SITE.n8builds}
      target="_blank"
      rel="noopener"
      aria-label="n8builds.dev, the maker of PortfolioRank"
      className="flex h-8 min-w-[2.125rem] flex-wrap content-start items-center gap-x-1.5 overflow-hidden border-l border-edge pl-3 text-xs font-medium text-mute transition hover:text-ink"
    >
      {/* Each item is a full 32 px line, so a wrapped name lands wholly below the clip. */}
      <span className="flex h-8 shrink-0 items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/n8-icon.png" alt="" width={16} height={16} className="h-4 w-4 rounded" />
      </span>
      <span className="h-8 whitespace-nowrap leading-8">n8builds.dev</span>
    </a>
  );
}

export function SiteHeader({ action }: { action: PrimaryAction | null }) {
  const ActionIcon = action?.label === "Your report" ? Clock : action?.done ? UserRound : Sparkles;
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-bg/85 backdrop-blur">
      <div className="wrap flex h-16 items-center gap-3 sm:gap-6 lg:gap-8">
        <div className="flex min-w-0 items-center gap-3">
          <Wordmark />
          <MakerLink />
        </div>
        <HeaderNav />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Below 360 px the toggle gives way; the theme stays in the More sheet. */}
          <ThemeToggle className="max-[359px]:hidden" />
          {action && (
            <a
              href={action.href}
              className={
                action.done
                  ? "group hidden h-10 items-center gap-2 rounded-lg border border-edge-strong bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-accent/60 lg:flex"
                  : "group btn-sheen hidden h-10 items-center gap-2 rounded-lg bg-fill px-4 text-sm font-semibold text-on-fill transition lg:flex"
              }
            >
              <ActionIcon className={action.done ? "h-4 w-4" : "icon-twinkle h-4 w-4"} aria-hidden />
              {action.label}
            </a>
          )}
          <AccountMenu action={action} />
        </div>
      </div>
    </header>
  );
}
