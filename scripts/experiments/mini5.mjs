#!/usr/bin/env node
// Owner mini test, 2026-11-13 ("mini5"), separate from the locked two-sets
// experiment. Five sites from the not-ranked set, one per group (seeded):
//   1 graded "not a portfolio" (still listed)   2 delisted after grading
//   3 delisted before grading                   4 status error or dead, never graded
//   5 live, never graded
// Captured with the new rules: load, the splash click-through and the
// dialog default action (pipeline/splash.mjs, on main), then a scroll
// through the whole page and back to the top (scrollThrough and
// settleFirstScreen from the feat/fullpage-shots worktree), then the
// desktop 1440x900 and phone 390x844 top screenshots, text and facts, plus
// the tall stitched images (captureFullPages). Graded as ONE batch of 5 with
// the locked batch prompt: gemini-3.1-flash-lite (temperature 0.2, thinking
// "low", job "exp-mini5", at most 3 HTTP requests) and, run by the owner,
// claude-haiku-5-5 (hard stop $0.10).
//
//   pass-env run -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN -- node scripts/experiments/mini5.mjs select
//   node scripts/experiments/mini5.mjs capture
//   pass-env run -e GEMINI_API_KEY=... -e TURSO_...=... -- node scripts/experiments/mini5.mjs gemini
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- node scripts/experiments/mini5.mjs haiku
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildExcerpt, OUTLINE_ARGS, readPageOutline } from "../../pipeline/excerpt.mjs";
import { measurePage } from "../../pipeline/facts.mjs";
import { UA, readRenderedPage } from "../../pipeline/gate.mjs";
import { dailyTotals } from "../../pipeline/gemini-log.mjs";
import { redactContacts } from "../../pipeline/redact.mjs";
import { actionNote, passModal, passSplashGate } from "../../pipeline/splash.mjs";
import { clean, factsFor } from "./grading-two-sets.mjs";
import { assertNotOurs, mulberry32, readFirstScreen, readJson, shuffled, writeJson } from "./grading-two-sets-lib.mjs";
import { SETTINGS, run } from "./grading-two-sets-run.mjs";
import { HAIKU, runClaude } from "./grading-two-sets-claude.mjs";

// The full-page helpers live on the feat/fullpage-shots branch (not on main yet).
export const FULLPAGE = path.join(os.homedir(), "worktrees", "portfolio-rank-feat-fullpage-shots", "pipeline", "fullpage.mjs");
const ROOT = path.join(os.homedir(), "research", "portfoliorank-experiments", "mini5");
const SEED = 20261113;
const JOB = "exp-mini5";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export const GROUPS = [
  { group: 1, label: "graded not a portfolio", where: "p.delisted_at IS NULL AND p.ai_rubric IS NOT NULL AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric,'$.is_portfolio') = 0" },
  { group: 2, label: "delisted after grading", where: "p.delisted_at IS NOT NULL AND p.ai_rubric IS NOT NULL" },
  { group: 3, label: "delisted before grading", where: "p.delisted_at IS NOT NULL AND p.ai_rubric IS NULL" },
  { group: 4, label: "error or dead, never graded", where: "p.delisted_at IS NULL AND p.ai_rubric IS NULL AND p.status IN ('error','dead')" },
  { group: 5, label: "live, never graded", where: "p.delisted_at IS NULL AND p.ai_rubric IS NULL AND p.status = 'live'" },
];

async function select() {
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  if (!process.env.TURSO_DATABASE_URL) throw new Error("select reads the production DB: run through pass-env");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const rnd = mulberry32(SEED);
  const out = { created_at: new Date().toISOString(), seed: SEED, groups: [] };
  for (const g of GROUPS) {
    // Not ranked: no points in tier_ratings.
    const rows = (await db.execute(`SELECT p.url, p.name, p.status, p.reason, p.delisted_at FROM portfolios p LEFT JOIN tier_ratings t ON t.url = p.url WHERE t.points IS NULL AND ${g.where} ORDER BY p.url`)).rows;
    out.groups.push({ ...g, pool: rows.length, candidates: shuffled(rows.map((r) => ({ url: String(r.url), name: String(r.name ?? ""), status: String(r.status), reason: r.reason == null ? null : String(r.reason), delisted_at: r.delisted_at == null ? null : String(r.delisted_at) })), rnd).slice(0, 8) });
    console.log(`group ${g.group} (${g.label}): ${rows.length} sites`);
  }
  writeJson(path.join(ROOT, "selection.json"), out);
}

