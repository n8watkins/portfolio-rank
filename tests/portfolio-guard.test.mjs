// The strong-signals guard (pipeline/portfolio-guard.mjs): an AI "not a
// portfolio" verdict against 4 or more of the code's 6 portfolio signals is
// stored as a portfolio for review, so it stays listed and ranked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { STRONG_SIGNALS, guardVerdict, guardedForReview } from "../pipeline/portfolio-guard.mjs";
import { gradeRecord } from "../pipeline/rubric.mjs";
import { replaceGradeStatements } from "../pipeline/rubric-history.mjs";
import { ACTIVE, NOT_PORTFOLIO } from "../pipeline/roster.mjs";
import { migrate } from "../lib/schema.mjs";
import { gradedUrls } from "../lib/sitemap-profiles.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pr-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const signals = (n) => {
  const names = ["name", "projects", "about", "contact", "resume", "github"];
  return { score: n, ...Object.fromEntries(names.map((k, i) => [k, i < n])) };
};
const notPortfolio = { tier: "D", is_portfolio: false, visual_design: { score: 2, note: "x" } };

test("4 or more signals keep a 'not a portfolio' verdict as a portfolio, with the AI's answer and why", () => {
  assert.equal(STRONG_SIGNALS, 4);
  const g = guardVerdict(notPortfolio, signals(4));
  assert.equal(g.is_portfolio, true);
  assert.equal(g.ai_is_portfolio, false);
  assert.equal(g.review.kind, "strong_signals");
  assert.equal(g.review.signals, 4);
  assert.match(g.review.reason, /4 of 6 portfolio signals \(name, projects, about, contact\)/);
  assert.equal(guardedForReview(g), true);
  assert.equal(g.tier, "D", "the rest of the grade is the AI's");
});

test("fewer signals, missing signals, or a portfolio verdict: unchanged", () => {
  assert.equal(guardVerdict(notPortfolio, signals(3)), notPortfolio);
  assert.equal(guardVerdict(notPortfolio, null), notPortfolio);
  assert.equal(guardVerdict(notPortfolio, {}), notPortfolio);
  const yes = { tier: "A", is_portfolio: true };
  assert.equal(guardVerdict(yes, signals(6)), yes);
  const unsaid = { tier: "B" };
  assert.equal(guardVerdict(unsaid, signals(6)), unsaid, "no verdict, nothing to guard");
});

test("every stored grade goes through it (gradeRecord), and the write marks the site needs_review", () => {
  const facts = { signals: signals(5) };
  const kept = gradeRecord({ parsed: notPortfolio, model: "gemini-3.5-flash-lite", facts, source: "r2" });
  assert.equal(kept.is_portfolio, true);
  assert.equal(kept.ai_is_portfolio, false);
  const plain = gradeRecord({ parsed: notPortfolio, model: "gemini-3.5-flash-lite", facts: { signals: signals(2) }, source: "r2" });
  assert.equal(plain.is_portfolio, false);
  assert.ok(replaceGradeStatements("https://a.dev", null, kept).some((s) => /needs_review = 1/.test(s.sql)));
  assert.ok(!replaceGradeStatements("https://a.dev", null, plain).some((s) => /needs_review/.test(s.sql)));
});

test("a kept grade stays listed and ranked: not 'not a portfolio' for the tiers and boards, and in the sitemap", async () => {
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  const kept = gradeRecord({ parsed: notPortfolio, model: "m", facts: { signals: signals(4) }, source: "r2" });
  const dropped = gradeRecord({ parsed: notPortfolio, model: "m", facts: { signals: signals(1) }, source: "r2" });
  for (const [url, g] of [["https://kept.dev", kept], ["https://dropped.dev", dropped]]) {
    await db.execute({ sql: "INSERT INTO portfolios (url, name, status, shot_key) VALUES (?, 'x', 'live', 'k')", args: [url] });
    await db.batch(replaceGradeStatements(url, null, g), "write");
  }
  const notPortfolios = (await db.execute(`SELECT url FROM portfolios p WHERE ${ACTIVE("p")} AND ${NOT_PORTFOLIO("p")}`)).rows.map((r) => r.url);
  assert.deepEqual(notPortfolios, ["https://dropped.dev"]);
  assert.deepEqual([...(await gradedUrls(db))], ["https://kept.dev"]);
  assert.deepEqual((await db.execute("SELECT url, needs_review FROM portfolios ORDER BY url")).rows.map((r) => [r.url, Number(r.needs_review)]), [
    ["https://dropped.dev", 0],
    ["https://kept.dev", 1],
  ]);
});
