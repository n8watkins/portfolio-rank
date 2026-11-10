import { db, ensureSchema } from "@/lib/db";
import { hiddenUrls, isKnownPortfolio } from "@/lib/roster";

// Read side of the new leaderboards (ranking v2, RANKING.md) for the app:
// scripts/recompute-ratings.mjs writes site_ratings; this only reads it.
// Not used by any page yet: the switch from the ELO board happens with the
// redesign. Until the first recompute the table doesn't exist and every
// view is empty.

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
 * One view of the board, best first. Sites the app hides (down, failed
 * capture) and URLs no longer on the list are left out; ranks are counted
 * again over what is shown, so they have no gaps.
 */
export async function readBoard(view: View, { limit = 100, offset = 0 } = {}): Promise<Board> {
  await ensureSchema();
  let rows: BoardRow[] = [];
  let computedAt: string | null = null;
  try {
    const res = await db().execute({
      sql: `SELECT url, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, tier
            FROM site_ratings WHERE view = ? ORDER BY rank`,
      args: [view],
    });
    const hidden = await hiddenUrls();
    rows = res.rows
      .map((r) => ({ url: String(r.url), r }))
      .filter(({ url }) => isKnownPortfolio(url) && !hidden.has(url))
      .map(({ url, r }, i) => {
        const mu = Number(r.mu);
        const sigma = Number(r.sigma);
        return {
          rank: i + 1,
          url,
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
    const run = await db().execute("SELECT at FROM ranking_runs ORDER BY id DESC LIMIT 1");
    computedAt = run.rows[0]?.at == null ? null : String(run.rows[0].at);
  } catch (e) {
    // No recompute has run yet (the tables don't exist): an empty board.
    if (!/no such table/i.test(String((e as Error).message))) throw e;
  }
  return { view, computedAt, total: rows.length, rows: rows.slice(offset, offset + limit) };
}
