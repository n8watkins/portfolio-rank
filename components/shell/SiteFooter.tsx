import { Coffee } from "lucide-react";
import { SITE } from "@/lib/site";
import { Wordmark } from "@/components/shell/SiteHeader";

const COLS: { title: string; links: { href: string; label: string; ext?: boolean }[] }[] = [
  {
    title: "Rank",
    links: [
      { href: "/top", label: "Leaderboard" },
      { href: "/rank", label: "Face-off" },
      { href: "/play?mode=guess", label: "Guess the percentile" },
      { href: "/browse", label: "Browse" },
      { href: "/#grade", label: "Grade your portfolio" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "/about", label: "About" },
      { href: "/about#grading", label: "How grading works" },
      { href: "/blog", label: "Blog" },
      { href: "/polls", label: "Polls" },
      { href: "/removed", label: "Removed and why" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: SITE.github, label: "GitHub", ext: true },
      { href: SITE.submit, label: "Submit a portfolio", ext: true },
      { href: SITE.remove, label: "Remove my portfolio", ext: true },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-edge">
      <div className="wrap grid grid-cols-1 gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <Wordmark />
          <p className="mt-3 text-sm text-mute">
            The best developer portfolios, ranked by people and AI. List curated by{" "}
            <a href="https://github.com/emmabostian/developer-portfolios" className="underline decoration-edge underline-offset-4 hover:text-ink">
              Emma Bostian and 1,700+ contributors
            </a>
            .
          </p>
          <div className="mt-5 flex items-center gap-4">
            <a href={SITE.n8builds} target="_blank" rel="noopener" aria-label="n8builds.dev" className="opacity-90 transition hover:opacity-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/n8-icon.png" alt="n8builds" className="h-9 w-9 rounded-lg" />
            </a>
            <a href={SITE.kofi} className="group inline-flex items-center gap-1.5 text-sm text-mute transition hover:text-ink">
              <Coffee className="icon-shake h-4 w-4" aria-hidden /> Support on Ko-fi
            </a>
          </div>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="text-xs font-semibold uppercase tracking-wider text-mute">{c.title}</p>
            <ul className="mt-3 grid grid-cols-1 gap-2 text-sm">
              {c.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    {...(l.ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="text-ink/80 transition hover:text-ink"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-edge">
        <p className="wrap py-5 text-xs text-mute">
          Built by{" "}
          <a href={SITE.n8builds} target="_blank" rel="noopener" className="font-medium text-ink underline decoration-edge-strong underline-offset-4 hover:decoration-accent">
            n8builds
          </a>
          . Grades are estimates, not a verdict on the developer.
        </p>
      </div>
    </footer>
  );
}
