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
import { readCookieCheck, watchRequests } from "../../pipeline/cookie-check.mjs";

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
      const cookies = r.cookies?.filter((c) => c.tracking).map((c) => `${c.name}@${c.domain}(${c.party})`) ?? [];
      console.log(
        JSON.stringify({
          url,
          state: r.state,
          reason: r.reason,
          banner: r.banner_how ?? r.banner,
          tool: r.tool,
          tracking_cookies: cookies,
          all_cookies: r.cookie_count,
          trackers: r.trackers?.map((t) => `${t.host}x${t.requests}`),
          loaders: r.loaders?.map((t) => `${t.host}x${t.requests}`),
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
