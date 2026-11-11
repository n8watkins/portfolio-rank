/**
 * The uptime check (GET /healthz): `ok`, answered before Next.js, the
 * middleware, auth or the database run. No cookie, no bindings, no cache.
 */
export function healthCheck(request: Request): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  if (new URL(request.url).pathname !== '/healthz') return null
  return new Response(request.method === 'HEAD' ? null : 'ok', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
