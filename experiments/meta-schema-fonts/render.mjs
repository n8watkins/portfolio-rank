// Step 2: parse the raw HTML from step 1 (no network, no JavaScript) and
// render each home page once in a local Chromium for the rendered head,
// fonts and screenshots.
//
//   node experiments/meta-schema-fonts/render.mjs <sample.psv> <rawDir> [webpCount=20]
//
// Writes <rawDir>/render.json and PNG/JPEG screenshots in <rawDir>/shots/.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { keyOf, pool, readSample, UA } from "./common.mjs";
import { readFonts, readHead } from "./extract.mjs";

const [samplePath, rawDir, webpArg] = process.argv.slice(2);
const webpCount = Number(webpArg ?? 20);
const shots = path.join(rawDir, "shots");
fs.mkdirSync(shots, { recursive: true });
const sample = readSample(samplePath);
const webpSet = new Set(sample.slice(0, webpCount).map((s) => s.url));

const browser = await chromium.launch();
const ua = (await browser.newPage().then(async (p) => {
  const v = await p.evaluate(() => navigator.userAgent);
  await p.close();
  return v;
})).replace("HeadlessChrome", "Chrome") + ` ${UA}`;

const out = {};
try {
  // Static: the HTML a link-preview bot or a plain fetch sees.
  const staticCtx = await browser.newContext({ javaScriptEnabled: false });
  await staticCtx.route("**/*", (r) => r.abort());
  for (const { url } of sample) {
    const file = path.join(rawDir, `${keyOf(url)}.html`);
    if (!fs.existsSync(file)) continue;
    const page = await staticCtx.newPage();
    await page.setContent(fs.readFileSync(file, "utf8"), { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    out[url] = { static: await page.evaluate(readHead).catch((e) => ({ error: String(e) })) };
    await page.close();
  }
  await staticCtx.close();

  // Rendered: one page load per site.
  await pool(sample, 4, async ({ url }) => {
    const key = keyOf(url);
    const row = (out[url] ??= {});
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: ua, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    // Every request URL (for analytics beacons and mixed content) and mixed-content console warnings.
    const requests = [];
    const mixed = [];
    page.on("request", (q) => requests.length < 2000 && requests.push(q.url().slice(0, 300)));
    page.on("console", (m) => /mixed content/i.test(m.text()) && mixed.push(m.text().slice(0, 200)));
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      // Scroll through once so reveal-on-scroll text is shown, then back to the top.
      await page.evaluate(async () => {
        for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 12000); y += 700) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
      }).catch(() => {});
      await page.waitForTimeout(800);
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      row.finalUrl = page.url();
      row.rendered = await page.evaluate(readHead);
      const fonts = await page.evaluate(readFonts);
      // Ask Chromium which font file actually drew each sample element.
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      for (const g of fonts.groups) {
        const platform = {};
        for (const id of g.sampleIds) {
          try {
            const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-msf-id="${id}"]` });
            if (!nodeId) continue;
            const { fonts: pf } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
            for (const f of pf) platform[f.familyName] = (platform[f.familyName] ?? 0) + f.glyphCount;
          } catch {}
        }
        g.platform = platform;
        delete g.sampleIds;
      }
      row.fonts = fonts;
      row.requests = requests.filter((u) => !/^data:/.test(u));
      row.httpRequests = requests.filter((u) => /^http:\/\//i.test(u));
      row.mixedConsole = mixed;
      const hero = path.join(shots, `${key}-hero.png`);
      if (!fs.existsSync(hero)) await page.screenshot({ path: hero });
      if (webpSet.has(url) && !fs.existsSync(hero.replace(".png", ".cr.jpg"))) {
        // The pipeline's format, straight from Chromium, right after the lossless one.
        await page.screenshot({ path: path.join(shots, `${key}-hero.cr.jpg`), type: "jpeg", quality: 75 });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(shots, `${key}-mobile.png`) });
        await page.screenshot({ path: path.join(shots, `${key}-mobile.cr.jpg`), type: "jpeg", quality: 75 });
      }
      console.log("ok", url);
    } catch (e) {
      row.renderError = String(e?.message ?? e).split("\n")[0];
      console.log("fail", url, row.renderError);
    } finally {
      await ctx.close();
    }
  });
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(rawDir, "render.json"), JSON.stringify(out, null, 1));
