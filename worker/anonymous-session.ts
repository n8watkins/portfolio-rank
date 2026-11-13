/**
 * The header's session read for visitors who are not signed in.
 *
 * Every page load asks GET /api/auth/session once (lib/session-client.ts).
 * Without a session cookie Auth.js can only answer `null`, but reaching it
 * starts Next.js and Auth.js first: about 50 ms of CPU, on most page views,
 * since most visitors and every crawler that runs scripts are signed out.
 * This answers that case before Next, with the body and cache headers Auth.js
 * sends. Any request with a session cookie, even an expired or chunked one,
 * still goes to Auth.js, which decodes it and clears it when needed.
 *
 * Auth.js also sets its CSRF and callback-url cookies on this answer; they are
 * left out here because sign-in fetches /api/auth/csrf itself
 * (next-auth/react signIn), which sets them.
 */
const SESSION_PATH = '/api/auth/session'

/** auth.ts uses Auth.js's default names: `authjs.session-token`, `__Secure-` on https, chunked as `.0`, `.1`... */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?authjs\.session-token(?:\.\d+)?=/

export function anonymousSession(request: Request): Response | null {
  if (request.method !== 'GET') return null
  if (new URL(request.url).pathname !== SESSION_PATH) return null
  if (SESSION_COOKIE.test(request.headers.get('Cookie') ?? '')) return null
  return new Response('null', {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-cache, no-store',
      Expires: '0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
