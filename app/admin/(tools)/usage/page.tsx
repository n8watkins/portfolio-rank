import { notFound } from "next/navigation";
import { Bot, Clock, Gauge, ImageIcon, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { requireAdmin } from "@/lib/admin";
import { adminUsage, type UsageDay } from "@/lib/admin/usage";
import { PEOPLE_JOBS } from "@/pipeline/budget.mjs";

// The admin usage page: what the site spends of its free allowances, in
// plain words, from lib/admin/usage.ts (the same data as GET
// /api/admin/quota). Gemini today per model and per job, what each job may
// still spend, people's grades and the grades still on their way, the last
// 30 days, the monthly and daily caps of Tavily, Pexels and Workers AI, and
// a line on when site checks re-ran (AUTOMATION.md "When checks re-run").
// Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Usage - PortfolioRank admin", robots: { index: false, follow: false } };

const n = (v: number) => Math.round(v).toLocaleString("en-US");
const modelName = (m: string) =>
  m
    .replace(/^gemini-/, "Gemini ")
    .replace(/-flash-lite$/, " Flash-Lite")
    .replace(/-flash$/, " Flash")
    .replace(/-pro$/, " Pro");
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** One meter: "Label: N of M unit", a bar that turns amber at 75% and red at 90%. */
function Meter({ label, used, cap, unit, note }: { label: string; used: number; cap: number; unit: string; note?: string }) {
  const share = cap > 0 ? Math.min(1, used / cap) : 0;
  const tone = share >= 0.9 ? "bg-down" : share >= 0.75 ? "bg-fill" : "bg-up";
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-sm tabular-nums">
          <span className="font-bold">{n(used)}</span> <span className="text-mute">of {cap > 0 ? `${n(cap)} ${unit}` : `no cap set`}</span>
        </p>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap || 1}
        aria-valuenow={Math.min(used, cap || used)}
        aria-valuetext={`${n(used)} of ${n(cap)} ${unit}`}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(used > 0 ? 2 : 0, share * 100)}%` }} />
      </div>
      {note && <p className="mt-1 text-xs text-mute">{note}</p>}
    </div>
  );
}

function Card({ id, icon, title, note, children }: { id: string; icon: React.ReactNode; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="card p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="icon-tile h-9 w-9 shrink-0">{icon}</span>
        <div className="min-w-0">
          <h2 id={id} className="text-lg font-bold leading-tight tracking-tight">
            {title}
          </h2>
          {note && <p className="mt-0.5 text-sm text-mute">{note}</p>}
        </div>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** The last 30 days as small bars, today on the right. */
function History({ days, model, quota }: { days: UsageDay[]; model: string; quota: number }) {
  const list = [...days].reverse();
  const max = Math.max(quota, ...list.map((d) => Object.values(d.total).reduce((a, b) => a + b, 0)), 1);
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={`Gemini requests a day for the last ${list.length} days`}>
        {list.map((d) => {
          const total = Object.values(d.total).reduce((a, b) => a + b, 0);
          const main = d.total[model] ?? 0;
          return (
            <div key={d.day} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${dayLabel(d.day)}: ${n(total)} requests`}>
              <div className="w-full rounded-t-sm bg-fill/80 group-hover:bg-fill" style={{ height: `${(main / max) * 100}%` }} />
              {total > main && <div className="w-full bg-mute/40" style={{ height: `${((total - main) / max) * 100}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-mute">
        <span>{list[0] ? dayLabel(list[0].day) : ""}</span>
        <span>Today</span>
      </div>
      {quota > 0 && <p className="mt-1 text-xs text-mute">The top of the chart is the daily allowance of {n(quota)} {modelName(model)} requests; grey is other models.</p>}
    </div>
  );
}

export default async function AdminUsagePage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  const u = await adminUsage({ days: 30 });
  const models = [...new Set([u.model, ...Object.keys(u.quota), ...Object.keys(u.now.used)])];
  const todayJobs = u.today?.jobs ?? [];
  const peopleToday = todayJobs.filter((j) => j.job in PEOPLE_JOBS).reduce((a, j) => a + j.requests, 0);
  const queued = Object.values(u.gradeJobs).reduce((a, b) => a + b, 0);
  const peopleWaiting = u.peopleQueue.queued ?? 0;
  const ai = u.aiImages as null | { images: number; maxImages: number; neurons: number; ceiling: number; lastHour: number; perHour: number; problem: string | null; monthImages: number };
  const tavily = u.tavily as { used: number; cap: number };
  const pexels = u.pexels as { used: number; cap: number };
  const alerts = u.alerts as { key: string; message?: string; title?: string }[];
  // When checks re-run (lib/freshness.mjs).
  const fresh = u.freshness as null | { unchanged: number; changedThisWeek: number; unchecked: number; checkedToday: number; remeasuredToday: { lighthouse: number; polish: number; screenshots: number; links: number; total: number } };

  return (
    <>
      <AdminHeader title="Usage">
        {u.now.day ? `Today is ${u.now.day} in Pacific time; ` : "Days are counted in Pacific time; "}Gemini&apos;s allowance resets at midnight Pacific. Every metered call is capped and stops at its limit, so nothing here can bill.
      </AdminHeader>
      {fresh && (
        <p className="-mt-2 mb-6 flex items-start gap-2 text-sm" aria-label="Site checks">
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
          <span>
            <span className="font-semibold">Site checks:</span> {n(fresh.unchanged)} unchanged, {n(fresh.changedThisWeek)} changed this week, {n(fresh.remeasuredToday.total)} re-measured today
            <span className="text-mute">
              {" "}
              (Lighthouse {n(fresh.remeasuredToday.lighthouse)}, polish {n(fresh.remeasuredToday.polish)}, screenshots {n(fresh.remeasuredToday.screenshots)}, links {n(fresh.remeasuredToday.links)}; {n(fresh.checkedToday)} fingerprints checked today
              {fresh.unchecked > 0 ? `, ${n(fresh.unchecked)} not checked yet` : ""})
            </span>
          </span>
        </p>
      )}
      {alerts.length > 0 && (
        <ul className="-mt-2 mb-6 grid gap-2" aria-label="Owner alerts">
          {alerts.map((a) => (
            <li key={a.key} className="flex items-start gap-2 rounded-xl border border-down/40 bg-down/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden /> {a.title ?? a.message ?? a.key}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card id="gemini" icon={<Bot className="h-4 w-4" aria-hidden />} title="Gemini today" note="Requests since midnight Pacific, retries included.">
          <div className="divide-y divide-edge">
            {models.map((m) => (
              <Meter
                key={m}
                label={`${modelName(m)} today`}
                used={u.now.used[m] ?? 0}
                cap={u.quota[m] ?? 0}
                unit="requests"
                note={m === u.model ? `People can still use ${n(u.now.people)} today; ${n(u.now.reserve)} are kept for them while the background runs.` : undefined}
              />
            ))}
          </div>
        </Card>

        <Card id="queue" icon={<Clock className="h-4 w-4" aria-hidden />} title="Grades on their way" note="People's grade requests that haven't finished yet.">
          <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ["Queued for Gemini", peopleWaiting, "wait for the hourly drain"],
              ["Still in progress", queued, "capturing, grading or waiting"],
              ["People's requests today", peopleToday, "Gemini requests"],
            ].map(([label, value, hint]) => (
              <div key={String(label)} className="rounded-lg border border-edge bg-raised px-3 py-2">
                <dt className="text-xs font-semibold text-mute">{label}</dt>
                <dd className="mt-0.5 text-xl font-bold tabular-nums">{n(Number(value))}</dd>
                <dd className="text-xs text-mute">{hint}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(u.gradeJobs).length > 0 && (
            <p className="mt-3 text-xs text-mute">
              {Object.entries(u.gradeJobs)
                .map(([s, c]) => `${n(c)} ${s.replace("_", " ")}`)
                .join(", ")}
            </p>
          )}
        </Card>

        <Card id="jobs" icon={<Gauge className="h-4 w-4" aria-hidden />} title="Gemini by job today" note={`${modelName(u.model)}: each job's daily cap, and what it may still spend now.`}>
          <div className="divide-y divide-edge">
            {u.now.background.map((s) => (
              <Meter
                key={s.key}
                label={s.label}
                used={s.used}
                cap={s.cap}
                unit="requests"
                note={s.allowed > 0 ? `Can spend ${n(s.allowed)} more now.` : s.limitedBy === "quota" ? "Paused: the rest of today's allowance is kept for people." : "Done for today: its cap is reached."}
              />
            ))}
          </div>
          {todayJobs.filter((j) => j.job in PEOPLE_JOBS).length > 0 && (
            <ul className="mt-2 grid gap-1 text-sm">
              {todayJobs
                .filter((j) => j.job in PEOPLE_JOBS)
                .map((j) => (
                  <li key={`${j.job}-${j.model}`} className="flex justify-between gap-3">
                    <span>{j.label}</span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums text-mute">
                      {n(j.requests)} ({n(j.ok)} answered)
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <div className="grid gap-5">
          <Card id="history" icon={<Bot className="h-4 w-4" aria-hidden />} title="Gemini, the last 30 days">
            <History days={u.days} model={u.model} quota={u.quota[u.model] ?? 0} />
          </Card>

          <Card id="images" icon={<ImageIcon className="h-4 w-4" aria-hidden />} title="AI images and neurons" note="Workers AI, free daily allowance only; resets at midnight UTC.">
            {ai ? (
              <div className="divide-y divide-edge">
                <Meter label="AI images today" used={ai.images} cap={ai.maxImages} unit="images" note={`${n(ai.lastHour)} in the last hour (at most ${n(ai.perHour)}); ${n(ai.monthImages)} this month.`} />
                <Meter label="Neurons today" used={ai.neurons} cap={ai.ceiling} unit="neurons" note="PortfolioRank's slice of the account's free 10,000 a day." />
                {ai.problem && <p className="py-2 text-sm text-down">{ai.problem}</p>}
              </div>
            ) : (
              <p className="py-3 text-sm text-mute">No AI images yet.</p>
            )}
          </Card>

          <Card id="search" icon={<Search className="h-4 w-4" aria-hidden />} title="Search and stock photos" note="This calendar month.">
            <div className="divide-y divide-edge">
              <Meter label="Tavily credits" used={tavily.used} cap={tavily.cap} unit="credits" note="Outside claims in blog drafts; without credits they are cut." />
              <Meter label="Pexels searches" used={pexels.used} cap={pexels.cap} unit="searches" note="Free; the cap only stops a runaway." />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
