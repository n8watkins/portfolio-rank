// The free tools' APIs (app/api/tools/*, docs/TOOLS.md), end to end against
// the server scripts/test-e2e.sh starts with TOOLS_ENABLED on, TOOLS_CAPS
// lowering the speed check to 3 a network, PageSpeed pointed at a stand-in
// (PSI_API_BASE) and the sites served by a stand-in (GRADER_TEST_SITE),
// both run by this file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const db = createClient({ url: process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/e2e.db`, timeout: 10000 });
const PSI_PORT = Number(process.env.E2E_PSI_PORT ?? 7692);
const SITE_PORT = Number(process.env.E2E_GRADER_MOCK_PORT ?? 7693);
const enabled = process.env.TOOLS_ENABLED === "true";
const RUN = Math.random().toString(36).slice(2, 8);
let ipSeq = 1;
const ip = () => `198.51.100.${ipSeq++}`;

// A 1200 x 630 PNG header: enough for the share checker to read the size.
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

const GOOD = (host) => `<!doctype html><html lang="en"><head><title>Jane Tools - Frontend Developer</title>
<meta name="description" content="I build calm, fast interfaces for small teams.">
<meta property="og:title" content="Jane Tools - Frontend Developer">
<meta property="og:description" content="I build calm, fast interfaces for small teams.">
<meta property="og:image" content="https://${host}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg"></head><body><h1>Jane Tools</h1>
<a href="/resume.pdf">Resume</a> <a href="https://github.com/jane-tools">GitHub</a> <a href="mailto:jane@example.com">Email</a>
<footer>© ${new Date().getUTCFullYear()} Jane Tools</footer></body></html>`;
const BARE = `<!doctype html><html><head><title>Home</title></head><body><h1>Hello</h1><p>Welcome to my site, it has words on it.</p><footer>© 2019</footer></body></html>`;

const site = createServer((req, res) => {
  const u = new URL(req.url, "http://x").searchParams.get("u") ?? "";
  req.resume();
  const host = (() => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  })();
  if (u.endsWith("/og.png")) return res.writeHead(200, { "content-type": "image/png" }).end(png(1200, 630));
  if (host.startsWith("down-")) return res.writeHead(503).end();
  if (host.startsWith("bare-")) return res.writeHead(200, { "content-type": "text/html" }).end(BARE);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(GOOD(host));
});

let psiCalls = 0;
const psi = createServer((req, res) => {
  psiCalls++;
  req.resume();
  const strategy = new URL(req.url, "http://x").searchParams.get("strategy");
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      lighthouseResult: {
        finalDisplayedUrl: new URL(req.url, "http://x").searchParams.get("url"),
        categories: {
          performance: { score: strategy === "mobile" ? 0.42 : 0.9, auditRefs: [{ id: "render-blocking-insight", group: "insights", weight: 0 }, { id: "largest-contentful-paint", group: "metrics", weight: 25 }] },
          accessibility: { score: 0.85, auditRefs: [{ id: "color-contrast", weight: 7 }] },
          "best-practices": { score: 1, auditRefs: [] },
          seo: { score: 1, auditRefs: [] },
        },
        audits: {
          "largest-contentful-paint": { title: "Largest Contentful Paint", score: 0.3, displayValue: "4.1 s", numericValue: 4100 },
          "render-blocking-insight": { title: "Render-blocking requests", score: 0, scoreDisplayMode: "metricSavings", displayValue: "Est savings of 600 ms", metricSavings: { LCP: 600, FCP: 600 } },
          "color-contrast": { title: "Contrast", score: 0, scoreDisplayMode: "binary" },
          "total-byte-weight": { numericValue: 812345 },
        },
      },
    })
  );
});

before(async () => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => psi.listen(PSI_PORT, "127.0.0.1", r));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
});
after(() => {
  site.close();
  psi.close();
});

async function post(tool, body, { from = ip(), origin = BASE } = {}) {
  const r = await fetch(`${BASE}/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": from, ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const cacheRow = async (k) => (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })).rows[0];
const seenRow = async (url) =>
  (await db.execute({ sql: "SELECT status, source, url FROM discovery_sites WHERE url = ?", args: [url] })).rows[0];

test("the tools refuse another site's form, and say what's wrong with an address", { skip: !enabled }, async () => {
  assert.equal((await post("checklist", { url: "jane.dev" }, { origin: null })).status, 403);
  assert.equal((await post("checklist", { url: "jane.dev" }, { origin: "https://evil.example" })).body.error, "bad_origin");
  const local = await post("share-preview", { url: "http://localhost:3000" });
  assert.equal(local.status, 400);
  assert.match(local.body.message, /checked/);
  assert.doesNotMatch(local.body.message, /graded/);
  assert.equal((await post("speed", { url: "http://10.0.0.1" })).status, 400);
});

test("share preview: the card, the image size, nothing to fix; saved for a day and measured again on request", { skip: !enabled }, async () => {
  const url = `https://share-${RUN}.example.dev/`;
  const a = await post("share-preview", { url: `share-${RUN}.example.dev` });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.url, url);
  assert.equal(a.body.listed, false);
  const s = a.body.share;
  assert.equal(s.ok, true);
  assert.equal(s.card.title, "Jane Tools - Frontend Developer");
  assert.deepEqual([s.card.image.loads, s.card.image.width, s.card.image.height], [true, 1200, 630]);
  assert.equal(s.card.large, true);
  assert.deepEqual(s.issues, []);
  const saved = await cacheRow(`share:${url}`);
  assert.ok(saved, "saved under share:<url>");
  const again = await post("share-preview", { url });
  assert.equal(again.body.share.measuredAt, s.measuredAt, "a second check within the day reuses the result");
  await new Promise((r) => setTimeout(r, 20));
  const fresh = await post("share-preview", { url, fresh: true });
  assert.notEqual(fresh.body.share.measuredAt, s.measuredAt, "fresh measures again");
});

