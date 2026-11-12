import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin } from "@/lib/admin";
import { getImage } from "@/lib/content/library.mjs";
import { readMedia } from "@/lib/blog-media";

// A library image's bytes for the review page, from its private prefix of
// the SHOTS bucket (lib/blog-media.ts readMedia, which off the deployed
// Workers can read the local fixture folder instead); only for the admin,
// never from a shared cache.
//   GET /api/admin/library/<id>/image
export const dynamic = "force-dynamic";

const notFound = () => new Response("not found", { status: 404, headers: { "cache-control": "private, no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireAdmin();
  if ("error" in who) return new Response(who.error, { status: adminErrorStatus(who.error), headers: { "cache-control": "private, no-store" } });
  const { id } = await params;
  if (!/^[0-9a-f]{16}$/.test(id)) return notFound();
  await ensureSchema();
  const image = await getImage(db(), id);
  if (!image) return notFound();
  const bytes = await readMedia(image.key);
  if (!bytes) return notFound();
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}
