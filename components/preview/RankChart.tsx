/** Merged rank over the last eight weekly updates. Rank 1 is at the top. */
export function RankChart({ points }: { points: { week: string; rank: number }[] }) {
  const W = 600;
  const H = 280;
  const pad = { l: 52, r: 64, t: 16, b: 30 };
  const ranks = points.map((p) => p.rank);
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  const span = Math.max(10, hi - lo);
  const top = Math.max(1, lo - span * 0.15);
  const bottom = hi + span * 0.15;
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (r: number) => pad.t + ((r - top) / (bottom - top)) * (H - pad.t - pad.b);
  const ticks = [Math.round(top), Math.round((top + bottom) / 2), Math.round(bottom)];
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.rank).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Merged rank went from #${first.rank} on ${first.week} to #${last.rank} on ${last.week}.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-edge" strokeWidth="1" />
            <text x={pad.l - 10} y={y(t)} dy="0.35em" textAnchor="end" className="fill-mute text-[14px] tabular-nums">
              #{t}
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={p.week} x={x(i)} y={H - 8} textAnchor="middle" className={`fill-mute text-[13px] ${i % 2 && i !== points.length - 1 ? "max-sm:hidden" : ""}`}>
            {p.week}
          </text>
        ))}
        <path d={path} fill="none" className="stroke-accent" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={p.week} cx={x(i)} cy={y(p.rank)} r="4" className="fill-accent stroke-card" strokeWidth="2">
            <title>{`${p.week}: #${p.rank} merged`}</title>
          </circle>
        ))}
        <text x={x(points.length - 1) + 10} y={y(last.rank)} dy="0.35em" className="fill-ink text-[15px] font-semibold tabular-nums">
          #{last.rank}
        </text>
      </svg>
      <table className="sr-only">
        <caption>Merged rank by week</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.week}>
              <th scope="row">{p.week}</th>
              <td>#{p.rank}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
