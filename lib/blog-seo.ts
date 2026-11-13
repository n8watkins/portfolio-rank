import { SITE, SITE_URL } from "@/lib/site";
import { type BlogPost, postUrl } from "@/lib/blog";
import { breadcrumbList, graph } from "@/lib/json-ld";

// A post's structured data (docs/BOTS-AND-SEO.md, "Blog posts"): a
// BlogPosting with the owner as its author (he reads and publishes every
// post, /about-posts), its real edit time, and the trail Home > Blog > post.

/** The owner, who publishes every post. */
export const OWNER = {
  "@type": "Person",
  name: "Nathan Watkins",
  url: SITE.n8builds,
  sameAs: ["https://github.com/n8watkins"],
} as const;

/**
 * When a post last changed in public: its publish time, or a later update to
 * the row (re-published, its text edited). An update before the publish time
 * (scheduling it) doesn't count.
 */
export function postModified(post: Pick<BlogPost, "publishAt" | "updatedAt">): string | null {
  const at = [post.publishAt, post.updatedAt].filter((t): t is string => Boolean(t) && !Number.isNaN(Date.parse(t!)));
  if (!at.length) return null;
  return new Date(Math.max(...at.map((t) => Date.parse(t)))).toISOString();
}

/** `image`: the post's cover, else its generated share image (absolute). */
export function blogPostingLd(post: BlogPost, image: string) {
  const url = postUrl(post.slug);
  return graph([
    {
      "@type": "BlogPosting",
      "@id": `${url}#article`,
      headline: post.title,
      description: post.subtitle ?? undefined,
      datePublished: post.publishAt,
      dateModified: postModified(post) ?? post.publishAt,
      url,
      mainEntityOfPage: url,
      image,
      keywords: post.tags.join(", "),
      inLanguage: "en",
      author: OWNER,
      publisher: { "@type": "Organization", name: SITE.name, url: SITE_URL, logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` } },
      isBasedOn: post.facts?.dataLink,
      citation: post.claims.map((c) => c.url),
    },
    breadcrumbList([
      { name: SITE.name, url: SITE_URL },
      { name: "Blog", url: `${SITE_URL}/blog` },
      { name: post.title, url },
    ]),
  ]);
}
