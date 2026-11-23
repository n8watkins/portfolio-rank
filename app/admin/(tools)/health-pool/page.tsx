import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import excluded from "@/data/excluded.json";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { tag } from "@/components/ui/Chip";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { healthPool } from "@/lib/admin/health-pool.mjs";
import { ARCHIVE_EVERY_DAYS, ARCHIVE_FIRST_DAYS, LEAVE_AFTER_DAYS, RETURNS_SHOWN_DAYS } from "@/pipeline/not-working.mjs";

// /admin/health-pool (owner, 2026-11-23): the temporary pool and the archive,
// read-only. Sites failing their health checks never reach the review queue;
// this is where the owner sees them: what is failing now, what is hidden in
// the temporary pool (why, since when, the next check, the day it is
// archived), what is in the archive (when, why, the next archive check), and
// what came back in the last 30 days. The rules are in
// pipeline/not-working.mjs; the reads in lib/admin/health-pool.mjs. Only the
// admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Health pool - PortfolioRank admin", robots: { index: false, follow: false } };

type PoolSite = { url: string; name: string; reason: string; started: string | null; since: string | null; next: string | null; hidden: boolean; archiveOn: string | null };
type ArchiveSite = { url: string; name: string; kind: string; reason: string; archived: string | null; lastChecked: string | null; next: string };
type Returned = { url: string; at: string; from: "pool" | "archive"; reason: string; since: string | null; hidden: boolean };
type Elsewhere = { url: string; name: string; at: string; checked: string | null };
type Pool = { failing: PoolSite[]; pool: PoolSite[]; archive: ArchiveSite[]; returned: Returned[]; elsewhere: Elsewhere[] };

