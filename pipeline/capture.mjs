#!/usr/bin/env node
// Phase 0 capture pipeline: gate every portfolio (dead/parked/blank), then
// Playwright-capture the live ones — desktop hero, mobile, full-page, 3-frame
// motion strip — plus diagnostics (console errors, page weight, broken assets,
// 390px overflow, dark-mode support, DOM-shape hash). Artifacts land in
// captures/<key>/ and upload to R2 when R2_* env vars exist; results upsert
// into the `portfolios` table (Turso when TURSO_* set, else local file).
//
// Usage:
//   node pipeline/capture.mjs [--limit N] [--concurrency C] [--only substr] [--force]
//   node pipeline/capture.mjs --upload-only   # backfill captures/ to R2 later
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// env (.env.local, no dotenv dependency)
// ---------------------------------------------------------------------------
for (const line of fs
  .readFileSync(path.join(ROOT, ".env.local"), "utf8")
  .split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
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

// ---------------------------------------------------------------------------
// Gate tables (ported from pipeline/check_parking_redirects.py)
// ---------------------------------------------------------------------------
const PARKING_DOMAINS = new Set([
  "sedoparking.com", "sedo.com", "bodis.com", "parkingcrew.net",
  "sav.com", "dan.com", "afternic.com", "hugedomains.com",
  "undeveloped.com", "buydomains.com", "brandbucket.com", "efty.com",
  "domainmarket.com", "above.com", "parklogic.com", "uniregistry.com",
  "domainnameshop.com", "registrar-servers.com", "topdns.com",
  "godaddysites.com", "secureserver.net", "domaincontrol.com",
  "domainnamesales.com", "domainagents.com", "squadhelp.com",
  "flippa.com", "epik.com",
]);
const PARKING_PHRASES = [
  "domain for sale", "buy this domain", "this domain is for sale",
  "make an offer", "parked domain", "this domain is parked",
  "domain parking", "purchase this domain", "inquire about this domain",
  "this web page is parked", "the domain has expired", "domain has expired",
  "this domain expired", "renew this domain", "domain registration expired",
];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const netloc = (url) => {
  try {
    const n = new URL(url).hostname.toLowerCase();
    return n.startsWith("www.") ? n.slice(4) : n;
  } catch {
    return "";
  }
};
const isParkingDomain = (url) => {
  const d = netloc(url);
  return [...PARKING_DOMAINS].some((p) => d === p || d.endsWith("." + p));
};

/** HTTP-level gate. Returns { status: 'live'|'dead'|'parked'|'error', reason } */
async function httpGate(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const msg = String(e?.cause?.code ?? e?.cause ?? e);
    if (/ENOTFOUND|EAI_AGAIN/.test(msg))
      return { status: "dead", reason: "DNS resolution failed" };
    if (/CERT|certificate/i.test(msg))
      return { status: "error", reason: "TLS error" };
    if (e.name === "TimeoutError")
      return { status: "error", reason: "timeout" };
    return { status: "error", reason: msg.slice(0, 120) };
  }
  if (res.status === 404 || res.status === 410)
    return { status: "dead", reason: `HTTP ${res.status}` };
  if (!res.ok) return { status: "error", reason: `HTTP ${res.status}` };
  if (isParkingDomain(res.url))
    return { status: "parked", reason: `redirects to ${netloc(res.url)}` };
  const body = (await res.text()).slice(0, 65536).toLowerCase();
  const phrase = PARKING_PHRASES.find((p) => body.includes(p));
  if (phrase) return { status: "parked", reason: `parking phrase: "${phrase}"` };
  return { status: "live", reason: "" };
}

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
const db = process.env.TURSO_DATABASE_URL
  ? createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  : createClient({
      url: `file:${path.join(ROOT, "data", "portfoliorank.db")}`,
    });

await db.execute(`CREATE TABLE IF NOT EXISTS portfolios (
  url TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  shot_key TEXT,
  meta TEXT,
  checked_at TEXT,
  captured_at TEXT
)`);

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

async function uploadDir(key, dir) {
  if (!s3) return;
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  for (const f of fs.readdirSync(dir)) {
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

async function captureSite(browser, entry) {
  const { url, name } = entry;
  const key = keyOf(url);
  const dir = path.join(ROOT, "captures", key);

  const gate = await httpGate(url);
  if (gate.status !== "live") {
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, reason, checked_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(url) DO UPDATE SET status=excluded.status,
              reason=excluded.reason, checked_at=excluded.checked_at`,
      args: [url, name, gate.status, gate.reason],
    });
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
    const textLen = await page.evaluate(
      () => document.body?.innerText?.trim().length ?? 0
    );
    if (textLen < 30) {
      await ctx.close();
      await db.execute({
        sql: `INSERT INTO portfolios (url, name, status, reason, checked_at)
              VALUES (?, ?, 'dead', 'renders blank', datetime('now'))
              ON CONFLICT(url) DO UPDATE SET status='dead',
                reason='renders blank', checked_at=excluded.checked_at`,
        args: [url, name],
      });
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

    // 3-frame motion strip (PNG for diffing), hero from the settled frame.
    const f0 = await page.screenshot({ type: "png" });
    await page.waitForTimeout(1500);
    const f1 = await page.screenshot({ type: "png" });
    await page.waitForTimeout(1500);
    const f2 = await page.screenshot({ type: "png" });
    const motion = lively >= 2 || pngDiff(f0, f2) > 0.02;
    fs.writeFileSync(path.join(dir, "strip0.png"), f0);
    fs.writeFileSync(path.join(dir, "strip1.png"), f1);
    fs.writeFileSync(path.join(dir, "strip2.png"), f2);
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
              (url, name, status, reason, shot_key, meta, checked_at, captured_at)
            VALUES (?, ?, 'live', '', ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(url) DO UPDATE SET status='live', reason='',
              shot_key=excluded.shot_key, meta=excluded.meta,
              checked_at=excluded.checked_at, captured_at=excluded.captured_at`,
      args: [url, name, key, JSON.stringify(meta)],
    });
    return `live → ${key} (motion=${meta.motion} dark=${meta.darkMode} overflow=${meta.overflow390})`;
  } catch (e) {
    await ctx.close().catch(() => {});
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, reason, checked_at)
            VALUES (?, ?, 'error', ?, datetime('now'))
            ON CONFLICT(url) DO UPDATE SET status='error',
              reason=excluded.reason, checked_at=excluded.checked_at`,
      args: [url, name, String(e.message ?? e).slice(0, 200)],
    });
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
let queue = feed.filter((p) => !ONLY || p.url.includes(ONLY));

if (!FORCE) {
  const done = await db.execute(
    "SELECT url FROM portfolios WHERE status != 'pending'"
  );
  const seen = new Set(done.rows.map((r) => String(r.url)));
  queue = queue.filter((p) => !seen.has(p.url));
}
queue = queue.slice(0, LIMIT);
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
      const result = await captureSite(browser, entry);
      result.startsWith("live") ? ok++ : skipped++;
      console.log(
        `[${idx}/${queue.length}] ${entry.url} — ${result} (${((Date.now() - t) / 1000).toFixed(1)}s)`
      );
    }
  })
);
await browser.close();
console.log(`done: ${ok} captured, ${skipped} gated out`);
