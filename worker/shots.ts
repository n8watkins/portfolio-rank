// Our screenshots from the SHOTS R2 bucket, /shots/<shot_key>/<file>?v=<version>
// (answered by the Worker before the app, with the edge cache in front,
// ./assets.ts): the old frames, hero.jpg and mobile.jpg (pipeline/shot-files.mjs).
// Pages add ?v= (the capture's time, lib/shot-url.ts), so a recapture gets a
// new URL and the old one can be cached for a year; without a version a
// response is cached for a day.
//
// The tall images and thumbnails never come through here: they live in the
// public images bucket and are served by R2 itself on its own domain
// (IMAGES_BASE_URL, pipeline/shot-store.mjs), with no Worker CPU per image.

export const SHOT_FILES: Record<string, string> = {
  "hero.jpg": "image/jpeg",
  "mobile.jpg": "image/jpeg",
};

const YEAR = 31536000;
const DAY = 86400;

type Bucket = { get(key: string): Promise<{ body: ReadableStream; httpEtag: string } | null> };
export type ShotsEnv = { SHOTS: Bucket };

const PATH = /^\/shots\/([0-9a-f]{16})\/([a-z]{1,16}\.jpg)$/;
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
