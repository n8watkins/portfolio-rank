// The nightly capture's limits and its storage order (pipeline/capture.mjs),
// end to end in headless Chromium against local pages, with a throwaway
// database and a stand-in bucket:
//   - a page whose main thread hangs after load is cut off at the site's time
//     limit, its context closed, and retried later; the same browser goes on;
//   - a capture that throws before its own handling leaves no timer behind;
//   - a stalled write after a good capture (the old images' delete) is
//     bounded, so the capture still returns;
//   - when the browser goes away under a capture nothing is recorded, and the
//     run (captureQueue) puts the site back in line; a failed browser start is
//     tried again, and repeated failures end the run with an error;
//   - the old image version is deleted only after the row points at the new
//     one; a capture that fails after uploading (all or part of a version)
//     removes its own new images and leaves the row's.
// Every outbound link points at .invalid hosts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { BROWSER_GONE, MAX_LAUNCH_FAILURES, captureQueue, captureSite, keyOf } from "../pipeline/capture.mjs";
import { dueForCapture, ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";

const SITE = `<!doctype html><title>Jane Doe</title><body style="font:18px system-ui;max-width:800px;margin:40px auto"><h1>Jane Doe</h1><h2>Backend engineer</h2>
<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(6)}</p>
<p><a href="https://code.invalid/jane/ledger">Ledger</a> <a href="https://social.invalid/jane">Profile</a></p></body>`;
const pages = {
  "/site": SITE,
  "/site2": SITE,
  "/site3": SITE,
  // The main thread blocks for good a few seconds after load.
  "/hang": `<!doctype html><title>Jane Doe</title><body><h1>Jane Doe</h1><p>${"I build things for the web and write about them here. ".repeat(10)}</p><a href="https://code.invalid/jane">GitHub</a>
    <script>setTimeout(()=>{for(;;){}},2500)</script></body>`,
};

let server;
let browser;
let base;
let db;
let root;
const url = (p) => `${base}${p}`;
const OLD_TEXT = "Old good page text of the portfolio";
const OLD_AT = "2026-07-01 00:00:00";
const OLD_META = { motion: false, fullPage: { v: "oldv", textHash: "x", desktop: { bytes: 1 }, phone: { bytes: 1 } } };

async function seedGood(p, meta = OLD_META) {
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [url(p)] });
  await db.execute({
    sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Old Site', 'live', '', ?, ?, ?, '{}', ?, ?)",
    args: [url(p), keyOf(url(p)), JSON.stringify(meta), OLD_TEXT, OLD_AT, OLD_AT],
  });
}

before(async () => {
  server = http.createServer((req, res) => res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url] ?? "not found"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-limits-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];
const captured = (p) => fs.existsSync(path.join(root, "captures", keyOf(url(p))));
const SLOW = { timeout: 300000 };

test("a page that hangs after load is cut off at the time limit, its context closed, and retried later", SLOW, async () => {
  const b = await chromium.launch();
  try {
    const t0 = Date.now();
    const result = await captureSite(b, { url: url("/hang"), name: "Jane Doe" }, { db, s3: null, root, limitMs: 20000 });
    const s = (Date.now() - t0) / 1000;
    assert.equal(result, "error (capture timed out after 20s)");
    assert.ok(s < 45, `returned in ${s}s`);
    assert.equal(b.contexts().length, 0, "the hung page's context is closed");
    const row = await rowOf("/hang");
    assert.equal(row.status, "error");
    assert.equal(row.reason, "capture timed out after 20s");
    assert.equal(Number(row.capture_attempts), 1);
    assert.deepEqual(await dueForCapture(db, [{ url: url("/hang") }]), [], "not due again tonight");
    assert.equal(captured("/hang"), false);
    // The browser still works for the next site.
    const next = await captureSite(b, { url: url("/site3"), name: "Jane Doe" }, { db, s3: null, root });
    assert.match(next, /^live/, next);
  } finally {
    await b.close();
  }
});

test("a capture that throws before its own handling leaves no timer running", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  const broken = { execute: async () => Promise.reject(new Error("database gone")) };
  await assert.rejects(captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { db: broken, s3: null, root, limitMs: 600000 }), /database gone/);
  assert.equal(timers(), before, "the site limit's timer is cleared");
});

test("when the browser goes away under a capture, nothing is recorded and the result says to retry", SLOW, async () => {
  const b = await chromium.launch();
  const p = captureSite(b, { url: url("/site2"), name: "Jane Doe" }, { db, s3: null, root });
  await new Promise((r) => setTimeout(r, 3000));
  await b.close();
  assert.equal(await p, BROWSER_GONE);
  assert.equal(await rowOf("/site2"), undefined, "no failed capture recorded for a site that did nothing wrong");
});

