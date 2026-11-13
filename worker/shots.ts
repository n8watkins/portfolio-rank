// Our screenshots from the SHOTS R2 bucket, /shots/<shot_key>/<file>?v=<version>
// (answered by the Worker before the app, with the edge cache in front,
// ./assets.ts). The files are the ones the capture stores
// (pipeline/shot-files.mjs): the hero and phone tops as JPEG, and the
// full-page frames as WebP. Pages add ?v= (the capture's time,
// lib/shot-url.ts), so a recapture gets a new URL and the old one can be
// cached for a year; without a version a response is cached for a day.
//
// Serving the full-page files needs no switch: nothing links to them while
// FULLPAGE_PREVIEW_ENABLED is off (lib/fullpage-flag.ts).

export const SHOT_FILES: Record<string, string> = {
  "hero.jpg": "image/jpeg",
  "mobile.jpg": "image/jpeg",
  "full-desktop.webp": "image/webp",
  "full-phone.webp": "image/webp",
};

const YEAR = 31536000;
const DAY = 86400;

type Bucket = { get(key: string): Promise<{ body: ReadableStream; httpEtag: string } | null> };
export type ShotsEnv = { SHOTS: Bucket };

const PATH = /^\/shots\/([0-9a-f]{16})\/([a-z-]{1,24}\.(?:jpg|webp))$/;
const VERSION = /^[0-9a-z]{1,16}$/;

async function shot(key: string, file: string, versioned: boolean, env: ShotsEnv): Promise<Response> {
  const object = await env.SHOTS.get(`${key}/${file}`);
  if (!object) return new Response("not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  return new Response(object.body, {
    headers: {
      "Content-Type": SHOT_FILES[file],
      "Cache-Control": versioned ? `public, max-age=${YEAR}, immutable` : `public, max-age=${DAY}`,
      ETag: object.httpEtag,
    },
  });
}

/** How to answer a screenshot URL (uncached), or null when the URL isn't one. */
export function shotFor(url: URL, env: ShotsEnv): (() => Promise<Response>) | null {
  const m = url.pathname.match(PATH);
  if (!m || !Object.hasOwn(SHOT_FILES, m[2])) return null;
  const versioned = VERSION.test(url.searchParams.get("v") ?? "");
  return () => shot(m[1], m[2], versioned, env);
}
