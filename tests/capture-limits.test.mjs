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
import { BROWSER_GONE, CRASH_REASON, MAX_LAUNCH_FAILURES, captureQueue, captureSite, keyOf, recordBrowserCrash } from "../pipeline/capture.mjs";
import { dueForCapture, ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";

const SITE = `<!doctype html><title>Jane Doe</title><body style="font:18px system-ui;max-width:800px;margin:40px auto"><h1>Jane Doe</h1><h2>Backend engineer</h2>
<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(6)}</p>
<p><a href="https://code.invalid/jane/ledger">Ledger</a> <a href="https://social.invalid/jane">Profile</a></p></body>`;
const pages = {
  "/site": SITE,
  "/site2": SITE,
  "/site3": SITE,
  "/rejected": SITE,
  "/s3fault": SITE,
  "/crasher": SITE,
  "/neighbour": SITE,
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

// The browser to kill and where (the "browser goes away" test), and whether it was.
const killer = { browser: null, point: null, fired: false };
const kill = () => {
  if (killer.fired || !killer.browser) return;
  killer.fired = true;
  killer.browser.close().catch(() => {});
};
/** The kill-test page for one point: the site, plus what signals that point. */
const killPage = (point) =>
  SITE.replace(
    "</body>",
    {
      gate: "",
      goto: "",
      settle: `<script>addEventListener("load",()=>fetch("/beacon"))</script>`,
      polls: `<script>setTimeout(()=>fetch("/beacon"),6000)</script>`,
      scroll: `<div style="height:6000px"></div><img loading=lazy src="/beacon.png" width=40 height=40>`,
      phone: `<script>addEventListener("resize",()=>{if(innerWidth<500)fetch("/beacon")})</script>`,
    }[point] + "</body>"
  );

before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    const m = /^\/kill-(\w+)$/.exec(req.url);
    // Only the browser's own navigation, not the plain pre-check's fetch.
    const navigation = req.headers["sec-fetch-mode"] === "navigate";
    // The plain pre-check's fetch: the browser dies meanwhile, and the pre-check then fails.
    if (m && m[1] === "gate" && killer.point === "gate" && !navigation) {
      kill();
      return setTimeout(() => res.writeHead(404, html).end("not found"), 1500);
    }
    if (m && m[1] === killer.point && navigation) {
      if (m[1] === "goto") {
        kill();
        return setTimeout(() => res.writeHead(200, html).end(killPage("goto")), 3000);
      }
    }
    if (m) return res.writeHead(200, html).end(killPage(m[1]));
    if (req.url === "/beacon" || req.url === "/beacon.png") {
      kill();
      return res.writeHead(204).end();
    }
    res.writeHead(pages[req.url] ? 200 : 404, html).end(pages[req.url] ?? "not found");
  });
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
  // Only the timers made during this call are followed (other tests' timers come and go meanwhile).
  const pending = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = realSet((...a) => {
      pending.delete(h);
      fn(...a);
    }, ms, ...args);
    pending.add(h);
    return h;
  };
  globalThis.clearTimeout = (h) => {
    pending.delete(h);
    realClear(h);
  };
  try {
    const broken = { execute: async () => Promise.reject(new Error("database gone")) };
    await assert.rejects(captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { db: broken, s3: null, root, limitMs: 600000 }), /database gone/);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.equal(pending.size, 0, "the site limit's timer is cleared");
});

// The browser is killed at a point the page itself signals, so each case hits
// the same step every run: while the page loads (its document request), in
// the settle wait (a beacon on load), in the screenshot polls (a beacon six
// seconds in), in the scroll-through (a lazy image far down), and while the
// page is resized for the phone view (a beacon on a narrow resize).
// "gate": during the plain pre-check, which then fails: still the browser's death, not the site's failure.
const KILL_POINTS = ["gate", "goto", "settle", "polls", "scroll", "phone"];

