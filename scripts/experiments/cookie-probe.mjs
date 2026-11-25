#!/usr/bin/env node
// A quick look at the cookie check (pipeline/cookie-check.mjs) on a few
// addresses, the way the capture reads it on arrival (a fresh browser context,
// the load, the network going quiet, 1.5 seconds), without the rest of the
// capture or any database. For tuning the lists; the capture itself is
// pipeline/capture.mjs.
//
//   node scripts/experiments/cookie-probe.mjs <url> [<url> ...]
import { chromium } from "playwright";
import { UA } from "../../pipeline/gate.mjs";
import { readCookieCheck, watchRequests, withReading } from "../../pipeline/cookie-check.mjs";
import { cookieCheckView } from "../../lib/cookie-check.mjs";

const urls = process.argv.slice(2);
const browser = await chromium.launch();
try {
  for (const url of urls) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const watch = watchRequests(page);
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const r = await readCookieCheck(page, watch);
      const view = cookieCheckView({ privacy: withReading(null, r) });
      console.log(
        JSON.stringify({
          url,
          state: r.state,
          shown: `${view.level}: ${view.title}`,
          reason: r.reason,
          banner: r.banner_how ?? r.banner,
          sample: r.banner_sample,
          tool: r.tool,
          own_cookies: r.own_cookies?.map((c) => c.name),
          beacons: r.beacons?.map((t) => `${t.host}x${t.requests}`),
          ads: r.ads?.map((t) => `${t.vendor}:${t.cookie ?? t.host}`),
          embeds: r.embeds?.map((e) => `${e.name}: ${e.cookies.join(",")} ${e.trackers.join(",")}`),
          loaders: r.loaders?.map((t) => t.host),
          cookieless: r.cookieless?.map((t) => t.vendor),
          pings: r.consent_mode_pings,
        })
      );
    } catch (e) {
      console.log(JSON.stringify({ url, error: String(e?.message ?? e).slice(0, 120) }));
    } finally {
      await ctx.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}
