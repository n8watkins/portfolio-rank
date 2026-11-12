// The places a board shows (components/top/Leaderboard.tsx and the medals in
// components/ui/badges.tsx RankBadge).
//
// Two numbers per row, kept apart on purpose:
//   rank   the place shown as text: neighbours the board marks tied, with the
//          same score as shown, share the higher one's rank ("=3"), so the
//          number stays honest about ties;
//   place  the row's position in the board's own order (1, 2, 3, ...), which
//          is already deterministic (lib/ranking/engine.mjs buildBoard: score,
//          then the tighter estimate, then the address). Medals go by place,
//          so a view has exactly one gold, one silver and one bronze however
//          many rows share a rank.

/**
 * @param {{ rank: number, mu: number, tiedWithNext: boolean }[]} rows best first, as lib/ranking/board.ts readBoard returns them
 * @returns {{ rank: number, place: number, tied: boolean }[]}
 */
export function shownPlaces(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const shared = Boolean(prev?.tiedWithNext) && prev.mu.toFixed(1) === r.mu.toFixed(1);
    if (shared) out[i - 1].tied = true;
    out.push({ rank: shared ? out[i - 1].rank : r.rank, place: r.rank, tied: shared });
  });
  return out;
}

/** "gold", "silver" or "bronze" for places 1 to 3, else null. */
export function medalFor(place) {
  return place === 1 ? "gold" : place === 2 ? "silver" : place === 3 ? "bronze" : null;
}
