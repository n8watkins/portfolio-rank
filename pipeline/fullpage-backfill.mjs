#!/usr/bin/env node
// Full-page frames (pipeline/fullpage.mjs) for sites captured before the
// capture took them. Runs in the nightly free checks right after the capture
// (sync-upstream.yml), a capped number of sites a night, so the list fills
// in over a few weeks instead of in one burst; new and re-captured sites get
// their frames from the capture itself.
//
// Per site: the same gate as the capture (a site that went dead or parked
// is skipped), the page at 1440 and at 390, both frames, an upload of only
// those two files to R2 next to hero.jpg, and `fullPage` in the row's meta.
// Nothing else about the row changes: not the hero, not captured_at, not the
// page fingerprint, so no re-grade follows. A site whose frames fail is
// tried again a week later, three tries at most (fullPageDue).
//
// Usage:
//   node pipeline/fullpage-backfill.mjs [--limit N] [--concurrency C] [--only substr] [--dry-run]
//
// --limit defaults to 0 (nothing): the workflow passes the nightly cap.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { httpGate, UA } from "./gate.mjs";
import { ACTIVE, ensureRosterSchema, pipelineDb } from "./roster.mjs";
import { FULL_PAGE_FILES, captureFullPages, fullPageComplete, fullPageDue, nextTries, recordFullPage } from "./fullpage.mjs";
import { contentTypeOf } from "./shot-files.mjs";

const ROOT = path.join(import.meta.dirname, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIMIT = Math.max(0, Number(flag("limit", "0")) || 0);
const CONCURRENCY = Math.max(1, Number(flag("concurrency", "3")) || 3);
const ONLY = flag("only", "");
const DRY = args.includes("--dry-run");

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

async function upload(key, dir) {
  if (!s3) return;
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  for (const f of FULL_PAGE_FILES) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET ?? "portfolio-rank",
        Key: `${key}/${f}`,
        Body: fs.readFileSync(file),
        ContentType: contentTypeOf(f),
      })
    );
  }
}

const failed = (error) => ({ desktop: { error }, phone: { error } });

async function backfillSite(browser, row) {
  const dir = path.join(ROOT, "captures", row.shotKey);
  let fullPage;
  const gate = await httpGate(row.url);
  if (gate.status !== "live") {
    fullPage = { at: new Date().toISOString(), ...failed(`gate: ${gate.status} (${gate.reason})`.slice(0, 200)) };
  } else {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
    try {
      const page = await ctx.newPage();
      await page.goto(row.url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      // The phone page the way the capture takes mobile.jpg.
      const mpage = await ctx.newPage();
      await mpage.setViewportSize({ width: 390, height: 844 });
      await mpage.goto(row.url, { waitUntil: "load", timeout: 30000 });
      await mpage.waitForTimeout(1500);
      fs.mkdirSync(dir, { recursive: true });
      fullPage = await captureFullPages({ desktop: page, phone: mpage }, dir);
    } catch (e) {
      fullPage = { at: new Date().toISOString(), ...failed(String(e?.message ?? e).split("\n")[0].slice(0, 200)) };
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  fullPage.tries = nextTries(row.fullPage);
  await upload(row.shotKey, dir);
  await recordFullPage(db, { url: row.url, shotKey: row.shotKey, fullPage });
  return fullPage;
}

const due = (await fullPageDue(db, { limit: ONLY ? 100000 : LIMIT, active: ACTIVE }))
  .filter((r) => !ONLY || r.url.includes(ONLY))
  .slice(0, ONLY ? Math.max(LIMIT, 1) : LIMIT);
console.log(`full-page backfill: ${due.length} site(s), concurrency ${CONCURRENCY}, R2 ${s3 ? "on" : "off (local only)"}${DRY ? ", dry run" : ""}`);
if (DRY || due.length === 0) process.exit(0);

const browser = await chromium.launch();
let idx = 0;
let ok = 0;
const kb = (n) => (n ? `${Math.round(n / 1024)} KB` : "-");
try {
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
      while (idx < due.length) {
        const row = due[idx++];
        const t = Date.now();
        let fp;
        try {
          fp = await backfillSite(browser, row);
        } catch (e) {
          // R2 or the database: nothing recorded, the site stays due.
          console.log(`[${idx}/${due.length}] ${row.url} not stored: ${String(e?.message ?? e).slice(0, 120)}`);
          continue;
        }
        if (fullPageComplete(fp)) ok++;
        const part = (f) => (f?.error ? `error (${f.error.slice(0, 60)})` : `${f.width}x${f.height}${f.cropped ? " cropped" : ""} ${kb(f.bytes)}`);
        console.log(`[${idx}/${due.length}] ${row.url} desktop ${part(fp.desktop)}, phone ${part(fp.phone)} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      }
    })
  );
} finally {
  await browser.close();
}
console.log(`done: ${ok} of ${due.length} with both frames`);
