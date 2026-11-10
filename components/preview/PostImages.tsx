import { Check, X } from "lucide-react";

/**
 * IMAGE 2 of the "green checks" draft, made by code. Only known numbers are
 * drawn: zero AI grades from Jul 28 to Nov 10 and the 35-grade test batch on
 * Nov 10. Volume before Jul 28 isn't pulled from the database yet, so that
 * span is marked, not estimated (the draft's [check] note).
 */
export function GradesTimeline() {
  const W = 720;
  const H = 300;
  const pad = { l: 44, r: 20, t: 34, b: 40 };
  // Days from Jul 7 to Nov 12.
  const days = 128;
  const x = (d: number) => pad.l + (d / days) * (W - pad.l - pad.r);
  const yMax = 40;
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const dead0 = 21; // Jul 28
  const dead1 = 126; // Nov 10
  const ticks = [
    { d: 0, l: "Jul 7" },
    { d: dead0, l: "Jul 28" },
    { d: 56, l: "Sep 1" },
    { d: 86, l: "Oct 1" },
    { d: dead1, l: "Nov 10" },
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby="gt-t gt-d">
      <title id="gt-t">AI grades written per day</title>
      <desc id="gt-d">Zero AI grades every day from July 28 to November 10 while scheduled runs kept passing, then 35 grades on November 10 after the fix. Earlier weeks are not shown.</desc>
      <defs>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" className="stroke-edge-strong" strokeWidth="2" />
        </pattern>
      </defs>
      {[0, 10, 20, 30, 40].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="stroke-edge" strokeWidth="1" />
          <text x={pad.l - 8} y={y(v)} dy="0.35em" textAnchor="end" className="fill-mute text-[11px] tabular-nums">
            {v}
          </text>
        </g>
      ))}
      {/* Not pulled yet */}
      <rect x={x(0)} y={pad.t} width={x(dead0) - x(0)} height={H - pad.t - pad.b} fill="url(#hatch)" opacity="0.6" />
      <text x={(x(0) + x(dead0)) / 2} y={pad.t + 16} textAnchor="middle" className="fill-mute text-[11px]">
        not pulled yet
      </text>
      {/* Key dead, every run green */}
      <rect x={x(dead0)} y={pad.t} width={x(dead1) - x(dead0)} height={H - pad.t - pad.b} className="fill-down" opacity="0.08" />
      <text x={(x(dead0) + x(dead1)) / 2} y={pad.t + 16} textAnchor="middle" className="fill-down text-[12px] font-semibold">
        Key dead, every run green: 0 grades a day
      </text>
      <line x1={x(dead0)} x2={x(dead1)} y1={y(0)} y2={y(0)} className="stroke-down" strokeWidth="2.5" />
      {/* Fix */}
      <line x1={x(dead1)} x2={x(dead1)} y1={y(0)} y2={y(35)} className="stroke-accent" strokeWidth="6" strokeLinecap="round" />
      <circle cx={x(dead1)} cy={y(35)} r="5" className="fill-accent stroke-card" strokeWidth="2" />
      <text x={x(dead1) - 10} y={y(35)} dy="0.35em" textAnchor="end" className="fill-ink text-[12px] font-semibold">
        Fix shipped: 35 grades
      </text>
      {ticks.map((t) => (
        <text key={t.l} x={x(t.d)} y={H - 14} textAnchor="middle" className="fill-mute text-[11px]">
          {t.l}
        </text>
      ))}
      <text x={12} y={pad.t - 8} className="fill-mute text-[11px]">
        AI grades per day
      </text>
    </svg>
  );
}

/** IMAGE 3: the real before and after from the fix (commit 65a2cb7), key redacted. */
export function KeyCodeCompare() {
  const rows = [
    {
      ok: false,
      label: "Before: in the URL, so it ends up in logs",
      code: ["fetch(", "  `.../models/${MODEL}:generateContent?key=REDACTED`,", ")"],
    },
    {
      ok: true,
      label: "After: in a header",
      code: ["fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {", '  method: "POST",', '  headers: { "x-goog-api-key": REDACTED },', "})"],
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 p-4 sm:p-5">
      {rows.map((r) => (
        <div key={r.label} className="overflow-hidden rounded-xl border border-edge">
          <p className="flex items-center gap-2 border-b border-edge bg-raised px-3 py-2 text-xs font-semibold">
            {r.ok ? <Check className="h-4 w-4 text-up" aria-hidden /> : <X className="h-4 w-4 text-down" aria-hidden />}
            {r.label}
          </p>
          <pre className="overflow-x-auto bg-bg/60 px-4 py-3 font-mono text-[12.5px] leading-relaxed">
            {r.code.map((line, i) => (
              <code key={i} className="block">
                {line}
              </code>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
