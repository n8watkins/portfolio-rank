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
import { CAP, DAY_LIMIT, JOB, candidates, cappedFetch, groupOf, outcomeOf, report, usage } from "../scripts/regrade-not-portfolio.mjs";
import { buildDupIndex, junkCheck } from "../pipeline/junk-rules.mjs";

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

test("the narrow code rules: exact placeholder, promo-without-work, parked and address rules are junk; a copy is review; sparse pages are not judged", () => {
  const dup = buildDupIndex([{ url: "https://original.dev", page_text: "word ".repeat(10) + "Jane builds fast accessible web apps for small teams and loves typography and maps" }]);
  const cases = [
    [{ url: "https://a.dev", name: "A", page_text: "Build your AI portfolio in minutes", has_work: false }, true, "template promo text, no work shown"],
    // Templates are fine: promo text next to the person's own work, or with the work unknown, is not junk.
    [{ url: "https://a2.dev", name: "A", page_text: "Build your AI portfolio in minutes. My projects: Ledger", has_work: true }, false, null],
    [{ url: "https://a3.dev", name: "A", page_text: "Get this portfolio as a template" }, false, null],
    [{ url: "https://a4.dev", name: "A", page_text: "Hi, I'm Your Name, a developer" }, true, "placeholder name"],
    [{ url: "https://b.dev", name: "Aaaaby", page_text: "Hey there" }, true, "placeholder name"],
    [{ url: "https://c.dev", name: "C", page_text: "This domain is for sale. Make an offer on this domain." }, true, "parked or for sale"],
    [{ url: "https://github.com/someone", name: "S", page_text: "" }, true, "not a portfolio address"],
    [{ url: "https://linktr.ee/someone", name: "S", page_text: "" }, true, "not a portfolio address"],
    // Not junk: a sparse or gated real portfolio, lorem ipsum, a "coming soon" page.
    [{ url: "https://d.dev", name: "Dana", page_text: "Dana. Designer." }, false, null],
    [{ url: "https://e.dev", name: "E", page_text: "Lorem ipsum dolor sit amet" }, false, null],
    [{ url: "https://f.dev", name: "F", page_text: "Coming soon" }, false, null],
  ];
  for (const [row, junk, rule] of cases) {
    const r = junkCheck(row, dup);
    assert.equal(r.junk, junk, row.url);
    assert.equal(r.rule, rule, row.url);
  }
  const copy = junkCheck({ url: "https://copy.dev", name: "X", page_text: "word ".repeat(10) + "Jane builds fast accessible web apps for small teams and loves typography and maps" }, dup);
  assert.deepEqual([copy.junk, copy.review, copy.rule], [false, true, "same text on another domain"]);
  assert.equal(junkCheck({ url: "https://original.dev", name: "J", page_text: "word ".repeat(10) + "Jane builds fast accessible web apps for small teams and loves typography and maps" }, dup).review, false, "its own text");
});

test("the report counts each path: code rule, Gemini's three outcomes, copies and failed captures", async () => {
  const db = createClient({ url: `file:${path.join(dir, "report.sqlite")}` });
  await migrate(db);
  const rows = [
    ["https://r1.dev", { outcome: "junk_rule", rule: "placeholder name" }],
    ["https://r2.dev", { outcome: "portfolio", copy: true }],
    ["https://r3.dev", { outcome: "needs_review" }],
    ["https://r4.dev", { outcome: "not_portfolio" }],
    ["https://r5.dev", { captured: false }],
  ];
  for (const [url, s] of rows) {
    await db.execute({ sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, 'x', 'live', ?)", args: [url, JSON.stringify({ is_portfolio: false })] });
    await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, ?, 0)", args: [`regrade-np:${url}`, JSON.stringify(s)] });
  }
  const r = await report(db, { print: false });
  assert.deepEqual(
    Object.fromEntries(["junk_rule", "portfolio", "needs_review", "not_portfolio", "pending", "copies", "failedCaptures"].map((k) => [k, r[k].length])),
    { junk_rule: 1, portfolio: 1, needs_review: 1, not_portfolio: 1, pending: 1, copies: 1, failedCaptures: 1 }
  );
});

test("a new grade's outcome: portfolio, still not a portfolio, or needs review", () => {
  assert.equal(outcomeOf({ is_portfolio: true }), "portfolio");
  assert.equal(outcomeOf({ is_portfolio: false }), "not_portfolio");
  assert.equal(outcomeOf({ is_portfolio: true, ai_is_portfolio: false, review: { kind: "strong_signals" } }), "needs_review");
});
