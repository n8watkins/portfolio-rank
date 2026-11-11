"use client";

import { useEffect } from "react";
import { ROUTES } from "@/lib/nav";

/**
 * The browse grid used to live on home (/#browse, /?q=...&role=...); it now
 * has its own page. Old links and bookmarks land there with their filters.
 */
export function BrowseRedirect() {
  useEffect(() => {
    if (!ROUTES.browse) return;
    const url = new URL(location.href);
    const filtered = ["q", "role", "letter"].some((k) => url.searchParams.has(k));
    if (filtered || url.hash === "#browse") location.replace(`${ROUTES.browse}${url.search}`);
  }, []);
  return null;
}
