import Link from "next/link";
import { ArrowRight, Newspaper, Rss } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { chip, tag as tagClass } from "@/components/ui/Chip";
import { btnSecondary } from "@/components/ui/styles";
import { NewsletterSignup } from "@/components/newsletter/NewsletterSignup";
import { type BlogListItem, coverOf, imageSrc, postDate } from "@/lib/blog";

// /blog and /blog/tag/[tag]: the newest post large, the rest in a grid, and
// the tags as chips. Server-rendered; nothing here depends on the visitor.

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

function Cover({ post, eager = false }: { post: BlogListItem; eager?: boolean }) {
  const cover = coverOf(post.images);
  if (!cover) return <div className="aspect-[16/9] w-full bg-raised" />;
  const chart = cover.kind === "chart";
  return (
    // eslint-disable-next-line @next/next/no-img-element -- our own media route, sized by CSS
    <img
      src={imageSrc(post.id, cover)}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={`aspect-[16/9] w-full ${chart ? "bg-[#0a0a0b] object-contain" : "object-cover object-top"} transition duration-300 group-hover:scale-[1.02]`}
    />
  );
}

function Meta({ post }: { post: BlogListItem }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm text-mute">
      <time dateTime={post.publishAt}>{postDate(post.publishAt)}</time>
      <span aria-hidden>·</span>
      <span>{post.minutes} min read</span>
    </p>
  );
}

function Featured({ post }: { post: BlogListItem }) {
  return (
    <a href={`/blog/${post.slug}`} className="card card-hover group grid overflow-hidden md:grid-cols-[1.25fr_1fr]">
      <div className="overflow-hidden border-b border-edge md:border-b-0 md:border-r">
        <Cover post={post} eager />
      </div>
      <div className="flex flex-col justify-center p-5 sm:p-7">
        {post.tags[0] && <span className={`${tagClass} self-start`}>{post.tags[0]}</span>}
        <h2 className="mt-3 text-2xl font-bold leading-tight tracking-tight text-balance sm:text-[1.75rem]">{post.title}</h2>
        {post.subtitle && <p className="mt-3 text-[15px] leading-relaxed text-mute text-pretty sm:text-base">{post.subtitle}</p>}
        <div className="mt-5 flex items-center justify-between gap-3">
          <Meta post={post} />
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-accent">
            Read <ArrowRight className="nudge h-4 w-4" aria-hidden />
          </span>
        </div>
      </div>
    </a>
  );
}

/** One post as a card: the grid on /blog, and "More articles" under a post (h3 there). */
export function Card({ post, level = 2 }: { post: BlogListItem; level?: 2 | 3 }) {
  const H = level === 3 ? "h3" : "h2";
  return (
    <a href={`/blog/${post.slug}`} className="card card-hover group flex h-full flex-col overflow-hidden">
      <div className="overflow-hidden border-b border-edge">
        <Cover post={post} />
      </div>
      <div className="flex flex-1 flex-col p-5">
        {post.tags[0] && <span className={`${tagClass} self-start`}>{post.tags[0]}</span>}
        <H className="mt-3 text-lg font-bold leading-snug tracking-tight text-balance">{post.title}</H>
        {post.subtitle && <p className="mt-2 line-clamp-3 text-[15px] leading-relaxed text-mute">{post.subtitle}</p>}
        <div className="mt-auto pt-4">
          <Meta post={post} />
        </div>
      </div>
    </a>
  );
}

export function BlogIndex({ posts, tags, current }: { posts: BlogListItem[]; tags: { slug: string; name: string; count: number }[]; current: { slug: string; name: string } | null }) {
  const [first, ...rest] = current ? [null, ...posts] : posts;
  return (
    <div className="pb-20">
      <section aria-labelledby="blog" className="band band-glow">
        <div className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
          <p className="rise text-xs font-semibold uppercase tracking-[0.14em] text-accent">Blog</p>
          <h1 id="blog" className="rise mt-2 text-4xl font-bold tracking-tight text-balance sm:text-5xl" style={d(40)}>
            {current ? current.name : "What the best portfolios do"}
          </h1>
          <p className="rise mx-auto mt-4 max-w-xl text-[15px] text-mute text-pretty sm:text-lg" style={d(80)}>
            {current
              ? `Posts tagged ${current.name}.`
              : "Short posts from PortfolioRank's own data. Code computes every number, AI writes the words, and a person reads each one before it goes out."}
          </p>
          <p className="rise mt-5" style={d(120)}>
            <a href="/blog/rss.xml" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-mute transition hover:text-ink">
              <Rss className="h-4 w-4 text-accent" aria-hidden /> RSS feed
            </a>
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {tags.length > 1 && (
          <nav aria-label="Tags" className="-mx-4 mt-8 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <ul className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
              <li>
                <Link href="/blog" prefetch={false} aria-current={current ? undefined : "true"} className={chip}>
                  All posts
                </Link>
              </li>
              {tags.map((t) => (
                <li key={t.slug}>
                  <a href={`/blog/tag/${t.slug}`} aria-current={current?.slug === t.slug ? "true" : undefined} className={chip}>
                    {t.name}
                    <span className="text-xs tabular-nums text-mute">{t.count}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {posts.length === 0 ? (
          <EmptyState
            icon={Newspaper}
            title="No posts yet"
            className="mx-auto mt-10 max-w-xl"
            action={
              <Link href="/top" prefetch={false} className={btnSecondary}>
                See the leaderboard
              </Link>
            }
          >
            The first posts are on their way. Until then, the leaderboard shows who&apos;s on top.
          </EmptyState>
        ) : (
          <div className="mt-8 grid gap-6">
            {first && <Featured post={first} />}
            {rest.length > 0 && (
              <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {(rest as BlogListItem[]).map((p) => (
                  <li key={p.id}>
                    <Card post={p} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <NewsletterSignup form="blog" layout="wide" className="card mt-12 p-6 sm:p-8" />
      </div>
    </div>
  );
}