/** One site: both views with the new rules, kept open for the tall images. */
export async function captureSite(browser, site, dir, fp) {
  assertNotOurs(site.url);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const out = { url: site.url, at: new Date().toISOString() };
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: PHONE_UA, ignoreHTTPSErrors: true });
  try {
    const views = {};
    for (const [name, ctx, maxHeight] of [["desktop", dctx, 6000], ["phone", pctx, 8000]]) {
      const page = await ctx.newPage();
      await page.goto(site.url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const splash = await passSplashGate(page).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
      const modal = await passModal(page).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
      const rendered = await page.evaluate(readRenderedPage);
      if (name === "desktop" && rendered.text.trim().length < 30 && !rendered.media) throw new Error("renders blank");
      const scroll = await fp.scrollThrough(page, { maxHeight });
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
      const settled = await fp.settleFirstScreen(page).catch(() => false);
      fs.writeFileSync(path.join(dir, `${name}.jpg`), await page.screenshot({ type: "jpeg", quality: 75, timeout: 30000 }));
      out[name] = await page.evaluate(readFirstScreen);
      out[`${name}_action`] = { splash, modal, note: actionNote({ splash: splash?.error ? null : splash, modal: modal?.error ? null : modal }), scroll, settled };
      views[name] = page;
    }
    // Text and facts from the desktop view (after the scroll, so lazy sections rendered).
    const d = views.desktop;
    const outline = await d.evaluate(readPageOutline, OUTLINE_ARGS);
    writeJson(path.join(dir, "outline.json"), { ...outline, final_url: d.url() });
    const full = await d.evaluate(readRenderedPage);
    out.final_url = d.url();
    out.facts = await measurePage({ html: full.html, text: full.text, url: site.url, finalUrl: out.final_url, name: site.name }, { userAgent: UA });
    out.capture_seconds = (Date.now() - t0) / 1000;
    // The tall stitched images, for the report only (not sent to the graders).
    const t1 = Date.now();
    out.full_page = await fp.captureFullPages({ desktop: views.desktop, phone: views.phone }, dir);
    out.full_page_seconds = (Date.now() - t1) / 1000;
  } finally {
    await dctx.close().catch(() => {});
    await pctx.close().catch(() => {});
  }
  writeJson(path.join(dir, "measured.json"), out);
  return out;
}

async function capture() {
  const sel = readJson(path.join(ROOT, "selection.json"));
  const fp = await import(FULLPAGE);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const picked = [];
  const tries = [];
  try {
    for (const g of sel.groups) {
      let done = null;
      for (const c of g.candidates) {
        const dir = path.join(ROOT, "sites", `g${g.group}`);
        fs.rmSync(dir, { recursive: true, force: true });
        try {
          const m = await captureSite(browser, c, dir, fp);
          const outline = readJson(path.join(dir, "outline.json"));
          const ex = buildExcerpt(outline);
          fs.writeFileSync(path.join(dir, "text.txt"), `${redactContacts(clean(ex.text, 6000)).trim()}\n`);
          writeJson(path.join(dir, "facts.json"), factsFor(c, m, ex));
          done = { group: g.group, label: g.label, ...c, dir, capture_seconds: m.capture_seconds, full_page_seconds: m.full_page_seconds, desktop_action: m.desktop_action.note, phone_action: m.phone_action.note };
          tries.push({ group: g.group, url: c.url, ok: true });
          console.log(`group ${g.group}: ${c.url} ok in ${m.capture_seconds.toFixed(1)} s (+${m.full_page_seconds.toFixed(1)} s tall images); desktop: ${m.desktop_action.note ?? "no click"}; phone: ${m.phone_action.note ?? "no click"}`);
          break;
        } catch (e) {
          tries.push({ group: g.group, url: c.url, ok: false, why: String(e?.message ?? e).split("\n")[0].slice(0, 160) });
          console.log(`group ${g.group}: ${c.url} failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}`);
        }
      }
      if (done) picked.push(done);
    }
  } finally {
    await browser.close();
  }
  // Batch order and ids: a seeded shuffle, so position says nothing about the group.
  const order = shuffled(picked, mulberry32(SEED + 1));
  order.forEach((p, i) => {
    p.id = `M${i + 1}`;
    const link = path.join(ROOT, "bundles", "M", p.id);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(p.dir, link);
  });
  writeJson(path.join(ROOT, "manifest.json"), { created_at: new Date().toISOString(), sites: order, tries });
}

const batchRequest = () => {
  const ids = readJson(path.join(ROOT, "manifest.json")).sites.map((s) => s.id);
  return { key: "mini5/batch", step: "mini5", set: "M", kind: "batch", ids };
};

async function gemini() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error("needs TURSO_DATABASE_URL through pass-env (request log)");
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const used = (await dailyTotals(db)).used.get(GEMINI_MODEL)?.n ?? 0;
  console.log(`${GEMINI_MODEL}: ${used} requests this Pacific quota day`);
  if (used + 1 > 495) throw new Error(`refusing: ${used} + 1 would pass 495`);
  const settings = { ...SETTINGS, model: GEMINI_MODEL, job: JOB, hard_stop: 3, day_cap: 495 };
  const { exit } = await run({ db, plan: { requests: [batchRequest()] }, settings, out: path.join(ROOT, "gemini-3.1"), rawDir: path.join(ROOT, "raw", "gemini-3.1"), bundleRoot: path.join(ROOT, "bundles"), timelinePath: path.join(ROOT, "timeline.json") });
  process.exit(exit === "done" ? 0 : 3);
}

async function haiku() {
  const settings = { ...HAIKU, folder: "claude-haiku-api", hard_stop_usd: 0.1, job: JOB };
  const { exit } = await runClaude({ settings, requestList: [batchRequest()], out: path.join(ROOT, "claude-haiku-api"), rawDir: path.join(ROOT, "raw", "claude-haiku-api"), bundleRoot: path.join(ROOT, "bundles"), timelinePath: path.join(ROOT, "timeline.json") });
  process.exit(exit === "done" ? 0 : exit === "spend_limit" ? 4 : 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  const steps = { select, capture, gemini, haiku };
  if (!steps[step]) {
    console.error("usage: mini5.mjs <select|capture|gemini|haiku>");
    process.exit(1);
  }
  await steps[step]();
}
