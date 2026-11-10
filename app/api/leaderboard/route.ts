import { NextResponse } from "next/server";
import { isView, readBoard } from "@/lib/ranking/board";
import { cachedResponse } from "@/lib/edge-cache";

// The new leaderboards (ranking v2, RANKING.md), read-only and public, like
// the method and the comparisons behind them:
//   GET /api/leaderboard?view=merged|people|ai&limit=100&offset=0
// merged is the default. Empty until scripts/recompute-ratings.mjs has run.
// No page uses this yet; the /top page keeps the ELO board until the switch.
// The board changes once a night, so each answer is kept at the edge for 5
// minutes (lib/edge-cache.ts), keyed by the normalised view, limit and offset.
export const dynamic = "force-dynamic";

const MAX_AGE = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const view = params.get("view") ?? "merged";
  if (!isView(view)) {
    return NextResponse.json({ error: "view must be merged, people or ai" }, { status: 400 });
  }
  const limit = Math.min(Math.max(Math.floor(Number(params.get("limit"))) || 100, 1), 500);
  const offset = Math.max(Math.floor(Number(params.get("offset"))) || 0, 0);
  const key = `${url.origin}/api/leaderboard?view=${view}&limit=${limit}&offset=${offset}`;
  return cachedResponse(key, async () =>
    NextResponse.json(await readBoard(view, { limit, offset }), { headers: { "cache-control": `public, max-age=${MAX_AGE}` } })
  );
}
