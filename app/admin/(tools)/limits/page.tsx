import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck, Clock, Database, Globe, HardDrive, ImageIcon, Mail, Search, Server } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { DANGER, SIZES, WARN, adminLimits } from "@/lib/admin/limits.mjs";
import { PRIMARY_MODEL } from "@/pipeline/gemini.mjs";

// /admin/limits: every free allowance the site depends on, against its
// limit, in one place (lib/admin/limits.mjs): what is used now, a bar that
// turns amber at 50% and red at 80%, when it was measured, and what the
// audit projects at 5,000, 20,000 and 50,000 portfolios
// (docs/audits/free-tier-limits.md). Account-wide numbers (Turso, R2,
// Workers) come from the daily snapshot (scripts/limits-snapshot.mjs); the
// rest the app counts itself. Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Limits - PortfolioRank admin", robots: { index: false, follow: false } };

type Row = Awaited<ReturnType<typeof adminLimits>>["rows"][number];

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

/** A value in its unit, short: 3.97 GB, 6.8M rows, 412 emails. */
function amount(v: number, unit: string) {
  if (unit === "bytes") {
    if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 2)} GB`;
    if (v >= 1e6) return `${Math.round(v / 1e6)} MB`;
    return `${Math.round(v / 1e3)} KB`;
  }
  const n = v >= 10000 ? compact.format(v) : whole.format(Math.round(v));
  return unit === "ms" ? `${n} ms` : n;
}
const pct = (share: number) => (share < 0.01 && share > 0 ? "under 1%" : `${Math.round(share * 100)}%`);
const periodText = { month: "this month", day: "today", total: "stored" } as const;

const TONE = {
  ok: { bar: "bg-up", text: "text-mute" },
  warn: { bar: "bg-fill", text: "text-ink" },
  danger: { bar: "bg-down", text: "text-down" },
  unknown: { bar: "bg-mute/40", text: "text-mute" },
} as const;

function when(at: string | null) {
  if (!at) return null;
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
}

function LimitRow({ r }: { r: Row }) {
  const tone = TONE[r.level as keyof typeof TONE];
  const share = r.share ?? 0;
  const label = `${r.label}, ${periodText[r.period as keyof typeof periodText]}`;
  return (
    <li className="py-3.5" data-limit={r.key} data-level={r.level}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="min-w-0 text-sm font-semibold">
          {r.label}
          {r.scope === "account" && <span className="ml-1.5 rounded-md bg-raised px-1.5 py-0.5 align-[1px] text-[11px] font-semibold text-mute">whole account</span>}
        </p>
        <p className="text-sm tabular-nums">
          {r.used == null ? (
            <span className="text-mute">not measured yet</span>
          ) : (
            <>
              <span className={`font-bold ${r.level === "danger" ? "text-down" : ""}`}>{amount(r.used, r.unit)}</span>{" "}
              <span className="text-mute">
                of {amount(r.cap, r.unit)} {periodText[r.period as keyof typeof periodText]}
              </span>
            </>
          )}
        </p>
      </div>
      <div
        className="relative mt-1.5 h-2 rounded-full bg-raised"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={r.share == null ? undefined : Math.min(100, Math.round(share * 100))}
        aria-valuetext={r.used == null ? "not measured yet" : `${pct(share)} of the free limit`}
      >
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${r.used == null ? 0 : Math.max(r.used > 0 ? 1.5 : 0, Math.min(1, share) * 100)}%` }} />
        {/* The warning line: act before a limit, not at it. */}
        <span aria-hidden className="absolute -top-0.5 h-3 w-px bg-ink/40" style={{ left: `${Math.round(r.warn * 100)}%` }} />
      </div>
      <p className={`mt-1 text-xs ${tone.text}`}>
        {r.share == null ? "" : `${pct(share)} used`}
        {r.share != null && r.shareLevel !== "ok" && (r.shareLevel === "danger" ? ", past the danger line" : ", past the warning line")}
        {r.pace != null && r.pace >= WARN && <span className={r.pace >= 0.9 ? "font-semibold text-down" : ""}>{`, on pace for ${pct(r.pace)} by the month's end`}</span>}
        {r.share != null && " · "}
        <span className="text-mute">Over the limit: {r.over}.</span>
      </p>
      {(r.at || r.stale) && r.source === "snapshot" && (
        <p className={`mt-0.5 flex items-center gap-1 text-xs ${r.stale ? "text-down" : "text-mute"}`}>
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          Measured {when(r.at)} Pacific{r.stale ? ", more than a day and a half ago" : ""}
        </p>
      )}
      {r.projections && (
        <div className="mt-2">
          <dl className="grid grid-cols-3 gap-1.5" aria-label={`${r.label}: projected use as the library grows`}>
            {r.projections.map((p) => (
              <div key={p.size} className="rounded-lg border border-edge bg-raised px-2 py-1.5">
                <dt className="text-[11px] text-mute">{compact.format(p.size)} sites</dt>
                <dd className={`text-sm font-semibold tabular-nums ${TONE[p.level as keyof typeof TONE].text}`}>{pct(p.share)}</dd>
              </div>
            ))}
          </dl>
          {r.projectionNote && <p className="mt-1 text-xs text-mute first-letter:uppercase">{r.projectionNote}</p>}
        </div>
      )}
    </li>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  "Turso (database)": <Database className="h-4 w-4" aria-hidden />,
  "R2 (screenshots and page cache)": <HardDrive className="h-4 w-4" aria-hidden />,
  Workers: <Server className="h-4 w-4" aria-hidden />,
  Google: <Globe className="h-4 w-4" aria-hidden />,
  Email: <Mail className="h-4 w-4" aria-hidden />,
  "Workers AI": <ImageIcon className="h-4 w-4" aria-hidden />,
  Search: <Search className="h-4 w-4" aria-hidden />,
};

