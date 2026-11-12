import { notFound } from "next/navigation";
import { Inbox, Users } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { NewsletterTestButton } from "@/components/admin/NewsletterTestButton";
import { pacificTime } from "@/components/admin/postStatus";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { emailCaps, emailToday } from "@/lib/email/gate.mjs";
import { ownerEmail } from "@/lib/newsletter/admin";
import { NEWSLETTER_BATCH } from "@/lib/newsletter/send.mjs";
import { newsletterEnabled } from "@/lib/newsletter/server";
import { listSubscribers, newsletterCounts, recentIssues } from "@/lib/newsletter/store.mjs";
import { maskEmail } from "@/lib/signin/store.mjs";

// The blog newsletter for the owner (AUTOMATION.md "Newsletter"): how many
// people are subscribed, confirmed or not, who they are with the date and
// the page they signed up on, the recent sends with how far each got, today's
// caps, and "Send test to me". Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Newsletter - PortfolioRank admin", robots: { index: false, follow: false } };

const SUB_TONE: Record<string, string> = {
  confirmed: "bg-up/10 text-up ring-up/30",
  pending: "bg-accent-soft text-accent ring-accent/30",
  unsubscribed: "bg-raised text-mute ring-edge",
};
const ISSUE_TONE: Record<string, string> = {
  sending: "bg-accent-soft text-accent ring-accent/30",
  sent: "bg-up/10 text-up ring-up/30",
  stopped: "bg-down/10 text-down ring-down/30",
  skipped: "bg-raised text-mute ring-edge",
};
const ISSUE_LABEL: Record<string, string> = { sending: "Sending", sent: "Sent", stopped: "Stopped", skipped: "Not sent" };

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-semibold capitalize ring-1 ring-inset ${tone}`}>{children}</span>;
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-edge bg-raised px-4 py-3">
      <dt className="text-xs font-semibold text-mute">{label}</dt>
      <dd className="mt-0.5 text-2xl font-bold tabular-nums">{value.toLocaleString("en-US")}</dd>
      <dd className="text-xs text-mute">{hint}</dd>
    </div>
  );
}

type Issue = { id: string; title: string; slug: string | null; status: string; reason: string | null; createdAt: string; finishedAt: string | null; sent: number; failed: number; waiting: number };
type Subscriber = { id: string; email: string; status: string; source: string | null; createdAt: string };
type Today = { rows: { kind: string; status: string; n: number }[] };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

export default async function AdminNewsletterPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const client = db();
  const [counts, subscribers, issues, today, owner] = (await Promise.all([
    newsletterCounts(client),
    listSubscribers(client, { limit: 500 }),
    recentIssues(client, { limit: 10 }),
    emailToday(client),
    ownerEmail(),
  ])) as [{ confirmed: number; pending: number; unsubscribed: number }, Subscriber[], Issue[], Today, string | null];
  const caps = emailCaps(process.env.EMAIL_CAPS || undefined);
  const used = (kind: string) => today.rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.n, 0);
  const on = newsletterEnabled();
  const total = counts.confirmed + counts.pending + counts.unsubscribed;

  return (
    <>
      <AdminHeader title="Newsletter" back={{ href: "/admin/blog", label: "Blog drafts" }}>
        {on ? (
          <>
            <span className="font-semibold text-up">On.</span> Each published post goes to confirmed subscribers in batches of {NEWSLETTER_BATCH} every 10 minutes, within the caps below.
          </>
        ) : (
          <>
            <span className="font-semibold text-ink">Off</span> (NEWSLETTER_ENABLED): no sign-up forms, nothing is sent. Unsubscribe links still work.
          </>
        )}
      </AdminHeader>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <div className="grid min-w-0 gap-10">
          <section aria-labelledby="nl-counts">
            <h2 id="nl-counts" className="sr-only">
              Subscribers by status
            </h2>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-newsletter-counts>
              <Stat label="Confirmed" value={counts.confirmed} hint="get every new post" />
              <Stat label="Pending" value={counts.pending} hint="haven't confirmed; deleted after 7 days" />
              <Stat label="Unsubscribed" value={counts.unsubscribed} hint="deleted 30 days after leaving" />
            </dl>
          </section>

          <section aria-labelledby="nl-sends">
            <h2 id="nl-sends" className="text-lg font-bold tracking-tight">
              Recent sends <span className="text-mute tabular-nums">{issues.length}</span>
            </h2>
            {issues.length === 0 ? (
              <EmptyState icon={Inbox} title="Nothing sent yet" className="mt-4">
                Publishing a post queues its email here; the next 10-minute tick starts sending.
              </EmptyState>
            ) : (
              <ul className="mt-4 grid gap-2">
                {issues.map((i) => (
                  <li key={i.id} className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:p-4">
                    <Pill tone={ISSUE_TONE[i.status] ?? ISSUE_TONE.skipped}>{ISSUE_LABEL[i.status] ?? i.status}</Pill>
                    <span className="min-w-0 flex-1 basis-56">
                      {i.slug ? (
                        <a href={`/blog/${i.slug}`} className="block font-semibold leading-snug hover:underline">
                          {i.title}
                        </a>
                      ) : (
                        <span className="block font-semibold leading-snug">{i.title}</span>
                      )}
                      <span className="mt-0.5 block text-sm text-mute">
                        Queued {pacificTime(i.createdAt)}
                        {i.finishedAt && i.status !== "skipped" ? ` · finished ${pacificTime(i.finishedAt)}` : ""}
                        {i.reason ? ` · ${i.reason}` : ""}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums text-mute">
                      <span className="font-semibold text-ink">{i.sent}</span> sent
                      {i.failed > 0 && <>, {i.failed} failed</>}
                      {i.status === "sending" && <>, {i.waiting} to go</>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="nl-list">
            <h2 id="nl-list" className="text-lg font-bold tracking-tight">
              Subscribers <span className="text-mute tabular-nums">{total}</span>
            </h2>
            {subscribers.length === 0 ? (
              <EmptyState icon={Users} title="No sign-ups yet" className="mt-4">
                The form is on every post, on /blog and in the site footer.
              </EmptyState>
            ) : (
              <div className="card mt-4 overflow-hidden">
                <div className="hidden grid-cols-[minmax(0,1.6fr)_7.5rem_7rem_minmax(0,1.2fr)] gap-4 border-b border-edge bg-raised px-4 py-2 text-xs font-semibold text-mute md:grid">
                  <span>Email</span>
                  <span>Status</span>
                  <span>Signed up</span>
                  <span>Source</span>
                </div>
                <ul className="divide-y divide-edge" data-newsletter-list>
                  {subscribers.map((s) => (
                    <li key={s.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[minmax(0,1.6fr)_7.5rem_7rem_minmax(0,1.2fr)] md:items-center md:gap-4">
                      <span className="flex min-w-0 items-center justify-between gap-3">
                        <span className="truncate font-medium" title={s.email}>
                          {s.email}
                        </span>
                        <span className="md:hidden">
                          <Pill tone={SUB_TONE[s.status] ?? SUB_TONE.unsubscribed}>{s.status}</Pill>
                        </span>
                      </span>
                      <span className="hidden md:block">
                        <Pill tone={SUB_TONE[s.status] ?? SUB_TONE.unsubscribed}>{s.status}</Pill>
                      </span>
                      <span className="tabular-nums text-mute">
                        <span className="md:hidden">Signed up </span>
                        {day(s.createdAt)}
                      </span>
                      <span className="truncate text-mute" title={s.source ?? ""}>
                        <span className="md:hidden">From </span>
                        {s.source ?? "unknown"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        <aside aria-label="Test and caps" className="grid min-w-0 gap-4">
          <section aria-labelledby="nl-test" className="card p-5">
            <h2 id="nl-test" className="font-bold tracking-tight">
              Test email
            </h2>
            <p className="mt-1 mb-4 text-sm text-mute">See the email subscribers get, in your own inbox.</p>
            <NewsletterTestButton disabled={!owner} to={owner ? maskEmail(owner) : null} />
          </section>
          <section aria-labelledby="nl-caps" className="card p-5">
            <h2 id="nl-caps" className="font-bold tracking-tight">
              Today&apos;s caps
            </h2>
            <dl className="mt-3 grid gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-mute">Post emails</dt>
                <dd className="font-semibold tabular-nums">
                  {used("newsletter")} of {(caps.kinds as Record<string, number>).newsletter ?? 0}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-mute">Confirm emails</dt>
                <dd className="font-semibold tabular-nums">
                  {used("newsletter-confirm")} of {(caps.kinds as Record<string, number>)["newsletter-confirm"] ?? 0}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-mute">
              Pacific day. Mailroom adds its own: 40 a day and 150 a month for the newsletter, and the account&apos;s 2,500 a month, so email never bills. At a cap the rest waits for the next day.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
