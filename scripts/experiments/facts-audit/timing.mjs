#!/usr/bin/env node
// The audit's wait numbers from a probe run (probe.mjs meta files): how much
// of the page the render.mjs reading point (R: network idle, then 1 s) and the
// capture's reading (A) had compared with the settled page (A2: after the text
// held for 8 s), the facts the old code got wrong at R but right at A, and
// what a settle rule "text holds for Q ms, at most M ms" would cost and catch,
// replayed on the recorded text-length series.
//
//   node scripts/experiments/facts-audit/timing.mjs <before-dir> [<after-dir>]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const [dir, afterDir] = process.argv.slice(2);
const sample = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "sample.json"), "utf8"));
const key = (u) => createHash("sha1").update(u).digest("hex").slice(0, 12);
const metas = sample.map((s) => JSON.parse(fs.readFileSync(path.join(dir, key(s.url), "meta-before.json"), "utf8"))).filter((m) => m.A);

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 100);
const rThin = metas.filter((m) => pct(m.R.words, m.A2?.words ?? m.A.words) < 50);
console.log(`sites with a capture reading: ${metas.length}`);
console.log(`R (render.mjs point) had under half of the settled words: ${rThin.length} (${rThin.map((m) => `${m.url} ${m.R.words}/${m.A2?.words}`).join(", ")})`);
const aShort = metas.filter((m) => (m.A2?.chars ?? 0) > m.A.chars * 1.05 + 20);
console.log(`A (the capture's reading) had 5% fewer characters than the settled page: ${aShort.length} (${aShort.map((m) => `${m.url} ${m.A.chars}->${m.A2.chars}`).join(", ")})`);
const grewAtAll = metas.filter((m) => m.series && m.series.at(-1)[1] !== m.series[0][1]);
console.log(`text still changing after the capture's reading: ${grewAtAll.length} site(s)`);

// Replay a settle rule on each series: when it would stop and how much text it would have by then.
function replay(series, quietMs, maxMs) {
  let stillSince = series[0][0];
  let last = series[0][1];
  for (const [t, n] of series) {
    if (n !== last) stillSince = t;
    last = n;
    if (t - stillSince >= quietMs || t >= maxMs) return { ms: t, chars: n };
  }
  const end = series.at(-1);
  return { ms: Math.min(end[0], maxMs), chars: end[1] };
}
for (const [q, m] of [
  [1500, 8000],
  [2000, 10000],
  [3000, 10000],
]) {
  const r = metas.filter((x) => x.series?.length).map((x) => ({ ...replay(x.series, q, m), final: x.series.at(-1)[1] }));
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  const caught = r.filter((x) => x.chars >= x.final).length;
  console.log(`settle rule quiet ${q} ms, ceiling ${m} ms: median ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms, max ${ms.at(-1)} ms; reaches the settled length on ${caught} of ${r.length}`);
}
const capT = metas.map((m) => m.t.A).sort((a, b) => a - b);
console.log(`capture replay, load to the capture's reading: median ${Math.round(capT[Math.floor(capT.length / 2)] / 1000)} s, max ${Math.round(capT.at(-1) / 1000)} s (machine load inflates these)`);

if (afterDir) {
  const after = sample
    .map((s) => {
      const f = path.join(afterDir, key(s.url), "meta-after.json");
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    })
    .filter((m) => m?.settle);
  const ms = after.map((m) => m.settle.ms).sort((a, b) => a - b);
  console.log(`after pass, settleText in the capture: ${after.length} site(s), median ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms, max ${ms.at(-1)} ms; text grew meanwhile on ${after.filter((m) => m.settle.grew > 0).length}`);
}
