#!/usr/bin/env node
// The facts audit's browser pass: one visit per site of sample.json, at most
// --concurrency (6) pages at a time.
//
// Each visit first replays the list capture's own sequence up to the reading
// its facts are measured from (pipeline/capture.mjs captureOnce: load,
// network idle up to 8 s, 1.5 s, the splash, dialog and mode passes, the
// wait for content, the preloader polls, the motion frames, the dark-mode
// shot, the scroll-through) and saves that reading (A). On the way it saves
// the reading at the point pipeline/render.mjs reads (R: network idle, then
// 1 s). With --pass after, the capture's settle step (pipeline/render.mjs
// settleText) runs where capture.mjs now runs it, so A is the fixed
// capture's reading.
//
// With --pass before it then goes on for the ground truth: the visible
// text's length is sampled every 500 ms until it holds for 8 s (20 s at
// most; saved as a time series, for weighing settle rules offline), the page
// is scrolled slowly to the bottom and back, and the broad DOM probe
// (dom-probe.mjs) runs, with a first-screen and a full-page screenshot and a
// crop of each candidate resume, GitHub, contact and projects control.
//
//   node scripts/experiments/facts-audit/probe.mjs --pass before|after --out <dir> [--only substr] [--concurrency 6]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { UA, readRenderedPage } from "../../../pipeline/gate.mjs";
import { pngDiff } from "../../../pipeline/png-diff.mjs";
import { passModal, passModePicker, passSplashGate } from "../../../pipeline/splash.mjs";
import { shot, waitForContent } from "../../../pipeline/capture-steps.mjs";
import { captureViewAsSeen } from "../../../pipeline/capture.mjs";
import { domProbe } from "./dom-probe.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const pass = opt("--pass", "before");
const outDir = opt("--out");
const only = opt("--only", "");
const concurrency = Math.min(6, Number(opt("--concurrency", 6)));
if (!outDir) throw new Error("--out is required");
const sample = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "sample.json"), "utf8")).filter((s) => s.url.includes(only));
const keyOf = (url) => createHash("sha1").update(url).digest("hex").slice(0, 12);
let settleText = null;
if (pass === "after") ({ settleText } = await import("../../../pipeline/render.mjs"));

const SITE_CAP_MS = 240000;
const read = (page) => page.evaluate(readRenderedPage).catch(() => ({ text: "", media: false, html: "" }));
const words = (t) => String(t ?? "").split(/\s+/).filter(Boolean).length;
const CROP = {
  resume: /\b(resume|résumé|cv|curriculum vitae)\b|resume|[-_/]cv\.pdf/i,
  github: /github/i,
  contact: /mailto:|contact|get in touch|hire me|say hello|let'?s talk|email me|reach out/i,
  projects: /\bprojects?\b|\bwork\b|portfolio/i,
};

