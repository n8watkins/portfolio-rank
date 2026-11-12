// Stale-while-revalidate for /api/psi and /api/inspect, end to end: the app
// (started by scripts/test-e2e.sh with PSI_API_BASE pointed here) calls a local
// stand-in for Google PageSpeed that answers slowly and counts its calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
// Shares the server's SQLite file: wait for its locks instead of SQLITE_BUSY.
const db = createClient({ url: process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/e2e.db`, timeout: 10000 });
const PSI_PORT = Number(process.env.E2E_PSI_PORT ?? 7692);
const SLOW_MS = 2500;
const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
let failNext = false;
const lighthouse = (perf) => ({
  lighthouseResult: {
    categories: { performance: { score: perf }, accessibility: { score: 0.9 }, "best-practices": { score: 0.8 }, seo: { score: 1 } },
    audits: {},
  },
});
let perf = 0.5;
const psi = createServer(async (_req, res) => {
  calls++;
  await sleep(SLOW_MS);
  if (failNext) { res.writeHead(500, { "content-type": "application/json" }); return res.end("{}"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(lighthouse(perf)));
});

before(async () => {
  await new Promise((r) => psi.listen(PSI_PORT, "127.0.0.1", r));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/rank")).ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error(`no server at ${BASE}`);
});
after(() => psi.close());

async function get(kind, url) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/${kind}?url=${encodeURIComponent(url)}`);
  return { ms: Date.now() - t, body: await r.json() };
}
const age = async (kind, url, ms) =>
  db.execute({ sql: "UPDATE cache SET at = ? WHERE k = ?", args: [Date.now() - ms, `${kind}:${url}`] });
const row = async (kind, url) =>
  (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [`${kind}:${url}`] })).rows[0];
// Each test starts from no cached result and no lease for its site. Earlier
// test files share this database and server: the browser tests open pages
// whose diagnostics ask /api/psi for whatever sites they show, and with no
// PageSpeed stand-in running then, a failure is cached for an hour.
const clean = async (url) => {
  await db.execute({ sql: "DELETE FROM cache WHERE k IN (?, ?, ?, ?)", args: [`psi:${url}`, `inspect:${url}`, `lease:psi:${url}`, `lease:inspect:${url}`] });
  await db.execute({ sql: "DELETE FROM site_freshness WHERE url = ?", args: [url] });
};
const seedPsi = (url, at, perf = 0.5) =>
  db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [`psi:${url}`, JSON.stringify({ ok: true, scores: { performance: Math.round(perf * 100) }, metrics: [] }), at] });
const page = (url, cols) =>
  db.execute({
    sql: `INSERT INTO site_freshness (url, hash, checked_at, changed_at, forced_at) VALUES (?, 'h', ?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET checked_at = excluded.checked_at, changed_at = excluded.changed_at, forced_at = excluded.forced_at`,
    args: [url, cols.checked ?? null, cols.changed ?? null, cols.forced ?? null],
  });

test("only the first request for a never-measured site waits", async () => {
  const url = feed[100].url;
  await clean(url);
  calls = 0;
  const first = await get("psi", url);
  assert.ok(first.ms >= SLOW_MS - 100, `first fill took ${first.ms}ms: ${JSON.stringify(first.body)}`);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.scores.performance, 50);
  assert.ok(first.body.measuredAt);
  assert.equal(first.body.stale, undefined);
  const second = await get("psi", url);
  assert.ok(second.ms < 1000, `cached hit took ${second.ms}ms`);
  assert.equal(calls, 1);
});

test("a stale result returns at once, and concurrent requests schedule one refresh", async () => {
  const url = feed[101].url;
  await clean(url);
  perf = 0.5;
  await get("psi", url);
  await age("psi", url, 91 * DAY);
  const oldAt = Number((await row("psi", url)).at);
  calls = 0;
  perf = 0.7;

  const hits = await Promise.all(Array.from({ length: 5 }, () => get("psi", url)));
  for (const h of hits) {
    assert.ok(h.ms < 1000, `stale hit took ${h.ms}ms`);
    assert.equal(h.body.stale, true);
    assert.equal(h.body.scores.performance, 50);
    assert.equal(h.body.measuredAt, new Date(oldAt).toISOString());
  }
  await sleep(SLOW_MS + 1500);
  assert.equal(calls, 1, `expected one refresh, saw ${calls}`);
  const fresh = await get("psi", url);
  assert.equal(fresh.body.stale, undefined);
  assert.equal(fresh.body.scores.performance, 70);
  assert.ok(Date.parse(fresh.body.measuredAt) > oldAt);
});

