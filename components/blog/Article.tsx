import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, BarChart3, Bot, ExternalLink, Trophy } from "lucide-react";
import { Markdown, headingsOf } from "@/components/blog/Markdown";
import { type TocItem, TocRail, TocToggle } from "@/components/blog/Toc";
import { ShareLinks } from "@/components/blog/ShareLinks";
import { tag as tagClass } from "@/components/ui/Chip";
import { btnSecondary, eyebrow } from "@/components/ui/styles";
import { tagSlug } from "@/lib/content/blog.mjs";
import { Card } from "@/components/blog/BlogIndex";
import { type BlogListItem, type BlogPost, type PostImage, coverOf, creditOf, imageSrc, postDate, postUrl } from "@/lib/blog";
import { ROUTES } from "@/lib/nav";
import { postLinkFor } from "@/lib/portfolio-links";
import { sitePath } from "@/lib/site";

// One post, as readers see it on /blog/[slug] and as the owner previews a
// draft on /admin/blog/[id]: the title block with the AI line, the cover,
// the body (components/blog/Markdown.tsx), the portfolios it names, its
// sources, the full AI note and the share links.

export type Related = { name: string; url: string; domain: string; reason?: string; shot: string | null };

function Figure({ postId, image, cover = false }: { postId: string; image: PostImage; cover?: boolean }) {
  const credit = creditOf(image);
  const chart = image.kind === "chart";
  const href = image.kind === "screenshot" && credit.href ? postLinkFor(credit.href) : credit.href;
  return (
    <figure className={`post-figure ${cover ? "" : "my-9"}`}>
      {/* .post-frame lifts and its image zooms a touch on hover (globals.css, never with reduced motion). */}
      <div className={`post-frame overflow-hidden rounded-xl border border-edge ${chart ? "bg-[#0a0a0b]" : "bg-raised"} shadow-[var(--card-hi),var(--card-drop)]`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- our own media route and Pexels hotlinks, sized by CSS */}
        <img
          src={imageSrc(postId, image)}
          alt={image.alt ?? ""}
          loading={cover ? "eager" : "lazy"}
          decoding="async"
          {...(cover ? { fetchPriority: "high" as const } : {})}
          className={chart ? "block h-auto w-full" : "block aspect-[16/9] w-full object-cover object-top"}
        />
      </div>
      <figcaption className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-snug text-mute">
        {!cover && image.alt && <span className="text-ink/80">{image.alt}</span>}
        {href ? (
          <a href={href} className="underline decoration-edge-strong underline-offset-2 hover:text-ink" {...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {credit.text}
          </a>
        ) : (
          <span>{credit.text}</span>
        )}
      </figcaption>
    </figure>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-12 border-t border-edge pt-8">
      <h2 id={id} className="text-lg font-bold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export function Article({ post, related, banner, more = [] }: { post: BlogPost; related: Related[]; banner?: ReactNode; more?: BlogListItem[] }) {
  const cover = coverOf(post.images);
  const bySlot = new Map(post.images.map((im) => [im.slot, im]));
  const sources = post.claims.map((c) => c.url);
  const dataLink = post.facts?.dataLink ?? "/top";
  const date = post.publishAt ?? post.createdAt;
  const blog = ROUTES.blog ?? "/blog";
  // The contents: the body's subheads, then the post's own Sources section.
  const toc: TocItem[] = [...headingsOf(post.body), { id: "sources", text: "Sources" }];
  return (
    <article className="pb-20">
      {banner}
      <header className="mx-auto max-w-[42rem] px-4 pt-8 sm:px-6 sm:pt-12">
        <a href={blog} className="group inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-mute transition hover:text-ink">
          <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-0.5" aria-hidden /> Blog
        </a>
        <p className={`${eyebrow} mt-4 flex flex-wrap items-center gap-x-2`}>
          {post.tags[0] && <span>{post.tags[0]}</span>}
          {post.tags[0] && <span aria-hidden className="text-mute">·</span>}
          <time dateTime={date} className="text-mute">
            {postDate(date)}
          </time>
          <span aria-hidden className="text-mute">·</span>
          <span className="text-mute">{post.minutes} min read</span>
        </p>
        <h1 className="mt-3 text-[2rem] font-bold leading-[1.12] tracking-tight text-balance sm:text-5xl">{post.title}</h1>
        {post.subtitle && <p className="mt-4 text-lg leading-relaxed text-mute text-pretty sm:text-xl">{post.subtitle}</p>}
        <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-mute">
          <span className="inline-flex items-center gap-1.5">
            <Bot className="h-4 w-4" aria-hidden /> {post.aiLine}
          </span>
          <a href="/about-posts" className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
            How posts are made
          </a>
          <a href={sitePath(dataLink) || "/"} className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
            The data
          </a>
        </p>
      </header>

      {cover && (
        <div className="mx-auto mt-8 max-w-4xl px-4 sm:px-6">
          <Figure postId={post.id} image={cover} cover />
        </div>
      )}

      {/* The reading column stays centred under the header; on wide screens the
          contents rail sits in the left gutter (the right one stays empty). */}
      <div className="mx-auto max-w-[78rem] px-4 sm:px-6 xl:grid xl:grid-cols-[minmax(0,1fr)_39rem_minmax(0,1fr)] xl:gap-12">
        {toc.length > 1 && (
          <aside className="hidden pt-8 xl:block xl:justify-self-end">
            <div className="h-full w-56">
              <TocRail items={toc} />
            </div>
          </aside>
        )}
      <div className="mx-auto w-full max-w-[39rem] pt-8 text-[17px] leading-[1.75] sm:text-lg sm:leading-[1.75] xl:col-start-2 xl:mx-0">
        {toc.length > 1 && (
          <div className="xl:hidden">
            <TocToggle items={toc} />
          </div>
        )}
        <Markdown
          body={post.body}
          sources={sources}
          linkFor={postLinkFor}
          figure={(slot) => {
            const im = bySlot.get(slot);
            return im && im !== cover ? <Figure postId={post.id} image={im} /> : null;
          }}
        />

        {related.length > 0 && (
          <Section title="Portfolios in this post" id="related">
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {related.map((r) => (
                <li key={r.url}>
                  <a href={postLinkFor(r.url)} className="post-related card card-hover flex items-center gap-3 p-3">
                    <span className="h-12 w-20 shrink-0 overflow-hidden rounded-md border border-edge bg-raised">
                      {r.shot && (
                        // eslint-disable-next-line @next/next/no-img-element -- a small screenshot thumbnail
                        <img src={r.shot} alt="" loading="lazy" className="post-thumb h-full w-full object-cover object-top" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold leading-tight">{r.name}</span>
                      <span className="block truncate text-sm text-mute">{r.domain}</span>
                    </span>
                    <ArrowRight className="nudge h-4 w-4 shrink-0 text-mute" aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          <a href={ROUTES.top ?? "/top"} className={btnSecondary}>
            <Trophy className="h-4 w-4 text-accent" aria-hidden /> See the leaderboard
          </a>
        </div>

        <Section title="Sources" id="sources">
          <ol className="mt-4 grid gap-3 text-[15px] leading-relaxed">
            {post.claims.map((c, i) => (
              <li key={c.url + i} id={`source-${i + 1}`} className="flex gap-3 scroll-mt-24">
                <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-accent">{i + 1}</span>
                <span className="min-w-0">
                  <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-medium underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
                    {c.title || domainOf(c.url)}
                  </a>
                  <ExternalLink className="ml-1 inline h-3.5 w-3.5 text-mute" aria-hidden />
                  <span className="block text-sm text-mute">
                    {domainOf(c.url)}. Checked against: &ldquo;{c.sentence}&rdquo;
                  </span>
                </span>
              </li>
            ))}
            <li className="flex gap-3">
              <BarChart3 className="mt-1.5 h-4 w-5 shrink-0 text-accent" aria-hidden />
              <span className="min-w-0">
                Every number: PortfolioRank&apos;s own data, as of {postDate(post.dataAsOf)}.{" "}
                <a href={sitePath(dataLink) || "/"} className="font-medium underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
                  See the data
                </a>
              </span>
            </li>
          </ol>
        </Section>

        <aside aria-label="How this post was made" className="card mt-10 p-5 text-sm leading-relaxed text-mute">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <Bot className="h-4 w-4" aria-hidden /> How this post was made
          </p>
          <p className="mt-2">
            Written with AI from PortfolioRank data, data as of {postDate(post.dataAsOf)}. Code computed every number and drew every chart; Gemini wrote the words around them,
            code and a second Gemini pass checked them, and a person read it before it went out.{" "}
            <a href="/about-posts" className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
              How posts are made
            </a>
          </p>
        </aside>

        {post.tags.length > 0 && (
          <ul className="mt-8 flex flex-wrap gap-2" aria-label="Tags">
            {post.tags.map((t) => (
              <li key={t}>
                <a href={`${blog}/tag/${tagSlug(t)}`} className={`${tagClass} h-7 px-2.5 text-[13px] hover:text-ink`}>
                  {t}
                </a>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 border-t border-edge pt-6">
          <p className="mb-3 text-sm font-semibold">Share this post</p>
          <ShareLinks url={postUrl(post.slug)} text={post.shareLine || post.title} />
        </div>
      </div>
      </div>

      {more.length > 0 && (
        <section aria-labelledby="more-articles" className="mx-auto mt-16 max-w-6xl border-t border-edge px-4 pt-10 sm:px-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="more-articles" className="text-2xl font-bold tracking-tight">
              More articles
            </h2>
            <a href={blog} className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-mute transition hover:text-ink">
              All posts <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </a>
          </div>
          <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {more.map((p) => (
              <li key={p.id}>
                <Card post={p} level={3} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
