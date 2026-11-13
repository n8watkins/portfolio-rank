// The capture of "recheck-543" (scripts/experiments/recheck-543.mjs): the
// two-sets capture (desktop 1440x900 and phone 390x844 tops, page text and
// first-screen facts, in the bundle format the locked prompts were tested
// with), plus what the spec adds:
// - the splash click-through of #208 (pipeline/splash.mjs passSplashGate);
// - a mode-picker click (passModePicker): "Terminal / GUI", "Dark / Light";
// - up to 15 s for slow content (CONTENT_WAIT_MS) before the screenshots;
// - one retry when a load fails or stays blank;
// - the portfolio signals of the full page (pipeline/signals.mjs), for the
//   strong-signals guard.
// meta.json records what happened. It never writes to the database.
import fs from "fs";
import path from "path";
import { buildExcerpt, OUTLINE_ARGS, readPageOutline } from "../../pipeline/excerpt.mjs";
import { measurePage } from "../../pipeline/facts.mjs";
import { UA, readRenderedPage } from "../../pipeline/gate.mjs";
import { pngDiff } from "../../pipeline/png-diff.mjs";
import { redactContacts } from "../../pipeline/redact.mjs";
import { portfolioSignals } from "../../pipeline/signals.mjs";
import { detectGate, passModePicker, passSplashGate } from "../../pipeline/splash.mjs";
import { clean, factsFor, shot } from "./grading-two-sets.mjs";
import { assertNotOurs, readFirstScreen, readJson, writeJson } from "./grading-two-sets-lib.mjs";


const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export const CONTENT_WAIT_MS = 15000;
export const RETRY_AFTER_MS = 5000;
const MIN_WORDS = 30;
// Owner, 2026-11-13: never grade a gate. A capture that still shows a gate,
// a loader or a mode picker after the click-through and the longer wait, or
// has under BLOCK_MAX_WORDS words and no outbound links, is "capture blocked,
// needs review": no model sees it, the review queue shows its screenshots.
export const BLOCK_MAX_WORDS = 40;

const words = (t) => String(t ?? "").split(/\s+/).filter(Boolean).length;

/** Up to CONTENT_WAIT_MS for content: MIN_WORDS words or a visible image, video or canvas. Returns the wait in ms and whether content came. */
async function waitForContent(page, maxMs = CONTENT_WAIT_MS) {
  const t0 = Date.now();
  for (;;) {
    const r = await page.evaluate(readRenderedPage).catch(() => ({ text: "", media: false }));
    if (words(r.text) >= MIN_WORDS || r.media) return { ms: Date.now() - t0, content: true };
    if (Date.now() - t0 >= maxMs) return { ms: Date.now() - t0, content: words(r.text) > 0 };
    await page.waitForTimeout(500);
  }
}

/** Until two screenshots 2 s apart barely differ, at most 12 s (the two-sets settle). */
async function settle(page) {
  let prev = await shot(page);
  let quiet = 0;
  for (let i = 0; i < 6 && quiet < 2; i++) {
    await page.waitForTimeout(2000);
    const cur = await shot(page);
    quiet = pngDiff(prev, cur) < 0.01 ? quiet + 1 : 0;
    prev = cur;
  }
}

/** The gate and the mode picker, in that order (a gate can lead to a picker). */
async function passFirstScreens(page) {
  const gate = await passSplashGate(page).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
  const mode = await passModePicker(page).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
  return { gate, mode };
}

/** One attempt: desktop, then phone. Throws when the desktop page fails to load or stays blank. */
async function attempt(browser, site, dir) {
  const out = { url: site.url, at: new Date().toISOString() };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
  let html = "";
  try {
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    out.desktop_first = await passFirstScreens(page);
    out.desktop_wait = await waitForContent(page);
    const first = await page.evaluate(readRenderedPage);
    out.still_gate = detectGate(first.text).gate || /(^|[^\d])\d{1,3}\s?%/.test(first.text.trim()) && words(first.text) <= 6;
    out.blank = first.text.trim().length < 30 && !first.media;
    await settle(page);
    fs.writeFileSync(path.join(dir, "desktop.jpg"), await shot(page, { type: "jpeg", quality: 75 }));
    out.desktop = await page.evaluate(readFirstScreen);
    out.final_url = page.url();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(height, 20000); y += 700) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    out.outline = await page.evaluate(readPageOutline, OUTLINE_ARGS);
    out.outbound_links = await page.evaluate(() => {
      const here = location.hostname.replace(/^www\./, "");
      const hosts = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          const u = new URL(a.getAttribute("href"), location.href);
          if (/^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, "") !== here) hosts.add(u.hostname);
        } catch {
          /* not a link */
        }
      }
      return hosts.size;
    });
    out.still_picker = out.desktop_first?.mode?.passed === false;
    const full = await page.evaluate(readRenderedPage);
    html = full.html;
    out.facts = await measurePage({ html: full.html, text: full.text, url: site.url, finalUrl: out.final_url, name: site.name }, { userAgent: UA });
  } finally {
    await ctx.close().catch(() => {});
  }
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: PHONE_UA, ignoreHTTPSErrors: true });
  try {
    const m = await mctx.newPage();
    await m.goto(site.url, { waitUntil: "load", timeout: 30000 });
    await m.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    await m.waitForTimeout(1500);
    out.phone_first = await passFirstScreens(m);
    out.phone_wait = await waitForContent(m);
    await m.waitForTimeout(1500);
    fs.writeFileSync(path.join(dir, "phone.jpg"), await shot(m, { type: "jpeg", quality: 75 }));
    out.phone = await m.evaluate(readFirstScreen);
  } finally {
    await mctx.close().catch(() => {});
  }
  return { out, html };
}

