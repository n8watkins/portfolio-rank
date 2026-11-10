import { imageFor } from "@/worker/assets";

// A roster site's icon, or a placeholder when it has none. In production the
// Worker answers /favicon/... itself, with edge caching (worker/assets.ts);
// this route serves the same thing under `next dev` and `next start`.
export async function GET(req: Request) {
  const make = imageFor(new URL(req.url), { SHOTS: undefined as never });
  return make ? make() : new Response("not found", { status: 404 });
}
