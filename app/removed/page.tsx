import excluded from "@/data/excluded.json";
import { REMOVED_KINDS } from "@/lib/removed-kinds.mjs";
import { SITE } from "@/lib/site";

export const metadata = {
  title: "Removed portfolios - PortfolioRank",
  description:
    "Portfolios PortfolioRank took off its list, with the reason and the date: sites that failed their checks for 90 days, duplicates, sites that are not a portfolio, and removal requests.",
};

type Removal = {
  url: string;
  name?: string;
  reason?: string;
  kind?: "down" | "dead" | "duplicate" | "not_portfolio" | "owner_request";
  removed?: string;
  duplicate_of?: string;
};

const KIND_LABEL: Record<string, string> = REMOVED_KINDS;

function domainOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

export default function RemovedPage() {
  // Old entries are bare URL strings with no reason; they aren't listed.
  const all = (excluded as unknown[]).filter(
    (e): e is Removal => typeof e === "object" && e !== null && "url" in e
  );
  // People who asked to be taken off are counted, never named.
  const requests = all.filter((e) => e.kind === "owner_request").length;
  const rows = all
    .filter((e) => e.kind !== "owner_request")
    .sort((a, b) => String(b.removed ?? "").localeCompare(String(a.removed ?? "")));

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
      <div>
        <div className="py-6">
          <h1 className="text-3xl font-bold tracking-tight">Removed portfolios</h1>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-mute">
            <p>
              PortfolioRank checks the sites on its list every night. A site that
              fails is checked again an hour later and once more the next day, and
              is hidden only if it still fails then. When the failure could be our
              own checker&apos;s mistake (the page looks empty, our screenshot never
              showed the site, it sends visitors to a social profile, or it repeats
              another site on the list), that last check comes a week later
              instead. A hidden site keeps being checked and comes back as soon as
              it works. It is taken off the list only after 90 days of failing
              checks, so a short outage never takes anyone off. Bot checks that
              block automated visitors don&apos;t count as failures.
            </p>
            <p>
              A site taken off because it was down or gone is checked again at least
              once a month. When it works again and still shows the same person (their
              name, or clearly a portfolio), it comes back as a new site and starts
              fresh: its old votes, rank and grade do not come with it.
            </p>
            <p>
              Was your site removed by mistake?{" "}
              <a
                href={SITE.submit}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Submit it again
              </a>{" "}
              and a person will look at it. A site taken off for being down or gone
              usually needs nothing: it comes back by itself once one of those
              checks passes.
            </p>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-xl border border-edge bg-card px-4 py-6 text-center text-sm text-mute">
            Nothing has been removed yet.
          </p>
        ) : (
          <ul className="divide-y divide-edge rounded-xl border border-edge bg-card">
            {rows.map((r) => (
              <li
                key={r.url}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{r.name ?? domainOf(r.url)}</p>
                  <p className="truncate text-xs text-mute">{domainOf(r.url)}</p>
                </div>
                <div className="shrink-0 text-xs text-mute sm:text-right">
                  <p>
                    <span className="font-semibold text-ink">
                      {KIND_LABEL[r.kind ?? "down"] ?? "Removed"}
                    </span>
                    {r.reason ? ` - ${r.reason}` : ""}
                  </p>
                  {r.removed ? <p>{r.removed}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {requests > 0 ? (
          <p className="mt-4 text-xs text-mute">
            Plus {requests.toLocaleString()} portfolio{requests === 1 ? "" : "s"} removed at the
            owner&apos;s request (not listed by name).
          </p>
        ) : null}
      </div>
    </div>
  );
}
