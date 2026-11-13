import { Coffee } from "lucide-react";
import { SITE } from "@/lib/site";
import { ROUTES } from "@/lib/nav";
import { Wordmark } from "@/components/shell/Wordmark";
import { BlogFooterLink } from "@/components/shell/useBlogLive";
import { CONTRIBUTOR_COUNT_LABEL, PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";

type Link = { href: string | null; label: string; ext?: boolean };

const COLS: { title: string; links: Link[] }[] = [
  {
    title: "Rank",
    links: [
      { href: ROUTES.top, label: "Leaderboard" },
      { href: ROUTES.faceoff, label: "Face-off" },
      { href: ROUTES.guess, label: "Guess the percentile" },
      { href: ROUTES.browse, label: "Browse" },
      { href: ROUTES.grade, label: "Grade your portfolio" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: ROUTES.about, label: ROUTES.about === "/how" ? "How it works" : "About" },
      { href: ROUTES.grading === ROUTES.about ? null : ROUTES.grading, label: "How grading works" },
      { href: ROUTES.blog, label: "Blog" },
      { href: ROUTES.polls, label: "Polls" },
      { href: ROUTES.removed, label: "Removed and why" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: SITE.github, label: "GitHub", ext: true },
      { href: SITE.submit, label: "Submit a portfolio", ext: true },
      // Self-serve: prove the site is yours, then hide or remove it (app/claim).
      { href: "/claim", label: "Remove my portfolio" },
    ],
  },
];

// The policy pages (docs/legal), on every page.
const POLICIES = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/removal", label: "Remove or don't name me" },
];

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-edge">
      <div className="wrap grid grid-cols-1 gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <Wordmark />
          <p className="mt-3 text-sm text-mute">
            The best developer portfolios, ranked by people and AI. {PORTFOLIO_COUNT_LABEL} portfolios, listed by{" "}
            <a
              href="https://github.com/emmabostian/developer-portfolios"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-edge-strong underline-offset-4 transition hover:text-ink"
            >
              Emma Bostian and {CONTRIBUTOR_COUNT_LABEL} contributors
            </a>
            .
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
            <a
              href={SITE.n8builds}
              target="_blank"
              rel="noopener"
              aria-label="n8builds.dev, the maker of PortfolioRank"
              className="inline-flex min-h-11 items-center gap-2.5 rounded-lg text-sm font-medium text-ink/80 transition hover:text-ink"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/n8-icon.png" alt="" width={28} height={28} loading="lazy" className="h-7 w-7 rounded-md" />
              n8builds.dev
            </a>
            <a
              href={SITE.kofi}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex min-h-11 items-center gap-1.5 text-sm text-mute transition hover:text-ink"
            >
              <Coffee className="icon-shake h-4 w-4" aria-hidden /> Support on Ko-fi
            </a>
          </div>
        </div>
        {COLS.map((c) => (
          <nav key={c.title} aria-labelledby={`footer-${c.title}`}>
            <h2 id={`footer-${c.title}`} className="text-xs font-semibold uppercase tracking-wider text-mute">
              {c.title}
            </h2>
            <ul className="mt-3 grid grid-cols-1 gap-2 text-sm">
              {c.links
                .filter((l): l is Link & { href: string } => l.href !== null)
                .map((l) =>
                  // Shown once a post is published (components/shell/useBlogLive.ts).
                  l.href === ROUTES.blog ? (
                    <BlogFooterLink key={l.label} href={l.href} className="inline-block py-0.5 text-ink/80 transition hover:text-ink" />
                  ) : (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      {...(l.ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="inline-block py-0.5 text-ink/80 transition hover:text-ink"
                    >
                      {l.label}
                    </a>
                  </li>
                  )
                )}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-edge">
        <div className="wrap flex flex-col gap-3 py-5 text-xs text-mute sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <p>
            Built by{" "}
            <a
              href={SITE.n8builds}
              target="_blank"
              rel="noopener"
              className="font-medium text-ink underline decoration-edge-strong underline-offset-4 hover:decoration-accent"
            >
              n8builds.dev
            </a>
            . Grades are estimates, not a verdict on the developer.
          </p>
          <nav aria-label="Policies">
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {POLICIES.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="inline-block py-1 text-ink/80 transition hover:text-ink">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
