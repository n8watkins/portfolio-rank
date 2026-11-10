// The Gemini quota day is defined once (pipeline/quota-day.mjs) and every
// "today" for Gemini budgets uses it: the request ledger, the accountant,
// the ranking store's comparisons per day and the comparison seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import * as quotaDayModule from "../pipeline/quota-day.mjs";
import * as budget from "../pipeline/budget.mjs";
import { ensureGeminiLog, createRequestLog, dailyTotals } from "../pipeline/gemini-log.mjs";
import { ensureRankingSchema, comparisonsToday, insertComparison } from "../lib/ranking/store.mjs";

const { quotaDay, pacificParts } = quotaDayModule;

test("budget.mjs re-exports the one quota-day helper, not a copy", () => {
  assert.equal(budget.quotaDay, quotaDayModule.quotaDay);
  assert.equal(budget.pacificParts, quotaDayModule.pacificParts);
  assert.equal(budget.QUOTA_TZ, "America/Los_Angeles");
});

test("every hour of 2026 and 2027 falls in the quota day that contains it, and days tile with no gap", () => {
  let prev = null;
  for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2028-01-01T00:00:00Z"); t += 3600000) {
    const q = quotaDay(new Date(t));
    assert.ok(q.start.getTime() <= t && t < q.end.getTime(), new Date(t).toISOString());
    assert.equal(pacificParts(q.start).hour, 0);
    const hours = (q.end - q.start) / 3600000;
    assert.ok(hours === 23 || hours === 24 || hours === 25, `${q.day} is ${hours} hours`);
    if (prev && prev.day !== q.day) assert.equal(prev.end.getTime(), q.start.getTime(), `${prev.day} -> ${q.day}`);
    prev = q;
  }
});

test("DST days: the 2027 spring and fall days are 23 and 25 hours", () => {
  const spring = quotaDay(new Date("2027-03-14T12:00:00Z"));
  assert.equal(spring.day, "2027-03-14");
  assert.equal((spring.end - spring.start) / 3600000, 23);
  const fall = quotaDay(new Date("2027-11-07T12:00:00Z"));
  assert.equal(fall.day, "2027-11-07");
  assert.equal((fall.end - fall.start) / 3600000, 25);
  // 01:30 Pacific happens twice on the fall day; both are the same quota day.
  assert.equal(quotaDay(new Date("2027-11-07T08:30:00Z")).day, "2027-11-07"); // 01:30 PDT
  assert.equal(quotaDay(new Date("2027-11-07T09:30:00Z")).day, "2027-11-07"); // 01:30 PST
});

async function memoryDb() {
  const db = createClient({ url: ":memory:" });
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  return db;
}

test("ledger and ranking store agree on the fall-back day: 25 hours of requests and comparisons count as one day", async () => {
  const db = await memoryDb();
  const log = createRequestLog({ db, job: "compare", runId: "t" });
  const comparison = (at, i) =>
    insertComparison(db, { created_at: at, rater_type: "ai", model: "gemini-3.5-flash-lite", method: "one_on_one", ranking: [["a"], ["b"]], source: `t:${i}` });
  // 2026-11-01 Pacific runs 07:00 UTC Nov 1 to 08:00 UTC Nov 2.
  const inside = ["2026-11-01T07:00:00.000Z", "2026-11-01T23:00:00.000Z", "2026-11-02T07:30:00.000Z"];
  const outside = ["2026-11-01T06:59:59.000Z", "2026-11-02T08:00:00.000Z"];
  let i = 0;
  for (const at of [...inside, ...outside]) {
    await log.record({ at, model: "gemini-3.5-flash-lite", status: 200 });
    await comparison(at, i++);
  }
  const now = new Date("2026-11-02T07:45:00Z"); // 23:45 PST on Nov 1
  const totals = await dailyTotals(db, { now, quota: { "gemini-3.5-flash-lite": 500 } });
  assert.equal(totals.used.get("gemini-3.5-flash-lite").n, 3);
  assert.match(totals.markdown, /2026-11-01, Pacific quota day/);
  const usage = await budget.usageToday(db, { now });
  assert.equal(usage.byModel["gemini-3.5-flash-lite"], 3);
  assert.equal(usage.day, "2026-11-01");
  assert.deepEqual(await comparisonsToday(db, { now }), { one_on_one: 3, batched: 0 });
});

test("no Gemini budget code keys a day on the UTC date", () => {
  for (const file of ["pipeline/gemini-log.mjs", "pipeline/budget.mjs", "pipeline/compare.mjs", "pipeline/night.mjs", "pipeline/people.mjs", "pipeline/alerts.mjs", "lib/ranking/store.mjs", "worker/night.ts"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /toISOString\(\)\.slice\(0, ?10\)/, `${file} slices a UTC date`);
  }
});
