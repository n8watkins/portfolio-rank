// Step 4: JPEG q75 (what pipeline/capture.mjs stores) versus WebP at the same
// visual quality, measured with SSIM against the lossless PNG.
//
//   node experiments/meta-schema-fonts/webp.mjs <shotsDir> <outDir>
//
// For each <key>-<view>.png with a matching .cr.jpg (Chromium's own JPEG q75,
// taken right after the PNG), finds the smallest WebP quality whose SSIM is at
// least the JPEG's. Also reports sharp's JPEG q75 and WebP at fixed qualities.
// Needs ffmpeg on PATH for SSIM.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const [shotsDir, outDir] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(shotsDir, "tmp-"));

/** SSIM and PSNR (All) of b against reference a, via ffmpeg (it prints to stderr). */
function score(a, b) {
  const graph = "[0:v]split[a][b];[1:v]split[c][d];[a][c]ssim;[b][d]psnr";
  const out = execFileSync("sh", ["-c", 'ffmpeg -hide_banner -nostats -i "$1" -i "$2" -lavfi "$3" -f null - 2>&1', "sh", a, b, graph], { encoding: "utf8" });
  const s = out.match(/SSIM .*All:([0-9.]+)/);
  const p = out.match(/PSNR .*average:([0-9.]+|inf)/);
  if (!s || !p) throw new Error("no score: " + out.slice(-300));
  return { ssim: Number(s[1]), psnr: p[1] === "inf" ? 99 : Number(p[1]) };
}

const rows = [];
const pngs = fs.readdirSync(shotsDir).filter((f) => f.endsWith(".png") && fs.existsSync(path.join(shotsDir, f.replace(".png", ".cr.jpg"))));
for (const f of pngs) {
  const png = path.join(shotsDir, f);
  const crJpg = png.replace(".png", ".cr.jpg");
  const view = f.includes("-mobile") ? "mobile" : "hero";
  const img = sharp(png);
  const jpegBytes = fs.statSync(crJpg).size;
  const jpeg = score(png, crJpg);
  // sharp's own JPEG q75 from the same PNG, as a check that the Chromium frame matches the PNG frame.
  const sj = path.join(tmp, "s.jpg");
  await img.clone().jpeg({ quality: 75 }).toFile(sj);
  const sharpJpegBytes = fs.statSync(sj).size;
  const sharpJpeg = score(png, sj);
  // Target: sharp's JPEG q75 of the very same frame (the Chromium JPEG is a
  // separate capture, so a moving page can make it look worse than it is).
  const target = sharpJpeg;
  const wp = path.join(tmp, "w.webp");
  const at = {};
  const enc = async (q) => {
    if (at[q]) return at[q];
    await img.clone().webp({ quality: q, effort: 4 }).toFile(wp);
    return (at[q] = { q, bytes: fs.statSync(wp).size, ...score(png, wp) });
  };
  // Binary search the lowest quality that matches the JPEG (quality is close to monotonic).
  const lowest = async (ok) => {
    let lo = 1,
      hi = 100,
      best = await enc(100);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await enc(mid);
      if (ok(r)) {
        best = r;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return best;
  };
  // SSIM alone forgives WebP's smoothing of text edges, so the main figure also needs PSNR to match.
  const ssimOnly = await lowest((r) => r.ssim >= target.ssim);
  const best = await lowest((r) => r.ssim >= target.ssim && r.psnr >= target.psnr);
  const w75 = await enc(75);
  const w80 = await enc(80);
  rows.push({
    shot: f.replace(".png", ""),
    view,
    jpegBytes,
    jpeg,
    sharpJpegBytes,
    sharpJpeg,
    matchedWebp: best,
    ssimOnlyWebp: ssimOnly,
    webp75: w75,
    webp80: w80,
    savingMatched: +(1 - best.bytes / sharpJpegBytes).toFixed(3),
  });
  console.log(f, sharpJpegBytes, "->", best.q, best.bytes, `${Math.round(100 * (1 - best.bytes / sharpJpegBytes))}%`, "ssim-only q", ssimOnly.q);
}
fs.rmSync(tmp, { recursive: true, force: true });

const sum = (a, k) => a.reduce((s, r) => s + k(r), 0);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null;
};
const byView = (v) => rows.filter((r) => r.view === v);
const saving = (rs, k) => +(1 - sum(rs, k) / sum(rs, (r) => r.sharpJpegBytes)).toFixed(3);
const agg = (rs) => ({
  shots: rs.length,
  jpegTotal: sum(rs, (r) => r.sharpJpegBytes),
  chromiumJpegTotal: sum(rs, (r) => r.jpegBytes),
  webpMatchedTotal: sum(rs, (r) => r.matchedWebp.bytes),
  totalSaving: saving(rs, (r) => r.matchedWebp.bytes),
  medianSaving: median(rs.map((r) => r.savingMatched)),
  medianMatchedQuality: median(rs.map((r) => r.matchedWebp.q)),
  ssimOnlyTotalSaving: saving(rs, (r) => r.ssimOnlyWebp.bytes),
  ssimOnlyMedianQuality: median(rs.map((r) => r.ssimOnlyWebp.q)),
  webp75TotalSaving: saving(rs, (r) => r.webp75.bytes),
  webp80TotalSaving: saving(rs, (r) => r.webp80.bytes),
  webp80BeatsJpegOnBoth: rs.filter((r) => r.webp80.ssim >= r.sharpJpeg.ssim && r.webp80.psnr >= r.sharpJpeg.psnr).length,
});
const summary = { all: agg(rows), hero: agg(byView("hero")), mobile: agg(byView("mobile")) };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "webp.json"), JSON.stringify({ summary, rows }, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));
