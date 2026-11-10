import { NextResponse } from "next/server";
import { isView, readBoard } from "@/lib/ranking/board";

// The new leaderboards (ranking v2, RANKING.md), read-only and public, like
// the method and the comparisons behind them:
//   GET /api/leaderboard?view=merged|people|ai&limit=100&offset=0
// merged is the default. Empty until scripts/recompute-ratings.mjs has run.
// No page uses this yet; the /top page keeps the ELO board until the switch.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const view = params.get("view") ?? "merged";
  if (!isView(view)) {
    return NextResponse.json({ error: "view must be merged, people or ai" }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const board = await readBoard(view, { limit, offset });
  return NextResponse.json(board, { headers: { "cache-control": "public, max-age=300" } });
}
