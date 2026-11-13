// One address per site (lib/site.ts SITE_URL): the production Worker also
// answers at its old address and at www, staging at its old address
// (wrangler.jsonc routes), and each sends
// every request there to the same path and query on its SITE_URL, before
// anything else runs. GET and HEAD get a 301; other methods a 308, which keeps
// the method and body, so an API caller still on the old address keeps
// working while it moves. Any other host (staging, local runs) is answered as
// usual. Staging redirects before its gate, which then asks again on the
// new host (its cookie belongs to the host).

/** The redirect for a request on one of oldHosts (lib/site.ts OLD_SITE_HOSTS), or null to answer it here. */
export function canonicalRedirect(request: Request, siteUrl: string | undefined, oldHosts: readonly string[]): Response | null {
  if (!siteUrl) return null;
  const url = new URL(request.url);
  if (!oldHosts.includes(url.hostname)) return null;
  let target: URL;
  try {
    target = new URL(siteUrl);
  } catch {
    return null;
  }
  if (target.hostname === url.hostname) return null;
  const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return new Response(null, {
    status,
    headers: { Location: `${target.origin}${url.pathname}${url.search}`, "Cache-Control": "public, max-age=86400" },
  });
}
