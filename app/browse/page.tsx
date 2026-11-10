import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { TierBadge, card } from "@/components/preview/bits";
import { ROLES, leaderboard, roster } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Browse portfolios - PortfolioRank" };

const PER_PAGE = 24;

type SP = { state?: string; q?: string; role?: string; sort?: string; page?: string };

function href(sp: SP, patch: Partial<SP>) {
  const u = new URLSearchParams();
  const m = { ...sp, ...patch };
  for (const k of ["q", "role", "sort", "page"] as const) if (m[k]) u.set(k, String(m[k]));
  const s = u.toString();
  return `/browse${s ? `?${s}` : ""}`;
}

export default async function BrowsePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const q = (sp.q ?? "").trim().toLowerCase();
  const role = ROLES.find((r) => r.key === sp.role);
  const sort = sp.sort === "az" ? "az" : "rank";
  const rankOf = new Map(leaderboard("merged").map((r) => [r.url, r]));
  let list = roster().filter(
    (s) =>
      (!q || s.name.toLowerCase().includes(q) || s.domain.includes(q) || s.tagline?.toLowerCase().includes(q)) &&
      (!role || (s.tagline && role.re.test(s.tagline)))
  );
  list =
    sort === "az"
      ? [...list].sort((a, b) => a.name.localeCompare(b.name))
      : [...list].sort((a, b) => (rankOf.get(a.url)?.rank ?? 1e6) - (rankOf.get(b.url)?.rank ?? 1e6) || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number(sp.page) || 1));
  const shown = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const chip =
    "inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-medium transition aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent";

  return (
    <AppShell visitor={v} current="browse">
      <div className="py-8 sm:py-10">
        <h1 className="rise text-3xl font-bold tracking-tight">Browse</h1>
        <p className="mt-1.5 text-sm text-mute">
          All {roster().length.toLocaleString()} portfolios. Search, filter by role, and share the link: filters live in the address.
        </p>

        <form action="/browse" className="rise mt-5 flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search portfolios
          </label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={sp.q}
              placeholder="Search by name, role or domain"
              className="h-11 w-full rounded-lg border border-edge bg-card pl-10 pr-3 text-[15px] outline-none placeholder:text-mute/80 focus:border-accent"
            />
          </div>
          {role && <input type="hidden" name="role" value={role.key} />}
          {sort === "az" && <input type="hidden" name="sort" value="az" />}
          <button type="submit" className="h-11 shrink-0 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong">
            Search
          </button>
        </form>

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Filter by role" className="flex flex-wrap gap-2">
          <a href={href(sp, { role: undefined, page: undefined })} aria-current={!role} className={`${chip} border-edge`}>
            All roles
          </a>
          {ROLES.map((r) => (
            <a key={r.key} href={href(sp, { role: r.key, page: undefined })} aria-current={role?.key === r.key} className={`${chip} border-edge`}>
              {r.label}
            </a>
          ))}
        </nav>
        <nav aria-label="Sort" className="inline-flex w-fit shrink-0 rounded-lg border border-edge bg-raised p-1">
          {[
            { key: "rank", label: "Top ranked" },
            { key: "az", label: "A to Z" },
          ].map((o) => (
            <a
              key={o.key}
              href={href(sp, { sort: o.key === "rank" ? undefined : o.key, page: undefined })}
              aria-current={sort === o.key ? "page" : undefined}
              className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-mute transition hover:text-ink aria-[current=page]:bg-card aria-[current=page]:text-ink aria-[current=page]:shadow-[var(--card-hi),var(--card-drop)]"
            >
              {o.label}
            </a>
          ))}
        </nav>
        </div>

        <p className="mt-5 text-sm text-mute" aria-live="polite">
          {list.length.toLocaleString()} {list.length === 1 ? "portfolio" : "portfolios"}
          {pages > 1 && ` · page ${page} of ${pages}`}
        </p>

        {shown.length === 0 ? (
          <div className={`${card} mt-3 p-10 text-center`}>
            <p className="font-semibold">No portfolios match &quot;{sp.q}&quot;.</p>
            <a href={href(sp, { q: undefined, page: undefined })} className="mt-2 inline-block text-sm font-semibold text-accent hover:underline">
              Clear the search
            </a>
          </div>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((s) => {
              const r = rankOf.get(s.url);
              return (
                <li key={s.url}>
                  <a href={r ? `/grade/${s.slug}` : s.url} className={`${card} group block overflow-hidden card-hover`}>
                    <Shot base={s.shot} alt="" domain={s.domain} className="aspect-[16/10] w-full border-b border-edge" />
                    <div className="flex items-center gap-3 p-3.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold group-hover:text-accent">{s.name}</span>
                        <span className="block truncate text-sm text-mute">{s.tagline ?? s.domain}</span>
                      </span>
                      {r ? (
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-sm font-semibold tabular-nums text-mute">#{r.rank}</span>
                          <TierBadge tier={r.grade!.tier} />
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-mute">Not graded</span>
                      )}
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        {pages > 1 && (
          <nav aria-label="Pages" className="mt-8 flex items-center justify-center gap-2">
            {page > 1 ? (
              <a href={href(sp, { page: String(page - 1) })} className="inline-flex h-10 items-center gap-1 rounded-lg border border-edge px-3 text-sm font-semibold hover:border-mute">
                <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
              </a>
            ) : null}
            <span className="px-2 text-sm text-mute tabular-nums">
              {page} / {pages}
            </span>
            {page < pages ? (
              <a href={href(sp, { page: String(page + 1) })} className="inline-flex h-10 items-center gap-1 rounded-lg border border-edge px-3 text-sm font-semibold hover:border-mute">
                Next <ChevronRight className="h-4 w-4" aria-hidden />
              </a>
            ) : null}
          </nav>
        )}
      </div>
    </AppShell>
  );
}
