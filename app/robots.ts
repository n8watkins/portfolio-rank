import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const BASE = SITE_URL;

export default function robots(): MetadataRoute.Robots {
  return {
    // Personal pages (/me, /profile, /votes, /settings) and reports say noindex
    // themselves; crawlers must be able to fetch them to see it.
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/admin/"] },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
