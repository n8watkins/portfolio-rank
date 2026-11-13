import { notFound } from "next/navigation";
import { ExternalLink, Eye, Inbox } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { pacificTime } from "@/components/admin/postStatus";
import { EmptyState } from "@/components/ui/EmptyState";
import { btnSecondary } from "@/components/ui/styles";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { broadcastMode } from "@/lib/newsletter/send.mjs";
import { kit, kitFormId, newsletterEnabled, subscriberCount } from "@/lib/newsletter/server";
import { recentIssues } from "@/lib/newsletter/store.mjs";
import { IS_STAGING } from "@/lib/site";

// The blog newsletter for the owner (AUTOMATION.md "Newsletter"). Kit keeps
// the list and sends the emails, so this page shows Kit's confirmed
// subscriber count (asked fresh on each visit), whether Kit is connected,
// each post's broadcast (scheduled, or a draft ready in Kit), and a preview
// of the email. Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Newsletter - PortfolioRank admin", robots: { index: false, follow: false } };

const KIT_BROADCASTS_URL = "https://app.kit.com/campaigns";

const TONE = {
  wait: "bg-accent-soft text-accent ring-accent/30",
  good: "bg-up/10 text-up ring-up/30",
  bad: "bg-down/10 text-down ring-down/30",
  mute: "bg-raised text-mute ring-edge",
};
const ISSUE: Record<string, { label: string; tone: string }> = {
  queued: { label: "Waiting for Kit", tone: TONE.wait },
  creating: { label: "Sending to Kit", tone: TONE.wait },
  scheduled: { label: "Scheduled in Kit", tone: TONE.good },
  draft: { label: "Draft ready in Kit", tone: TONE.wait },
  stopped: { label: "Stopped", tone: TONE.bad },
  skipped: { label: "Not sent", tone: TONE.mute },
  // Issues from before Kit (staging only).
  sending: { label: "Before Kit", tone: TONE.mute },
  sent: { label: "Before Kit", tone: TONE.mute },
};

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset ${tone}`}>{children}</span>;
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-mute">{label}</dt>
      <dd className={`text-right font-semibold ${ok ? "text-up" : "text-down"}`}>{ok ? "Set" : hint}</dd>
    </div>
  );
}

type Issue = { id: string; title: string; slug: string | null; status: string; reason: string | null; createdAt: string; finishedAt: string | null; broadcastId: string | null; sendAt: string | null };

export default async function AdminNewsletterPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const [count, issues] = (await Promise.all([subscriberCount({ fresh: true }), recentIssues(db(), { limit: 10 })])) as [Awaited<ReturnType<typeof subscriberCount>>, Issue[]];
  const on = newsletterEnabled();
  const connected = Boolean(kit());
  const form = Boolean(await kitFormId());
  const mode = IS_STAGING ? "draft" : broadcastMode(process.env.KIT_BROADCAST_MODE);

  return (
    <>
      <AdminHeader title="Newsletter" back={{ href: "/admin/blog", label: "Blog drafts" }}>
        {on ? (
          <>
            <span className="font-semibold text-up">On.</span> Kit keeps the list and sends the emails. Each published post becomes a Kit broadcast{" "}
            {mode === "send" ? "scheduled 10 minutes ahead, to every confirmed subscriber." : "saved as a draft; you get a note and send it from Kit."}
          </>
        ) : (
          <>
            <span className="font-semibold text-ink">Off</span> (NEWSLETTER_ENABLED): no sign-up forms and no broadcasts.
          </>
        )}
      </AdminHeader>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <div className="grid min-w-0 gap-10">
          <section aria-labelledby="nl-count">
            <h2 id="nl-count" className="sr-only">
              Subscribers
            </h2>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-newsletter-count>
              <div className="rounded-lg border border-edge bg-raised px-4 py-3">
                <dt className="text-xs font-semibold text-mute">Confirmed subscribers</dt>
                <dd className="mt-0.5 text-2xl font-bold tabular-nums">{count.count == null ? "-" : count.count.toLocaleString("en-US")}</dd>
                <dd className="text-xs text-mute">{count.count == null ? (count.error === "no_kit_key" ? "Kit isn't connected (KIT_API_KEY)" : "Kit didn't answer; try again in a moment") : "from Kit, just now"}</dd>
              </div>
              <div className="rounded-lg border border-edge bg-raised px-4 py-3">
                <dt className="text-xs font-semibold text-mute">New posts</dt>
                <dd className="mt-0.5 text-2xl font-bold">{mode === "send" ? "Sent" : "Drafts"}</dd>
                <dd className="text-xs text-mute">{IS_STAGING ? "staging only ever makes drafts" : "KIT_BROADCAST_MODE"}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="nl-sends">
            <h2 id="nl-sends" className="text-lg font-bold tracking-tight">
              Recent posts <span className="text-mute tabular-nums">{issues.length}</span>
            </h2>
            {issues.length === 0 ? (
              <EmptyState icon={Inbox} title="Nothing sent yet" className="mt-4">
                Publishing a post queues its email here; the next 10-minute tick hands it to Kit.
              </EmptyState>
            ) : (
              <ul className="mt-4 grid gap-2">
                {issues.map((i) => {
                  const s = ISSUE[i.status] ?? { label: i.status, tone: TONE.mute };
                  return (
                    <li key={i.id} className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:p-4">
                      <Pill tone={s.tone}>{s.label}</Pill>
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
                          {i.status === "scheduled" && i.sendAt ? ` · Kit sends it ${pacificTime(i.sendAt)}` : ""}
                          {i.reason ? ` · ${i.reason}` : ""}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside aria-label="Kit" className="grid min-w-0 gap-4">
          <section aria-labelledby="nl-kit" className="card p-5">
            <h2 id="nl-kit" className="font-bold tracking-tight">
              Kit
            </h2>
            <dl className="mt-3 grid gap-2 text-sm">
              <Check ok={connected} label="API key" hint="Missing (KIT_API_KEY)" />
              <Check ok={form} label="Sign-up form" hint="None (make one form, or set KIT_FORM_ID)" />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-mute">Kit sends the confirm email (double opt-in on the form), the posts and the unsubscribe link, and handles bounces. We keep no addresses.</p>
            <a href={KIT_BROADCASTS_URL} target="_blank" rel="noreferrer" className={`${btnSecondary} mt-4 w-full sm:w-auto`}>
              <ExternalLink className="h-4 w-4 text-accent" aria-hidden /> Open Kit broadcasts
            </a>
          </section>
          <section aria-labelledby="nl-preview" className="card p-5">
            <h2 id="nl-preview" className="font-bold tracking-tight">
              Preview
            </h2>
            <p className="mt-1 mb-4 text-sm text-mute">The email of the latest post, as Kit gets it. Send yourself a test from the draft in Kit.</p>
            <a href="/api/admin/newsletter/preview" target="_blank" className={`${btnSecondary} w-full sm:w-auto`}>
              <Eye className="h-4 w-4 text-accent" aria-hidden /> Preview the email
            </a>
          </section>
        </aside>
      </div>
    </>
  );
}
