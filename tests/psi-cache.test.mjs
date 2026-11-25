// /api/psi end to end: a page view never measures; only a request with the
// internal token (the daily prewarm job) does, and it waits for the answer.
// The app (started by scripts/test-e2e.sh with PSI_API_BASE pointed here)
// calls a local stand-in for Google PageSpeed that answers slowly and counts
// its calls. /api/inspect keeps its stale-while-revalidate (one test below).
//
// Against `next start` nothing is cut off after the response, which the
// deployed Worker does after about 30 seconds (waitUntil). So these tests
// assert what a view must never do (call PageSpeed, hold a lease) and what the
// token path must have finished before it answers (the results stored, the
// lease gone), not how long background work may live.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { listen } from "./helpers/listen.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { INTERNAL_TOKEN_HEADER, MEASURE_PSI, REVALIDATE_PROFILES, internalToken } from "../lib/internal-token.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
// Shares the server's SQLite file: wait for its locks instead of SQLITE_BUSY.
const db = createClient({ url: process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/e2e.db`, timeout: 10000 });
const PSI_PORT = Number(process.env.E2E_PSI_PORT ?? 7692);
const SLOW_MS = 1500;
// A measure is two runs a phone and two on desktop, the devices side by side (the run gap is 0 here: scripts/test-e2e.sh).
const RUNS = 4;
const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = await internalToken(process.env.AUTH_SECRET ?? "", MEASURE_PSI);

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
  await listen(psi, PSI_PORT);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/rank")).ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error(`no server at ${BASE}`);
});
after(() => psi.close());

async function get(kind, url, headers = {}) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/${kind}?url=${encodeURIComponent(url)}`, { headers });
  return { ms: Date.now() - t, status: r.status, body: await r.json() };
}
const measure = (url) => get("psi", url, { [INTERNAL_TOKEN_HEADER]: TOKEN });
const row = async (kind, url) =>
  (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [`${kind}:${url}`] })).rows[0];
const callsToday = async () => Number((await db.execute("SELECT COALESCE(SUM(n), 0) AS n FROM psi_calls")).rows[0].n);
// Each test starts from no cached result and no lease for its site. Earlier
// test files share this database and server.
const clean = async (url) => {
  await db.execute({ sql: "DELETE FROM cache WHERE k IN (?, ?, ?, ?, ?)", args: [`psi:${url}`, `psi-desktop:${url}`, `inspect:${url}`, `lease:psi:${url}`, `lease:inspect:${url}`] });
  await db.execute({ sql: "DELETE FROM site_freshness WHERE url = ?", args: [url] });
};
// A result of the current method (two runs); `runs: null` seeds an old row, stored before runs were counted.
const seedPsi = (url, at, perf = 0.5, { runs = 2, key = "psi" } = {}) =>
  db.execute({
    sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
    args: [`${key}:${url}`, JSON.stringify({ ok: true, scores: { performance: Math.round(perf * 100) }, metrics: [], ...(runs ? { runs, runsAttempted: runs } : {}) }), at],
  });

test("a view of a never-measured site says so at once and never calls PageSpeed", async () => {
  const url = feed[100].url;
  await clean(url);
  calls = 0;
  const h = await get("psi", url);
  assert.ok(h.ms < 1000, `took ${h.ms}ms`);
  assert.deepEqual(h.body, { ok: false, error: "not_measured" });
  await sleep(SLOW_MS + 1000);
  assert.equal(calls, 0);
  assert.equal(await row("psi", url), undefined, "nothing stored");
  assert.equal(await row("lease:psi", url), undefined, "no lease taken");
});

test("a view returns what is stored as it is, however old: an old row reads as one run, nothing runs behind it", async () => {
  const url = feed[101].url;
  await clean(url);
  // A row from before two runs a device, 120 days old (past the 90 days the daily job re-measures at).
  const at = Date.now() - 120 * DAY;
  await seedPsi(url, at, 0.5, { runs: null });
  calls = 0;
  const hits = await Promise.all(Array.from({ length: 5 }, () => get("psi", url)));
  for (const h of hits) {
    assert.ok(h.ms < 1000, `took ${h.ms}ms`);
    assert.equal(h.body.ok, true);
    assert.equal(h.body.scores.performance, 50);
    assert.equal(h.body.runs, undefined, "the old row is one run: no run count stored, the reader treats it as 1");
    assert.equal(h.body.measuredAt, new Date(at).toISOString());
    assert.equal(h.body.stale, undefined);
  }
  await sleep(SLOW_MS + 1000);
  assert.equal(calls, 0);
  assert.equal(await row("lease:psi", url), undefined);
});

test("a stored failure is returned too, and a view does not retry it", async () => {
  const url = feed[102].url;
  await clean(url);
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [`psi:${url}`, JSON.stringify({ ok: false, error: "unreachable" }), Date.now() - 3 * 3600 * 1000] });
  calls = 0;
  const h = await get("psi", url);
  assert.equal(h.body.ok, false);
  assert.equal(h.body.error, "unreachable");
  await sleep(SLOW_MS + 500);
  assert.equal(calls, 0);
});