const n = (v: number) => v.toLocaleString("en-US");
const TZ = "America/Los_Angeles";
/** "Nov 23" for a day (YYYY-MM-DD, read as that day) or a time. */
const day = (v: string | null) => {
  if (!v) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T12:00:00Z`) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(v) ? "UTC" : TZ }) : null;
};
/** "Nov 23, 3 PM" for a re-check time (Pacific). */
const when = (v: string | null) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", timeZone: TZ }) : null;
};
// The address as listed (www kept): a duplicate and its original can differ by it alone.
const domainOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
};

const tagWrap = tag.replace("h-6", "min-h-6 py-0.5 leading-snug").replace("rounded-full", "rounded-xl");
const tagDown = `${tagWrap.replace("text-mute", "")} text-down ring-down/40`;
const tagUp = `${tagWrap.replace("text-mute", "")} text-up ring-up/40`;

/** One site: its address (a link to the site), its name, the reason, then the facts as phrases that each stay on one line. */
function Site({ url, name, reason, facts, badge, data }: { url: string; name: string; reason: string; facts: (string | null | false)[]; badge?: { text: string; cls: string }; data: Record<string, string> }) {
  const domain = domainOf(url);
  const parts = facts.filter((f): f is string => typeof f === "string" && f.length > 0);
  return (
    <li className="card p-4" {...data}>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 min-w-0 items-center gap-1 font-bold [overflow-wrap:anywhere] hover:text-accent">
          {domain}
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-mute" aria-hidden />
          <span className="sr-only">(opens the site)</span>
        </a>
        {name && name !== domain && <span className="min-w-0 truncate text-sm text-mute">{name}</span>}
      </p>
      {(reason || badge) && (
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1.5 text-sm text-pretty">
          {badge && <span className={badge.cls}>{badge.text}</span>}
          {reason && <span className="min-w-0 [overflow-wrap:anywhere]" data-reason>{reason}</span>}
        </p>
      )}
      {parts.length > 0 && (
        <p className="mt-1.5 text-xs text-mute tabular-nums" data-facts>
          {parts.map((p, i) => (
            <span key={p}>
              {i > 0 && " · "}
              <span className="whitespace-nowrap">{p}</span>
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

function Section({ id, title, count, about, empty, children }: { id: string; title: string; count: number; about: React.ReactNode; empty: string; children: React.ReactNode }) {
  return (
    // scroll-mt clears the sticky site header, so a count card's link lands on the section's heading.
    <section id={id} className="mt-8 scroll-mt-28" aria-labelledby={`${id}-heading`} data-health-section={id}>
      <h2 id={`${id}-heading`} className="flex flex-wrap items-baseline gap-x-2 text-lg font-bold tracking-tight">
        <span>{title}</span>
        <span className="text-sm font-semibold text-mute tabular-nums">{n(count)}</span>
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-mute text-pretty">{about}</p>
      {count === 0 ? <p className="card mt-3 p-5 text-sm text-mute">{empty}</p> : <ul className="mt-3 grid gap-2">{children}</ul>}
    </section>
  );
}

export default async function AdminHealthPoolPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const p = (await healthPool(db(), { excluded: excluded as unknown[] })) as Pool;
  const counts = [
    { id: "pool", label: "In the temporary pool", value: p.pool.length },
    { id: "failing", label: "Failing, not hidden yet", value: p.failing.length },
    { id: "returned", label: `Back in the last ${RETURNS_SHOWN_DAYS} days`, value: p.returned.length },
    { id: "archive", label: "In the archive", value: p.archive.length },
  ];

  return (
    <>
      <AdminHeader title="Health pool">
        Sites failing their health checks never come to your review list. A site that fails a check leaves the AI&rsquo;s work; when it still fails the next day it is hidden here, in the temporary pool, with its rank, votes, grade and
        captures kept. One passing check brings it back as it was. After {LEAVE_AFTER_DAYS} days it goes to the archive, which is checked again on days {ARCHIVE_FIRST_DAYS.join(", ")} and then every {ARCHIVE_EVERY_DAYS} days; one that passes comes back as a new site, starting fresh. Read only.
      </AdminHeader>

      <nav aria-label="Sections" className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-health-counts>
        {counts.map((c) => (
          <a key={c.id} href={`#${c.id}`} className="card card-hover flex min-w-0 flex-col p-4" data-count={c.id}>
            <span className="text-2xl font-bold leading-none tabular-nums">{n(c.value)}</span>
            <span className="mt-1.5 text-xs text-mute text-pretty">{c.label}</span>
          </a>
        ))}
      </nav>

      <Section
        id="pool"
        title="In the temporary pool"
        count={p.pool.length}
        about="Hidden from the list, rankings, tiers and games; its profile answers not found. Checked again daily for a week, weekly to day 30, then monthly."
        empty="None. No listed site is hidden for failing its checks."
      >
        {p.pool.map((s) => (
          <Site
            key={s.url}
            url={s.url}
            name={s.name}
            reason={s.reason || "no reason recorded"}
            data={{ "data-pool-site": s.url }}
            facts={[day(s.since ?? s.started) && `Hidden since ${day(s.since ?? s.started)}`, when(s.next) && `next check ${when(s.next)}`, day(s.archiveOn) && `archived ${day(s.archiveOn)} if it still fails`]}
          />
        ))}
      </Section>

      <Section
        id="failing"
        title="Failing, not hidden yet"
        count={p.failing.length}
        about="Failed one or two checks: out of grading and AI comparisons, still shown. Hidden only if the check the next day fails too."
        empty="None. Every listed site passed its last check."
      >
        {p.failing.map((s) => (
          <Site
            key={s.url}
            url={s.url}
            name={s.name}
            reason={s.reason || "no reason recorded"}
            data={{ "data-failing-site": s.url }}
            facts={[day(s.started) && `Failing since ${day(s.started)}`, when(s.next) && `next check ${when(s.next)}`]}
          />
        ))}
      </Section>

      <Section
        id="returned"
        title={`Back in the last ${RETURNS_SHOWN_DAYS} days`}
        count={p.returned.length}
        about="Sites that passed a check while failing or in the pool, back as they were; and sites back from the archive, which start fresh as new sites."
        empty="None."
      >
        {p.returned.map((s) => (
          <Site
            key={`${s.url}:${s.at}`}
            url={s.url}
            name=""
            reason={s.reason ? `Was: ${s.reason}` : ""}
            badge={{ text: s.from === "archive" ? "From the archive" : s.hidden ? "From the pool" : "Was failing", cls: tagUp }}
            data={{ "data-returned-site": s.url }}
            facts={[day(s.at) && `Back ${day(s.at)}`, day(s.since) && `${s.from === "archive" ? "archived" : "failing"} since ${day(s.since)}`]}
          />
        ))}
      </Section>

      {p.elsewhere.length > 0 && (
        <Section
          id="elsewhere"
          title="Listed address unreliable"
          count={p.elsewhere.length}
          about="The listed address failed its check, but the site answered at its own address with www or https, where it ended on an earlier read, so nothing was counted. The listed address may point at an old server."
          empty="None."
        >
          {p.elsewhere.map((s) => (
            <Site
              key={s.url}
              url={s.url}
              name={s.name}
              reason={`The site answers at ${s.at}`}
              data={{ "data-elsewhere-site": s.url }}
              facts={[day(s.checked) && `last checked ${day(s.checked)}`]}
            />
          ))}
        </Section>
      )}

      {/* Last: the longest list. */}
      <Section
        id="archive"
        title="In the archive"
        count={p.archive.length}
        about={
          <>
            Off the list after {LEAVE_AFTER_DAYS} days in the pool, or gone before the pool existed. One that passes its archive check comes back as a new site: captured, measured and ranked from code, with none of the old site&rsquo;s votes,
            rating, grade, face-offs, likes, claim or review decisions (we cannot know it is the same site). Removals as not a portfolio or by your decision are not here and never come back this way.
          </>
        }
        empty="None."
      >
        {p.archive.map((s) => (
          <Site
            key={s.url}
            url={s.url}
            name={s.name}
            reason={s.reason}
            badge={{ text: s.kind === "dead" ? "Gone" : "Down", cls: tagDown }}
            data={{ "data-archive-site": s.url }}
            facts={[day(s.archived) && `Archived ${day(s.archived)}`, day(s.lastChecked) && `last checked ${day(s.lastChecked)}`, day(s.next) && `next check ${day(s.next)}`]}
          />
        ))}
      </Section>
    </>
  );
}
