import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Serves our Playwright captures (<shot_key>/<file>) from the R2 bucket the
// pipeline uploads them to (pipeline/capture.mjs), through the Worker's SHOTS
// binding. Pages normally link the bucket's public URL (SHOTS_BASE_URL); this
// route serves the same objects at /shots/<shot_key>/<file>.
// Locked down: shot_key must be 16 hex chars and the file must be allowlisted,
// so only capture objects can be read from the bucket.
const ALLOWED = new Set([
  "hero.jpg",
  "mobile.jpg",
  "full.jpg",
  "strip0.png",
  "strip1.png",
  "strip2.png",
]);
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png" };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; file: string }> }
) {
  const { key, file } = await params;
  if (!/^[0-9a-f]{16}$/.test(key) || !ALLOWED.has(file)) {
    return new NextResponse("not found", { status: 404 });
  }
  try {
    const { env } = await getCloudflareContext({ async: true });
    const object = await env.SHOTS.get(`${key}/${file}`);
    if (!object) return new NextResponse("not found", { status: 404 });
    return new NextResponse(object.body, {
      headers: {
        "Content-Type": MIME[file.split(".").pop() ?? ""] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
