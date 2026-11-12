// The content engine's admin API (GET /api/admin/content), end to end
// against the running production build (scripts/test-e2e.sh, which sets
// ADMIN_GITHUB_ID): only that account may read it, and it lists
// drafts with their fact sheet, checks and images, plus the content runs
// and the current CONTENT_MODE ("off" unless set).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { migrate } from "../lib/schema.mjs";
import { recordRun, storePost } from "../lib/content/store.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

const cookieFor = (login, id) => sessionCookie({ id, login });

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

const get = (cookie, q = "") => fetch(`${BASE}/api/admin/content${q}`, { headers: cookie ? { cookie } : {} });

test("admin content API: signed out is 401, any other login is 403, never cached", async () => {
  const anon = await get();
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("cache-control"), "private, no-store");
  const other = await get(await cookieFor("someone-else", 990000002));
  assert.equal(other.status, 403);
});

test("admin content API: drafts with their fact sheet, checks and images; dropped ones on request", async () => {
  await migrate(db);
  const now = Date.now();
  // Post ids are 16 hex digits, like the engine's (the review pages refuse anything else).
  const id = `e2e${now.toString(16)}`.padEnd(16, "0").slice(0, 16);
  const idd = `${id.slice(0, 15)}d`;
  const facts = { kind: "top-grades", facts: [{ id: "f1", label: "Portfolios graded", value: 60, display: "60", query: "portfolios" }], names: [], charts: [], screenshots: [] };
  const post = (pid, status) => ({
    id: pid,
    slug: `e2e-${pid}`,
    kind: "top-grades",
    status,
    title: `E2E draft ${pid}`,
    aiLine: "Written with AI from PortfolioRank data.",
    aiNote: "note",
    body: "> **TL;DR**\n> - We graded 60 portfolios.",
    facts,
    checks: { passed: status !== "dropped", failures: status === "dropped" ? ["numbers: 38%"] : [] },
    images: [{ slot: "hero", kind: "chart", source: "code", licence: "ours", credit: "Chart: PortfolioRank data", alt: "a" }],
    claims: [],
    dataAsOf: new Date(now).toISOString(),
  });
  await storePost(db, post(id, "draft"), { mode: "dry-run", publishAt: null, now });
  await storePost(db, post(idd, "dropped"), { mode: "dry-run", publishAt: null, now });
  await recordRun(db, { night: "2026-11-16", now, step: "draft", mode: "dry-run", status: "ok", kind: "top-grades", postId: id, gemini: 3 });

  const cookie = await cookieFor("e2e-admin", ADMIN_ID);
  const res = await get(cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, "off");
  const mine = body.posts.find((p) => p.id === id);
  assert.ok(mine, "the draft is listed");
  assert.equal(mine.status, "draft");
  assert.equal(mine.facts.facts[0].display, "60");
  assert.equal(mine.images[0].credit, "Chart: PortfolioRank data");
  assert.equal(mine.checks.passed, true);
  assert.ok(!body.posts.some((p) => p.status !== "draft"));
  assert.ok(body.runs.some((r) => r.postId === id && r.gemini === 3));

  const dropped = await (await get(cookie, "?status=dropped")).json();
  assert.ok(dropped.posts.some((p) => p.id === idd && p.checks.failures[0] === "numbers: 38%"));
  assert.equal((await get(cookie, "?status=nope")).status, 400);

  // The review page shows the scorecard and the compare link for another draft on the same story.
  const page = await fetch(`${BASE}/admin/blog/${id}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = (await page.text()).replace(/<!-- -->/g, "");
  assert.match(html, /Scorecard/);
  assert.match(html, /Takeaway in the first 150 words/);
  assert.match(html, new RegExp(`/admin/blog/compare\\?a=${id}&amp;b=${idd}`));
  const cmp = await fetch(`${BASE}/admin/blog/compare?a=${id}&b=${idd}`, { headers: { cookie } });
  assert.equal(cmp.status, 200);
  assert.match(await cmp.text(), /Compare drafts/);
  assert.equal((await fetch(`${BASE}/admin/blog/compare?a=${id}&b=${idd}`)).status, 404);
});

const post = (path, body, { cookie, origin = BASE } = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });

test("admin blog pages: signed out or another login is a 404; the admin sees Write a draft now and the cost panel", async () => {
  const other = await cookieFor("someone-else", 990000002);
  for (const p of ["/admin/blog", "/admin/blog/guidelines", "/admin/blog/compare?a=0000000000000001&b=0000000000000002"]) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 404, p);
    assert.equal((await fetch(`${BASE}${p}`, { headers: { cookie: other } })).status, 404, p);
  }
  const cookie = await cookieFor("e2e-admin", ADMIN_ID);
  const html = (await (await fetch(`${BASE}/admin/blog`, { headers: { cookie } })).text()).replace(/<!-- -->/g, "");
  assert.match(html, /Write a draft now/);
  assert.match(html, /Gemini today/);
  assert.match(html, /Tavily this month/);
  assert.match(html, /Drafts today<\/dt><dd[^>]*>0 of 5/);
  assert.match(html, /What people vote for and against/);
  assert.match((await (await fetch(`${BASE}/admin/blog/guidelines`, { headers: { cookie } })).text()).replace(/<!-- -->/g, ""), /Editor&#x27;s guidelines|Editor's guidelines/);
});

test("write a draft now API: admin and CSRF checked, input bounded, production only; status and costs readable by the admin only", async () => {
  const cookie = await cookieFor("e2e-admin", ADMIN_ID);
  const other = await cookieFor("someone-else", 990000002);
  assert.equal((await post("/api/admin/content/draft", {})).status, 401);
  assert.equal((await post("/api/admin/content/draft", {}, { cookie: other })).status, 403);
  assert.equal((await post("/api/admin/content/draft", {}, { cookie, origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/admin/content/draft", { topic: "x".repeat(300) }, { cookie })).status, 400);
  assert.equal((await post("/api/admin/content/draft", { kind: "model-compare" }, { cookie })).status, 400, "the old dev-meta kind is gone");
  assert.equal((await post("/api/admin/content/draft", { rewriteOf: "0000000000000001", notes: "short" }, { cookie })).status, 400);
  const r = await post("/api/admin/content/draft", { topic: "Hero mistakes" }, { cookie });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "production_only" });
  assert.equal((await fetch(`${BASE}/api/admin/content/draft`)).status, 401);
  const status = await fetch(`${BASE}/api/admin/content/draft`, { headers: { cookie } });
  assert.equal(status.status, 200);
  const s = await status.json();
  assert.deepEqual(s.costs.drafts, { today: 0, cap: 5 });
  assert.equal(s.costs.tavily.weekCap, 50);
  assert.equal((await fetch(`${BASE}/api/admin/content/draft?id=ffffffffffffffff`, { headers: { cookie } })).status, 404);
});

test("guidelines API: admin and CSRF checked; add, edit and remove, bounded", async () => {
  const cookie = await cookieFor("e2e-admin", ADMIN_ID);
  assert.equal((await post("/api/admin/content/guidelines", { op: "add", text: "Lead with the takeaway." })).status, 401);
  assert.equal((await post("/api/admin/content/guidelines", { op: "add", text: "Lead with the takeaway." }, { cookie, origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/admin/content/guidelines", { op: "add", text: "no" }, { cookie })).status, 400);
  assert.equal((await post("/api/admin/content/guidelines", { op: "drop" }, { cookie })).status, 400);
  const added = await post("/api/admin/content/guidelines", { op: "add", text: "Lead with the takeaway." }, { cookie });
  assert.equal(added.status, 200);
  const [g] = (await added.json()).guidelines.filter((x) => x.text === "Lead with the takeaway.");
  assert.equal((await post("/api/admin/content/guidelines", { op: "edit", id: g.id, text: "Lead with the takeaway, early." }, { cookie })).status, 200);
  assert.equal((await post("/api/admin/content/guidelines", { op: "remove", id: g.id }, { cookie })).status, 200);
  assert.equal((await post("/api/admin/content/guidelines", { op: "remove", id: g.id }, { cookie })).status, 404);
});
