// Old profile addresses, answered by the Worker before Next.js runs
// (docs/BOTS-AND-SEO.md F1, lib/profile-url.mjs). A profile used to live at
// its whole URL percent-encoded, /p/https%3A%2F%2Fjanedoe.dev; clients that
// decode it ask for /p/https://janedoe.dev, and Next.js makes that
// /p/https:/janedoe.dev. All three get one 301 to /p/janedoe.dev, with the
// query kept, so links and search engines' indexes carry over in one hop and
// without rendering a page. app/p/[...slug] redirects them too where the
// Worker isn't in front (next start, the tests).
import { legacyAddress, profilePath, requestedSlug } from "../lib/profile-url.mjs";

/** A 301 to the readable address for an old-style profile path, or null for anything else. */
export function legacyProfileRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/p/http")) return null;
  const address = legacyAddress(requestedSlug(url.pathname.slice("/p/".length)));
  if (!address) return null;
  return new Response(null, {
    status: 301,
    headers: { Location: `${profilePath(address)}${url.search}`, "Cache-Control": "public, max-age=86400" },
  });
}
