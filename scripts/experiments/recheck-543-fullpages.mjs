#!/usr/bin/env node
// The whole-page images for the recheck-543 report, for the sites it shows
// in cards only (the disagreements and Gemini's "no" on grounds v2.1 does
// not allow). Local Playwright, no AI, no database, no R2: each site is
// opened on desktop (1440) and phone (390), passed through the same splash,
// dialog and mode-picker steps as the capture, then stitched top to bottom
// (scripts/experiments/vendor/fullpage.mjs captureFullPages: WebP, at most
// 6,000 px tall on desktop and 8,000 px on the phone). These images are for
// people reading the report; the graders saw only the first screens.
//
//   node scripts/experiments/recheck-543-fullpages.mjs            # the card sites from results.json
//   node scripts/experiments/recheck-543-fullpages.mjs X063,X120  # given ids
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { passModal, passModePicker, passSplashGate } from "../../pipeline/splash.mjs";
import { readJson } from "./grading-two-sets-lib.mjs";
import { DIR, SET } from "./recheck-543.mjs";
import { disallowedNo } from "./recheck-543-report.mjs";
import { captureFullPages } from "./vendor/fullpage.mjs";

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** The ids the report shows in cards. */
export function cardIds(results) {
  return results
    .filter((r) => r.outcome === "disagree" || (r.verdicts?.gemini31?.batch?.is_portfolio === false && disallowedNo(r.verdicts.gemini31.batch.reason)))
    .map((r) => r.id);
}

async function open(browser, url, desktop) {
  const ctx = await browser.newContext(desktop ? { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await passSplashGate(page).catch(() => null);
  await passModal(page).catch(() => null);
  await passModePicker(page).catch(() => null);
  await page.waitForTimeout(1000);
  return { ctx, page };
}

async function main() {
  const results = readJson(path.join(DIR, "results.json"));
  const byId = new Map(results.map((r) => [r.id, r]));
  const ids = process.argv[2] ? process.argv[2].split(",") : cardIds(results);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const [i, id] of ids.entries()) {
      const r = byId.get(id);
      const dir = path.join(DIR, "fullpages", SET, id);
      if (fs.existsSync(path.join(dir, "full-desktop.webp")) && fs.existsSync(path.join(dir, "full-phone.webp"))) continue;
      fs.mkdirSync(dir, { recursive: true });
      const opened = [];
      try {
        const d = await open(browser, r.url, true);
        opened.push(d);
        const p = await open(browser, r.url, false);
        opened.push(p);
        const out = await captureFullPages({ desktop: d.page, phone: p.page }, dir);
        console.log(`[${i + 1}/${ids.length}] ${id} ${r.url}: desktop ${out.desktop?.error ? `failed (${out.desktop.error})` : "ok"}, phone ${out.phone?.error ? `failed (${out.phone.error})` : "ok"}`);
      } catch (e) {
        console.log(`[${i + 1}/${ids.length}] ${id} ${r.url}: failed (${String(e?.message ?? e).split("\n")[0].slice(0, 120)})`);
      } finally {
        for (const o of opened) await o.ctx.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
