// End to end, with "Add your portfolio" on (TOOLS_ENABLED in scripts/test-e2e.sh):
// claiming a portfolio with code the owner deploys (POST /api/owner/verify),
// and the existence check, dedupe and anti-spam limits of POST /api/add.
// The portfolio sites are a local stand-in on the grader's mock port
// (GRADER_TEST_SITE, honoured only in test runs); no request leaves the
// machine, and nothing reaches Gemini.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "@libsql/client";
import { listen } from "./helpers/listen.mjs";
import { sessionCookie } from "./helpers/session.mjs";
import { graderCaps } from "../lib/grader/caps.mjs";
import { seen } from "../lib/discovery/sites.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const MOCK_PORT = Number(process.env.E2E_GRADER_MOCK_PORT ?? 7693);
const db = createClient({ url: DB_URL, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Listed portfolios (data/feed.json) used here only.
const LISTED = "https://yashahire.info";
const LISTED_2 = "https://aakarsh-devhq.vercel.app";
const LISTED_3 = "https://aakashgugilla.is-a.dev";
const PAGES = "https://aahana-surya.github.io";

const PAGE = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Developer portfolio with projects and writing.</p></body></html>`;

// The stand-in internet: one handler per URL, set by each test.
const siteMap = new Map();
// Keys are normalized (a bare host gains its "/"), as a browser would.
const sites = { set: (u, v) => siteMap.set(new URL(u).href, v), get: (u) => siteMap.get(new URL(u).href) };
const asked = [];
let geminiCalls = 0;
let mock;
before(async () => {
  mock = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    req.resume();
    req.on("end", () => {
      if (url.pathname.startsWith("/gemini")) {
        geminiCalls++;
        return res.writeHead(500).end();
      }
      if (url.pathname.startsWith("/github/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ workflow_run_id: 1, html_url: "https://github.test/run/1" }));
      if (url.pathname !== "/site") return res.writeHead(404).end();
      const u = url.searchParams.get("u");
      asked.push(u);
      const hit = sites.get(u) ?? (new URL(u).hostname.endsWith("-own-e2e.dev") && new URL(u).pathname === "/" ? [200, PAGE(new URL(u).hostname)] : null);
      if (!hit) return res.writeHead(404, { "content-type": "text/plain" }).end("not here");
      const [status, body = "", headers = {}] = hit;
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(body);
    });
  });
  await listen(mock, MOCK_PORT);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/leaderboard`)).status < 500) break;
    } catch {}
    await sleep(1000);
  }
});
after(() => mock?.close());