/** Why a finished capture is blocked (never graded), or null. */
export function blockedWhy(out) {
  const n = words(out.outline?.text);
  if (out.still_gate) return "still a gate or loader after the click-through";
  if (out.still_picker) return "still a mode picker after the click";
  if (n < BLOCK_MAX_WORDS && !out.outbound_links) return `${n} words and no outbound links`;
  return null;
}

/** One site, with one retry (a load that failed, or a capture still blocked). Writes the bundle files and meta.json; returns meta. */
export async function captureSite(browser, site, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id: site.id, url: site.url, group: site.group, attempts: [], at: new Date().toISOString() };
  let got = null;
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    try {
      assertNotOurs(site.url);
      const next = await attempt(browser, site, dir);
      got = next;
      const why = blockedWhy(next.out);
      meta.attempts.push(why ? { ok: true, blocked: why } : { ok: true });
      if (!why) break;
    } catch (e) {
      meta.attempts.push({ ok: false, error: String(e?.message ?? e).split("\n")[0].slice(0, 200) });
      // Keep a blocked first attempt's screenshots when the retry fails to load.
      if (!got) for (const f of ["desktop.jpg", "phone.jpg"]) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
  meta.retried = meta.attempts.length > 1;
  if (!got) {
    meta.failed = meta.attempts.at(-1).error;
    writeJson(path.join(dir, "meta.json"), meta);
    return meta;
  }
  const { out, html } = got;
  const ex = buildExcerpt(out.outline);
  fs.writeFileSync(path.join(dir, "text.txt"), `${redactContacts(clean(ex.text, 6000)).trim()}\n`);
  writeJson(path.join(dir, "facts.json"), factsFor(site, out, ex));
  const gateOf = (f) => (f?.gate ? { passed: f.gate.passed ?? null, phrase: f.gate.phrase ?? null, clicks: f.gate.clicks ?? 0, left: f.gate.left ?? false, error: f.gate.error } : null);
  const modeOf = (f) => (f?.mode ? { passed: f.mode.passed ?? null, picked: f.mode.picked ?? null, options: f.mode.options ?? [], left: f.mode.left ?? false, error: f.mode.error } : null);
  meta.blocked = blockedWhy(out);
  Object.assign(meta, {
    final_url: out.final_url,
    words: words(out.outline?.text),
    outbound_links: out.outbound_links,
    gate: { desktop: gateOf(out.desktop_first), phone: gateOf(out.phone_first) },
    mode_pick: { desktop: modeOf(out.desktop_first), phone: modeOf(out.phone_first) },
    content_wait_ms: { desktop: out.desktop_wait.ms, phone: out.phone_wait.ms },
    text_chars: ex.text.length,
    // The full text for the junk rules (the bundle's text.txt is the cut excerpt).
    page_text: redactContacts(clean(out.outline.text, 20000)),
    signals: portfolioSignals(html, site.name),
  });
  writeJson(path.join(dir, "meta.json"), meta);
  return meta;
}

/** Every selected site of this shard ("k/n") not captured yet. */
export async function captureAll({ dir: DIR, set: SET, shard = null, only = null }) {
  const sel = readJson(path.join(DIR, "selection.json"));
  let sites = sel.sites;
  if (shard) {
    const [k, n] = shard.split("/").map(Number);
    sites = sites.filter((_, i) => i % n === k);
  }
  if (only) sites = sites.filter((s) => only.split(",").includes(s.id) || only.split(",").includes(s.url));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const counts = { ok: 0, failed: 0, blocked: 0, skipped: 0, retried: 0, gate: 0, mode: 0 };
  try {
    for (const [i, s] of sites.entries()) {
      const dir = path.join(DIR, "bundles", SET, s.id);
      if (fs.existsSync(path.join(dir, "meta.json"))) {
        counts.skipped++;
        continue;
      }
      const t0 = Date.now();
      const meta = await captureSite(browser, s, dir);
      if (meta.failed) counts.failed++;
      else if (meta.blocked) counts.blocked++;
      else counts.ok++;
      if (meta.retried) counts.retried++;
      if (meta.gate?.desktop || meta.gate?.phone) counts.gate++;
      if (meta.mode_pick?.desktop || meta.mode_pick?.phone) counts.mode++;
      const notes = [meta.retried && "retried", (meta.gate?.desktop || meta.gate?.phone) && "gate", (meta.mode_pick?.desktop || meta.mode_pick?.phone) && `mode ${meta.mode_pick?.desktop?.picked ?? meta.mode_pick?.phone?.picked}`].filter(Boolean);
      console.log(`[${i + 1}/${sites.length}] ${s.id} ${s.url}: ${meta.failed ? `FAILED (${meta.failed})` : meta.blocked ? `BLOCKED (${meta.blocked})` : `ok, signals ${meta.signals.score}`}${notes.length ? ` [${notes.join(", ")}]` : ""} ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  } finally {
    await browser.close();
  }
  console.log(`capture: ${JSON.stringify(counts)}`);
  return 0;
}
