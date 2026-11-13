// Structured data (schema.org JSON-LD) shared by the public pages: the
// breadcrumb trail and the inline <script> body. Each page builds its own
// graph (lib/blog-seo.ts for posts) and renders it with jsonLdHtml.

export type Crumb = { name: string; url: string };

/** A BreadcrumbList from the site's root down to the page itself, absolute URLs. */
export function breadcrumbList(crumbs: Crumb[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })),
  };
}

/** Several nodes as one JSON-LD document. */
export const graph = (nodes: object[]) => ({ "@context": "https://schema.org", "@graph": nodes });

/** The <script type="application/ld+json"> body: "<" escaped so text in it can never close the tag. */
export const jsonLdHtml = (data: object) => JSON.stringify(data).replace(/</g, "\\u003c");
