// One "grade my portfolio" capture (scripts/grade-jobs.mjs on GitHub
// Actions): the same evidence the nightly capture gathers for listed sites
// (pipeline/capture.mjs), for one visitor-chosen address, in a browser whose
// every request goes through the filtering proxy
// (pipeline/net-guard-node.mjs):
//
//   hero.jpg     the settled top of the page, 1440 x 900, JPEG 75 (what
//                the AI grade sees)
//   mobile.jpg   the top at 390 x 844
//   page text    the rendered visible text, capped (pipeline/rubric.mjs)
//   facts        measured by code (pipeline/facts.mjs), project links
//                checked with guardedFetch
//   meta         motion, dark mode, 390px overflow, console errors, page
//                weight, DOM and class hashes (the page fingerprint)
//
// Returns { ok: true, finalUrl, pageText, facts, meta, files } or
// { ok: false, reason } with a reason fit to show the visitor (never the
// browser's raw error, which can echo addresses).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UA, parkingPhrase, readRenderedPage } from "./gate.mjs";
import { actionNote, passModal, passSplashGate } from "./splash.mjs";
import { measurePage } from "./facts.mjs";
import { normalizePageText } from "./rubric.mjs";
import { pngDiff } from "./png-diff.mjs";
import { BLOCKED_HEADER } from "./net-guard-node.mjs";

export const NAV_TIMEOUT_MS = 30000;

/**
 * @param {import("playwright").Browser} browser launched with the filtering proxy
 * @param {string} url
 * @param {{ dir: string, linkFetch: typeof fetch, settlePolls?: number, pollMs?: number }} options
 */
export async function capturePage(browser, url, { dir, linkFetch, settlePolls = 6, pollMs = 2500 }) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
  });
  let errors = 0;
  let requests = 0;
  let bytes = 0;
  let broken = 0;
  try {
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors++;
    });
    page.on("requestfinished", async (req) => {
      requests++;
      try {
        const sz = await req.sizes();
        bytes += sz.responseBodySize + sz.responseHeadersSize;
      } catch {
        /* the request went away */
      }
    });
    page.on("response", (res) => {
      if (res.status() === 404) broken++;
    });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("popup", (p) => p.close().catch(() => {}));

    let response;
    try {
      response = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|403/.test(m)) return { ok: false, reason: "That address points somewhere we don't visit." };
      if (/Timeout/i.test(m)) return { ok: false, reason: "The page took too long to load." };
      if (/ERR_NAME_NOT_RESOLVED/.test(m)) return { ok: false, reason: "That domain doesn't exist." };
      return { ok: false, reason: "The page couldn't be opened." };
    }
    const status = response?.status() ?? 0;
    if (response?.headers()[BLOCKED_HEADER]) return { ok: false, reason: "That address points somewhere we don't visit." };
    if (status >= 400) return { ok: false, reason: `The page answered with an error (HTTP ${status}).` };
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    // A splash gate is clicked through first, at most twice (./splash.mjs), as in the list's capture.
    const splash = await passSplashGate(page).catch(() => null);
    // Then a dialog on top of the page, closed as a visitor would (./splash.mjs passModal).
    const modal = await passModal(page).catch(() => null);

    const rendered = await page.evaluate(readRenderedPage);
    if (rendered.text.trim().length < 30 && !rendered.media) return { ok: false, reason: "The page renders blank." };
    if (parkingPhrase({ html: rendered.html, text: rendered.text })) return { ok: false, reason: "That domain looks parked or for sale." };

    // Wait out preloaders: both the viewport and its center hold still for two polls.
    let prev = await page.screenshot({ type: "png" });
    let quiet = 0;
    let lively = 0;
    for (let polls = 0; polls < settlePolls && quiet < 2 && lively < 2; polls++) {
      await page.waitForTimeout(pollMs);
      const cur = await page.screenshot({ type: "png" });
      const full = pngDiff(prev, cur);
      quiet = full < 0.01 && pngDiff(prev, cur, true) < 0.005 ? quiet + 1 : 0;
      lively = full > 0.05 ? lively + 1 : 0;
      prev = cur;
    }
    const f0 = await page.screenshot({ type: "png" });
    await page.waitForTimeout(3000);
    const f2 = await page.screenshot({ type: "png" });
    const motion = lively >= 2 || pngDiff(f0, f2) > 0.02;

    fs.mkdirSync(dir, { recursive: true });
    const hero = path.join(dir, "hero.jpg");
    fs.writeFileSync(hero, await page.screenshot({ type: "jpeg", quality: 75 }));

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    const darkMode = pngDiff(f2, await page.screenshot({ type: "png" })) > 0.05;
    await page.emulateMedia({ colorScheme: "light" });

    const sig = await page.evaluate(() => {
      const tags = [];
      const walk = (el, depth) => {
        if (depth > 12 || tags.length > 3000) return;
        tags.push(el.tagName);
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(document.body, 0);
      const classes = new Set();
      for (const el of document.querySelectorAll("[class]")) for (const c of el.classList) classes.add(c);
      return { tags: tags.join(","), classes: [...classes].sort().slice(0, 500).join(",") };
    });
    const settled = await page.evaluate(readRenderedPage).catch(() => rendered);
    const finalUrl = page.url();
    const pageText = normalizePageText(settled.text);
    const facts = await measurePage(
      { html: settled.html, text: settled.text, url, finalUrl, name: "", motion, source: "rendered" },
      { userAgent: UA, fetchImpl: linkFetch, timeoutMs: 6000 }
    ).catch(() => null);

    const mobilePage = await ctx.newPage();
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    let overflow390 = null;
    const mobile = path.join(dir, "mobile.jpg");
    try {
      await mobilePage.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      await mobilePage.waitForTimeout(1500);
      await passSplashGate(mobilePage).catch(() => null);
      await passModal(mobilePage).catch(() => null);
      overflow390 = await mobilePage.evaluate(() => document.documentElement.scrollWidth > 395);
      fs.writeFileSync(mobile, await mobilePage.screenshot({ type: "jpeg", quality: 75 }));
    } catch {
      /* the desktop capture is enough to grade */
    }
    const meta = {
      consoleErrors: errors,
      requests,
      bytes,
      broken404s: broken,
      overflow390,
      darkMode,
      motion,
      heroSettled: quiet >= 2,
      domHash: createHash("sha1").update(sig.tags).digest("hex"),
      classHash: createHash("sha1").update(sig.classes).digest("hex"),
      ...(splash ? { splash } : {}),
      ...(modal ? { modal } : {}),
      // One line of what was done to reach the screenshots; only the screen after it is stored.
      ...(actionNote({ splash, modal }) ? { action: actionNote({ splash, modal }) } : {}),
    };
    return { ok: true, finalUrl, pageText, facts, meta, files: { hero, ...(fs.existsSync(mobile) ? { mobile } : {}) } };
  } finally {
    await ctx.close().catch(() => {});
  }
}
