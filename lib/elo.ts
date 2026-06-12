export const BASE_ELO = 1200;

/**
 * Direction-independent key for a matchup, so "A beat B" and "B beat A" map to
 * the same value. Backs the UNIQUE(rater_id, pair_key) index that enforces
 * one vote per pair per rater atomically (no check-then-insert race). The
 * separator must be a byte that can't appear in a URL and isn't NUL (SQLite
 * truncates stored TEXT at a NUL byte) — a newline satisfies both.
 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("\n");
}

export function eloUpdate(winnerElo: number, loserElo: number, k = 32) {
  const expectedWin = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  const gain = k * (1 - expectedWin);
  return {
    winner: Math.round(winnerElo + gain),
    loser: Math.round(loserElo - gain),
  };
}
