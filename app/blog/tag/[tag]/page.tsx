import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogIndex } from "@/components/blog/BlogIndex";
import { publishedPosts } from "@/lib/blog-server";
import { tagsOf } from "@/lib/content/blog.mjs";

// One tag's posts, rendered on first visit and at most every 5 minutes (ISR).
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }): Promise<Metadata> {
  const { tag } = await params;
  const name = tagsOf(await publishedPosts()).find((t) => t.slug === tag)?.name;
  if (!name) return {};
  return { title: `${name} - PortfolioRank blog`, alternates: { canonical: `/blog/tag/${tag}` } };
}

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const all = await publishedPosts();
  const tags = tagsOf(all);
  const current = tags.find((t) => t.slug === tag);
  if (!current) notFound();
  return <BlogIndex posts={await publishedPosts({ tag })} tags={tags} current={current} />;
}
