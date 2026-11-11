// The share of sampled pixels that differ noticeably between two PNG frames
// of the same size (1 when the sizes differ). Used by the captures
// (pipeline/capture.mjs, scripts/grade-jobs.mjs) to wait out preloaders and
// to detect motion. `centerOnly` restricts it to the middle third, where
// spinners and percent counters live, so their few changing pixels aren't
// drowned out.
import { PNG } from "pngjs";

export function pngDiff(bufA, bufB, centerOnly = false) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) return 1;
  const x0 = centerOnly ? Math.floor(a.width / 3) : 0;
  const x1 = centerOnly ? Math.floor((2 * a.width) / 3) : a.width;
  const y0 = centerOnly ? Math.floor(a.height / 3) : 0;
  const y1 = centerOnly ? Math.floor((2 * a.height) / 3) : a.height;
  const region = (x1 - x0) * (y1 - y0);
  const step = Math.max(1, Math.floor(Math.sqrt(region / 40000)));
  let diff = 0;
  let samples = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const o = (y * a.width + x) * 4;
      const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
      if (d > 30) diff++;
      samples++;
    }
  }
  return diff / samples;
}