test("share preview: a bare page gets the fixes, the biggest first", { skip: !enabled }, async () => {
  const r = await post("share-preview", { url: `bare-${RUN}.example.dev` });
  assert.equal(r.body.share.ok, true);
  const ids = r.body.share.issues.map((i) => i.id);
  for (const id of ["no_image", "no_description", "no_twitter_card", "no_favicon"]) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.equal(r.body.share.issues[0].level, "fix");
  assert.equal(r.body.share.card.title, "Home");
});

test("checklist: the grader's free checks with a fix each, saved under the grader's own key", { skip: !enabled }, async () => {
  const r = await post("checklist", { url: `bare-check-${RUN}.example.dev` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.checklist.ok, true);
  const by = Object.fromEntries(r.body.checklist.items.map((i) => [i.id, i]));
  assert.equal(by.https.pass, true);
  assert.equal(by.resume.pass, false);
  assert.match(by.resume.tip, /resume/i);
  assert.equal(by.github.pass, false);
  assert.equal(by.fresh_footer.pass, false);
  assert.ok(await cacheRow(`grader:quick:bare-check-${RUN}.example.dev`), "saved as grader:quick:<site key>");
  const good = await post("checklist", { url: `good-check-${RUN}.example.dev` });
  const gby = Object.fromEntries(good.body.checklist.items.map((i) => [i.id, i]));
  assert.deepEqual([gby.resume.pass, gby.github.pass, gby.contact.pass, gby.fresh_footer.pass], [true, true, true, true]);
});

test("a site that can't load: said plainly, nothing saved, not added to PortfolioRank", { skip: !enabled }, async () => {
  const url = `https://down-${RUN}.example.dev/`;
  const r = await post("checklist", { url });
  assert.equal(r.body.checklist.ok, false);
  assert.ok(r.body.checklist.message);
  assert.equal(r.body.discovery, null);
  assert.equal(await seenRow(url), undefined);
});

test("speed: mobile and desktop from PageSpeed, plain fixes, saved where the profile reads it", { skip: !enabled }, async () => {
  const url = `https://speed-${RUN}.example.dev/`;
  psiCalls = 0;
  const r = await post("speed", { url });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(psiCalls, 2);
  assert.equal(r.body.mobile.scores.performance, 42);
  assert.equal(r.body.desktop.scores.performance, 90);
  assert.equal(r.body.mobile.metrics[0].value, "4.1 s");
  assert.deepEqual(
    r.body.mobile.fixes.map((f) => f.id),
    ["render-blocking-insight", "color-contrast"]
  );
  assert.equal(r.body.mobile.weight.bytes, 812345);
  assert.ok(await cacheRow(`psi:${url}`));
  assert.ok(await cacheRow(`psi-desktop:${url}`));
  const again = await post("speed", { url });
  assert.equal(psiCalls, 2, "a second check within the day costs nothing");
  assert.equal(again.body.mobile.measuredAt, r.body.mobile.measuredAt);
});

test("a listed portfolio is refreshed in place: its profile's Lighthouse, no discovery row", { skip: !enabled }, async () => {
  const listed = feed[205].url;
  const u = new URL(listed);
  const typed = `www.${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}/`;
  const r = await post("speed", { url: typed, fresh: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.listed, true);
  assert.equal(r.body.url, listed);
  assert.equal(r.body.profile, `/p/${encodeURIComponent(listed)}`);
  assert.equal(r.body.discovery, null);
  const profile = await (await fetch(`${BASE}/api/psi?url=${encodeURIComponent(listed)}`)).json();
  assert.equal(profile.scores.performance, 42, "the profile reads what the tool saved");
});

test("an unlisted site that loads joins the discovery seen-set as pending, once", { skip: !enabled }, async () => {
  const url = `https://seen-${RUN}.example.dev/`;
  const a = await post("share-preview", { url });
  assert.deepEqual(a.body.discovery, { status: "pending", added: true });
  const b = await post("checklist", { url });
  assert.deepEqual(b.body.discovery, { status: "pending", added: false });
  const row = await seenRow(url);
  assert.deepEqual([row.status, row.source, row.url], ["pending", "tools", url]);
  const n = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM discovery_sites WHERE url = ?", args: [url] })).rows[0].n;
  assert.equal(Number(n), 1);
});

test("the daily cap: past it a network is refused with the reset time, and nothing runs", { skip: !enabled }, async () => {
  // scripts/test-e2e.sh sets TOOLS_CAPS to 3 speed checks a network.
  const from = ip();
  for (let i = 0; i < 3; i++) assert.equal((await post("speed", { url: `https://cap-${RUN}-${i}.example.dev/` }, { from })).status, 200);
  psiCalls = 0;
  const over = await post("speed", { url: `https://cap-${RUN}-x.example.dev/` }, { from });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "daily_limit");
  assert.equal(over.body.scope, "network");
  assert.ok(Date.parse(over.body.resetAt) > Date.now());
  assert.equal(psiCalls, 0);
  // A result already saved is still free to read past the cap.
  assert.equal((await post("speed", { url: `https://cap-${RUN}-0.example.dev/` }, { from })).status, 200);
});
