// scripts/regrade-not-portfolio.mjs: which sites it re-checks, its hard
// Gemini caps (retries included, and the Pacific day's total) and how it
// reads a new grade. Offline; no Gemini, no capture.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { CAP, DAY_LIMIT, JOB, candidates, cappedFetch, groupOf, outcomeOf, usage } from "../scripts/regrade-not-portfolio.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pr-regrade-np-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the caps: 160 for the job, under 480 for the day, retries counted as requests", async () => {
  assert.equal(CAP, 160);
  assert.equal(DAY_LIMIT, 480);
  const ok = async () => new Response("{}");
  // 150 already spent by this job: 10 more, then every send is refused.
  const f = cappedFetch({ job: 150, day: 0 }, { fetchImpl: ok });
  for (let i = 0; i < 10; i++) await f("x");
  await assert.rejects(f("x"), { name: "BudgetError" });
  assert.equal(f.exhausted, true);
  assert.equal(f.sent(), 10);
  // The day: 470 used by every job together, so 9 more (stays under 480).
  const d = cappedFetch({ job: 0, day: 470 }, { fetchImpl: ok });
  for (let i = 0; i < 9; i++) await d("x");
  await assert.rejects(d("x"), { name: "BudgetError" });
});

test("which sites: listed and shown with a stored 'not a portfolio', in two groups; usage counts the job and the Pacific day", async () => {
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  const add = (url, g, extra = "") =>
    db.execute({ sql: `INSERT INTO portfolios (url, name, status, ai_rubric${extra ? ", health" : ""}) VALUES (?, 'x', 'live', ?${extra ? ", ?" : ""})`, args: [url, JSON.stringify(g), ...(extra ? [extra] : [])] });
  await add("https://old31.dev", { is_portfolio: false, model: "gemini-3.1-flash-lite", rubric_version: 2 });
  await add("https://v1.dev", { is_portfolio: false, model: "gemini-3.5-flash-lite" });
  await add("https://v2.dev", { is_portfolio: false, model: "gemini-3.5-flash-lite", rubric_version: 2 });
  await add("https://yes.dev", { is_portfolio: true, model: "gemini-3.5-flash-lite", rubric_version: 2 });
  await add("https://down.dev", { is_portfolio: false, model: "gemini-3.1-flash-lite" }, "down");
  const list = await candidates(db);
  assert.deepEqual(list.map((c) => [c.url, groupOf(c)]), [
    ["https://old31.dev", "legacy"],
    ["https://v1.dev", "legacy"],
    ["https://v2.dev", "v2"],
  ]);
  // Re-graded to a portfolio, it stays on the list for the report (its state row).
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = 'https://v2.dev'", args: [JSON.stringify({ is_portfolio: true })] });
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES ('regrade-np:https://v2.dev', '{\"outcome\":\"portfolio\"}', 0)" });
  assert.equal((await candidates(db)).length, 3);

  const now = new Date("2026-11-14T12:00:00Z");
  for (const [job, at] of [[JOB, "2026-11-14T10:00:00Z"], [JOB, "2026-11-13T10:00:00Z"], ["grade-new", "2026-11-14T11:00:00Z"]]) {
    await db.execute({ sql: "INSERT INTO gemini_requests (at, job, model) VALUES (?, ?, 'm')", args: [at, job] });
  }
  assert.deepEqual(await usage(db, now), { job: 2, day: 2 });
});

test("a new grade's outcome: portfolio, still not a portfolio, or needs review", () => {
  assert.equal(outcomeOf({ is_portfolio: true }), "portfolio");
  assert.equal(outcomeOf({ is_portfolio: false }), "not_portfolio");
  assert.equal(outcomeOf({ is_portfolio: true, ai_is_portfolio: false, review: { kind: "strong_signals" } }), "needs_review");
});
