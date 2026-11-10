import { ArrowRight, Rss } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { NewsletterFeature } from "@/components/preview/NewsletterFeature";
import { SampleTag } from "@/components/preview/bits";
import { TAG_LABEL, posts } from "@/lib/preview/blog";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Blog - PortfolioRank" };

export default async function BlogIndex({ searchParams }: { searchParams: Promise<{ state?: string; tag?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const all = posts();
  const tags = [...new Set(all.flatMap((p) => p.tags))];
  const list = sp.tag ? all.filter((p) => p.tags.includes(sp.tag!)) : all;
  const [lead, ...rest] = list;
  const chip =
    "inline-flex h-8 items-center rounded-full border border-edge bg-card px-3 text-sm font-medium transition hover:border-edge-strong aria-[current=true]:border-accent/60 aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent";

  return (
    <AppShell visitor={v} current="blog">
      <div className="py-8 sm:py-10">
        <div className="rise flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Blog</h1>
            <p className="mt-1.5 text-sm text-mute">Reports from the data, model watch, and building PortfolioRank in public.</p>
          </div>
          <a
            href="/blog/rss.xml"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-sm font-semibold text-mute shadow-[var(--card-hi)] transition hover:border-edge-strong hover:text-ink"
          >
            <Rss className="h-4 w-4" aria-hidden /> RSS
          </a>
        </div>

        <nav aria-label="Tags" className="rise mt-5 flex flex-wrap gap-2" style={{ "--d": "60ms" } as React.CSSProperties}>
          <a href="/blog" aria-current={!sp.tag} className={chip}>
            All
          </a>
          {tags.map((t) => (
            <a key={t} href={`/blog?tag=${t}`} aria-current={sp.tag === t} className={chip}>
              {TAG_LABEL[t] ?? t}
            </a>
          ))}
        </nav>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        {lead && (
          <a
            href={`/blog/${lead.slug}`}
            className="card card-hover card-featured rise group grid grid-cols-1 gap-6 p-6 sm:p-8 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"
            style={{ "--d": "120ms" } as React.CSSProperties}
          >
            <span className="flex flex-col">
              <Meta p={lead} />
              <span className="mt-3 block text-2xl font-bold leading-tight tracking-tight text-balance transition group-hover:text-accent sm:text-3xl">{lead.title}</span>
              <span className="mt-2 block text-[15px] text-mute text-pretty">{lead.subtitle}</span>
              <span className="mt-auto flex items-center gap-1 pt-5 text-sm font-semibold text-accent">
                Read the post <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </span>
            </span>
            <span className="block rounded-xl border border-edge bg-bg/40 p-4">
              <span className="block text-xs font-bold uppercase tracking-wider text-mute">TL;DR</span>
              <span className="mt-2 grid grid-cols-1 gap-2 text-sm">
                {lead.tldr.slice(0, 3).map((t) => (
                  <span key={t} className="flex gap-2.5">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />
                    <span>{short(t)}</span>
                  </span>
                ))}
              </span>
            </span>
          </a>
        )}
        <div className="rise" style={{ "--d": "160ms" } as React.CSSProperties}>
          {v.subscribed ? (
            <div className="card flex h-full flex-col p-5 text-sm">
              <p className="font-semibold">How posts are made</p>
              <p className="mt-1 text-mute">Reports are AI-written from PortfolioRank data and checked by a person before they go out. Every number traces to a source.</p>
            </div>
          ) : (
            <NewsletterFeature layout="side" id="blog-nl" />
          )}
        </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-3">
          {rest.map((p) => (
            <a key={p.slug} href={`/blog/${p.slug}`} className="card card-hover reveal group flex flex-col p-5">
              <Meta p={p} />
              <span className="mt-3 block text-lg font-bold leading-snug tracking-tight transition group-hover:text-accent">{p.title}</span>
              <span className="mt-1 block text-sm text-mute">{p.subtitle}</span>
              <span className="mt-auto flex justify-end pt-4 text-mute">
                <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </span>
            </a>
          ))}
          <div className="card reveal flex flex-col justify-center p-5 text-sm">
            <p className="font-semibold">How posts are made</p>
            <p className="mt-1 text-mute">
              Reports are AI-written from PortfolioRank data and checked by a person before they go out. Every number traces to a source.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Meta({ p }: { p: ReturnType<typeof posts>[number] }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-mute">
      <span className="font-semibold uppercase tracking-wider text-ink">{TAG_LABEL[p.tags[0]] ?? p.tags[0]}</span>
      <span aria-hidden>·</span>
      {p.date}
      <span aria-hidden>·</span>
      {p.minutes} min read
      {p.status === "sample" ? (
        <SampleTag what="Sample post" />
      ) : (
        <span className="rounded-full border border-edge px-1.5 text-[10px] font-semibold uppercase tracking-wide">Draft</span>
      )}
    </span>
  );
}

/** A TL;DR bullet cut to its first clause for the index (the post has the full list). */
function short(t: string) {
  const clean = t.replace(/`/g, "");
  const first = clean.split(/(?<=[.;:])\s/)[0].replace(/[.;:]$/, "");
  return first.length > 90 ? first.slice(0, 88).trimEnd() + "..." : first;
}
