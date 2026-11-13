import { blogEntries, pageEntries, profileEntries } from "@/lib/sitemap-entries";
import { XML_HEADERS, chunk, parsePart, urlsetXml } from "@/lib/sitemaps.mjs";

// One part of the sitemap (app/sitemap.xml lists them): /sitemap/pages.xml,
// /sitemap/blog.xml and /sitemap/profiles-<n>.xml. Rebuilt once a day; a
// failed rebuild keeps yesterday's file. A part past the last profiles file,
// or any other name, is a 404.

export const revalidate = 86400;

export async function generateStaticParams() {
  return [];
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(_request: Request, { params }: { params: Promise<{ part: string }> }) {
  const part = parsePart((await params).part);
  if (!part) return notFound();
  if (part.kind === "pages") return new Response(urlsetXml(pageEntries()), { headers: XML_HEADERS });
  if (part.kind === "blog") return new Response(urlsetXml(await blogEntries()), { headers: XML_HEADERS });
  const files = chunk(await profileEntries());
  const file = files[(part.n ?? 0) - 1];
  return file ? new Response(urlsetXml(file), { headers: XML_HEADERS }) : notFound();
}