let ipSeq = 1;
async function call(method, p, body, { cookie = "", ip = `198.51.100.${ipSeq++}`, origin = BASE } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { cookie, "cf-connecting-ip": ip, ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const verify = (cookie, url, method) => call("POST", "/api/owner/verify", { url, method }, { cookie });

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------
test("verify: GitHub sign-in and this site's origin are required", async () => {
  assert.equal((await verify("", LISTED, "start")).status, 401);
  const cookie = await sessionCookie({ id: 750000001, login: "own-e2e-a" });
  assert.equal((await call("POST", "/api/owner/verify", { url: LISTED, method: "start" }, { cookie, origin: "https://evil.example" })).status, 403);
  assert.equal((await verify(cookie, "https://not-on-portfoliorank-e2e.dev", "start")).body.error, "unknown_portfolio");
  assert.equal((await verify(cookie, LISTED, "nope")).status, 400);
});

test("verify by file: a token, then one fetch of /portfoliorank-<token>.txt at the root, then the owner's tools unlock", async () => {
  const cookie = await sessionCookie({ id: 750000002, login: "own-e2e-b" });
  const start = await verify(cookie, LISTED, "start");
  assert.equal(start.status, 200);
  const c = start.body.claim;
  assert.equal(c.verified, false);
  assert.match(c.token, /^[A-Za-z0-9_-]{12,64}$/);
  assert.equal(c.file.path, `/portfoliorank-${c.token}.txt`);
  assert.equal(c.file.url, `${LISTED}/portfoliorank-${c.token}.txt`);
  assert.equal(c.meta.tag, `<meta name="portfoliorank-verification" content="${c.token}">`);

  // Not there yet.
  const before = asked.length;
  assert.equal((await verify(cookie, LISTED, "file")).body.reason, "not_found");
  assert.deepEqual(asked.slice(before), [c.file.url], "one fetch, of the file only");
  assert.equal((await call("GET", `/api/recheck?url=${encodeURIComponent(LISTED)}`, undefined, { cookie })).body.owner, false);

  sites.set(c.file.url, [200, `${c.token}\n`, { "content-type": "text/plain" }]);
  const ok = await verify(cookie, LISTED, "file");
  assert.equal(ok.body.claim.verified, true);
  assert.equal(ok.body.claim.method, "file");
  assert.equal((await call("GET", `/api/recheck?url=${encodeURIComponent(LISTED)}`, undefined, { cookie })).body.owner, true);
  // Remove is unlocked (then withdrawn, so the site stays listed for other tests).
  const removed = await call("POST", "/api/owner/actions", { url: LISTED, action: "remove", confirm: true }, { cookie });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.ok(removed.body.state.removeAfter);
  assert.equal((await call("POST", "/api/owner/actions", { url: LISTED, action: "cancel_remove" }, { cookie })).status, 200);
  // Another account is not the owner.
  const other = await sessionCookie({ id: 750000003, login: "own-e2e-c" });
  assert.equal((await call("GET", `/api/recheck?url=${encodeURIComponent(LISTED)}`, undefined, { cookie: other })).body.owner, false);
  assert.equal((await call("POST", "/api/owner/actions", { url: LISTED, action: "hide_grade" }, { cookie: other })).status, 403);
});

test("verify by meta tag: the claim's own token on the home page; a redirect to another site proves nothing", async () => {
  const cookie = await sessionCookie({ id: 750000004, login: "own-e2e-d" });
  const c = (await verify(cookie, LISTED_2, "start")).body.claim;
  sites.set(LISTED_2, [200, `<head><meta name="portfoliorank-verification" content="someone-elses-token-99"></head>`]);
  assert.equal((await verify(cookie, LISTED_2, "meta")).body.reason, "not_found");
  sites.set(LISTED_2, [302, "", { location: "https://elsewhere-e2e.example/" }]);
  sites.set("https://elsewhere-e2e.example/", [200, c.meta.tag]);
  const before = asked.length;
  assert.equal((await verify(cookie, LISTED_2, "meta")).body.reason, "off_site");
  assert.ok(!asked.slice(before).includes("https://elsewhere-e2e.example/"), "the other site is never fetched");
  sites.set(LISTED_2, [301, "", { location: `${LISTED_2.replace("https://", "https://www.")}/` }]);
  sites.set(`${LISTED_2.replace("https://", "https://www.")}/`, [200, `<html><head>${c.meta.tag}</head><body>Hi</body></html>`]);
  const ok = await verify(cookie, LISTED_2, "meta");
  assert.equal(ok.body.claim.verified, true);
  assert.equal(ok.body.claim.method, "meta");
});

test("verify: at most 5 tries an hour per account", async () => {
  const cookie = await sessionCookie({ id: 750000005, login: "own-e2e-e" });
  await verify(cookie, LISTED_3, "start");
  for (let i = 0; i < 5; i++) assert.equal((await verify(cookie, LISTED_3, i % 2 ? "meta" : "file")).status, 200);
  const sixth = await verify(cookie, LISTED_3, "file");
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, "rate_limited");
});

test("verify: your own GitHub Pages site is verified at once, with no fetch", async () => {
  const before = asked.length;
  const owner = await sessionCookie({ id: 750000006, login: "aahana-surya" });
  const r = await verify(owner, PAGES, "start");
  assert.equal(r.body.claim.verified, true);
  assert.equal(r.body.claim.method, "github_pages");
  assert.equal(asked.length, before, "nothing fetched");
  // Someone else's github.io is not theirs.
  const stranger = await sessionCookie({ id: 750000007, login: "own-e2e-f" });
  assert.equal((await verify(stranger, PAGES, "start")).body.claim.verified, false);
});

test("a claim proven only by a link to a GitHub profile no longer unlocks the owner's tools", async () => {
  const id = "gh:750000008";
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO claims (url, owner, login, status, method, token, created_at, updated_at) VALUES (?, ?, 'own-e2e-g', 'verified', 'github_link', 'linkonlytoken1234', ?, ?)",
    args: [LISTED_3, id, now, now],
  });
  const cookie = await sessionCookie({ id: 750000008, login: "own-e2e-g" });
  assert.equal((await call("GET", `/api/recheck?url=${encodeURIComponent(LISTED_3)}`, undefined, { cookie })).body.owner, false);
  assert.equal((await call("POST", "/api/owner/actions", { url: LISTED_3, action: "remove", confirm: true }, { cookie })).status, 403);
});

