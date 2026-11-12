import { db, ensureSchema } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { cachedResponse } from "@/lib/edge-cache";
import { getPost } from "@/lib/content/blog.mjs";
import { mediaType, readMedia } from "@/lib/blog-media";
import type { PostImage } from "@/lib/blog";

// A post's image by post id and slot: GET /blog/media/<post id>/<slot>.
// The key comes from the post's own row, never from the address, so this
// serves only images a post uses. A published post's images are public and
// cached at the edge and in browsers for a day (an image never changes for
// a given post and slot); a draft's, rejected or unpublished post's images
// only for the admin, never from a shared cache.
export const dynamic = "force-dynamic";

const PRIVATE = "private, no-store";
const notFound = () => new Response("not found", { status: 404, headers: { "cache-control": PRIVATE } });

function answer(bytes: Uint8Array, key: string, cacheControl: string): Response {
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": mediaType(key)!,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      // Charts are SVG drawn by code; even so, an SVG opened on its own runs nothing.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string; slot: string }> }) {
  const { id, slot } = await params;
  if (!/^[0-9a-f]{16}$/.test(id) || !/^[a-z0-9-]{1,20}$/.test(slot)) return notFound();
  await ensureSchema();
  const post = await getPost(db(), id);
  const image = (post?.images as PostImage[] | undefined)?.find((im) => im.slot === slot);
  if (!post || !image?.key) return notFound();
  const key = image.key;
  const live = post.status === "published" && post.publishAt != null && Date.parse(post.publishAt) <= Date.now();
  if (live) {
    const url = new URL(req.url);
    return cachedResponse(`${url.origin}/blog/media/${id}/${slot}`, async () => {
      const bytes = await readMedia(key);
      return bytes ? answer(bytes, key, "public, max-age=86400") : notFound();
    });
  }
  const who = await requireAdmin();
  if ("error" in who) return notFound();
  const bytes = await readMedia(key);
  return bytes ? answer(bytes, key, PRIVATE) : notFound();
}
