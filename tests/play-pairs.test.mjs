// The face-off shows only graded portfolios (owner, 2026-11-12): every pair
// /api/rank draws is from the graded library (lib/grader/report.mjs
// gradedPool), never a listed site we haven't graded.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const db = createClient({ url: process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/e2e.db`, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`no server at ${BASE}`);
});

const gradedUrls = async () =>
  new Set(
    (await db.execute("SELECT url FROM portfolios WHERE json_valid(ai_rubric) AND json_extract(ai_rubric, '$.tier') IS NOT NULL")).rows.map((r) => String(r.url))
  );

test("every face-off pair is two graded portfolios", async () => {
  const graded = await gradedUrls();
  // Most of the roster is ungraded in the test database: a draw from it would show up here.
  assert.ok(graded.size < feed.length / 4, `graded ${graded.size} of ${feed.length}`);
  for (let i = 0; i < 25; i++) {
    // No cookie: a new practice visitor each time, so the draw caps don't bite.
    const r = await fetch(`${BASE}/api/rank`);
    assert.equal(r.status, 200);
    const pair = await r.json();
    for (const side of [pair.a, pair.b]) assert.ok(graded.has(side.url), `${side.url} is not graded`);
    assert.notEqual(pair.a.url, pair.b.url);
  }
});
