import { notFound } from "next/navigation";
import { ArrowLeft, ImageIcon, Sparkles } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Inline } from "@/components/preview/Inline";
import { GradesTimeline, KeyCodeCompare } from "@/components/preview/PostImages";
import { leaderboard } from "@/lib/preview/data";
import { Newsletter } from "@/components/preview/Newsletter";
import { SampleTag, btnPrimary, card } from "@/components/preview/bits";
import { TAG_LABEL, postBySlug } from "@/lib/preview/blog";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = postBySlug((await params).slug);
  return { title: p ? `${p.title} - PortfolioRank` : "Post not found - PortfolioRank", description: p?.subtitle };
}

export default async function PostPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  const p = postBySlug((await params).slug);
  if (!p) notFound();
  const top3 = leaderboard("merged").slice(0, 3);

  return (
    <AppShell visitor={v} current="blog">
      <article className="mx-auto max-w-[680px] py-8 sm:py-12">
        <a href="/blog" className="inline-flex items-center gap-1 text-sm font-medium text-mute hover:text-ink">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Blog
        </a>
        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-mute">
          {p.tags.map((t, i) => (
            <span key={t} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>·</span>}
              <a href={`/blog?tag=${t}`} className="font-semibold uppercase tracking-wider text-accent hover:underline">
                {TAG_LABEL[t] ?? t}
              </a>
            </span>
          ))}
          <span aria-hidden>·</span>
          {p.date}
          <span aria-hidden>·</span>
          {p.minutes} min read
          {p.status === "sample" ? (
            <SampleTag what="Sample post" />
          ) : (
            <span className="rounded-full border border-edge px-1.5 text-[10px] font-semibold uppercase tracking-wide">Draft, not published</span>
          )}
        </p>
        <h1 className="mt-3 text-3xl font-bold leading-[1.15] tracking-tight text-balance sm:text-[40px]">{p.title}</h1>
        <p className="mt-3 text-lg text-mute text-pretty">{p.subtitle}</p>
        <p className="mt-4 flex items-center gap-2 text-xs text-mute">
          <Sparkles className="h-3.5 w-3.5 text-ai" aria-hidden /> AI-written from PortfolioRank data.
        </p>

        <aside aria-label="TL;DR" className="mt-8 rounded-2xl border border-accent/40 bg-accent-soft/60 p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-accent">TL;DR</p>
          <ul className="mt-2 grid grid-cols-1 list-disc gap-1.5 pl-5 text-[15px] marker:text-accent">
            {p.tldr.map((t) => (
              <li key={t}>
                <Inline text={t} />
              </li>
            ))}
          </ul>
        </aside>

        <div className="mt-8 grid grid-cols-1 gap-5 text-[17px] leading-[1.7]">
          {p.blocks.map((b, i) => {
            switch (b.t) {
              case "p":
                return (
                  <p key={i} className="text-pretty">
                    <Inline text={b.text} />
                  </p>
                );
              case "h":
                return (
                  <h2 key={i} className="mt-4 text-[22px] font-bold leading-snug tracking-tight">
                    {b.text}
                  </h2>
                );
              case "quote":
                return (
                  <blockquote key={i} className="my-2 border-l-4 border-accent py-1 pl-5">
                    <p className="text-2xl font-bold tracking-tight">
                      <Inline text={b.title} />
                    </p>
                    <p className="mt-1 text-[15px] text-mute">{b.text}</p>
                  </blockquote>
                );
              case "ol":
                return (
                  <ol key={i} className="grid grid-cols-1 list-decimal gap-1.5 pl-6 marker:font-semibold marker:text-mute">
                    {b.items.map((it) => (
                      <li key={it}>
                        <Inline text={it} />
                      </li>
                    ))}
                  </ol>
                );
              case "image":
                return (
                  <figure key={i} className={`${card} reveal my-2 overflow-hidden`}>
                    {b.n === 2 ? (
                      <div className="p-3 sm:p-5">
                        <GradesTimeline />
                      </div>
                    ) : b.n === 3 ? (
                      <KeyCodeCompare />
                    ) : (
                    <div className={`grid grid-cols-1 place-items-center bg-raised p-6 text-center ${b.n === 1 ? "aspect-[16/9]" : "aspect-[2/1]"}`}>
                      <div className="max-w-sm">
                        <ImageIcon className="mx-auto h-6 w-6 text-mute" aria-hidden />
                        <p className="mt-2 text-sm font-semibold">Image {b.n}: {b.label}</p>
                        {b.kind && <p className="mt-1 text-xs text-mute">{b.kind.split(".")[0]}. Not made yet.</p>}
                      </div>
                    </div>
                    )}
                    {b.alt && (
                      <figcaption className="flex items-start justify-between gap-3 border-t border-edge px-4 py-3 text-sm text-mute">
                        <span>{b.alt}</span>
                        {(b.n === 2 || b.n === 3) && (
                          <span className="shrink-0 rounded-full border border-edge-strong px-1.5 text-[10px] font-semibold uppercase tracking-wide">
                            {b.n === 2 ? "Chart by code" : "Real code"}
                          </span>
                        )}
                      </figcaption>
                    )}
                  </figure>
                );
              case "shots":
                return (
                  <figure key={i} className={`${card} reveal my-2 overflow-hidden`}>
                    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-3 sm:p-4">
                      {top3.map((r, k) => (
                        <a key={r.url} href={`/grade/${r.slug}`} className="group block overflow-hidden rounded-lg border border-edge">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`${r.shot}/hero.jpg`} alt={`#${k + 1}: ${r.domain}`} loading="lazy" className="aspect-[16/10] w-full bg-raised object-cover object-top transition group-hover:scale-[1.02]" />
                          <span className="block border-t border-edge px-3 py-2 text-xs">
                            <strong>#{k + 1}</strong> <span className="text-mute">{r.domain}</span>
                          </span>
                        </a>
                      ))}
                    </div>
                    <figcaption className="border-t border-edge px-4 py-3 text-sm text-mute">The top three on the merged leaderboard today. Real screenshots from our captures.</figcaption>
                  </figure>
                );
              case "cta":
                return (
                  <div key={i} className={`${card} mt-4 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center`}>
                    <p className="flex-1 font-semibold">Want to know where your portfolio stands?</p>
                    <a href="/#grade" className={btnPrimary}>
                      <Sparkles className="h-4 w-4" aria-hidden /> Grade yours
                    </a>
                  </div>
                );
            }
          })}
        </div>

        {!v.subscribed && <Newsletter className="mt-10" />}
      </article>
    </AppShell>
  );
}
