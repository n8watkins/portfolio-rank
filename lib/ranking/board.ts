import { db, ensureSchema } from "@/lib/db";

// Read side of the new leaderboards (ranking v2, RANKING.md) for the app:
// scripts/recompute-ratings.mjs writes site_ratings; this only reads it.
// Not used by any page yet: the switch from the ELO board happens with the
// redesign. Until the first recompute the table doesn't exist and every
// view is empty. The API in front of it is cached at the edge
// (app/api/leaderboard).

export const VIEWS = ["merged", "people", "ai"] as const;
export type View = (typeof VIEWS)[number];

export const isView = (v: unknown): v is View => typeof v === "string" && (VIEWS as readonly string[]).includes(v);

export type BoardRow = {
  rank: number;
  url: string;
  mu: number;
  sigma: number;
  low: number;
  high: number;
  confidence: "settled" | "confident" | "provisional" | "unsure";
  tiedWithNext: boolean;
  comparisons: number;
  wins: number;
  losses: number;
  tier: string | null;
};

export type Board = { view: View; computedAt: string | null; total: number; rows: BoardRow[] };

/**
 * One page of a view of the board, best first. Which sites the app shows (on
 * the list, not hidden) is decided when the board is computed
 * (lib/ranking/store.mjs assignShownRanks), so a request reads only its page
 * through the (view, shown_rank) index plus two single-row lookups, never
 * the whole view (docs/COSTS.md section C).
 */
export async function readBoard(view: View, { limit = 100, offset = 0 } = {}): Promise<Board> {
  await ensureSchema();
  let rows: BoardRow[] = [];
  let total = 0;
  let computedAt: string | null = null;
  try {
    const res = await db().execute({
      // The tier is today's tier by rank (lib/tiers.mjs, placed hourly), read from the grade by primary key,
      // so a board computed before the last refresh never shows a stale tier.
      sql: `SELECT s.shown_rank, s.url, s.mu, s.sigma, s.confidence, s.tied_with_next, s.comparisons, s.wins, s.losses,
                   CASE WHEN json_valid(p.ai_rubric) THEN json_extract(p.ai_rubric, '$.rank.tier') END AS tier
            FROM site_ratings s LEFT JOIN portfolios p ON p.url = s.url
            WHERE s.view = ? AND s.shown_rank > ? ORDER BY s.shown_rank LIMIT ?`,
      args: [view, offset, limit],
    });
    rows = res.rows.map((r) => {
      const mu = Number(r.mu);
      const sigma = Number(r.sigma);
      return {
        rank: Number(r.shown_rank),
        url: String(r.url),
        mu,
        sigma,
        low: Math.round((mu - 2 * sigma) * 100) / 100,
        high: Math.round((mu + 2 * sigma) * 100) / 100,
        confidence: String(r.confidence) as BoardRow["confidence"],
        tiedWithNext: Number(r.tied_with_next) === 1,
        comparisons: Number(r.comparisons),
        wins: Number(r.wins),
        losses: Number(r.losses),
        tier: r.tier == null ? null : String(r.tier),
      };
    });
    const max = await db().execute({ sql: "SELECT MAX(shown_rank) AS n FROM site_ratings WHERE view = ?", args: [view] });
    total = Number(max.rows[0]?.n ?? 0);
    const run = await db().execute("SELECT at FROM ranking_runs ORDER BY id DESC LIMIT 1");
    computedAt = run.rows[0]?.at == null ? null : String(run.rows[0].at);
  } catch (e) {
    // No recompute has run yet (the tables or the column don't exist): an empty board.
    if (!/no such (table|column)/i.test(String((e as Error).message))) throw e;
  }
  return { view, computedAt, total, rows };
}
