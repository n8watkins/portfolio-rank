import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { workerEnv } from "@/lib/grader/server";
import { activeAlerts } from "@/pipeline/alerts.mjs";
import { TestAlert } from "@/components/admin/TestAlert";
import { LEAVE_AFTER_DAYS, POOL_SQL } from "@/pipeline/not-working.mjs";

// The owner alerts (AUTOMATION.md "Owner alerts"): whether alerts can be
// emailed on this site, a button that sends a test alert through the normal
// path, and the alerts that hold now. Only the admin sees it; anyone else
// gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts - PortfolioRank admin", robots: { index: false, follow: false } };

type PoolSite = { url: string; name: string; hidden: boolean; reason: string; started: string | null; since: string | null; next: string | null };

type Alert = { key: string; kind: string; title: string; detail: string | null; first_seen: string; last_seen: string; last_sent_day: string | null; sends: number };

/** "n***@example.com": enough to recognise the address on a screen share, not to read it. */
function masked(address: string) {
  const [user, domain] = address.split("@");
  return domain ? `${user.slice(0, 1)}***@${domain}` : "set";
}

const day = (iso: string) => iso.slice(0, 10);

export default async function AdminAlertsPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const env = (await workerEnv()) as Record<string, unknown>;
  const to = typeof env.OWNER_EMAIL === "string" && env.OWNER_EMAIL ? masked(env.OWNER_EMAIL) : null;
  const from = typeof env.EMAIL_FROM === "string" ? env.EMAIL_FROM : null;
  let alerts: Alert[] = [];
  try {
    alerts = (await activeAlerts(db())) as Alert[];
  } catch (e) {
    if (!/no such table/i.test(String((e as Error)?.message))) throw e;
  }
  // The not-working pool (pipeline/not-working.mjs): the owner's only view of it, besides the job summaries.
  let pool: PoolSite[] = [];
  try {
    pool = (await db().execute(POOL_SQL)).rows.map((r) => ({
      url: String(r.url),
      name: r.name == null ? "" : String(r.name),
      hidden: String(r.health) === "down",
      reason: r.health_reason == null ? "" : String(r.health_reason),
      started: r.pool_started_at == null ? null : String(r.pool_started_at),
      since: r.pool_since == null ? null : String(r.pool_since),
      next: r.pool_next_at == null ? null : String(r.pool_next_at),
    }));
  } catch (e) {
    if (!/no such (table|column)/i.test(String((e as Error)?.message))) throw e;
  }

  return (
    <div className="wrap pb-20">
      <div className="py-6">
        <h1 className="text-3xl font-bold tracking-tight">Alerts</h1>
        <p className="mt-2 text-sm text-mute">Each alert is emailed once a day while it holds, and clears on its own when the problem goes away.</p>
      </div>

      <section className="card grid gap-3 p-5" aria-labelledby="email-heading">
        <h2 id="email-heading" className="text-lg font-bold tracking-tight">
          Email
        </h2>
        <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-mute">To</dt>
          <dd>{to ?? <span className="font-semibold text-down">not set (OWNER_EMAIL): alerts are recorded here but not emailed</span>}</dd>
          <dt className="text-mute">From</dt>
          <dd>{from ?? <span className="font-semibold text-down">not set (EMAIL_FROM)</span>}</dd>
        </dl>
        <p className="text-sm text-mute" data-alert-system>
          Site alerts go through Cloudflare Email Service, from {from ?? "EMAIL_FROM"}, and each one says so at the bottom. Newsletters go through Kit. The test below sends
          &ldquo;Test: PortfolioRank site alerts (Cloudflare Email Service)&rdquo;.
        </p>
        <TestAlert to={to} />
      </section>

      <section className="mt-6" aria-labelledby="active-heading">
        <h2 id="active-heading" className="text-lg font-bold tracking-tight">
          Holding now
        </h2>
        {alerts.length === 0 ? (
          <p className="card mt-3 p-5 text-sm text-mute">No alerts. Everything the checks watch is fine.</p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {alerts.map((a) => (
              <li key={a.key} className="card p-5" data-alert={a.key}>
                <p className="flex flex-wrap gap-x-2 text-xs text-mute">
                  <span className={`font-semibold ${a.kind === "good" ? "text-up" : "text-down"}`}>{a.kind === "good" ? "Good news" : "Problem"}</span>
                  <span>· since {day(a.first_seen)}</span>
                  <span>· {a.sends === 0 ? "not emailed yet" : `emailed ${a.sends} time${a.sends === 1 ? "" : "s"}, last ${a.last_sent_day}`}</span>
                </p>
                <h3 className="mt-1 font-bold">{a.title}</h3>
                {a.detail && <p className="mt-1 whitespace-pre-line text-sm text-mute">{a.detail}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6" aria-labelledby="pool-heading" data-not-working>
        <h2 id="pool-heading" className="text-lg font-bold tracking-tight">
          Sites that stopped working
        </h2>
        <p className="mt-1 text-sm text-mute">
          Failing: out of grading and AI comparisons, still shown. Not working: hidden everywhere until a check passes, then back as it was. Off the list after{" "}
          {LEAVE_AFTER_DAYS} days. Nobody is emailed.
        </p>
        {pool.length === 0 ? (
          <p className="card mt-3 p-5 text-sm text-mute">None. Every listed site answered its last check.</p>
        ) : (
          <>
            <p className="mt-3 text-sm" data-pool-counts>
              <span className="font-semibold">{pool.filter((p) => p.hidden).length}</span> not working ·{" "}
              <span className="font-semibold">{pool.filter((p) => !p.hidden).length}</span> failing
            </p>
            <ul className="mt-3 grid gap-2">
              {pool.map((p) => (
                <li key={p.url} className="card p-4 text-sm" data-pool-site={p.url}>
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`text-xs font-semibold ${p.hidden ? "text-down" : "text-mute"}`}>{p.hidden ? "Not working" : "Failing"}</span>
                    <span className="min-w-0 break-all font-semibold">{p.name || p.url}</span>
                  </p>
                  <p className="mt-1 break-all text-mute">
                    {p.reason || "no reason recorded"} · {p.hidden ? `hidden since ${day(p.since ?? p.started ?? "")}` : `failing since ${day(p.started ?? "")}`}
                    {p.next ? ` · next check ${p.next.slice(0, 16).replace("T", " ")} UTC` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
