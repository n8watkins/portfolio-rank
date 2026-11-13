import { SITE_URL } from "@/lib/site";
import { blogEntries, profileEntries } from "@/lib/sitemap-entries";
import { BLOG_PART, PAGES_PART, XML_HEADERS, chunk, newest, profilesPart, sitemapIndexXml } from "@/lib/sitemaps.mjs";

// The sitemap index (robots.txt points here): one part for the site's pages,
// one for the blog, and the profiles in files of 10,000 (lib/sitemaps.mjs),
// each with the newest lastmod in it. Rebuilt once a day like its parts, so
// a profile that is graded, hidden or removed joins or leaves by the next
// day; a failed rebuild keeps yesterday's index.

export const revalidate = 86400;

export async function GET() {
  const [blog, profiles] = await Promise.all([blogEntries(), profileEntries()]);
  const part = (name: string) => `${SITE_URL}/sitemap/${name}.xml`;
  const xml = sitemapIndexXml([
    { url: part(PAGES_PART) },
    { url: part(BLOG_PART), lastmod: newest(blog) },
    ...chunk(profiles).map((files, i) => ({ url: part(profilesPart(i + 1)), lastmod: newest(files) })),
  ]);
  return new Response(xml, { headers: XML_HEADERS });
}
