import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { workerEnv } from "@/lib/grader/server";
import { activeAlerts } from "@/pipeline/alerts.mjs";
import { TestAlert } from "@/components/admin/TestAlert";

// The owner alerts (AUTOMATION.md "Owner alerts"): whether alerts can be
// emailed on this site, a button that sends a test alert through the normal
// path, and the alerts that hold now. Only the admin sees it; anyone else
// gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts - PortfolioRank admin", robots: { index: false, follow: false } };

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
    </div>
  );
}
