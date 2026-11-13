// Profile addresses put right by the Worker before Next.js runs
// (docs/BOTS-AND-SEO.md F1, lib/profile-url.mjs profileRedirect).
//
// A profile used to live at its whole URL percent-encoded,
// /p/https%3A%2F%2Fjanedoe.dev; clients that decode it ask for
// /p/https://janedoe.dev, and Next.js makes that /p/https:/janedoe.dev. All
// three, and a readable address with "www.", an upper-case host or a
// trailing slash, get one 301 to /p/janedoe.dev with the query kept, so links
// and search engines' indexes carry over in one hop without rendering a page.
// A /p/ path that doesn't decode is a plain 404 here (Next.js would answer
// it with a 500).
//
// This is the only place profiles redirect: Next.js 16 answers a redirect
// thrown while rendering this catch-all page with its Location header twice,
// which browsers refuse. Under `next start` (the e2e tests) nothing is in
// front, so old forms there are a 404 and a wrong case renders with the one
// canonical.
import { profileRedirect } from "../lib/profile-url.mjs";

/** A 301 or 404 for a profile path that isn't the one address, or null to let the request through. */
export function legacyProfileRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/p/")) return null;
  const r = profileRedirect(url.pathname.slice("/p/".length));
  if (!r) return null;
  if ("bad" in r) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
  }
  return new Response(null, { status: 301, headers: { Location: `${r.to}${url.search}`, "Cache-Control": "public, max-age=86400" } });
}
