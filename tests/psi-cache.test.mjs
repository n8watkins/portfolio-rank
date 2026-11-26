// /api/psi end to end: it is a pure read. A page view, with or without any
// header, never measures: it returns what is stored or "not_measured", never
// calls PageSpeed, never takes a lease and never waits. The measuring is the
// daily prewarm job's, direct from its runner (tests/prewarm.test.mjs,
// tests/psi-job.test.mjs). The app (started by scripts/test-e2e.sh with
// PSI_API_BASE pointed here) has a local stand-in for Google PageSpeed that
// counts its calls: the tests assert it is never called. /api/inspect keeps
// its stale-while-revalidate (one test below).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { listen } from "./helpers/listen.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { INTERNAL_TOKEN_HEADER, REVALIDATE_PROFILES, internalToken } from "../lib/internal-token.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
// Shares the server's SQLite file: wait for its locks instead of SQLITE_BUSY.
const db = createClient({ url: process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/e2e.db`, timeout: 10000 });
const PSI_PORT = Number(process.env.E2E_PSI_PORT ?? 7692);
const SLOW_MS = 1500;
const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
const lighthouse = (perf) => ({
  lighthouseResult: {
    categories: { performance: { score: perf }, accessibility: { score: 0.9 }, "best-practices": { score: 0.8 }, seo: { score: 1 } },
    audits: {},
  },
});
const perf = 0.5;
const psi = createServer(async (_req, res) => {
  calls++;
  await sleep(SLOW_MS);
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
const row = async (kind, url) =>
  (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [`${kind}:${url}`] })).rows[0];
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

test("no header changes it: even a valid internal token only reads", async () => {
  const url = feed[103].url;
  await clean(url);
  calls = 0;
  const other = await internalToken(process.env.AUTH_SECRET ?? "", REVALIDATE_PROFILES);
  for (const headers of [{}, { [INTERNAL_TOKEN_HEADER]: "" }, { [INTERNAL_TOKEN_HEADER]: "nope" }, { [INTERNAL_TOKEN_HEADER]: other }, { "x-portfoliorank-internal": other, authorization: "Bearer x" }]) {
    const h = await get("psi", url, headers);
    assert.equal(h.body.error, "not_measured");
    assert.ok(h.ms < 1000);
  }
  const wait = await fetch(`${BASE}/api/psi?url=${encodeURIComponent(url)}&wait=1`);
  assert.equal((await wait.json()).error, "not_measured", "there is no measure-and-wait mode");
  await sleep(SLOW_MS + 500);
  assert.equal(calls, 0);
  assert.equal(await row("psi", url), undefined);
  assert.equal(await row("psi-desktop", url), undefined);
  assert.equal(await row("lease:psi", url), undefined);
});

test("a view while a lease is held still just reads", async () => {
  const url = feed[104].url;
  await clean(url);
  await seedPsi(url, Date.now() - DAY, 0.7);
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, '', ?)", args: [`lease:psi:${url}`, Date.now()] });
  calls = 0;
  const h = await get("psi", url);
  assert.equal(h.body.scores.performance, 70);
  assert.equal(calls, 0);
  await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`lease:psi:${url}`] });
});

test("a site the health check found dead is never shown, and nothing is measured", async () => {
  const url = feed[109].url;
  await clean(url);
  await db.execute({ sql: "INSERT OR REPLACE INTO portfolios (url, status) VALUES (?, 'dead')", args: [url] });
  calls = 0;
  assert.equal((await get("psi", url)).body.error, "site_down");
  assert.equal(calls, 0);
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [url] });
});

test("an address that is not on the roster is refused", async () => {
  const r = await get("psi", "https://not-listed.example/");
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
