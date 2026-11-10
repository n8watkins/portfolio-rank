import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { imageFor } from "@/worker/assets";

// Our Playwright captures (<shot_key>/<file>) from the SHOTS R2 bucket. In
// production the Worker answers /shots/... itself, with edge caching, before
// the app (worker/assets.ts); this route serves the same thing under
// `next dev`, where the binding is a simulated bucket.
export async function GET(req: Request) {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const make = imageFor(new URL(req.url), env);
    if (make) return await make();
  } catch {
    /* no bucket binding: nothing to serve */
  }
  return new NextResponse("not found", { status: 404 });
}
