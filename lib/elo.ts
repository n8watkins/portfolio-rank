export const BASE_ELO = 1200;

export function eloUpdate(winnerElo: number, loserElo: number, k = 32) {
  const expectedWin = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  const gain = k * (1 - expectedWin);
  return {
    winner: Math.round(winnerElo + gain),
    loser: Math.round(loserElo - gain),
  };
}
