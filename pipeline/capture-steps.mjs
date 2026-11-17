// Three steps of the list's capture (pipeline/capture.mjs) that keep a
// working site from being marked failed, found by the 543 re-check
// (2026-11-14: 30 relisted sites the owner confirmed failed the nightly
// capture, while a browser loaded all of them):
//
//   inconclusiveGate  the plain HTTP pre-check (gate.mjs httpGate) answered
//                     401, 403, 429 or 503, or failed on TLS: often a bot
//                     filter that lets a real browser through, or a
//                     certificate the browser accepts (ignoreHTTPSErrors).
//                     The browser decides instead of the pre-check: the
//                     status its main document ends on still rules out an
//                     error page (capture-blocked.mjs httpVerdict).
//   waitForContent    a page with no text yet is given up to CONTENT_WAIT_MS
//                     to render before it counts as blank (slow single-page
//                     apps rendered nothing in the first 3 seconds).
//   shot              a screenshot that times out or hits Chrome's "Unable to
//                     capture screenshot" is taken again through the DevTools
//                     protocol, which captures the viewport as composited.
//   flatFrame         whether a screenshot is one flat colour: a page with
//                     no text whose canvas or image never drew anything.

import { PNG } from "pngjs";
import { readRenderedPage } from "./gate.mjs";

export const CONTENT_WAIT_MS = 15000;
const POLL_MS = 500;
const INCONCLUSIVE_HTTP = new Set([401, 403, 429, 503]);

/** Whether a failed pre-check should be left to the browser. `gate`: httpGate's answer. */
export function inconclusiveGate(gate) {
  if (!gate || gate.status === "live") return false;
  if (gate.status !== "error") return false; // dead (DNS, 404, 410) and parked stay decided
  if (INCONCLUSIVE_HTTP.has(Number(gate.httpStatus))) return true;
  return gate.reason === "TLS error";
}

/**
 * Up to `maxMs` for content: 30 characters of visible text or visible media
 * (canvas, video, images), polled. Returns { ms, content }.
 * @param {import("playwright").Page} page
 */
export async function waitForContent(page, maxMs = CONTENT_WAIT_MS) {
  const t0 = Date.now();
  for (;;) {
    const r = await page.evaluate(readRenderedPage).catch(() => ({ text: "", media: false }));
    if (r.text.trim().length >= 30 || r.media) return { ms: Date.now() - t0, content: true };
    if (Date.now() - t0 >= maxMs) return { ms: Date.now() - t0, content: false };
    await page.waitForTimeout(POLL_MS);
  }
}

/** A frame is flat when fewer than this share of its sampled pixels differ from its most common colour. */
export const FLAT_FRAME_MAX_SHARE = 0.005;

/**
 * Whether a PNG screenshot is one flat colour (a canvas that never drew, a
 * black preloader): fewer than FLAT_FRAME_MAX_SHARE of about 40,000 sampled
 * pixels differ noticeably from the most common colour.
 * @param {Buffer} png
 */
export function flatFrame(png) {
  const img = PNG.sync.read(png);
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 40000)));
  const counts = new Map();
  const samples = [];
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const o = (y * img.width + x) * 4;
      const px = [img.data[o], img.data[o + 1], img.data[o + 2]];
      samples.push(px);
      const k = px.map((c) => c >> 4).join(",");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0,0,0";
  const base = top.split(",").map((c) => Number(c) * 16 + 8);
  const off = samples.filter((px) => Math.abs(px[0] - base[0]) + Math.abs(px[1] - base[1]) + Math.abs(px[2] - base[2]) > 40).length;
  return off / Math.max(1, samples.length) < FLAT_FRAME_MAX_SHARE;
}

/** The DevTools screenshot is asked for up to this many times, this far apart, while Chrome has no frame ready. */
const CDP_SHOT_TRIES = 3;
const CDP_SHOT_PAUSE_MS = 500;

/**
 * page.screenshot, with a retry through the DevTools protocol when it times
 * out or Chrome can't capture the page. Other errors are thrown as they are.
 * @param {import("playwright").Page} page
 * @param {{ type?: "png" | "jpeg", quality?: number }} [opts]
 */
export async function shot(page, { type = "png", quality } = {}) {
  try {
    return await page.screenshot({ type, ...(quality ? { quality } : {}), timeout: 30000 });
  } catch (e) {
    if (!/Timeout|Unable to capture screenshot|Protocol error/i.test(String(e?.message ?? e))) throw e;
    const cdp = await page.context().newCDPSession(page);
    try {
      // Chrome answers "Unable to capture screenshot" when it has no frame ready (a busy machine): that passes, so ask again.
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await cdp.send("Page.captureScreenshot", { format: type === "jpeg" ? "jpeg" : "png", ...(quality ? { quality } : {}), captureBeyondViewport: false, fromSurface: true });
          return Buffer.from(r.data, "base64");
        } catch (again) {
          if (attempt >= CDP_SHOT_TRIES || !/Unable to capture screenshot/i.test(String(again?.message ?? again))) throw again;
          await page.waitForTimeout(CDP_SHOT_PAUSE_MS);
        }
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
}
