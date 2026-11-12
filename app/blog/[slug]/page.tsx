import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Article } from "@/components/blog/Article";
import { publishedPost, relatedPortfolios } from "@/lib/blog-server";
import { coverOf, imageSrc, postUrl } from "@/lib/blog";
import { SITE_URL } from "@/lib/site";

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
    openGraph: { type: "article", title: post.title, description, url: `/blog/${post.slug}`, publishedTime: post.publishAt ?? undefined, tags: post.tags },
    twitter: { card: "summary_large_image", title: post.title, description },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await publishedPost(slug);
  if (!post) notFound();
  const related = await relatedPortfolios(post);
  const cover = coverOf(post.images);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.subtitle ?? undefined,
    datePublished: post.publishAt,
    dateModified: post.publishAt,
    url: postUrl(post.slug),
    mainEntityOfPage: postUrl(post.slug),
    image: cover ? new URL(imageSrc(post.id, cover), SITE_URL).toString() : `${SITE_URL}/blog/${post.slug}/opengraph-image`,
    keywords: post.tags.join(", "),
    author: { "@type": "Organization", name: "PortfolioRank", url: SITE_URL },
    publisher: { "@type": "Organization", name: "PortfolioRank", url: SITE_URL, logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` } },
    isBasedOn: post.facts?.dataLink,
    citation: post.claims.map((c) => c.url),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Article post={post} related={related} />
    </>
  );
}