async function visit(browser, site) {
  const dir = path.join(outDir, keyOf(site.url));
  fs.mkdirSync(dir, { recursive: true });
  const meta = { url: site.url, name: site.name, key: keyOf(site.url), pass, t: {} };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
  const T0 = Date.now();
  const mark = (k) => (meta.t[k] = Date.now() - T0);
  try {
    const page = await ctx.newPage();
    const res = await page.goto(site.url, { waitUntil: "load", timeout: 30000 });
    meta.status = res?.status() ?? 0;
    mark("load");
    // --- the capture's arrive() ---
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    mark("idle");
    await page.waitForTimeout(1000);
    const R = await read(page);
    mark("R");
    fs.writeFileSync(path.join(dir, "R.html"), R.html);
    meta.R = { words: words(R.text), chars: R.text.length };
    await page.waitForTimeout(500);
    const splash = await passSplashGate(page).catch(() => null);
    const modal = await passModal(page).catch(() => null);
    const mode = await passModePicker(page).catch(() => null);
    meta.passes = { splash: Boolean(splash), modal: Boolean(modal), mode: Boolean(mode) };
    meta.content = await waitForContent(page);
    const rendered = await read(page);
    meta.blank = rendered.text.trim().length < 30 && !rendered.media;
    // --- the preloader polls, motion and dark-mode shots, as in captureOnce ---
    let prevShot = await shot(page, { type: "png" });
    let quiet = 0,
      lively = 0,
      polls = 0;
    while (polls < 8 && quiet < 2 && lively < 2) {
      await page.waitForTimeout(3000);
      const cur = await shot(page, { type: "png" });
      const full = pngDiff(prevShot, cur);
      if (full < 0.01 && pngDiff(prevShot, cur, true) < 0.005) quiet++;
      else quiet = 0;
      lively = full > 0.05 ? lively + 1 : 0;
      prevShot = cur;
      polls++;
    }
    meta.polls = polls;
    const f0 = await shot(page, { type: "png" });
    await page.waitForTimeout(3000);
    const f2 = await shot(page, { type: "png" });
    meta.motion = lively >= 2 || pngDiff(f0, f2) > 0.02;
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    await shot(page, { type: "png" });
    await page.emulateMedia({ colorScheme: "light" });
    mark("beforeScroll");
    if (settleText) meta.settle = await settleText(page);
    mark("settled");
    await captureViewAsSeen(page, "desktop");
    mark("scrolled");
    const A = await read(page);
    mark("A");
    meta.finalUrl = page.url();
    meta.A = { words: words(A.text), chars: A.text.length, htmlChars: A.html.length, fullHtmlChars: await page.evaluate(() => document.documentElement.outerHTML.length).catch(() => null) };
    fs.writeFileSync(path.join(dir, `A-${pass}.html`), A.html);
    fs.writeFileSync(path.join(dir, `A-${pass}.txt`), A.text);
    if (pass === "before") {
      // --- ground truth: the text's length every 500 ms until it holds for 8 s (20 s at most) ---
      const series = [];
      const s0 = Date.now();
      let lastChange = s0;
      let last = -1;
      while (Date.now() - s0 < 20000 && Date.now() - lastChange < 8000) {
        const n = await page.evaluate(() => (document.body?.innerText ?? "").length).catch(() => last);
        if (n !== last) lastChange = Date.now();
        series.push([Date.now() - s0, n]);
        last = n;
        await page.waitForTimeout(500);
      }
      meta.series = series;
      const A2 = await read(page);
      fs.writeFileSync(path.join(dir, "A2.html"), A2.html);
      meta.A2 = { words: words(A2.text), chars: A2.text.length };
      // --- a slow scroll to the bottom and back ---
      await page
        .evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const el = document.querySelector("[data-pr-scroller]");
          const height = () => (el ? el.scrollHeight : Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
          const view = el ? el.clientHeight : innerHeight;
          const to = (y) => (el ? el.scrollTo(0, y) : scrollTo(0, y));
          for (let y = 0, i = 0; y < height() - view && i < 60; i++) {
            y += Math.floor(view * 0.6);
            to(y);
            await sleep(500);
          }
          await sleep(1000);
          to(0);
        })
        .catch(() => {});
      await page.waitForTimeout(1500);
      mark("truthScrolled");
      const probe = await page.evaluate(domProbe).catch((e) => ({ error: String(e?.message ?? e) }));
      const B = await read(page);
      fs.writeFileSync(path.join(dir, "B.html"), B.html);
      fs.writeFileSync(path.join(dir, "probe.json"), JSON.stringify(probe));
      meta.B = { words: words(B.text), chars: B.text.length };
      fs.writeFileSync(path.join(dir, "hero.jpg"), await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => Buffer.alloc(0)));
      const h = Math.min(probe.scrollHeight ?? 900, 9000);
      fs.writeFileSync(
        path.join(dir, "full.jpg"),
        await page.screenshot({ type: "jpeg", quality: 45, fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.max(900, h) } }).catch(() => Buffer.alloc(0))
      );
      // A crop of each candidate control, for reading by eye.
      const crops = [];
      for (const [kind, re] of Object.entries(CROP)) {
        const hits = (probe.clickables ?? []).filter((c) => c.visible && re.test(`${c.label} ${c.urls.join(" ")}`)).slice(0, 4);
        for (const [i, c] of hits.entries()) {
          const b = c.box;
          const clip = { x: Math.max(0, b.x - 60), y: Math.max(0, b.y - 40), width: Math.min(1440, b.w + 120), height: Math.min(400, b.h + 80) };
          const file = `crop-${kind}-${i}.jpg`;
          const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, clip }).catch(() => null);
          if (buf) {
            fs.writeFileSync(path.join(dir, file), buf);
            crops.push({ kind, file, label: c.label, urls: c.urls, tag: c.tag, via: c.via, box: b });
          }
        }
      }
      meta.crops = crops;
      mark("done");
    }
  } catch (e) {
    meta.error = String(e?.message ?? e).split("\n")[0].slice(0, 200);
  } finally {
    await ctx.close().catch(() => {});
  }
  fs.writeFileSync(path.join(dir, `meta-${pass}.json`), JSON.stringify(meta, null, 1));
  return meta;
}

const browser = await chromium.launch();
const queue = [...sample];
let n = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const site = queue.shift();
      const m = await Promise.race([visit(browser, site), new Promise((r) => setTimeout(() => r({ url: site.url, error: "site cap" }), SITE_CAP_MS))]);
      n++;
      console.log(`[${n}/${sample.length}] ${site.url} ${m.error ? `ERROR ${m.error}` : `A=${m.A?.words}w at ${Math.round((m.t?.A ?? 0) / 1000)}s B=${m.B?.words ?? "-"}w`}`);
    }
  })
);
await browser.close();
