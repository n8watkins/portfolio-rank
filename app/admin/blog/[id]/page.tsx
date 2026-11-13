import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleCheck, CircleX, ExternalLink } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { getPost } from "@/lib/content/blog.mjs";
import { Article } from "@/components/blog/Article";
import { ReviewActions } from "@/components/admin/ReviewActions";
import { StatusPill, checksLine, closedReason, pacificTime, scheduledFor } from "@/components/admin/postStatus";
import { relatedPortfolios } from "@/lib/blog-server";
import type { BlogPost } from "@/lib/blog";
import { scorecard } from "@/pipeline/content/scorecard.mjs";
import { Scorecard } from "@/components/admin/Scorecard";

// One post as readers would see it, with the owner's decision on top
// (Publish or Reject a draft, Unpublish a published post) and, under it,
// everything the decision rests on: the checks, the fact sheet every number
// came from, the outside claims kept and cut, and each image's source,
// licence and approval. Only the admin; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Review post - PortfolioRank admin", robots: { index: false, follow: false } };

type Check = { name: string; ok: boolean; problems: string[] };
type Round = { round: number; checks: Check[]; claims?: { cut?: { sentence: string; reason: string }[] } };

function Details({ title, children, open = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="card group mt-3 overflow-hidden" open={open}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-semibold">
        {title}
        <span aria-hidden className="text-mute transition group-open:rotate-90">›</span>
      </summary>
      <div className="max-h-[420px] overflow-auto border-t border-edge px-4 py-3 text-sm">{children}</div>
    </details>
  );
}

/** Now, read once per request (outside render, for the purity lint). */
const clock = async () => Date.now();

export default async function AdminPostPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  const { id } = await params;
  if (!/^[0-9a-f]{16}$/.test(id)) notFound();
  await ensureSchema();
  const post = (await getPost(db(), id)) as BlogPost | null;
  if (!post) notFound();
  const related = await relatedPortfolios(post);
  const now = await clock();
  const live = post.status === "published" && post.publishAt != null && Date.parse(post.publishAt) <= now;
  const history = (post.checks?.history ?? []) as Round[];
  const last = history.at(-1);
  const cut = history.flatMap((h) => h.claims?.cut ?? []);
  const facts = post.facts?.facts ?? [];
  const reason = closedReason(post);
  const card = scorecard(post);
  const siblings = (await db().execute({ sql: "SELECT id, title FROM posts WHERE kind = ? AND id != ? ORDER BY created_at DESC LIMIT 5", args: [post.kind, post.id] })).rows.map((r) => ({ id: String(r.id), title: String(r.title) }));

  const banner = (
    <div className="border-b border-edge bg-card/80 backdrop-blur">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <Link href="/admin/blog" className="inline-flex min-h-9 items-center gap-1.5 text-sm font-semibold text-mute hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Review queue
          </Link>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute">
            <StatusPill status={post.status} live={live} />
            {post.status === "draft" && <span>{checksLine(post)} · {post.requests} Gemini requests</span>}
            {post.status === "published" && (
              <span>
                {live ? "Live since" : "Goes live"} {pacificTime(post.publishAt!)} ·{" "}
                <a href={`/blog/${post.slug}`} className="font-medium text-ink underline underline-offset-2">
                  public page
                </a>
              </span>
            )}
            {reason && post.status !== "draft" && post.status !== "published" && <span>{reason}</span>}
          </p>
        </div>
        {["draft", "published", "rejected", "dropped"].includes(post.status) && <ReviewActions id={post.id} status={post.status} scheduledFor={scheduledFor(post, now)} />}
      </div>
    </div>
  );

  return (
    <>
      <Article post={post} related={related} banner={banner} />
      <section aria-label="What this post rests on" className="mx-auto -mt-8 max-w-[42rem] px-4 pb-20 sm:px-6">
        <h2 className="text-lg font-bold tracking-tight">For your review</h2>
        <p className="mt-1 text-sm text-mute">
          Kind {post.kind} · data as of {pacificTime(post.dataAsOf)} · {post.altTitles.length ? `other titles: ${post.altTitles.join(" | ")}` : ""}
        </p>
        <Scorecard card={card} />
        {siblings.length > 0 && (
          <p className="mt-3 text-sm">
            <span className="text-mute">Compare with another draft on this story: </span>
            {siblings.map((s, i) => (
              <span key={s.id}>
                {i > 0 && " · "}
                <Link href={`/admin/blog/compare?a=${post.id}&b=${s.id}`} className="font-semibold text-accent underline-offset-2 hover:underline">
                  {s.title}
                </Link>
              </span>
            ))}
          </p>
        )}
        <Details title={`Checks${last ? `: ${last.checks.filter((c) => c.ok).length} of ${last.checks.length} passed` : ""}`} open={!post.checks?.passed}>
          {history.length === 0 && <p className="text-mute">No checks recorded.</p>}
          {history.map((h) => (
            <div key={h.round} className="mb-3">
              <p className="mb-1 font-semibold">Round {h.round + 1}</p>
              <ul className="grid gap-1">
                {h.checks.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    {c.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-label="passed" /> : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-label="failed" />}
                    <span>
                      {c.name}
                      {c.problems.length > 0 && <span className="text-mute">: {c.problems.join("; ")}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {(post.checks?.failures?.length ?? 0) > 0 && <p className="text-down">Failures: {post.checks!.failures!.join("; ")}</p>}
        </Details>
        <Details title={`Outside claims: ${post.claims.length} kept, ${cut.length} cut`}>
          {post.claims.map((c) => (
            <p key={c.url + c.sentence} className="mb-2">
              Kept: {c.sentence}{" "}
              <a href={c.url} className="inline-flex items-center gap-1 text-accent underline" target="_blank" rel="noopener noreferrer">
                source <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </p>
          ))}
          {cut.map((c, i) => (
            <p key={i} className="mb-2 text-mute">
              Cut: {c.sentence} <em>({c.reason})</em>
            </p>
          ))}
          {post.claims.length + cut.length === 0 && <p className="text-mute">The draft made no outside claims.</p>}
        </Details>
        <Details title={`The data: ${facts.length} facts`}>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-mute">
                <th className="py-1 pr-2 font-medium">id</th>
                <th className="py-1 pr-2 font-medium">fact</th>
                <th className="py-1 font-medium">value</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => (
                <tr key={f.id} className="border-t border-edge align-top">
                  <td className="py-1 pr-2 text-mute">{f.id}</td>
                  <td className="py-1 pr-2">{f.label}</td>
                  <td className="py-1 font-semibold tabular-nums">{f.display}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-mute">Names allowed: {(post.facts?.names ?? []).map((n) => `${n.name} (${n.reason})`).join(", ") || "none"}</p>
        </Details>
        <Details title={`Images: ${post.images.length}`}>
          <ul className="grid gap-2">
            {post.images.map((im) => (
              <li key={im.slot}>
                <span className="font-semibold">{im.slot}</span> · {im.kind} from {im.source ?? "?"} · licence: {im.licence ?? "?"} · {im.credit} · approval: {(im as { approval?: string }).approval ?? "?"}
              </li>
            ))}
          </ul>
        </Details>
      </section>
    </>
  );
}