test("a failed refresh keeps the old result and is not retried on every request", async () => {
  const url = feed[102].url;
  await clean(url);
  perf = 0.4;
  await get("psi", url);
  await age("psi", url, 91 * DAY);
  calls = 0;
  failNext = true;
  try {
    await get("psi", url);
    await sleep(SLOW_MS + 1500);
    for (let i = 0; i < 3; i++) {
      const h = await get("psi", url);
      assert.equal(h.body.ok, true);
      assert.equal(h.body.stale, true);
      assert.equal(h.body.scores.performance, 40);
    }
    await sleep(500);
    assert.equal(calls, 1);
  } finally {
    failNext = false;
  }
});

test("a stale inspection returns at once too", async () => {
  const url = feed[103].url;
  await clean(url);
  await db.execute({
    sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
    args: [`inspect:${url}`, JSON.stringify({ ok: true, https: true, title: "seeded" }), Date.now() - 31 * DAY],
  });
  const h = await get("inspect", url);
  assert.ok(h.ms < 1000, `stale inspect took ${h.ms}ms`);
  assert.equal(h.body.stale, true);
  assert.equal(h.body.title, "seeded");
});

test("a failed PageSpeed run is cached for an hour, then retried", async () => {
  const url = feed[104].url;
  await clean(url);
  calls = 0;
  failNext = true;
  try {
    const first = await get("psi", url);
    assert.equal(first.body.ok, false);
    for (let i = 0; i < 3; i++) assert.equal((await get("psi", url)).body.ok, false);
    assert.equal(calls, 1, "a failure was asked again within the hour");
  } finally {
    failNext = false;
  }
  await age("psi", url, 61 * 60 * 1000);
  const stale = await get("psi", url);
  assert.equal(stale.body.stale, true);
  await sleep(SLOW_MS + 1500);
  assert.equal(calls, 2);
  // The retry succeeded, so the good result replaced the failure.
  assert.equal((await get("psi", url)).body.ok, true);
});

test("a miss while another isolate holds the lease answers in_progress without calling PageSpeed", async () => {
  const url = feed[105].url;
  await clean(url);
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, '', ?)", args: [`lease:psi:${url}`, Date.now()] });
  calls = 0;
  const h = await get("psi", url);
  assert.ok(h.ms < 1000, `took ${h.ms}ms`);
  assert.equal(h.body.error, "in_progress");
  assert.equal(calls, 0);
  await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`lease:psi:${url}`] });
});

test("a site the health check found dead is never sent to PageSpeed", async () => {
  const url = feed[106].url;
  await clean(url);
  await db.execute({
    sql: "INSERT OR REPLACE INTO portfolios (url, status) VALUES (?, 'dead')",
    args: [url],
  });
  calls = 0;
  const h = await get("psi", url);
  assert.equal(h.body.error, "site_down");
  assert.equal(calls, 0);
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [url] });
});

test("an unchanged site reuses a 40-day-old result and says it is unchanged since", async () => {
  const url = feed[107].url;
  await clean(url);
  const at = Date.now() - 40 * DAY;
  await seedPsi(url, at, 0.6);
  await page(url, { checked: Date.now() - DAY });
  calls = 0;
  const h = await get("psi", url);
  assert.equal(h.body.stale, undefined);
  assert.equal(h.body.scores.performance, 60);
  assert.equal(h.body.measuredAt, new Date(at).toISOString());
  assert.ok(Date.parse(h.body.unchangedSince) > at, "a check after the measurement found no change");
  await sleep(300);
  assert.equal(calls, 0, "nothing re-ran");
});

