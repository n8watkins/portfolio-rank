import { testSeam, workerEnv } from "@/lib/grader/server";

// A post image's bytes by its storage key (docs/CONTENT-ENGINE.md, "What is
// built": charts under content/<SITE_ENV>/<post id>/, library and fresh
// illustrations under private/library/<SITE_ENV>/, our screenshots under
// their shot key), from the SHOTS bucket; off the deployed Workers,
// BLOG_TEST_MEDIA_DIR can stand in for the bucket (the tests and the local
// fixture preview, scripts/seed-blog-fixtures.mjs).

const TYPES: Record<string, string> = { svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** The content type a key's extension says, or null for anything that isn't an image we store. */
export function mediaType(key: string): string | null {
  return TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** A key we may ever read for a post: no traversal, a known image type. */
export function safeKey(key: unknown): key is string {
  return typeof key === "string" && /^[a-z0-9][a-z0-9/_.-]*$/i.test(key) && !key.includes("..") && mediaType(key) !== null;
}

export async function readMedia(key: string): Promise<Uint8Array | null> {
  if (!safeKey(key)) return null;
  const dir = testSeam("BLOG_TEST_MEDIA_DIR");
  if (dir) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    try {
      return new Uint8Array(await fs.readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, key)));
    } catch {
      return null;
    }
  }
  const env = await workerEnv();
  const bucket = env.SHOTS as CloudflareEnv["SHOTS"] | undefined;
  const obj = bucket ? await bucket.get(key) : null;
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}
