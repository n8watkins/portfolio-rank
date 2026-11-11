// The monthly Tavily credit cap (lib/content/tavily-credits.mjs): the counter,
// the cap, the month rollover, concurrency, and what claims do at the cap.
// Tavily is a fake fetch; the real API is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { checkClaims } from "../pipeline/content/claims.mjs";
import { DEFAULT_MONTHLY_CREDITS, creditMonth, creditUsage, creditsFor, monthlyCap, releaseCredits, reserveCredits } from "../lib/content/tavily-credits.mjs";

const NOV = new Date("2026-11-10T12:00:00Z");

async function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tavily-credits-"));
  const url = `file:${path.join(dir, "db.sqlite")}`;
  const db = createClient({ url, timeout: 10000 });
  await migrate(db);
  return { db, url };
}

test("credits are counted up to the cap and no further", async () => {
  const { db } = await database();
  for (let i = 0; i < 3; i++) assert.equal(await reserveCredits(db, { cap: 3, now: NOV }), true);
  assert.equal(await reserveCredits(db, { cap: 3, now: NOV }), false);
  assert.deepEqual(await creditUsage(db, { cap: 3, now: NOV }), { month: "2026-11", used: 3, cap: 3 });
});

test("a take that would pass the cap is refused and leaves the count alone", async () => {
  const { db } = await database();
  await reserveCredits(db, { credits: 4, cap: 5, now: NOV });
  assert.equal(await reserveCredits(db, { credits: 2, cap: 5, now: NOV }), false);
  assert.equal((await creditUsage(db, { cap: 5, now: NOV })).used, 4);
});

test("a cap of 0 refuses everything", async () => {
  const { db } = await database();
  assert.equal(await reserveCredits(db, { cap: 0, now: NOV }), false);
});

test("a new calendar month (UTC) starts at zero", async () => {
  const { db } = await database();
  const lastSecond = new Date("2026-11-30T23:59:59Z");
  const firstSecond = new Date("2026-12-01T00:00:00Z");
  assert.equal(creditMonth(lastSecond), "2026-11");
  assert.equal(creditMonth(firstSecond), "2026-12");
  assert.equal(await reserveCredits(db, { cap: 1, now: lastSecond }), true);
  assert.equal(await reserveCredits(db, { cap: 1, now: lastSecond }), false);
  assert.equal(await reserveCredits(db, { cap: 1, now: firstSecond }), true);
  assert.equal((await creditUsage(db, { cap: 1, now: lastSecond })).used, 1);
});

test("released credits can be used again, and never below zero", async () => {
  const { db } = await database();
  await reserveCredits(db, { cap: 1, now: NOV });
  await releaseCredits(db, { now: NOV });
  await releaseCredits(db, { now: NOV });
  assert.equal((await creditUsage(db, { cap: 1, now: NOV })).used, 0);
  assert.equal(await reserveCredits(db, { cap: 1, now: NOV }), true);
});

test("the cap comes from the variable, with a default of 200", () => {
  assert.equal(DEFAULT_MONTHLY_CREDITS, 200);
  assert.equal(monthlyCap("200"), 200);
  assert.equal(monthlyCap(" 50 "), 50);
  assert.equal(monthlyCap("0"), 0);
  for (const bad of [undefined, "", "lots", "-1", "2.5"]) assert.equal(monthlyCap(bad), 200);
});

test("many searches at once, even from separate connections, never pass the cap", async () => {
  const { db, url } = await database();
  const other = createClient({ url, timeout: 10000 });
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => reserveCredits(i % 2 ? db : other, { cap: 7, now: NOV })));
  assert.equal(results.filter(Boolean).length, 7);
  assert.equal((await creditUsage(db, { cap: 7, now: NOV })).used, 7);
});

const CLAIM = "Recruiters spend about 7 seconds on a portfolio before deciding.";

function tavilyFetch({ status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://api.tavily.com/")) {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: [] }), { status });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}
const generate = async (req) => (req.schema.properties.claims ? { claims: [CLAIM, `${CLAIM} Again.`] } : { verdicts: [] });
const draft = `Intro.\n${CLAIM}\n${CLAIM} Again.`;

test("claims: at the cap outside claims are cut, with no call to Tavily", async () => {
  const { db } = await database();
  const web = tavilyFetch();
  const credits = creditsFor(db, { cap: 1, now: () => NOV });
  const r = await checkClaims(draft, { tavilyKey: "tvly-test", fetchImpl: web.fetchImpl, budget: { gemini: 5, tavily: 10 }, generate, credits });
  assert.equal(web.calls.length, 1);
  assert.equal(r.searches, 1);
  assert.equal(r.cut.filter((c) => /monthly credit cap/.test(c.reason)).length, 1);
  assert.equal((await creditUsage(db, { cap: 1, now: NOV })).used, 1);
  const again = await checkClaims(draft, { tavilyKey: "tvly-test", fetchImpl: web.fetchImpl, budget: { gemini: 5, tavily: 10 }, generate, credits });
  assert.equal(web.calls.length, 1);
  assert.equal(again.searches, 0);
  assert.equal(again.supported.length, 0);
  assert.equal(again.cut.length, 2);
  assert.ok(again.cut.every((c) => /monthly credit cap/.test(c.reason)));
});

test("claims: a search Tavily answers with an error gives its credit back", async () => {
  const { db } = await database();
  const credits = creditsFor(db, { cap: 5, now: () => NOV });
  const r = await checkClaims(draft, { tavilyKey: "tvly-test", fetchImpl: tavilyFetch({ status: 432 }).fetchImpl, budget: { gemini: 5, tavily: 10 }, generate, credits });
  assert.ok(r.cut.every((c) => /search failed/.test(c.reason)));
  assert.equal((await creditUsage(db, { cap: 5, now: NOV })).used, 0);
});

test("claims: without a key nothing is counted", async () => {
  const { db } = await database();
  const credits = creditsFor(db, { cap: 5, now: () => NOV });
  await checkClaims(draft, { tavilyKey: undefined, fetchImpl: tavilyFetch().fetchImpl, budget: { gemini: 5, tavily: 10 }, generate, credits });
  assert.equal((await creditUsage(db, { cap: 5, now: NOV })).used, 0);
});
