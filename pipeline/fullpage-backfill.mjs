#!/usr/bin/env node
// Tall images and thumbnails (pipeline/fullpage.mjs) for sites captured
// before the capture made them. Runs in the nightly free checks right after
// the capture (sync-upstream.yml), a capped number of sites a night, so the
// list fills in over a few weeks instead of in one burst; new and
// re-captured sites get their images from the capture itself.
//
// Per site, one visit the way the capture makes it: the same gate (a site
// that went dead or parked is skipped), the page at 1440, its splash gate
// and dialog passed (pipeline/splash.mjs), a still first screen, the tall
// desktop image; the same at 390 for the phone. Only the four versioned
// AVIF files are uploaded (pipeline/shot-store.mjs) and `fullPage` is
// written to the row's meta. Nothing else about the row changes: not
// hero.jpg, not captured_at, not the page fingerprint, so no re-grade
// follows. A site whose images fail is tried again a week later, three
// tries at most (fullPageDue).
//
// Usage:
//   node pipeline/fullpage-backfill.mjs [--limit N] [--minutes M] [--concurrency C] [--only substr] [--dry-run]
//
// --limit defaults to 0 (nothing): the workflow passes the nightly cap.
// --minutes: no new site is started after M minutes (default 40), so a slow
// night never holds up the end-of-day grading that waits for these checks.
import { chromium } from "playwright";
import path from "path";
import { httpGate, readRenderedPage, UA } from "./gate.mjs";
import { ACTIVE, ensureRosterSchema, pipelineDb } from "./roster.mjs";
import { normalizePageText } from "./rubric.mjs";
import { passModal, passSplashGate } from "./splash.mjs";
import { IMAGE_FILES, captureView, fullPageComplete, fullPageDue, nextFullPage, recordFullPage, settleFirstScreen } from "./fullpage.mjs";
import { imagesBucket, storeVersion } from "./shot-store.mjs";

const ROOT = path.join(import.meta.dirname, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIMIT = Math.max(0, Number(flag("limit", "0")) || 0);
const DEADLINE = Date.now() + Math.max(1, Number(flag("minutes", "40")) || 40) * 60000;
const CONCURRENCY = Math.max(1, Number(flag("concurrency", "3")) || 3);
const ONLY = flag("only", "");
const DRY = args.includes("--dry-run");
const IMAGES_BUCKET = imagesBucket();

const db = pipelineDb(ROOT);
await ensureRosterSchema(db);

let s3 = null;
if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

const failedView = (error) => ({ ok: false, meta: { error } });

/** One view of the site: load, gate and dialog, a still first screen, then the tall image. */
async function view(ctx, url, name, size) {
  const page = await ctx.newPage();
  await page.setViewportSize(size);
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await passSplashGate(page).catch(() => null);
  await passModal(page).catch(() => null);
  await settleFirstScreen(page);
  const text = name === "desktop" ? await page.evaluate(readRenderedPage).then((r) => r.text).catch(() => "") : null;
  return { result: await captureView(page, name), text };
}

async function backfillSite(browser, row) {
  let desktopView;
  let phoneView;
  let pageText = "";
  const gate = await httpGate(row.url);
  if (gate.status !== "live") {
    desktopView = phoneView = failedView(`gate: ${gate.status} (${gate.reason})`.slice(0, 200));
  } else {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
    try {
      const d = await view(ctx, row.url, "desktop", { width: 1440, height: 900 });
      desktopView = d.result;
      pageText = normalizePageText(d.text ?? "");
      phoneView = (await view(ctx, row.url, "phone", { width: 390, height: 844 })).result;
    } catch (e) {
      const error = String(e?.message ?? e).split("\n")[0].slice(0, 200);
      desktopView ??= failedView(error);
      phoneView ??= failedView(error);
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  const { fullPage, uploadImages } = nextFullPage(row.fullPage, { desktopView, phoneView, pageText, at: new Date() });
  if (s3 && uploadImages) {
    const commands = await import("@aws-sdk/client-s3");
    await storeVersion({
      send: (c) => s3.send(c),
      commands,
      bucket: IMAGES_BUCKET,
      shotKey: row.shotKey,
      v: fullPage.v,
      prevV: row.fullPage?.v,
      files: {
        [IMAGE_FILES.desktop.tall]: desktopView.files.tall,
        [IMAGE_FILES.desktop.thumb]: desktopView.files.thumb,
        [IMAGE_FILES.phone.tall]: phoneView.files.tall,
        [IMAGE_FILES.phone.thumb]: phoneView.files.thumb,
      },
    });
  }
  await recordFullPage(db, { url: row.url, shotKey: row.shotKey, fullPage });
  return fullPage;
}

const due = (await fullPageDue(db, { limit: ONLY ? 100000 : LIMIT, active: ACTIVE }))
  .filter((r) => !ONLY || r.url.includes(ONLY))
  .slice(0, ONLY ? Math.max(LIMIT, 1) : LIMIT);
console.log(`full-page backfill: ${due.length} site(s), concurrency ${CONCURRENCY}, R2 ${s3 ? "on" : "off (local only)"}${DRY ? ", dry run" : ""}`);
if (DRY || due.length === 0) process.exit(0);
// Nothing to store into until the public images bucket exists (pipeline/shot-store.mjs).
if (!s3 || !IMAGES_BUCKET) {
  console.log("::notice::No images bucket yet (R2_IMAGES_BUCKET): nothing backfilled.");
  process.exit(0);
}

const browser = await chromium.launch();
let idx = 0;
let ok = 0;
const kb = (n) => (n ? `${Math.round(n / 1024)} KB` : "-");
try {
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
      while (idx < due.length && Date.now() < DEADLINE) {
        const n = ++idx;
        const row = due[n - 1];
        const t = Date.now();
        let fp;
        try {
          fp = await backfillSite(browser, row);
        } catch (e) {
          // R2 or the database: nothing recorded, the site stays due.
          console.log(`[${n}/${due.length}] ${row.url} not stored: ${String(e?.message ?? e).slice(0, 120)}`);
          continue;
        }
        if (fullPageComplete(fp)) ok++;
        const part = (f) => (f?.error ? `error (${f.error.slice(0, 60)})` : `${f.width}x${f.height}${f.cropped ? " cropped" : ""} ${kb(f.bytes)} + thumb ${kb(f.thumbBytes)}`);
        console.log(`[${n}/${due.length}] ${row.url} desktop ${part(fp.desktop)}, phone ${part(fp.phone)} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      }
    })
  );
} finally {
  await browser.close();
}
console.log(`done: ${ok} of ${idx} with both images${idx < due.length ? `; ${due.length - idx} left for another night (time budget)` : ""}`);
