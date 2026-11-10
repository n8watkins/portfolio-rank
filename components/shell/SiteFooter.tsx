import { Coffee } from "lucide-react";
import { SITE } from "@/lib/site";
import { Wordmark } from "@/components/shell/SiteHeader";

const COLS: { title: string; links: { href: string; label: string; ext?: boolean }[] }[] = [
  {
    title: "Rank",
    links: [
      { href: "/top", label: "Leaderboard" },
      { href: "/rank", label: "Face-off" },
      { href: "/browse", label: "Browse" },
      { href: "/#grade", label: "Grade your portfolio" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "/how", label: "How grading works" },
      { href: "/blog", label: "Blog" },
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
      <div className="mx-auto grid grid-cols-1 max-w-6xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <Wordmark />
          <p className="mt-3 text-sm text-mute">
            The best developer portfolios, ranked by people and AI. List curated by{" "}
            <a href="https://github.com/emmabostian/developer-portfolios" className="underline decoration-edge underline-offset-4 hover:text-ink">
              Emma Bostian and 1,700+ contributors
            </a>
            .
          </p>
          <a
            href={SITE.kofi}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-edge px-3 text-sm font-semibold transition hover:border-mute"
          >
            <Coffee className="h-4 w-4 text-accent" aria-hidden /> Support on Ko-fi
          </a>
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
                    className="text-ink/85 transition hover:text-accent"
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
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-mute sm:px-6">
          Built by{" "}
          <a href={SITE.n8builds} className="underline decoration-edge underline-offset-4 hover:text-ink">
            n8builds.dev
          </a>
          . Grades are estimates, not a verdict on the developer.
        </p>
      </div>
    </footer>
  );
}
