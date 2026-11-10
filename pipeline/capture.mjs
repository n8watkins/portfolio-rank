#!/usr/bin/env node
// Phase 0 capture pipeline: gate every portfolio (dead/parked/blank), then
// Playwright-capture the live ones - desktop hero, mobile, full-page - plus
// diagnostics (console errors, page weight, broken assets, 390px overflow,
// dark-mode support, motion from a frame difference, DOM-shape hash), the
// page's visible text (capped) and the facts code can check
// (pipeline/facts.mjs: resume, GitHub, contact, project links that load, own
// domain, footer year, pages, template), which the AI grade reads
// (pipeline/rubric.mjs). Images land in captures/<key>/ and upload to R2
// when R2_* env vars exist; results upsert into the `portfolios` table
// (Turso when TURSO_* set, else local file).
//
// Usage:
//   node pipeline/capture.mjs [--limit N] [--concurrency C] [--only substr] [--force] [--refresh N]
//   node pipeline/capture.mjs --upload-only   # backfill captures/ to R2 later
//
// Failed captures are retried later with backoff (see recordCaptureFailure).
//
// --refresh N also re-captures the N listed sites captured longest ago (the
// nightly checks, sync-upstream.yml): their screenshots, text, facts and
// page fingerprint are renewed, so a redesign is found
// (scripts/detect-changes.mjs) and re-graded the same night. A refresh that
// fails keeps the existing capture and records nothing: whether a site is
// down is the weekly health check's call.
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { httpGate, readRenderedPage, UA } from "./gate.mjs";
import { measurePage } from "./facts.mjs";
import { normalizePageText } from "./rubric.mjs";
import {
  ACTIVE,
  captureRetryAt,
  dueForCapture,
  ensureRosterSchema,
  pipelineDb,
  syncRoster,
} from "./roster.mjs";

const ROOT = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// env (.env.local, no dotenv dependency). Optional: in CI (GitHub Actions)
// there's no .env.local — the vars come straight from the runner env/secrets.
// ---------------------------------------------------------------------------
if (fs.existsSync(path.join(ROOT, ".env.local"))) {
  for (const line of fs
    .readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIMIT = Number(flag("limit", "0")) || Infinity;
const CONCURRENCY = Number(flag("concurrency", "3"));
const ONLY = flag("only", "");
const FORCE = args.includes("--force");
const REFRESH = Number(flag("refresh", "0")) || 0;

// ---------------------------------------------------------------------------
// PNG diff: fraction of sampled pixels that differ noticeably
// ---------------------------------------------------------------------------
function pngDiff(bufA, bufB, centerOnly = false) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) return 1;
  // Optionally restrict to the middle third — where preloader spinners and
  // percent counters live — so their few changing pixels aren't drowned out.
  const x0 = centerOnly ? Math.floor(a.width / 3) : 0;
  const x1 = centerOnly ? Math.floor((2 * a.width) / 3) : a.width;
  const y0 = centerOnly ? Math.floor(a.height / 3) : 0;
  const y1 = centerOnly ? Math.floor((2 * a.height) / 3) : a.height;
  const region = (x1 - x0) * (y1 - y0);
  const step = Math.max(1, Math.floor(Math.sqrt(region / 40000)));
  let diff = 0,
    samples = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const o = (y * a.width + x) * 4;
      const d =
        Math.abs(a.data[o] - b.data[o]) +
        Math.abs(a.data[o + 1] - b.data[o + 1]) +
        Math.abs(a.data[o + 2] - b.data[o + 2]);
      if (d > 30) diff++;
      samples++;
    }
  }
  return diff / samples;
}

// ---------------------------------------------------------------------------
// DB + R2
// ---------------------------------------------------------------------------
const db = pipelineDb(ROOT);
await ensureRosterSchema(db);

let s3 = null;
if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// Only the frames the app serves go to R2 (the AI grade uses hero.jpg too).
const SERVE_FILES = new Set(["hero.jpg", "mobile.jpg", "full.jpg"]);

