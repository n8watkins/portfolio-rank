import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Article } from "@/components/blog/Article";
import { moreArticles, publishedPost, relatedPortfolios } from "@/lib/blog-server";
import { coverOf, imageSrc, postUrl } from "@/lib/blog";
import { SITE_URL } from "@/lib/site";
import { blogPostingLd, postModified } from "@/lib/blog-seo";
import { jsonLdHtml } from "@/lib/json-ld";

// One published post. Rendered on first visit, then served from the cache
// and rendered again at most every 5 minutes (ISR); nothing here depends on
// who is looking. Drafts and unpublished posts are a 404 here (the owner
// previews them on /admin/blog/[id]).
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = await publishedPost(slug);
  if (!post) return {};
  const description = post.subtitle ?? post.title;
  return {
    title: `${post.title} - PortfolioRank`,
    description,
    alternates: { canonical: `/blog/${post.slug}` },
    // The share image is ./opengraph-image.tsx.
    openGraph: {
      type: "article",
      title: post.title,
      description,
      url: `/blog/${post.slug}`,
      publishedTime: post.publishAt ?? undefined,
      modifiedTime: postModified(post) ?? undefined,
      tags: post.tags,
    },
    twitter: { card: "summary_large_image", title: post.title, description },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await publishedPost(slug);
  if (!post) notFound();
  const [related, more] = await Promise.all([relatedPortfolios(post), moreArticles(post)]);
  const cover = coverOf(post.images);
  // A BlogPosting and its breadcrumb trail (lib/blog-seo.ts).
  const jsonLd = blogPostingLd(post, cover ? new URL(imageSrc(post.id, cover), SITE_URL).toString() : `${postUrl(post.slug)}/opengraph-image`);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
      <Article post={post} related={related} more={more} signup />
    </>
  );
}
