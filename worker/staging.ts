// The staging site (wrangler.jsonc env.staging, DEPLOY.md "Staging") must
// never be indexed: when SITE_ENV is "staging", robots.txt disallows
// everything and every response carries `X-Robots-Tag: noindex, nofollow`.
// The app adds the visible "Staging" ribbon and a robots meta tag from its
// build (lib/site.ts IS_STAGING), so a page shows it even before this runs.

export const STAGING_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

export function isStaging(env: { SITE_ENV?: string }): boolean {
  return env.SITE_ENV === "staging";
}

/** robots.txt for staging, or null to let the app answer. */
export function stagingRobots(request: Request, env: { SITE_ENV?: string }): Response | null {
  if (!isStaging(env) || new URL(request.url).pathname !== "/robots.txt") return null;
  return new Response(STAGING_ROBOTS_TXT, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

/** Adds the noindex header on staging; production responses pass through untouched. */
export function markStaging(response: Response, env: { SITE_ENV?: string }): Response {
  if (!isStaging(env)) return response;
  const marked = new Response(response.body, response);
  marked.headers.set("X-Robots-Tag", "noindex, nofollow");
  return marked;
}
