import type { Metadata } from "next";
import { BlogIndex } from "@/components/blog/BlogIndex";
import { publishedPosts } from "@/lib/blog-server";
import { tagsOf } from "@/lib/content/blog.mjs";

// Rendered at most once every 5 minutes (ISR): anonymous visitors are served
// from the edge cache, and a post shows up within 5 minutes of its
// publish_at (owner review on /admin/blog, or the engine's schedule).
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Blog - PortfolioRank",
  description: "Short posts from PortfolioRank's own data on what the best developer portfolios do. Code computes every number; a person reads every post.",
  alternates: { canonical: "/blog", types: { "application/rss+xml": "/blog/rss.xml" } },
  openGraph: { type: "website", title: "PortfolioRank blog", url: "/blog" },
};

export default async function BlogPage() {
  const posts = await publishedPosts();
  return <BlogIndex posts={posts} tags={tagsOf(posts)} current={null} />;
}