test("whenever the browser goes away under a capture, nothing is recorded and the result says to retry", { timeout: 600000 }, async () => {
  for (const point of KILL_POINTS) {
    const b = await chromium.launch();
    Object.assign(killer, { browser: b, point, fired: false });
    try {
      const result = await captureSite(b, { url: url(`/kill-${point}`), name: "Jane Doe" }, { db, s3: null, root });
      assert.ok(killer.fired, `${point}: the browser was killed`);
      assert.equal(result, BROWSER_GONE, `${point}: ${result}`);
      assert.equal(await rowOf(`/kill-${point}`), undefined, `${point}: no failed capture recorded for a site that did nothing wrong`);
      assert.equal(captured(`/kill-${point}`), false, `${point}: nothing stored`);
    } finally {
      Object.assign(killer, { browser: null, point: null });
      await b.close().catch(() => {});
    }
  }
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

test("images: a row write the database rejects removes the new images and records the failure", SLOW, async () => {
  await withImagesBucket(async () => {
    // A new site; the database refuses the capture's own row (and nothing else).
    const rejecting = {
      execute: (stmt) =>
        /shot_key, meta, checked_at, captured_at/.test(String(stmt?.sql ?? stmt)) ? Promise.reject(new Error("SQLITE_CONSTRAINT: the row was refused (stand-in)")) : db.execute(stmt),
    };
    const bucket = fakeBucket("/rejected");
    const result = await captureSite(browser, { url: url("/rejected"), name: "Jane Doe" }, { db: rejecting, s3: bucket, root });
    assert.match(result, /^error \(SQLITE_CONSTRAINT/, result);
    assert.equal(newVersionDeletes(bucket.log).length, 1, "the new images are removed");
    const row = await rowOf("/rejected");
    assert.equal(row?.status, "error", "the failure is recorded");
    assert.match(String(row.reason), /SQLITE_CONSTRAINT/);
    assert.ok(row.retry_at, "with a retry date");
  });
});

test("a storage error no site causes (refused credentials) is thrown as the run's fault, not recorded as the site's", SLOW, async () => {
  await withImagesBucket(async () => {
    const refusing = {
      send: async (cmd) => {
        if (cmd.constructor.name === "PutObjectCommand") throw Object.assign(new Error("The AWS Access Key Id you provided does not exist"), { name: "InvalidAccessKeyId" });
        return {};
      },
    };
    await assert.rejects(captureSite(browser, { url: url("/s3fault"), name: "Jane Doe" }, { db, s3: refusing, root }), /Access Key Id/);
    assert.equal(await rowOf("/s3fault"), undefined, "nothing recorded against the site");
  });
});

test("captureQueue: a database that fails every site ends the run with an error instead of finishing green", SLOW, async () => {
  const down = { execute: async () => Promise.reject(new Error("SERVER_ERROR: the database is unreachable (stand-in)")) };
  const entries = ["/dbfault1", "/dbfault2", "/dbfault3", "/dbfault4"].map((p) => ({ url: url(p), name: "Jane Doe" }));
  await assert.rejects(
    captureQueue(entries, { capture: (b, entry) => captureSite(b, entry, { db: down, s3: null, root }), concurrency: 1, log: () => {} }),
    /the run cannot go on.*unreachable/
  );
});

test("captureQueue: a site that takes the browser down every time is captured alone once, then recorded; its neighbour is captured", { timeout: 600000 }, async () => {
  // Every browser launched here dies when one of its pages opens /crasher.
  const launch = async () => {
    const b = await chromium.launch();
    const newContext = b.newContext.bind(b);
    b.newContext = async (...a) => {
      const ctx = await newContext(...a);
      ctx.on("request", (r) => {
        if (r.isNavigationRequest() && r.url().endsWith("/crasher")) b.close().catch(() => {});
      });
      return ctx;
    };
    return b;
  };
  const entries = [
    { url: url("/crasher"), name: "Jane Doe" },
    { url: url("/neighbour"), name: "Sam Lee" },
  ];
  const out = await captureQueue(entries, {
    capture: (b, entry) => captureSite(b, entry, { db, s3: null, root }),
    recordCrash: (entry) => recordBrowserCrash(db, entry),
    launch,
    concurrency: 2,
    log: () => {},
  });
  assert.equal(out.ok, 1, JSON.stringify(out));
  assert.equal(out.skipped, 1);
  const crasher = await rowOf("/crasher");
  assert.equal(crasher.status, "error");
  assert.equal(crasher.reason, CRASH_REASON);
  assert.ok(crasher.retry_at, "with backoff");
  const neighbour = await rowOf("/neighbour");
  assert.equal(neighbour.status, "live", "the neighbour is not charged for someone else's crashes");
});