test("captureQueue: a site that lost its browser goes back in line; a failed start is tried again", async () => {
  const fakeBrowser = () => ({ connected: true, isConnected() { return this.connected; }, async close() { this.connected = false; } });
  let launches = 0;
  const launch = async () => {
    launches++;
    if (launches === 1) throw new Error("chromium did not start");
    return fakeBrowser();
  };
  const seen = [];
  const capture = async (b, entry) => {
    seen.push(entry.url);
    // The first capture of /a loses its browser.
    if (entry.url === "/a" && seen.filter((u) => u === "/a").length === 1) {
      b.connected = false;
      return BROWSER_GONE;
    }
    return "live → x";
  };
  const out = await captureQueue([{ url: "/a" }, { url: "/b" }], { capture, launch, concurrency: 1, log: () => {}, retryPauseMs: 0 });
  assert.deepEqual(out, { ok: 2, skipped: 0, requeued: 1 });
  // /a waits out the failed start, /b goes first, then /a twice (it lost its browser once).
  assert.deepEqual(seen, ["/b", "/a", "/a"]);
  assert.equal(launches, 3, "a failed start is not remembered: the next site starts it again");
});

test("captureQueue: a browser that never starts ends the run with an error", async () => {
  let launches = 0;
  const launch = async () => {
    launches++;
    throw new Error("chromium did not start");
  };
  await assert.rejects(captureQueue([{ url: "/a" }, { url: "/b" }], { capture: async () => "live", launch, concurrency: 1, log: () => {}, retryPauseMs: 0 }), /failed to start 3 times/);
  assert.equal(launches, MAX_LAUNCH_FAILURES);
});

/** A stand-in bucket: logs every write, reads the row's image version at each delete, can fail a PUT or never answer a delete. */
function fakeBucket(p, { failPut = null, hangDelete = false } = {}) {
  const log = [];
  let puts = 0;
  return {
    log,
    send: async (cmd) => {
      const name = cmd.constructor.name;
      const keys = cmd.input.Key ? [cmd.input.Key] : (cmd.input.Delete?.Objects ?? []).map((o) => o.Key);
      const rowV = (await db.execute({ sql: "SELECT json_extract(meta, '$.fullPage.v') AS v FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0]?.v ?? null;
      log.push({ name, keys, rowV });
      if (name === "PutObjectCommand" && failPut && failPut(cmd.input.Key, ++puts)) throw new Error("R2 503 SlowDown (stand-in)");
      if (name === "DeleteObjectsCommand" && hangDelete) return new Promise(() => {});
      return {};
    },
  };
}

/** Runs `fn` with the images bucket configured. */
async function withImagesBucket(fn) {
  const prev = process.env.R2_IMAGES_BUCKET;
  process.env.R2_IMAGES_BUCKET = "test-images";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.R2_IMAGES_BUCKET;
    else process.env.R2_IMAGES_BUCKET = prev;
  }
}

const newVersionDeletes = (log) => log.filter((l) => l.name === "DeleteObjectsCommand" && !l.keys.some((k) => k.includes("/oldv/")));
const oldVersionDeletes = (log) => log.filter((l) => l.name === "DeleteObjectsCommand" && l.keys.some((k) => k.includes("/oldv/")));

test("images: a failed upload leaves the row and its images; the new version, whole or partial, is removed", SLOW, async () => {
  await withImagesBucket(async () => {
    // The last upload (the old frames' hero.jpg) fails after the whole new version is up.
    await seedGood("/site");
    const late = fakeBucket("/site", { failPut: (key) => /hero\.jpg$/.test(key) });
    const r1 = await captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { refresh: true, db, s3: late, root });
    assert.match(r1, /^error \(R2 503/, r1);
    assert.equal(oldVersionDeletes(late.log).length, 0, "the row's images are not deleted");
    assert.equal(newVersionDeletes(late.log).length, 1, "the new version is removed");
    assert.equal((await rowOf("/site")).page_text, OLD_TEXT);
    assert.equal(JSON.parse(String((await rowOf("/site")).meta)).fullPage.v, "oldv");

    // The third of the four image uploads fails: the two already up are removed too.
    const partial = fakeBucket("/site", { failPut: (_key, n) => n === 3 });
    const r2 = await captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { refresh: true, db, s3: partial, root });
    assert.match(r2, /^error \(R2 503/, r2);
    assert.equal(oldVersionDeletes(partial.log).length, 0);
    assert.equal(newVersionDeletes(partial.log).length, 1, "a partly uploaded version is removed");
    assert.equal(JSON.parse(String((await rowOf("/site")).meta)).fullPage.v, "oldv");
  });
});

test("images: the old version is deleted only after the row points at the new one, and a stalled delete cannot hang the capture", SLOW, async () => {
  await withImagesBucket(async () => {
    await seedGood("/site");
    const ok = fakeBucket("/site");
    const r1 = await captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { refresh: true, db, s3: ok, root });
    assert.match(r1, /^live/, r1);
    const newV = JSON.parse(String((await rowOf("/site")).meta)).fullPage.v;
    assert.notEqual(newV, "oldv");
    const del = oldVersionDeletes(ok.log)[0];
    assert.ok(del, "the old version is deleted");
    assert.equal(del.rowV, newV, "the row already pointed at the new version when the old one was deleted");

    // The delete never answers: the capture still returns, as stored.
    await seedGood("/site");
    const stalled = fakeBucket("/site", { hangDelete: true });
    const t0 = Date.now();
    const r2 = await captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { refresh: true, db, s3: stalled, root, stepLimitMs: 2000 });
    assert.match(r2, /^live/, r2);
    assert.ok(Date.now() - t0 < 200000);
    assert.notEqual(JSON.parse(String((await rowOf("/site")).meta)).fullPage.v, "oldv");
  });
});
