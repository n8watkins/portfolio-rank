import excluded from "@/data/excluded.json";
import { SITE } from "@/lib/site";

export const metadata = {
  title: "Removed portfolios - PortfolioRank",
  description:
    "Portfolios PortfolioRank took off its list, with the reason and the date: sites confirmed down over two weeks of checks, duplicates and removal requests.",
};

type Removal = {
  url: string;
  name?: string;
  reason?: string;
  kind?: "down" | "duplicate" | "not_portfolio" | "owner_request";
  removed?: string;
};

const KIND_LABEL: Record<string, string> = {
  down: "Site down",
  duplicate: "Duplicate",
  not_portfolio: "Not a portfolio",
};

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
              Every week PortfolioRank checks each site on its list. A site is only
              removed after it fails three checks in a row spanning at least two
              weeks, so a short outage never takes anyone off. Bot checks that block
              automated visitors don&apos;t count as failures.
            </p>
            <p>
              Is your site back up, or was it removed by mistake?{" "}
              <a
                href={SITE.submit}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Submit it again
              </a>{" "}
              and it returns on the next sync.
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
