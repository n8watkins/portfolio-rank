import { AdminNav } from "@/components/admin/AdminNav";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { opensOn, weekRange } from "@/lib/polls/format";
import { publicPolls, type StoredPoll } from "@/lib/polls/server";
import { readGenerations, readSchedule } from "@/lib/polls/store.mjs";

// The owner's view of the polls (AUTOMATION.md "Polls"): this week's poll and
// every scheduled one with its options and sites, which the public pages
// keep private until a poll opens, and the last nightly generation runs.
// Read only. Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Polls - PortfolioRank admin", robots: { index: false, follow: false } };

type Scheduled = StoredPoll & { state: string; topic: string | null; source: string; upcoming: boolean };
type Generation = { night: string; at: string; model: string | null; requests: number; proposed: number; accepted: number; status: string; detail: string | null };

export default async function AdminPollsPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const client = db();
  const [schedule, generations] = (await Promise.all([readSchedule(client), readGenerations(client)])) as [Scheduled[], Generation[]];
  const shown = await publicPolls(schedule);

  return (
    <div className="wrap pb-20">
      <div className="py-6">
        <AdminNav current="/admin/polls" />
        <h1 className="mt-3 text-3xl font-bold tracking-tight">Polls</h1>
        <p className="mt-2 text-sm text-mute">
          {schedule.length} poll{schedule.length === 1 ? "" : "s"} from this week on. Visitors see the questions and weeks of upcoming polls on /polls, never their options.
        </p>
      </div>

      {schedule.length === 0 && <p className="card p-5 text-sm text-mute">Nothing scheduled. The next nightly run makes this week&apos;s poll.</p>}
      <ol className="grid gap-4">
        {schedule.map((p, i) => (
          <li key={p.id} className="card p-5" data-poll={p.id}>
            <p className="flex flex-wrap gap-x-2 text-xs text-mute">
              <span className="font-semibold text-ink">{p.upcoming ? `Opens ${opensOn(p.opensAt)}` : "Open now"}</span>
              <span>{weekRange(p.opensAt, p.closesAt)}</span>
              <span>· {p.kind}</span>
              {p.topic && <span>· {p.topic}</span>}
              <span>· by {p.source}</span>
              {p.state !== "scheduled" && <span className="font-semibold text-down">· {p.state}</span>}
              {!p.upcoming && <span>· {p.total.toLocaleString("en-US")} votes</span>}
            </p>
            <h2 className="mt-1 text-lg font-bold tracking-tight">{p.question}</h2>
            {p.detail && <p className="text-sm text-mute">{p.detail}</p>}
            <ul className="mt-3 grid gap-1.5 text-sm">
              {shown[i].options.map((o) => (
                <li key={o.index} className="flex items-center gap-3">
                  {o.site?.hero && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={o.site.hero} alt="" className="aspect-[16/10] w-20 rounded border border-edge object-cover object-top" />
                  )}
                  <span>
                    <span className="font-semibold">{o.label}</span>
                    {o.site && (
                      <a href={o.site.path} className="ml-2 text-mute underline underline-offset-2">
                        {o.site.name} ({o.site.domain})
                      </a>
                    )}
                    {!p.upcoming && <span className="ml-2 tabular-nums text-mute">{o.votes} votes</span>}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <h2 className="mt-12 text-xl font-bold tracking-tight">Nightly generation</h2>
      {generations.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-mute">
              <tr>
                <th className="py-2 pr-4">Night</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Requests</th>
                <th className="py-2 pr-4">Proposed</th>
                <th className="py-2 pr-4">Accepted</th>
                <th className="py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {generations.map((g) => (
                <tr key={g.at} className="border-t border-edge">
                  <td className="py-2 pr-4 tabular-nums">{g.night}</td>
                  <td className="py-2 pr-4">{g.status}</td>
                  <td className="py-2 pr-4 tabular-nums">{g.requests}</td>
                  <td className="py-2 pr-4 tabular-nums">{g.proposed}</td>
                  <td className="py-2 pr-4 tabular-nums">{g.accepted}</td>
                  <td className="py-2 text-mute">{g.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-mute">No generation runs yet.</p>
      )}
    </div>
  );
}