test("without the token, or with a wrong one, the request is only a view", async () => {
  const url = feed[103].url;
  await clean(url);
  calls = 0;
  for (const headers of [{}, { [INTERNAL_TOKEN_HEADER]: "" }, { [INTERNAL_TOKEN_HEADER]: "nope" }, { [INTERNAL_TOKEN_HEADER]: await internalToken(process.env.AUTH_SECRET ?? "", REVALIDATE_PROFILES) }]) {
    const h = await get("psi", url, headers);
    assert.equal(h.body.error, "not_measured");
    assert.ok(h.ms < 1000);
  }
  await sleep(SLOW_MS + 500);
  assert.equal(calls, 0);
  assert.equal(await row("psi", url), undefined);
});

test("with the token a measure is four runs, finished and stored before the answer: phone average, desktop average, the lease released", async () => {
  const url = feed[104].url;
  await clean(url);
  perf = 0.6;
  calls = 0;
  const before = await callsToday();
  const r = await measure(url);
  assert.ok(r.ms >= SLOW_MS - 100, `took ${r.ms}ms: it waited for the runs`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.measured, true);
  assert.equal(r.body.runs, 2);
  assert.equal(r.body.runsAttempted, 2);
  assert.deepEqual(r.body.runScores, [60, 60]);
  assert.equal(r.body.strategy, "mobile");
  assert.ok(Date.parse(r.body.ranAt) > Date.now() - 60000);
  assert.equal(calls, RUNS, "two phone runs and two desktop runs");
  // Everything is already stored when the answer arrives.
  const phone = JSON.parse((await row("psi", url)).v);
  const desktop = JSON.parse((await row("psi-desktop", url)).v);
  assert.equal(phone.runs, 2);
  assert.equal(desktop.strategy, "desktop");
  assert.equal(desktop.runs, 2);
  assert.equal(desktop.scores.performance, 60);
  assert.equal(await row("lease:psi", url), undefined, "the lease is released");
  assert.equal((await callsToday()) - before, RUNS, "the admin counter counts calls made");
  // A view now returns it.
  const view = await get("psi", url);
  assert.equal(view.body.runs, 2);
  assert.equal(view.body.measured, undefined);
  assert.equal(view.body.scores.performance, 60);
  assert.equal(calls, RUNS);
});

test("the token path measures again whatever is stored (the queue decides what is due)", async () => {
  const url = feed[105].url;
  await clean(url);
  perf = 0.9;
  await seedPsi(url, Date.now() - DAY, 0.5);
  calls = 0;
  const r = await measure(url);
  assert.equal(r.body.measured, true);
  assert.equal(r.body.scores.performance, 90);
  assert.equal(calls, RUNS);
});

test("a measure while another holds the site answers in_progress and calls nothing", async () => {
  const url = feed[106].url;
  await clean(url);
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, '', ?)", args: [`lease:psi:${url}`, Date.now()] });
  calls = 0;
  const r = await measure(url);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, "in_progress");
  assert.equal(calls, 0);
  assert.ok(await row("lease:psi", url), "the other's lease is left alone");
  await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`lease:psi:${url}`] });
});

test("a failed measure says why, keeps a good stored result, and releases the lease", async () => {
  const url = feed[107].url;
  await clean(url);
  const at = Date.now() - 100 * DAY;
  await seedPsi(url, at, 0.4);
  await seedPsi(url, at, 0.4, { key: "psi-desktop" });
  calls = 0;
  failNext = true;
  try {
    const r = await measure(url);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "unreachable");
    assert.equal(r.body.measured, undefined);
    assert.equal(calls, RUNS);
  } finally {
    failNext = false;
  }
  const kept = JSON.parse((await row("psi", url)).v);
  assert.equal(kept.ok, true);
  assert.equal(kept.scores.performance, 40);
  assert.equal(Number((await row("psi", url)).at), at, "not replaced");
  assert.equal(JSON.parse((await row("psi-desktop", url)).v).ok, true);
  assert.equal(await row("lease:psi", url), undefined);
});

test("a failed first measure is stored, so a view can say why", async () => {
  const url = feed[108].url;
  await clean(url);
  failNext = true;
  try {
    assert.equal((await measure(url)).body.ok, false);
  } finally {
    failNext = false;
  }
  const h = await get("psi", url);
  assert.equal(h.body.ok, false);
  assert.equal(h.body.error, "unreachable");
});

test("a site the health check found dead is never sent to PageSpeed, token or not", async () => {
  const url = feed[109].url;
  await clean(url);
  await db.execute({ sql: "INSERT OR REPLACE INTO portfolios (url, status) VALUES (?, 'dead')", args: [url] });
  calls = 0;
  assert.equal((await get("psi", url)).body.error, "site_down");
  assert.equal((await measure(url)).body.error, "site_down");
  assert.equal(calls, 0);
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [url] });
});

test("an address that is not on the roster is refused, token or not", async () => {
  const r = await measure("https://not-listed.example/");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "unknown_url");
});

test("a stale inspection still returns at once and refreshes behind", async () => {
  const url = feed[110].url;
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

test("the admin's Re-measure only asks: nobody else may, and no view runs Lighthouse for it", async () => {
  const url = feed[111].url;
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
  assert.equal(h.body.scores.performance, 50, "the view still shows what is stored");
  await sleep(SLOW_MS + 500);
  assert.equal(calls, 0, "the next daily job measures it (tests/prewarm.test.mjs), not a view");
});
