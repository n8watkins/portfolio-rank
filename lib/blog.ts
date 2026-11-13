import { SITE_URL } from "@/lib/site";

// What the blog pages need about a post and its images (lib/content/blog.mjs
// reads them; docs/CONTENT-ENGINE.md, "Images" says what each field holds).

export type PostImage = {
  slot: string;
  kind: "chart" | "screenshot" | "library" | "illustration" | "stock" | string;
  source?: string;
  key?: string;
  url?: string;
  alt?: string;
  caption?: string;
  licence?: string;
  credit?: string;
  creditUrl?: string;
  sourceUrl?: string;
};

export type PostName = { name: string; url?: string; domain?: string | null; reason?: string };
export type PostClaim = { sentence: string; url: string; title?: string };

export type BlogPost = {
  id: string;
  slug: string;
  kind: string;
  status: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  aiLine: string;
  aiNote: string;
  body: string;
  facts: { dataAsOf?: string; dataLink?: string; names?: PostName[]; facts?: { id: string; label: string; display: string }[] } | null;
  checks: { passed?: boolean; rounds?: number; failures?: string[]; owner?: { action: string; by: string; at: string; note?: string }; history?: unknown[] } | null;
  images: PostImage[];
  claims: PostClaim[];
  dataAsOf: string;
  publishAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  /** The row's last change (a publish, an owner's decision, an edit). */
  updatedAt: string | null;
  requests: number;
  minutes: number;
  shareLine: string | null;
  altTitles: string[];
};

export type BlogListItem = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  images: PostImage[];
  dataAsOf: string;
  publishAt: string;
  minutes: number;
};

/** Where an image is served from: Pexels photos are hotlinked (their licence asks for it), everything we store goes through /blog/media. */
export function imageSrc(postId: string, im: PostImage): string {
  if (im.url && /^https:\/\//.test(im.url)) return im.url;
  return `/blog/media/${postId}/${im.slot}`;
}

/** The cover: the hero slot, else the first image. */
export const coverOf = (images: PostImage[]) => images.find((i) => i.slot === "hero") ?? images[0] ?? null;

/** "Nov 11, 2026" in Pacific time, the site's day. */
export function postDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

export const postUrl = (slug: string) => `${SITE_URL}/blog/${slug}`;

/** The credit line under an image: who made it, and the licence's own words where it matters. */
export function creditOf(im: PostImage): { text: string; href?: string } {
  if (im.kind === "illustration" || im.kind === "library") return { text: im.caption || "AI-generated illustration" };
  if (im.kind === "stock") return { text: im.credit || "Photo on Pexels", href: im.creditUrl || im.sourceUrl };
  if (im.kind === "screenshot") return { text: im.credit || "Screenshot", href: im.creditUrl };
  return { text: im.credit || "Chart: PortfolioRank data" };
}
