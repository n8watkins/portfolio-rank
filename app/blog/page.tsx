import { Rss } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Newsletter } from "@/components/preview/Newsletter";
import { SampleTag, card } from "@/components/preview/bits";
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
    "inline-flex h-8 items-center rounded-full border border-edge px-3 text-sm font-medium transition hover:border-mute aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent";

  return (
    <AppShell visitor={v} current="blog">
      <div className="py-8 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Blog</h1>
            <p className="mt-1.5 text-sm text-mute">Reports from the data, model watch, and building PortfolioRank in public.</p>
          </div>
          <a href="/blog/rss.xml" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge px-3 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink">
            <Rss className="h-4 w-4" aria-hidden /> RSS
          </a>
        </div>

        <nav aria-label="Tags" className="mt-5 flex flex-wrap gap-2">
          <a href="/blog" aria-current={!sp.tag} className={chip}>
            All
          </a>
          {tags.map((t) => (
            <a key={t} href={`/blog?tag=${t}`} aria-current={sp.tag === t} className={chip}>
              {TAG_LABEL[t] ?? t}
            </a>
          ))}
        </nav>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-1 content-start gap-5">
            {lead && (
              <a href={`/blog/${lead.slug}`} className={`${card} group block p-6 transition hover:border-mute sm:p-7`}>
                <Meta p={lead} />
                <h2 className="mt-3 text-2xl font-bold leading-tight tracking-tight text-balance group-hover:text-accent sm:text-3xl">{lead.title}</h2>
                <p className="mt-2 text-[15px] text-mute text-pretty">{lead.subtitle}</p>
                <ul className="mt-4 grid grid-cols-1 gap-1.5 border-l-2 border-accent/50 pl-4 text-sm">
                  {lead.tldr.slice(0, 3).map((t) => (
                    <li key={t}>{t.replace(/`/g, "")}</li>
                  ))}
                </ul>
              </a>
            )}
            {rest.map((p) => (
              <a key={p.slug} href={`/blog/${p.slug}`} className={`${card} group block p-5 transition hover:border-mute`}>
                <Meta p={p} />
                <h2 className="mt-2 text-lg font-bold leading-snug tracking-tight group-hover:text-accent">{p.title}</h2>
                <p className="mt-1 text-sm text-mute">{p.subtitle}</p>
              </a>
            ))}
          </div>
          <div className="grid grid-cols-1 content-start gap-5">
            {!v.subscribed && <Newsletter />}
            <div className={`${card} p-5 text-sm`}>
              <p className="font-semibold">How posts are made</p>
              <p className="mt-1 text-mute">
                Reports are AI-written from PortfolioRank data and checked by a person before they go out. Every number traces to a source.
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Meta({ p }: { p: ReturnType<typeof posts>[number] }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-mute">
      <span className="font-semibold uppercase tracking-wider text-accent">{TAG_LABEL[p.tags[0]] ?? p.tags[0]}</span>
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