async function uploadDir(key, dir) {
  if (!s3) return;
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  for (const f of fs.readdirSync(dir)) {
    if (!SERVE_FILES.has(f)) continue;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET ?? "portfolio-rank",
        Key: `${key}/${f}`,
        Body: fs.readFileSync(path.join(dir, f)),
        ContentType: f.endsWith(".jpg") ? "image/jpeg" : "image/png",
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Per-site capture
// ---------------------------------------------------------------------------
const keyOf = (url) => createHash("sha1").update(url).digest("hex").slice(0, 16);

// A failed capture (gate said dead/parked/error, blank page, or a crash) is
// never final: the row gets a retry date with growing backoff
// (roster.captureRetryAt), and the weekly health check pulls the retry
// forward once the site passes. Whether a site is shown is decided by the
// health check (pipeline/health.mjs), not by one capture attempt.
async function recordCaptureFailure(url, name, status, reason) {
  const row = (
    await db.execute({ sql: "SELECT capture_attempts FROM portfolios WHERE url = ?", args: [url] })
  ).rows[0];
  const attempts = Number(row?.capture_attempts ?? 0) + 1;
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, reason, checked_at, capture_attempts, retry_at)
          VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
          ON CONFLICT(url) DO UPDATE SET status=excluded.status,
            reason=excluded.reason, checked_at=excluded.checked_at,
            capture_attempts=excluded.capture_attempts, retry_at=excluded.retry_at`,
    args: [url, name, status, reason, attempts, captureRetryAt(attempts)],
  });
}

async function captureSite(browser, entry, { refresh = false } = {}) {
  const { url, name } = entry;
  // A refresh never marks a site failed (see the header).
  const recordFailure = refresh ? async () => {} : recordCaptureFailure;
  const key = keyOf(url);
  const dir = path.join(ROOT, "captures", key);

  const gate = await httpGate(url);
  if (gate.status !== "live") {
    await recordFailure(url, name, gate.status, gate.reason);
    return `${gate.status} (${gate.reason})`;
  }

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  let bytes = 0,
    requests = 0,
    broken = 0;
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("requestfinished", async (req) => {
    requests++;
    try {
      const sz = await req.sizes();
      bytes += sz.responseBodySize + sz.responseHeadersSize;
    } catch {}
  });
  page.on("response", (res) => {
    if (res.status() === 404) broken++;
  });

  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    // Let SPAs/preloaders settle: idle network if it comes, then a beat.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Blank-page gate: needs visible text within the rendered page.
    // Blank-page gate: visible text, or visual content (canvas apps such as
    // Flutter web have no text in the DOM).
    const rendered = await page.evaluate(readRenderedPage);
    if (rendered.text.trim().length < 30 && !rendered.media) {
      await ctx.close();
      await recordFailure(url, name, "dead", "renders blank");
      return "dead (renders blank)";
    }

    fs.mkdirSync(dir, { recursive: true });

    // Wait out slow preloaders and intro animations: poll until both the
    // viewport and its center (spinners, percent counters) hold still for
    // two polls. Pages that churn the whole viewport every poll are
    // animated backgrounds, not loaders — bail early and call it motion.
    let prevShot = await page.screenshot({ type: "png" });
    let quiet = 0,
      lively = 0,
      polls = 0;
    while (polls < 8 && quiet < 2 && lively < 2) {
      await page.waitForTimeout(3000);
      const cur = await page.screenshot({ type: "png" });
      const full = pngDiff(prevShot, cur);
      if (full < 0.01 && pngDiff(prevShot, cur, true) < 0.005) quiet++;
      else quiet = 0;
      lively = full > 0.05 ? lively + 1 : 0;
      prevShot = cur;
      polls++;
    }
    const heroSettled = quiet >= 2;

    // Motion: two frames 3 seconds apart, diffed in memory. The AI grade gets
    // the result as a fact, not the frames. Hero from the settled frame.
    const f0 = await page.screenshot({ type: "png" });
    await page.waitForTimeout(3000);
    const f2 = await page.screenshot({ type: "png" });
    const motion = lively >= 2 || pngDiff(f0, f2) > 0.02;
    fs.writeFileSync(
      path.join(dir, "hero.jpg"),
      await page.screenshot({ type: "jpeg", quality: 75 })
    );
    fs.writeFileSync(
      path.join(dir, "full.jpg"),
      await page.screenshot({ type: "jpeg", quality: 70, fullPage: true })
    );

    // Dark-mode support: pixel-diff light vs dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    const dark = await page.screenshot({ type: "png" });
    const darkMode = pngDiff(f2, dark) > 0.05;
    await page.emulateMedia({ colorScheme: "light" });

    // DOM-shape hash + class signature (originality clustering input).
    const domSig = await page.evaluate(() => {
      const tags = [];
      const walk = (el, depth) => {
        if (depth > 12 || tags.length > 3000) return;
        tags.push(el.tagName);
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(document.body, 0);
      const classes = new Set();
      for (const el of document.querySelectorAll("[class]"))
        for (const c of el.classList) classes.add(c);
      return {
        tags: tags.join(","),
        classes: [...classes].sort().slice(0, 500).join(","),
      };
    });
    const domHash = createHash("sha1").update(domSig.tags).digest("hex");
    const classHash = createHash("sha1").update(domSig.classes).digest("hex");

    // Page text and facts from the settled, rendered page (single-page apps
    // included), plus a capped check of its project and demo links.
    const settled = await page.evaluate(readRenderedPage).catch(() => rendered);
    const pageText = normalizePageText(settled.text);
    const facts = await measurePage(
      { html: settled.html, text: settled.text, url, finalUrl: page.url(), name, motion, source: "rendered" },
      { userAgent: UA }
    ).catch(() => null);

    // Mobile: 390px hero + horizontal-overflow check.
    const mpage = await ctx.newPage();
    await mpage.setViewportSize({ width: 390, height: 844 });
    await mpage.goto(url, { waitUntil: "load", timeout: 30000 });
    await mpage.waitForTimeout(1500);
    const overflow390 = await mpage.evaluate(
      () => document.documentElement.scrollWidth > 395
    );
    fs.writeFileSync(
      path.join(dir, "mobile.jpg"),
      await mpage.screenshot({ type: "jpeg", quality: 75 })
    );

    await ctx.close();

    const meta = {
      consoleErrors: consoleErrors.length,
      consoleSample: consoleErrors.slice(0, 5),
      requests,
      bytes,
      broken404s: broken,
      overflow390,
      darkMode,
      motion,
      heroSettled,
      domHash,
      classHash,
    };

    await uploadDir(key, dir);

    await db.execute({
      sql: `INSERT INTO portfolios
              (url, name, status, reason, shot_key, meta, checked_at, captured_at,
               page_text, facts, facts_at)
            VALUES (?, ?, 'live', '', ?, ?, datetime('now'), datetime('now'), ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET status='live', reason='',
              shot_key=excluded.shot_key, meta=excluded.meta,
              checked_at=excluded.checked_at, captured_at=excluded.captured_at,
              capture_attempts=0, retry_at=NULL,
              page_text=excluded.page_text,
              facts=COALESCE(excluded.facts, portfolios.facts),
              facts_at=COALESCE(excluded.facts_at, portfolios.facts_at)`,
      args: [url, name, key, JSON.stringify(meta), pageText, facts ? JSON.stringify(facts) : null, facts?.measured_at ?? null],
    });
    return `live → ${key} (motion=${meta.motion} dark=${meta.darkMode} overflow=${meta.overflow390})`;
  } catch (e) {
    await ctx.close().catch(() => {});
    await recordFailure(url, name, "error", String(e.message ?? e).slice(0, 200));
    return `error (${String(e.message ?? e).slice(0, 80)})`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (args.includes("--upload-only")) {
  if (!s3) {
    console.error("R2_* env vars missing — nothing to upload to.");
    process.exit(1);
  }
  const capDir = path.join(ROOT, "captures");
  const keys = fs.existsSync(capDir) ? fs.readdirSync(capDir) : [];
  for (const [i, key] of keys.entries()) {
    await uploadDir(key, path.join(capDir, key));
    console.log(`[${i + 1}/${keys.length}] uploaded ${key}`);
  }
  process.exit(0);
}

const feed = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8")
);
// Rows that left the list are marked delisted; the queue only holds roster sites.
const roster = await syncRoster(db, feed);
console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);
let queue = feed.filter((p) => !ONLY || p.url.includes(ONLY));

if (!FORCE) {
  queue = await dueForCapture(db, queue);
}
queue = queue.slice(0, LIMIT);
// The nightly refresh: listed, healthy sites captured longest ago.
if (REFRESH > 0 && !ONLY) {
  const queued = new Set(queue.map((p) => p.url));
  const listed = new Map(feed.map((p) => [p.url, p]));
  const due = (
    await db.execute({
      sql: `SELECT url FROM portfolios WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
            ORDER BY captured_at, url LIMIT ?`,
      args: [REFRESH + queue.length],
    })
  ).rows
    .map((r) => String(r.url))
    .filter((u) => !queued.has(u) && listed.has(u))
    .slice(0, REFRESH);
  for (const u of due) queue.push({ ...listed.get(u), refresh: true });
  console.log(`refresh: re-capturing ${due.length} site(s) captured longest ago`);
}
console.log(`capturing ${queue.length} site(s), concurrency ${CONCURRENCY}, R2 ${s3 ? "on" : "off (local only)"}`);

const browser = await chromium.launch();
let idx = 0,
  ok = 0,
  skipped = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (idx < queue.length) {
      const entry = queue[idx++];
      const t = Date.now();
      const result = await captureSite(browser, entry, { refresh: Boolean(entry.refresh) });
      if (result.startsWith("live")) ok++;
      else skipped++;
      console.log(
        `[${idx}/${queue.length}] ${entry.url} — ${result} (${((Date.now() - t) / 1000).toFixed(1)}s)`
      );
    }
  })
);
await browser.close();
console.log(`done: ${ok} captured, ${skipped} gated out`);
