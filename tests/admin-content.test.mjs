// The content engine's admin API (GET /api/admin/content), end to end
// against the running production build (scripts/test-e2e.sh, which sets
// ADMIN_GITHUB_LOGIN=e2e-admin): only that login may read it, and it lists
// drafts with their fact sheet, checks and images, plus the content runs
// and the current CONTENT_MODE ("off" unless set).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";
import { migrate } from "../lib/schema.mjs";
import { recordRun, storePost } from "../lib/content/store.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

async function cookieFor(login, id) {
  const token = await encode({ token: { raterId: `gh:${id}`, login, sub: String(id) }, secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600 });
  return `authjs.session-token=${token}`;
}

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
  const id = `e2e${now.toString(16)}`.slice(0, 16);
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
  await storePost(db, post(`${id}d`, "dropped"), { mode: "dry-run", publishAt: null, now });
  await recordRun(db, { night: "2026-11-16", now, step: "draft", mode: "dry-run", status: "ok", kind: "top-grades", postId: id, gemini: 3 });

  const cookie = await cookieFor("e2e-admin", 990000003);
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
  assert.ok(dropped.posts.some((p) => p.id === `${id}d` && p.checks.failures[0] === "numbers: 38%"));
  assert.equal((await get(cookie, "?status=nope")).status, 400);
});
