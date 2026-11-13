import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { getPost } from "@/lib/content/blog.mjs";
import type { BlogPost } from "@/lib/blog";
import { Markdown } from "@/components/blog/Markdown";
import { StatusPill } from "@/components/admin/postStatus";
import { Scorecard } from "@/components/admin/Scorecard";
import { scorecard } from "@/pipeline/content/scorecard.mjs";
import { postLinkFor } from "@/lib/portfolio-links";

// Two drafts on one story side by side (docs/CONTENT-ENGINE.md, "Quality
// tools"): title, subtitle, the scorecard and the text, so the owner can
// keep the better one. /admin/blog/compare?a=<id>&b=<id>. Only the admin;
// anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Compare drafts - PortfolioRank admin", robots: { index: false, follow: false } };

function Column({ post }: { post: BlogPost }) {
  return (
    <article className="min-w-0" data-compare={post.id}>
      <p className="flex flex-wrap items-center gap-2 text-sm text-mute">
        <StatusPill status={post.status} live={false} /> {post.requests} Gemini requests
      </p>
      <h2 className="mt-2 text-xl font-bold leading-snug tracking-tight text-balance">
        <Link href={`/admin/blog/${post.id}`} className="underline-offset-4 hover:underline">
          {post.title}
        </Link>
      </h2>
      {post.subtitle && <p className="mt-1 text-mute">{post.subtitle}</p>}
      <Scorecard card={scorecard(post)} compact />
      <div className="prose-sm mt-4 max-h-[70vh] overflow-auto rounded-xl border border-edge bg-card p-4 text-sm">
        <Markdown body={post.body} figure={(slot) => <p className="my-2 text-xs text-mute">[image: {slot}]</p>} sources={post.claims.map((c) => c.url)} linkFor={postLinkFor} />
      </div>
    </article>
  );
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  const { a, b } = await searchParams;
  if (!/^[0-9a-f]{16}$/.test(String(a)) || !/^[0-9a-f]{16}$/.test(String(b)) || a === b) notFound();
  await ensureSchema();
  const client = db();
  const [pa, pb] = (await Promise.all([getPost(client, a!), getPost(client, b!)])) as (BlogPost | null)[];
  if (!pa || !pb) notFound();
  return (
    <>
      <AdminHeader title="Compare drafts" back={{ href: "/admin/blog", label: "Blog drafts" }}>
        {pa.kind === pb.kind ? `Both on ${pa.kind}.` : `Different stories: ${pa.kind} and ${pb.kind}.`}
      </AdminHeader>
      <div className="grid gap-8 lg:grid-cols-2">
        <Column post={pa} />
        <Column post={pb} />
      </div>
    </>
  );
}