// ---------------------------------------------------------------------------
// Adding a portfolio
// ---------------------------------------------------------------------------
const add = (url, opts = {}) => call("POST", "/api/add", { url }, opts);

test("add: a listed site says so with its profile, and runs nothing", async () => {
  const before = asked.length;
  const r = await add(LISTED.replace("https://", "https://www.") + "/");
  assert.equal(r.status, 200);
  assert.equal(r.body.already, "listed");
  assert.equal(r.body.path, `/p/${encodeURIComponent(LISTED)}`);
  assert.equal(asked.length, before);
});

test("add: a site must answer 200 with HTML that isn't parked; nothing is added otherwise", async () => {
  sites.set("https://parked-own-e2e.dev/", [200, "<title>parked-own-e2e.dev</title><h1>This domain is for sale</h1>"]);
  sites.set("https://gone-own-e2e.dev/", [404, "gone"]);
  const ip = "198.51.100.200";
  for (const [url, error] of [
    ["parked-own-e2e.dev", "parked"],
    ["gone-own-e2e.dev", "not_ok"],
  ]) {
    const r = await add(url, { ip });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error, error);
    assert.ok(r.body.message);
    assert.equal(await seen(db, `https://${url}`), null, "not added");
  }
});

test("add: 5 a day per address signed out, 25 per account signed in", async () => {
  sites.set("https://parked2-own-e2e.dev/", [200, "<h1>Buy this domain</h1>"]);
  const ip = "198.51.100.201";
  for (let i = 0; i < 5; i++) assert.equal((await add("parked2-own-e2e.dev", { ip })).status, 422);
  const sixth = await add("parked2-own-e2e.dev", { ip });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, "add_limit");
  assert.match(sixth.body.message, /Sign in/);
  assert.equal((await add("parked2-own-e2e.dev", { ip: "198.51.100.202" })).status, 422, "another address has its own day");

  const cookie = await sessionCookie({ id: 750000009, login: "own-e2e-h" });
  for (let i = 0; i < 25; i++) assert.equal((await add("parked2-own-e2e.dev", { cookie, ip })).status, 422, `add ${i + 1}`);
  assert.equal((await add("parked2-own-e2e.dev", { cookie, ip: "198.51.100.203" })).body.error, "add_limit", "per account, whatever the address");
});

test("add: a burst of real sites is added, but grades stay inside the grader's caps and nothing calls Gemini", async () => {
  const caps = graderCaps(process.env.GRADER_CAPS);
  const cookie = await sessionCookie({ id: 750000010, login: "own-e2e-i" });
  const ip = "198.51.100.210";
  const results = [];
  for (let i = 0; i < caps.visitor + 3; i++) {
    const r = await add(`burst${i}-own-e2e.dev`, { cookie, ip });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    results.push(r.body);
  }
  const started = results.filter((b) => ["capturing", "waiting"].includes(b.grade?.status));
  assert.ok(started.length <= caps.visitor, `${started.length} grades started, cap ${caps.visitor}`);
  assert.ok(results.some((b) => b.grade?.status === "daily_limit"), "past the cap, grades are refused, not queued");
  for (let i = 0; i < results.length; i++) assert.equal((await seen(db, `https://burst${i}-own-e2e.dev`))?.status, "pending", "every site is added");
  assert.equal(geminiCalls, 0);
  // Added once: the second time says so.
  const again = await add("burst0-own-e2e.dev", { cookie, ip });
  assert.equal(again.body.already, "added");
});
