import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Bell, Images, Inbox, ListChecks } from "lucide-react";
import { contentCosts } from "@/lib/content/costs.mjs";
import { recentJobs } from "@/lib/content/jobs.mjs";
import { BUILDERS, KIND_LABELS } from "@/pipeline/content/facts.mjs";
import { DraftNow, type Job } from "@/components/admin/DraftNow";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { publishedAround, reviewQueue } from "@/lib/content/blog.mjs";
import { PUBLISH_CAP, contentMode } from "@/lib/content/store.mjs";
import { type BlogPost, coverOf, imageSrc } from "@/lib/blog";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusPill, closedReason, pacificTime } from "@/components/admin/postStatus";

// The blog's drafts (docs/CONTENT-ENGINE.md, "Review and publish" and
// "Write a draft now"): "Write a draft now" with its live status, the cost
// panel, the engine's drafts waiting for the owner, what is published, and
// what was rejected, dropped by the checks or unpublished. Only the admin
// sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Blog drafts - PortfolioRank admin", robots: { index: false, follow: false } };

function Row({ post, now }: { post: BlogPost; now: number }) {
  const cover = coverOf(post.images);
  const live = post.status === "published" && post.publishAt != null && Date.parse(post.publishAt) <= now;
  const reason = post.status === "draft" ? null : closedReason(post);
  return (
    <li>
      <a href={`/admin/blog/${post.id}`} className="card card-hover group flex items-center gap-4 p-3 sm:p-4">
        <span className="hidden h-[72px] w-32 shrink-0 overflow-hidden rounded-lg border border-edge bg-raised sm:block">
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element -- the post's own media route
            <img src={imageSrc(post.id, cover)} alt="" className={`h-full w-full ${cover.kind === "chart" ? "bg-[#0a0a0b] object-contain" : "object-cover object-top"}`} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={post.status} live={live} />
            <span className="text-xs text-mute">{post.kind}</span>
          </span>
          <span className="mt-1.5 block font-semibold leading-snug text-balance">{post.title}</span>
          <span className="mt-1 block text-sm text-mute">
            {post.status === "draft" && (
              <>
                Written {pacificTime(post.createdAt)} · {post.checks?.passed ? `passed every check in ${post.checks.rounds ?? 1} round(s)` : "checks not passed"} · {post.requests} Gemini requests
                {post.checks && "publishCap" in post.checks ? " · held back by the weekly cap" : ""}
              </>
            )}
            {post.status === "published" && <>{live ? "Live since" : "Goes live"} {pacificTime(post.publishAt!)}</>}
            {reason && <>{reason}</>}
          </span>
        </span>
        <ArrowRight className="nudge h-4 w-4 shrink-0 text-mute" aria-hidden />
      </a>
    </li>
  );
}

function Group({ title, posts, now, empty }: { title: string; posts: BlogPost[]; now: number; empty?: string }) {
  if (!posts.length && !empty) return null;
  return (
    <section className="mt-10" aria-label={title}>
      <h2 className="text-lg font-bold tracking-tight">
        {title} <span className="text-mute tabular-nums">{posts.length}</span>
      </h2>
      {posts.length ? (
        <ul className="mt-4 grid gap-3">
          {posts.map((p) => (
            <Row key={p.id} post={p} now={now} />
          ))}
        </ul>
      ) : (
        <EmptyState icon={Inbox} title={empty!} className="mt-4" />
      )}
    </section>
  );
}

async function load(jobId: string | null) {
  const client = db();
  const now = Date.now();
  const [queue, thisWeek, costs, jobs, kinds] = await Promise.all([
    reviewQueue(client, { limit: 100 }),
    publishedAround(client, now),
    contentCosts(client, { env: process.env, now: new Date(now) }),
    recentJobs(client, { limit: 10 }),
    Promise.all(Object.entries(BUILDERS).map(async ([id, build]) => {
      const s = await build(client, { now });
      return { id, label: KIND_LABELS[id] ?? id, ready: Boolean(s.ready), reason: s.ready ? null : (s.reason ?? null) };
    })),
  ]);
  const job = (jobId ? jobs.find((j) => j.id === jobId) : null) ?? jobs.find((j) => j.status === "queued" || j.status === "running") ?? null;
  return { queue, thisWeek, now, costs, job, kinds };
}

const n = (v: number) => v.toLocaleString("en-US");

function Cost({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-edge bg-raised px-3 py-2">
      <dt className="text-xs font-semibold text-mute">{label}</dt>
      <dd className="mt-0.5 font-bold tabular-nums">{value}</dd>
      <dd className="text-xs text-mute">{hint}</dd>
    </div>
  );
}

export default async function AdminBlogPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const sp = await searchParams;
  const { queue, thisWeek, now, costs, job, kinds } = await load(typeof sp.job === "string" && /^[0-9a-f]{16}$/.test(sp.job) ? sp.job : null);
  const mode = contentMode(process.env.CONTENT_MODE);
  const g = costs.gemini;
  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4 py-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Admin</p>
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight">Blog drafts</h1>
          <p className="mt-2 text-sm text-mute">
            Content engine: <span className="font-semibold text-ink">{mode}</span> · published within 7 days: {thisWeek} of {PUBLISH_CAP}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4">
          <Link href="/admin/blog/guidelines" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-mute hover:text-ink">
            <ListChecks className="h-4 w-4" aria-hidden /> Editor&apos;s guidelines
          </Link>
          <Link href="/admin/images" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-mute hover:text-ink">
            <Images className="h-4 w-4" aria-hidden /> Image library
          </Link>
          <Link href="/admin/alerts" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-mute hover:text-ink">
            <Bell className="h-4 w-4" aria-hidden /> Alerts
          </Link>
        </div>
      </div>
      <DraftNow kinds={kinds} initialJob={job as Job | null} left={Math.max(0, costs.drafts.cap - costs.drafts.today)} />
      <section aria-label="What the blog may still spend" className="mt-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-cost-panel>
          <Cost label="Gemini today" value={`${n(g.used)} used, ${n(g.left)} left`} hint={`${n(g.reserve)} kept for people; a draft may take ${g.draftNow} now`} />
          <Cost label="Tavily this month" value={`${n(costs.tavily.used)} of ${n(costs.tavily.cap)}`} hint={`this week ${costs.tavily.week} of ${costs.tavily.weekCap}; ${costs.tavily.perPost} a post`} />
          <Cost label="AI images today" value={`${costs.images.used} of ${costs.images.cap}`} hint={`1 a post; Pexels ${costs.pexels.used} this month, 2 a post`} />
          <Cost label="Drafts today" value={`${costs.drafts.today} of ${costs.drafts.cap}`} hint="Write now and rewrites, Pacific day" />
        </dl>
      </section>
      <Group title="Waiting for you" posts={queue.drafts as BlogPost[]} now={now} empty="No drafts waiting. The engine writes them on Monday and Wednesday nights while it is on." />
      <Group title="Published" posts={queue.published as BlogPost[]} now={now} />
      <Group title="Rejected, dropped or unpublished" posts={queue.closed as BlogPost[]} now={now} />
    </div>
  );
}