export default async function AdminLimitsPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const l = await adminLimits(db(), { env: process.env, model: PRIMARY_MODEL });
  const groups = [...new Set(l.rows.map((r) => r.group))];
  const measured = l.rows.length - l.unmeasured;
  const attention = l.warnings + l.dangers;

  return (
    <>
      <AdminHeader title="Limits">
        Every free allowance the site runs on, against its limit. A bar turns amber at {Math.round(WARN * 100)}% and red at {Math.round(DANGER * 100)}%: act at amber, so nothing ever reaches a limit or a bill. Projections are for {SIZES.map((s) => compact.format(s)).join(", ")} portfolios.
      </AdminHeader>

      <div className="-mt-2 mb-6 flex flex-wrap gap-2 text-sm" aria-label="Summary">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-semibold ${attention ? "border-down/40 bg-down/5 text-down" : "border-up/40 bg-up/5"}`}>
          {attention ? <CircleAlert className="h-4 w-4" aria-hidden /> : <CircleCheck className="h-4 w-4 text-up" aria-hidden />}
          {attention ? `${attention} past the warning line` : "Everything under the warning line"}
        </span>
        <span className="inline-flex items-center rounded-full border border-edge px-3 py-1 text-mute">
          {measured} of {l.rows.length} measured
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border border-edge px-3 py-1 ${l.stale ? "text-down" : "text-mute"}`}>
          <Clock className="h-4 w-4" aria-hidden />
          {l.snapshotAt ? `Account snapshot ${when(l.snapshotAt)} Pacific` : "No account snapshot yet"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
        {groups.map((g) => {
          const rows = l.rows.filter((r) => r.group === g);
          const id = `limits-${g.toLowerCase().replace(/[^a-z]+/g, "-")}`;
          return (
            <section key={g} aria-labelledby={id} className="card p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <span className="icon-tile h-9 w-9 shrink-0">{ICONS[g]}</span>
                <h2 id={id} className="text-lg font-bold leading-tight tracking-tight">
                  {g}
                </h2>
              </div>
              <ul className="mt-1 divide-y divide-edge">
                {rows.map((r) => (
                  <LimitRow key={r.key} r={r} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="mt-6 max-w-3xl text-xs text-mute text-pretty">
        Account-wide rows (Turso, R2, Workers) are shared with the owner&apos;s other apps and come from the daily snapshot (scripts/limits-snapshot.mjs); the others are counted by this site as they happen. PageSpeed counts the results stored today, so a run that failed before storing is missed. The audit behind the projections is docs/audits/free-tier-limits.md.
      </p>
    </>
  );
}