test("a changed site is re-measured: the old result at once, with the reason, and one refresh", async () => {
  const url = feed[108].url;
  await clean(url);
  await seedPsi(url, Date.now() - 5 * DAY, 0.5);
  await page(url, { checked: Date.now() - DAY, changed: Date.now() - DAY });
  calls = 0;
  perf = 0.8;
  const h = await get("psi", url);
  assert.equal(h.body.stale, true);
  assert.equal(h.body.staleReason, "changed");
  assert.equal(h.body.scores.performance, 50);
  await sleep(SLOW_MS + 1500);
  assert.equal(calls, 1);
  const fresh = await get("psi", url);
  assert.equal(fresh.body.stale, undefined);
  assert.equal(fresh.body.scores.performance, 80);
  perf = 0.5;
});

test("the admin's Re-measure makes Lighthouse run again; nobody else may ask", async () => {
  const url = feed[109].url;
  await clean(url);
  await seedPsi(url, Date.now() - 2 * DAY, 0.5);
  const post = (headers, body = { url }) =>
    fetch(`${BASE}/api/admin/remeasure`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...headers }, body: JSON.stringify(body) });
  const admin = { cookie: await sessionCookie({ id: ADMIN_ID, login: "owner" }) };
  assert.equal((await post({})).status, 401, "signed out");
  assert.equal((await post({ cookie: await sessionCookie({ id: 990000123, login: "someone" }) })).status, 403, "not the admin");
  assert.equal((await post({ ...admin, origin: "https://evil.example" })).status, 403, "another site");
  assert.equal((await post(admin, { url: "https://not-listed.example" })).status, 404);
  calls = 0;
  const r = await post(admin);
  assert.equal(r.status, 200);
  const { forcedAt } = await r.json();
  assert.ok(Date.parse(forcedAt) > Date.now() - 60000);
  const state = await (await fetch(`${BASE}/api/admin/remeasure?url=${encodeURIComponent(url)}`, { headers: admin })).json();
  assert.equal(state.forcedAt, forcedAt);
  const h = await get("psi", url);
  assert.equal(h.body.stale, true);
  assert.equal(h.body.staleReason, "forced");
  await sleep(SLOW_MS + 1500);
  assert.equal(calls, 1);
  assert.equal((await get("psi", url)).body.stale, undefined);
});

test("?cached=1 never runs PageSpeed, and says when a stored result is due by the change rule", async () => {
  const url = feed[110].url;
  await clean(url);
  calls = 0;
  assert.equal((await get("psi", `${url}&cached=1`)).body.error, "unknown_url", "the flag is a separate parameter");
  const peek = async () => (await (await fetch(`${BASE}/api/psi?url=${encodeURIComponent(url)}&cached=1`)).json());
  assert.equal((await peek()).error, "not_measured");
  await seedPsi(url, Date.now() - 40 * DAY, 0.6);
  await page(url, { checked: Date.now() - DAY });
  const unchanged = await peek();
  assert.equal(unchanged.scores.performance, 60);
  assert.equal(unchanged.stale, undefined);
  assert.ok(unchanged.unchangedSince);
  await page(url, { checked: Date.now() - DAY, changed: Date.now() - DAY });
  const changed = await peek();
  assert.deepEqual([changed.stale, changed.staleReason], [true, "changed"]);
  await sleep(300);
  assert.equal(calls, 0, "a cached-only read never measures");
});

test("desktop is measured and stored apart from mobile, and cached=1 reads it without measuring", async () => {
  const url = feed[111].url;
  await clean(url);
  await db.execute({ sql: "DELETE FROM cache WHERE k IN (?, ?)", args: [`psi-desktop:${url}`, `lease:psi-desktop:${url}`] });
  calls = 0;
  const q = (extra) => fetch(`${BASE}/api/psi?url=${encodeURIComponent(url)}${extra}`).then((r) => r.json());
  // Play reads the stored result first: a miss says so and spends nothing.
  assert.equal((await q("&cached=1")).error, "not_measured");
  assert.equal((await q("&strategy=desktop&cached=1")).error, "not_measured");
  assert.equal(calls, 0);
  // Measuring desktop fills only the desktop entry.
  perf = 0.9;
  const desktop = await q("&strategy=desktop");
  assert.equal(desktop.ok, true);
  assert.equal(desktop.scores.performance, 90);
  assert.equal(calls, 1);
  assert.equal((await q("&strategy=desktop&cached=1")).scores.performance, 90);
  assert.equal((await q("&cached=1")).error, "not_measured");
  assert.ok(await row("psi-desktop", url));
  assert.equal(calls, 1);
  await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`psi-desktop:${url}`] });
});
